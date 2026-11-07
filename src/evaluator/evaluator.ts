import type { IntegrationConfig } from '../config/config.js';
import { validatePlan, stepDependencies, planStages, type CompositeDef } from '../composite/plan.js';
import { materialize, resolveRef, type Scope } from '../composite/refs.js';
import { errorMessage } from '../core/errors.js';
import { TOOL_NAME_PATTERN, type CallContext, type JsonObject, type JsonValue, type ToolCallResult } from '../core/types.js';
import { toolName } from '../core/naming.js';
import { HttpIntegrationClient } from '../openapi/http-executor.js';
import type { OpenApiIntegrationDef } from '../openapi/types.js';
import type { Evaluation } from '../registry/registry.js';
import { stableStringify } from '../registry/registry.js';
import type { Redactor } from '../security/redact.js';
import { envRefNames } from '../security/secrets.js';
import { isPrivateAddress } from '../security/ssrf.js';
import { isIP } from 'node:net';
import { validateAgainst } from '../gateway/validation.js';

type Check = Evaluation['checks'][number];

export interface IntegrationEvalOptions {
  /** Call read-only operations that need no parameters against the live API. */
  live: boolean;
}

/**
 * Evaluates an imported integration before a human sees it. Static and
 * security checks always run; live smoke tests only call safe GET operations
 * that need no arguments, never anything that writes.
 */
export async function evaluateIntegration(
  def: OpenApiIntegrationDef,
  cfg: IntegrationConfig,
  redactor: Redactor,
  opts: IntegrationEvalOptions,
): Promise<Evaluation> {
  const checks: Check[] = [];
  const metrics: Record<string, number> = {};
  const names = def.operations.map((o) => toolName(def.name, o.name));
  const bad = names.filter((n) => !TOOL_NAME_PATTERN.test(n));
  checks.push({ name: 'tool names valid', passed: bad.length === 0, detail: bad.length ? bad.join(', ') : `${names.length} tools`, severity: 'error' });
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  checks.push({ name: 'tool names unique', passed: dupes.length === 0, detail: dupes.join(', ') || undefined, severity: 'error' });

  const schemaErrors: string[] = [];
  for (const op of def.operations) {
    if (op.inputSchema.type !== 'object') schemaErrors.push(`${op.name}: input schema is not an object`);
    if (op.outputSchema && op.outputSchema.type !== 'object') schemaErrors.push(`${op.name}: output schema is not an object`);
  }
  checks.push({ name: 'schemas are MCP-compatible', passed: schemaErrors.length === 0, detail: schemaErrors.join('; ') || undefined, severity: 'error' });

  const injection = def.findings.filter((f) => f.code === 'suspicious_description');
  checks.push({
    name: 'no instruction-like text in descriptions',
    passed: injection.length === 0,
    detail: injection.length ? `${injection.map((f) => f.message).join(' | ')} — exclude these operations or fix the spec` : undefined,
    severity: 'error',
  });

  const base = new URL(cfg.baseUrl ?? def.baseUrl);
  const host = base.hostname.replace(/^\[|\]$/g, '');
  const privateHost = host === 'localhost' || (isIP(host) > 0 && isPrivateAddress(host));
  checks.push({
    name: 'egress policy',
    passed: !privateHost || cfg.allowPrivateNetwork,
    detail: privateHost
      ? cfg.allowPrivateNetwork
        ? `${host} is private; allowed because allowPrivateNetwork is true`
        : `${host} is a private/loopback address. Set "allowPrivateNetwork": true only if this is intentional.`
      : `only ${[host, ...cfg.allowedHosts].join(', ')} reachable`,
    severity: 'error',
  });
  checks.push({
    name: 'transport security',
    passed: true,
    detail: base.protocol === 'https:' ? 'https' : 'plain http: credentials and data are not encrypted in transit',
    severity: base.protocol === 'https:' ? 'info' : 'warning',
  });

  const refs = authRefs(cfg);
  const missing = refs.filter((r) => !process.env[r]);
  checks.push({
    name: 'credentials configured',
    passed: missing.length === 0,
    detail: missing.length ? `missing environment variables: ${missing.join(', ')}` : refs.length ? `from ${refs.join(', ')}` : 'no authentication configured',
    severity: 'error',
  });

  const counts = { read: 0, write: 0, destructive: 0 };
  for (const op of def.operations) counts[op.access]++;
  metrics.readOperations = counts.read;
  metrics.writeOperations = counts.write;
  metrics.destructiveOperations = counts.destructive;
  checks.push({
    name: 'permission review',
    passed: true,
    detail: `${counts.read} read, ${counts.write} write, ${counts.destructive} destructive. Write and destructive tools stay hidden unless explicitly granted at approval; destructive calls also need per-call approval.`,
    severity: counts.write + counts.destructive > 0 ? 'warning' : 'info',
  });

  for (const f of def.findings.filter((x) => x.severity === 'warning')) {
    checks.push({ name: `spec: ${f.code}`, passed: true, detail: f.message, severity: 'warning' });
  }

  if (opts.live && missing.length === 0 && (!privateHost || cfg.allowPrivateNetwork)) {
    const client = new HttpIntegrationClient(cfg, cfg.baseUrl ?? def.baseUrl, redactor);
    const probes = def.operations.filter((o) => o.method === 'GET' && !o.params.some((p) => p.required)).slice(0, 5);
    const latencies: number[] = [];
    for (const op of probes) {
      const t0 = performance.now();
      try {
        const out = await client.call(op, {});
        latencies.push(performance.now() - t0);
        if (!out.ok) {
          checks.push({
            name: `live: ${op.name}`,
            passed: out.errorCode !== 'auth',
            detail: out.error,
            severity: out.errorCode === 'auth' ? 'error' : 'warning',
          });
          continue;
        }
        let detail = `HTTP ${out.status}`;
        let severity: Check['severity'] = 'info';
        if (op.outputSchema && cfg.validateOutput) {
          const data = out.data ?? null;
          const shaped = op.outputWrapped || !data || typeof data !== 'object' || Array.isArray(data) ? { result: data } : data;
          const v = validateAgainst(op.outputSchema, shaped);
          if (!v.valid) {
            detail += `; response does not match documented schema (${v.message}). Fix the spec or set "validateOutput": false.`;
            severity = 'error';
          }
        }
        checks.push({ name: `live: ${op.name}`, passed: severity !== 'error', detail, severity });
      } catch (err) {
        checks.push({ name: `live: ${op.name}`, passed: false, detail: errorMessage(err), severity: 'warning' });
      }
    }
    if (probes.length === 0) checks.push({ name: 'live smoke test', passed: true, detail: 'no parameter-free GET operations to probe', severity: 'info' });
    if (latencies.length) metrics.liveMedianMs = Math.round(latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]!);
  } else if (!opts.live) {
    checks.push({ name: 'live smoke test', passed: true, detail: 'skipped (--no-live)', severity: 'info' });
  }

  return finish(checks, metrics);
}

