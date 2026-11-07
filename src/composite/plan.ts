import { validateTransform, type TransformOp } from './transform.js';
import type { AccessLevel, JsonSchema, JsonValue } from '../core/types.js';

/**
 * A composite tool is data, not code: a small DAG of calls to other gateway
 * tools, interpreted by a fixed executor. Nothing generated is ever run as
 * code, which is how the "no arbitrary generated code in-process" rule holds
 * without a sandbox.
 */

/** `{ "$ref": "input.userId" }`, `{ "$ref": "steps.orders.result" }`, `{ "$ref": "item.id" }`. */
export interface RefExpr {
  $ref: string;
}

export type ValueExpr = RefExpr | JsonValue;

export interface PlanStep {
  id: string;
  /** Gateway tool name this step calls. */
  tool: string;
  args: Record<string, ValueExpr>;
  /** Run once per element of this array (a ref with an optional [*] path). */
  forEach?: string;
  /** A failure here does not fail dependent-free siblings; result is partial. */
  optional?: boolean;
  /** Ordering-only dependencies (no data flows): run after these steps. */
  after?: string[];
  /** For tool "$transform": reshape the value at `from` (see transform.ts). */
  transform?: { from: string; ops: TransformOp[] };
}

/** Reserved tool name for data-transform steps (no tool is called). */
export const TRANSFORM_TOOL = '$transform';

export const isTransform = (step: PlanStep): boolean => step.tool === TRANSFORM_TOOL;

export interface CompositeDef {
  kind: 'composite';
  name: string;
  /** Exposed tool name (namespaced). */
  toolName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  steps: PlanStep[];
  /** Where this came from: a mined pattern id, a capability request, or manual. */
  provenance: {
    type: 'pattern' | 'capability' | 'manual';
    ref?: string;
    support?: number;
    confidence?: number;
  };
  /** Example inputs used by the evaluator (from redacted traces or supplied). */
  examples: Array<Record<string, JsonValue>>;
}

export function isRef(v: unknown): v is RefExpr {
  return (
    Boolean(v) &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as RefExpr).$ref === 'string' &&
    Object.keys(v as object).length === 1
  );
}

/** Collect the step ids a step depends on via its refs and forEach. */
export function stepDependencies(step: PlanStep): string[] {
  const deps = new Set<string>();
  const visit = (v: unknown): void => {
    if (isRef(v)) {
      const m = v.$ref.match(/^steps\.([A-Za-z0-9_-]+)/);
      if (m) deps.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(step.args);
  if (step.forEach) visit({ $ref: step.forEach });
  if (step.transform) visit({ $ref: step.transform.from });
  for (const a of step.after ?? []) deps.add(a);
  return [...deps];
}

/** Parallel stages: each stage only depends on earlier stages. */
export function planStages(steps: PlanStep[]): string[][] {
  const remaining = new Map(steps.map((s) => [s.id, new Set(stepDependencies(s))]));
  const done = new Set<string>();
  const stages: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => done.has(d)))
      .map(([id]) => id);
    if (ready.length === 0) throw new Error('Composite plan has a dependency cycle');
    stages.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return stages;
}

export function maxAccess(levels: AccessLevel[]): AccessLevel {
  if (levels.includes('destructive')) return 'destructive';
  if (levels.includes('write')) return 'write';
  return 'read';
}

export interface PlanLimits {
  maxSteps: number;
  maxFanOut: number;
}

/**
 * Static validation. Returns human-readable problems; empty means valid.
 * `toolExists` lets the caller check against the live catalog.
 */
export function validatePlan(
  def: CompositeDef,
  toolExists: (name: string) => boolean,
  limits: PlanLimits,
): string[] {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(def.toolName))
    problems.push(`invalid tool name "${def.toolName}"`);
  if (def.steps.length === 0) problems.push('plan has no steps');
  if (def.steps.length > limits.maxSteps)
    problems.push(`plan has ${def.steps.length} steps (limit ${limits.maxSteps})`);
  const ids = new Set<string>();
  const inputProps = Object.keys((def.inputSchema.properties ?? {}) as Record<string, unknown>);
  for (const step of def.steps) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(step.id)) problems.push(`invalid step id "${step.id}"`);
    if (ids.has(step.id)) problems.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
    if (isTransform(step)) {
      if (
        !step.transform ||
        typeof step.transform.from !== 'string' ||
        !/^(steps|input)\./.test(step.transform.from)
      ) {
        problems.push(
          `step "${step.id}" transform needs "from" referencing a step result or input`,
        );
      } else {
        for (const p of validateTransform(step.transform.ops))
          problems.push(`step "${step.id}" ${p}`);
      }
      if (step.forEach) problems.push(`step "${step.id}" transform steps cannot use forEach`);
    } else if (!toolExists(step.tool))
      problems.push(`step "${step.id}" calls unknown or unpublished tool "${step.tool}"`);
    if (step.tool === def.toolName) problems.push(`step "${step.id}" calls the composite itself`);
  }
  for (const step of def.steps) {
    for (const dep of stepDependencies(step)) {
      if (!ids.has(dep)) problems.push(`step "${step.id}" references unknown step "${dep}"`);
    }
    const checkRef = (ref: string): void => {
      if (ref.startsWith('input.')) {
        const key = ref.slice(6).split(/[.[]/)[0]!;
        if (!inputProps.includes(key))
          problems.push(`step "${step.id}" uses undeclared input "${key}"`);
      } else if (ref.startsWith('item')) {
        if (!step.forEach) problems.push(`step "${step.id}" uses "item" without forEach`);
      } else if (!ref.startsWith('steps.')) {
        problems.push(`step "${step.id}" has unsupported reference "${ref}"`);
      }
    };
    const visit = (v: unknown): void => {
      if (isRef(v)) checkRef(v.$ref);
      else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') Object.values(v).forEach(visit);
    };
    visit(step.args);
    if (step.forEach && !step.forEach.startsWith('steps.') && !step.forEach.startsWith('input.')) {
      problems.push(`step "${step.id}" forEach must reference a step result or input`);
    }
  }
  if (problems.length === 0) {
    try {
      planStages(def.steps);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return problems;
}
