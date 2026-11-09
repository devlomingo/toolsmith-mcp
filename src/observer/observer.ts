import { randomUUID } from 'node:crypto';
import type { CallContext, JsonObject, ToolCallResult, ToolDefinition } from '../core/types.js';
import type { Fingerprinter, Redactor } from '../security/redact.js';
import type { TraceRecord, TraceStore } from './trace-store.js';

export interface ObserverOptions {
  captureArguments: 'redacted' | 'none';
  /** Called after every record; used by the dashboard's live view. */
  onTrace?: (record: TraceRecord) => void;
}

/**
 * Wraps tool execution and records a trace per call. Recording must never
 * break a tool call, so storage failures are logged to stderr and swallowed.
 */
export class UsageObserver {
  constructor(
    private readonly store: TraceStore,
    private readonly redactor: Redactor,
    private readonly fingerprinter: Fingerprinter,
    private readonly opts: ObserverOptions,
  ) {}

  /**
   * Result paths are built from response object keys, which can themselves
   * be data (maps keyed by email, an echoed header). Redact them like values.
   */
  private redactPaths(fp: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [hash, paths] of Object.entries(fp))
      out[hash] = paths.map((p) => this.redactor.redactString(p));
    return out;
  }

  async observe(
    tool: ToolDefinition,
    args: JsonObject,
    ctx: CallContext,
    run: (callId: string) => Promise<ToolCallResult>,
  ): Promise<ToolCallResult> {
    const id = randomUUID();
    const startedAt = Date.now();
    const t0 = performance.now();
    let result: ToolCallResult;
    try {
      result = await run(id);
    } catch (err) {
      result = {
        ok: false,
        error: this.redactor.redactString((err as Error)?.message ?? String(err)),
        errorCode: 'internal',
        upstreamRequests: 0,
        retries: 0,
      };
    }
    const durationMs = performance.now() - t0;
    try {
      const serialized = result.data === undefined ? '' : JSON.stringify(result.data);
      const record: TraceRecord = {
        id,
        sessionId: ctx.sessionId,
        parentId: ctx.parentCallId ?? null,
        tool: tool.name,
        artifactId: tool.artifactId,
        source: tool.source,
        access: tool.access,
        startedAt,
        durationMs,
        ok: result.ok,
        errorCode: result.errorCode ?? null,
        error: result.error ? this.redactor.redactString(result.error) : null,
        upstreamRequests: result.upstreamRequests,
        retries: result.retries,
        args: this.opts.captureArguments === 'redacted' ? this.redactor.redact(args) : null,
        argFingerprints: this.fingerprinter.argFingerprints(args),
        resultFingerprints: result.ok
          ? this.redactPaths(this.fingerprinter.resultFingerprints(result.data))
          : {},
        resultBytes: Buffer.byteLength(serialized),
      };
      await this.store.insert(record);
      this.opts.onTrace?.(record);
    } catch (err) {
      process.stderr.write(`[toolsmith] failed to record trace: ${(err as Error).message}\n`);
    }
    return result;
  }
}
