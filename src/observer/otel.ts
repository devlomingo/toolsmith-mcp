import { randomBytes } from 'node:crypto';
import type { TraceRecord } from './trace-store.js';
import type { JsonValue } from '../core/types.js';

/**
 * Exports tool-call traces as OpenTelemetry spans over OTLP/HTTP (JSON),
 * without the OTel SDK. Attribute names follow the MCP / GenAI semantic
 * conventions (status: Development at the time of writing), so expect them
 * to move. Arguments are exported only when explicitly enabled, and then in
 * their redacted form; results are never exported.
 */
export interface OtelOptions {
  /** Collector base URL, e.g. http://localhost:4318 (spans go to /v1/traces). */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  exportArguments?: boolean;
  /** Flush when this many spans are queued, or every flushMs. */
  batchSize?: number;
  flushMs?: number;
  fetchImpl?: typeof fetch;
}

interface Ids {
  traceId: string;
  spanId: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export class OtlpExporter {
  private queue: Record<string, unknown>[] = [];
  private ids = new Map<string, Ids>();
  private timer?: NodeJS.Timeout;
  private inflight = new Set<Promise<void>>();
  exported = 0;
  failed = 0;

  constructor(private readonly opts: OtelOptions) {
    this.timer = setInterval(() => void this.flush(), opts.flushMs ?? 2000);
    this.timer.unref();
  }

  /** Called for each recorded trace (children arrive before their parent finishes). */
  record(t: TraceRecord): void {
    const parent = t.parentId ? (this.ids.get(t.parentId) ?? this.reserve(t.parentId)) : undefined;
    const own = this.ids.get(t.id) ?? this.reserve(t.id, parent?.traceId);
    const attrs: Record<string, JsonValue> = {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': t.tool,
      'mcp.method.name': 'tools/call',
      'mcp.session.id': t.sessionId,
      'toolsmith.tool.source': t.source,
      'toolsmith.tool.access': t.access,
      'toolsmith.upstream_requests': t.upstreamRequests,
      'toolsmith.retries': t.retries,
      'toolsmith.result_bytes': t.resultBytes,
    };
    if (t.errorCode) attrs['error.type'] = t.errorCode;
    if (this.opts.exportArguments && t.args !== null)
      attrs['gen_ai.tool.call.arguments'] = JSON.stringify(t.args);
    const start = BigInt(t.startedAt) * 1_000_000n;
    this.queue.push({
      traceId: own.traceId,
      spanId: own.spanId,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name: `tools/call ${t.tool}`,
      kind: t.parentId ? 3 : 2, // CLIENT for composite steps, SERVER for agent calls
      startTimeUnixNano: start.toString(),
      endTimeUnixNano: (start + BigInt(Math.round(t.durationMs * 1_000_000))).toString(),
      attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) })),
      status: t.ok ? { code: 1 } : { code: 2, message: t.error ?? t.errorCode ?? 'error' },
    });
    if (!t.parentId) setTimeout(() => this.forget(t.id), 60_000).unref();
    if (this.queue.length >= (this.opts.batchSize ?? 100)) void this.flush();
  }

  private reserve(id: string, traceId?: string): Ids {
    const ids = { traceId: traceId ?? hex(16), spanId: hex(8) };
    this.ids.set(id, ids);
    return ids;
  }

  private forget(id: string): void {
    this.ids.delete(id);
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const spans = this.queue.splice(0);
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: 'service.name',
                value: { stringValue: this.opts.serviceName ?? 'toolsmith-mcp' },
              },
            ],
          },
          scopeSpans: [{ scope: { name: 'toolsmith-mcp' }, spans }],
        },
      ],
    };
    const p = (this.opts.fetchImpl ?? fetch)(
      `${this.opts.endpoint.replace(/\/+$/, '')}/v1/traces`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    )
      .then((res) => {
        if (res.ok) this.exported += spans.length;
        else this.failed += spans.length;
      })
      // Telemetry must never break tool calls: count and move on.
      .catch(() => void (this.failed += spans.length));
    this.inflight.add(p);
    await p.finally(() => this.inflight.delete(p));
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await Promise.all(this.inflight);
  }
}

function toAnyValue(v: JsonValue): Record<string, unknown> {
  if (typeof v === 'number')
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: typeof v === 'string' ? v : JSON.stringify(v) };
}