function authRefs(cfg: IntegrationConfig): string[] {
  const a = cfg.auth;
  const vals = a.type === 'bearer' ? [a.token] : a.type === 'apiKey' ? [a.value] : a.type === 'basic' ? [a.username, a.password] : [];
  return [...vals, ...Object.values(cfg.headers)].flatMap(envRefNames);
}

export interface CompositeEvalDeps {
  /** Execute a tool through the gateway (validation, policy, tracing). */
  call: (tool: string, args: JsonObject, ctx: CallContext) => Promise<ToolCallResult>;
  /** Run the composite through the real (parallel) executor. */
  runComposite: (def: CompositeDef, args: JsonObject, ctx: CallContext) => Promise<ToolCallResult>;
  toolAccess: (tool: string) => 'read' | 'write' | 'destructive' | undefined;
  limits: { maxSteps: number; maxFanOut: number };
}

/**
 * Evaluate a composite: static plan checks, permission checks, then (for
 * read-only plans with example inputs) run the original tools one by one, the
 * way an agent would, and the composite, and require identical step results.
 * Plans that write are never executed by the evaluator.
 */
export async function evaluateComposite(def: CompositeDef, inputs: JsonObject[], deps: CompositeEvalDeps): Promise<Evaluation> {
  const checks: Check[] = [];
  const metrics: Record<string, number> = {};
  const problems = validatePlan(def, (t) => deps.toolAccess(t) !== undefined, deps.limits);
  checks.push({ name: 'plan is valid', passed: problems.length === 0, detail: problems.join('; ') || `${def.steps.length} steps`, severity: 'error' });
  if (problems.length) return finish(checks, metrics);

  const stages = planStages(def.steps);
  metrics.steps = def.steps.length;
  metrics.stages = stages.length;
  metrics.maxParallelism = Math.max(...stages.map((s) => s.length));
  const accesses = def.steps.map((s) => deps.toolAccess(s.tool)!);
  const writes = accesses.filter((a) => a !== 'read').length;
  checks.push({
    name: 'authorization preserved',
    passed: true,
    detail: `every step calls an already-exposed tool through the gateway; composite access = ${writes ? 'write' : 'read'} (${writes} writing steps)`,
    severity: writes ? 'warning' : 'info',
  });

  if (writes > 0) {
    checks.push({
      name: 'equivalence test',
      passed: true,
      detail: 'skipped: the plan writes data, so the evaluator will not execute it. Review the plan by hand before approving.',
      severity: 'warning',
    });
    return finish(checks, metrics);
  }
  const cases = inputs.length ? inputs : (def.examples as JsonObject[]);
  if (cases.length === 0) {
    checks.push({
      name: 'equivalence test',
      passed: false,
      detail: 'no example input. Run `toolsmith-mcp evaluate <name> --input \'{"…": …}\'` with a real input.',
      severity: 'error',
    });
    return finish(checks, metrics);
  }

  const baseMs: number[] = [];
  const compMs: number[] = [];
  let baselineCalls = 0;
  for (const [i, input] of cases.slice(0, 5).entries()) {
    const ctx: CallContext = { sessionId: `evaluator:${def.name}` };
    const t0 = performance.now();
    const baseline = await sequentialReference(def, input, (tool, args) => deps.call(tool, args, ctx));
    baseMs.push(performance.now() - t0);
    baselineCalls += baseline.calls;
    const t1 = performance.now();
    const composite = await deps.runComposite(def, input, ctx);
    compMs.push(performance.now() - t1);
    const compResults = ((composite.data as Record<string, JsonValue> | undefined)?.results ?? {}) as Record<string, JsonValue>;
    const same = stableStringify(baseline.results) === stableStringify(compResults);
    const baseErr = baseline.errors.length > 0;
    checks.push({
      name: `equivalence #${i + 1}`,
      passed: same && !baseErr,
      detail: baseErr
        ? `the original tools failed for this input: ${baseline.errors.join('; ')}`
        : same
          ? `identical results for ${Object.keys(compResults).length} steps`
          : 'composite results differ from calling the tools one by one',
      severity: 'error',
    });
  }
  const med = (xs: number[]): number => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! * 10) / 10;
  metrics.baselineMedianMs = med(baseMs);
  metrics.compositeMedianMs = med(compMs);
  metrics.baselineMcpCalls = Math.round(baselineCalls / Math.min(cases.length, 5));
  metrics.compositeMcpCalls = 1;
  const faster = metrics.compositeMedianMs <= metrics.baselineMedianMs * 1.1;
  checks.push({
    name: 'performance',
    passed: true,
    detail: faster
      ? `server-side ${metrics.compositeMedianMs} ms vs ${metrics.baselineMedianMs} ms sequential; ${metrics.baselineMcpCalls} MCP calls → 1`
      : `no server-side latency gain (${metrics.compositeMedianMs} ms vs ${metrics.baselineMedianMs} ms); benefit is fewer MCP round-trips only`,
    severity: faster ? 'info' : 'warning',
  });
  return finish(checks, metrics);
}

