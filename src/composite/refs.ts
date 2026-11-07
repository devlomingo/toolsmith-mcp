import type { JsonValue } from '../core/types.js';
import { isRef, type ValueExpr } from './plan.js';

export interface Scope {
  input: Record<string, JsonValue>;
  steps: Record<string, { result: JsonValue }>;
  item?: JsonValue;
}

/**
 * Resolve a dotted path with optional [*] (flat-map over arrays) and [n].
 * "steps.orders.result[*].id" -> array of ids. Missing segments give undefined.
 */
export function resolvePath(root: unknown, path: string): JsonValue | undefined {
  const tokens = path.match(/[^.[\]]+|\[\*\]|\[\d+\]/g) ?? [];
  let current: unknown[] = [root];
  let flattened = false;
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if (tok === '[*]') {
        flattened = true;
        if (Array.isArray(value)) next.push(...value);
      } else if (/^\[\d+\]$/.test(tok)) {
        if (Array.isArray(value)) next.push(value[Number(tok.slice(1, -1))]);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        next.push((value as Record<string, unknown>)[tok]);
      } else if (Array.isArray(value) && /^\d+$/.test(tok)) {
        next.push(value[Number(tok)]);
      }
    }
    current = next;
  }
  if (flattened) return current.filter((v) => v !== undefined) as JsonValue[];
  return current[0] as JsonValue | undefined;
}

export function resolveRef(ref: string, scope: Scope): JsonValue | undefined {
  if (ref === 'item') return scope.item;
  if (ref.startsWith('item.') || ref.startsWith('item[')) return resolvePath(scope.item, ref.slice(4).replace(/^\./, ''));
  return resolvePath(scope, ref);
}

/** Substitute refs inside an args template. Undefined refs drop the key. */
export function materialize(template: Record<string, ValueExpr>, scope: Scope): Record<string, JsonValue> {
  const walk = (v: ValueExpr): JsonValue | undefined => {
    if (isRef(v)) return resolveRef(v.$ref, scope);
    if (Array.isArray(v)) return v.map((x) => walk(x as ValueExpr) ?? null);
    if (v && typeof v === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [k, child] of Object.entries(v)) {
        const r = walk(child as ValueExpr);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return v;
  };
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(template)) {
    const r = walk(v);
    if (r !== undefined) out[k] = r;
  }
  return out;
}
