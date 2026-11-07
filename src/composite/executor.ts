import type {
  CallContext,
  ErrorCode,
  JsonObject,
  JsonValue,
  ToolCallResult,
} from '../core/types.js';
import { stepDependencies, type CompositeDef, type PlanStep } from './plan.js';
import { materialize, resolveRef, type Scope } from './refs.js';

export type StepCaller = (
  tool: string,
  args: JsonObject,
  ctx: CallContext,
) => Promise<ToolCallResult>;

export interface CompositeLimits {
  maxFanOut: number;
  concurrency: number;
  timeoutMs: number;
}

export interface StepError {
  step: string;
  tool: string;
  iteration?: number;
  code: ErrorCode;
  error: string;
}

export interface CompositeOutput {
  [key: string]: JsonValue;
}

/**
 * Interprets a composite plan. Steps start as soon as their dependencies
 * finish, so independent steps run in parallel; forEach steps fan out with a
 * bounded concurrency. Every step call goes back through the gateway, so it
 * gets the same validation, policy, rate limits and tracing as a direct call:
 * a composite can never do something its steps could not.
 */
export class CompositeExecutor {
  constructor(
    private readonly callStep: StepCaller,
    private readonly limits: CompositeLimits,
  ) {}

  async run(def: CompositeDef, input: JsonObject, ctx: CallContext): Promise<ToolCallResult> {
    const deadline = AbortSignal.timeout(this.limits.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
    const scope: Scope = { input: input as Record<string, JsonValue>, steps: {} };
    const errors: StepError[] = [];
    const skipped: string[] = [];
    const truncated: string[] = [];
    let upstreamRequests = 0;
    let retries = 0;
    let calls = 0;

    const status = new Map<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>(
      def.steps.map((s) => [s.id, 'pending']),
    );
    const deps = new Map(def.steps.map((s) => [s.id, stepDependencies(s)]));
    const limiter = new Semaphore(this.limits.concurrency);

    const callOnce = async (
      step: PlanStep,
      args: JsonObject,
      iteration?: number,
    ): Promise<JsonValue | undefined> => {
      if (signal.aborted) {
        errors.push({
          step: step.id,
          tool: step.tool,
          iteration,
          code: 'timeout',
          error: 'Composite timed out before this step ran',
        });
        return undefined;
      }
      await limiter.acquire();
      try {
        calls++;
        const r = await this.callStep(step.tool, args, { ...ctx, signal });
        upstreamRequests += r.upstreamRequests;
        retries += r.retries;
        if (!r.ok) {
          errors.push({
            step: step.id,
            tool: step.tool,
            iteration,
            code: r.errorCode ?? 'upstream',
            error: r.error ?? 'failed',
          });
          return undefined;
        }
        return r.data ?? null;
      } finally {
        limiter.release();
      }
    };

    const runStep = async (step: PlanStep): Promise<boolean> => {
      if (!step.forEach) {
        const args = materialize(step.args, scope) as JsonObject;
        const data = await callOnce(step, args);
        if (data === undefined) return false;
        scope.steps[step.id] = { result: data };
        return true;
      }
      const source = resolveRef(step.forEach, scope);
      let items: JsonValue[] = Array.isArray(source)
        ? source
        : source === undefined || source === null
          ? []
          : [source];
      if (items.length > this.limits.maxFanOut) {
        truncated.push(`${step.id}: ${items.length} items, ran first ${this.limits.maxFanOut}`);
        items = items.slice(0, this.limits.maxFanOut);
      }
      const results = await Promise.all(
        items.map((item, i) =>
          callOnce(step, materialize(step.args, { ...scope, item }) as JsonObject, i),
        ),
      );
      const failed = results.filter((r) => r === undefined).length;
      scope.steps[step.id] = { result: results.map((r) => (r === undefined ? null : r)) };
      // A fan-out with some failed iterations still yields a usable (partial)
      // result; only a fan-out where everything failed counts as a failed step.
      return items.length === 0 || failed < items.length;
    };

    await new Promise<void>((resolve) => {
      const inFlight = new Set<Promise<void>>();
      const schedule = (): void => {
        for (const step of def.steps) {
          if (status.get(step.id) !== 'pending') continue;
          const d = deps.get(step.id)!;
          if (d.some((x) => status.get(x) === 'failed' || status.get(x) === 'skipped')) {
            status.set(step.id, 'skipped');
            skipped.push(step.id);
            continue;
          }
          if (!d.every((x) => status.get(x) === 'done')) continue;
          status.set(step.id, 'running');
          const p = runStep(step)
            .then((ok) => void status.set(step.id, ok ? 'done' : 'failed'))
            .catch((err: unknown) => {
              errors.push({
                step: step.id,
                tool: step.tool,
                code: 'internal',
                error: (err as Error)?.message ?? String(err),
              });
              status.set(step.id, 'failed');
            })
            .finally(() => {
              inFlight.delete(p);
              schedule();
            });
          inFlight.add(p);
        }
        // Re-scan after marking skips, since a skip can cascade.
        const changed = def.steps.some(
          (s) =>
            status.get(s.id) === 'pending' &&
            deps.get(s.id)!.some((x) => status.get(x) === 'failed' || status.get(x) === 'skipped'),
        );
        if (changed) return schedule();
        if (inFlight.size === 0) resolve();
      };
      schedule();
    });

    const results: Record<string, JsonValue> = {};
    for (const step of def.steps)
      if (scope.steps[step.id]) results[step.id] = scope.steps[step.id]!.result;
    const requiredFailed = def.steps.filter((s) => !s.optional && status.get(s.id) !== 'done');
    const partial = errors.length > 0 || skipped.length > 0 || truncated.length > 0;
    const data: CompositeOutput = {
      results,
      partial,
      errors: errors as unknown as JsonValue,
      skippedSteps: skipped,
      ...(truncated.length ? { truncated } : {}),
      stats: { stepCalls: calls, upstreamRequests },
    };
    const nothing = Object.keys(results).length === 0;
    return {
      ok: !nothing,
      data,
      error: nothing
        ? `All steps failed: ${errors.map((e) => `${e.step}: ${e.error}`).join('; ')}`
        : requiredFailed.length
          ? `Partial result: ${requiredFailed.map((s) => s.id).join(', ')} did not complete`
          : undefined,
      errorCode: nothing ? (errors[0]?.code ?? 'upstream') : undefined,
      upstreamRequests,
      retries,
    };
  }
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => (this.active++, resolve())));
  }

  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