/**
 * Independent reference interpreter: strictly sequential, one call at a time,
 * in plan order. Deliberately separate from CompositeExecutor so the
 * equivalence test cross-checks the parallel scheduler instead of comparing
 * it with itself.
 */
async function sequentialReference(
  def: CompositeDef,
  input: JsonObject,
  call: (tool: string, args: JsonObject) => Promise<ToolCallResult>,
): Promise<{ results: Record<string, JsonValue>; errors: string[]; calls: number }> {
  const scope: Scope = { input: input as Record<string, JsonValue>, steps: {} };
  const errors: string[] = [];
  let calls = 0;
  const order = planStages(def.steps).flat();
  for (const id of order) {
    const step = def.steps.find((s) => s.id === id)!;
    if (stepDependencies(step).some((d) => !scope.steps[d])) continue;
    if (step.forEach) {
      const src = resolveRef(step.forEach, scope);
      const items = Array.isArray(src) ? src : src == null ? [] : [src];
      const out: JsonValue[] = [];
      for (const item of items) {
        calls++;
        const r = await call(step.tool, materialize(step.args, { ...scope, item }) as JsonObject);
        if (!r.ok) errors.push(`${step.id}: ${r.error}`);
        out.push(r.ok ? (r.data ?? null) : null);
      }
      scope.steps[id] = { result: out };
    } else {
      calls++;
      const r = await call(step.tool, materialize(step.args, scope) as JsonObject);
      if (!r.ok) {
        errors.push(`${step.id}: ${r.error}`);
        continue;
      }
      scope.steps[id] = { result: r.data ?? null };
    }
  }
  const results: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(scope.steps)) results[k] = v.result;
  return { results, errors, calls };
}

function finish(checks: Check[], metrics: Record<string, number>): Evaluation {
  return {
    passed: checks.every((c) => c.passed || c.severity !== 'error'),
    ranAt: new Date().toISOString(),
    checks,
    metrics,
  };
}
