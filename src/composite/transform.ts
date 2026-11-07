import type { JsonValue } from '../core/types.js';
import { resolvePath } from './refs.js';

/**
 * Data transforms for composite plans: a fixed, small vocabulary interpreted
 * by this file. There is no expression language and nothing is evaluated, so
 * a transform can reshape data but never run code. Input size is bounded.
 */
export type TransformOp =
  | {
      filter: {
        field: string;
        op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'exists';
        value?: JsonValue;
      };
    }
  | { sort: { field: string; order?: 'asc' | 'desc' } }
  | { pick: string[] }
  | { limit: number }
  | { first: true }
  | { last: true }
  | { count: true };

export const MAX_TRANSFORM_ITEMS = 10_000;

const OPS = new Set(['filter', 'sort', 'pick', 'limit', 'first', 'last', 'count']);
const CMP = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists']);

/** Static check of a transform pipeline; returns problems (empty = valid). */
export function validateTransform(ops: unknown): string[] {
  if (!Array.isArray(ops) || ops.length === 0) return ['transform needs a non-empty "ops" list'];
  if (ops.length > 20) return ['transform has more than 20 ops'];
  const problems: string[] = [];
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      problems.push(`op ${i} is not an object`);
      continue;
    }
    const keys = Object.keys(op);
    if (keys.length !== 1 || !OPS.has(keys[0]!)) {
      problems.push(`op ${i} must be exactly one of ${[...OPS].join(', ')}`);
      continue;
    }
    const o = op as Record<string, unknown>;
    if ('filter' in o) {
      const f = o.filter as { field?: unknown; op?: unknown };
      if (typeof f?.field !== 'string' || !CMP.has(String(f?.op)))
        problems.push(`op ${i}: filter needs a field and one of ${[...CMP].join(', ')}`);
    } else if ('sort' in o) {
      const st = o.sort as { field?: unknown; order?: unknown };
      if (
        typeof st?.field !== 'string' ||
        (st.order !== undefined && st.order !== 'asc' && st.order !== 'desc')
      )
        problems.push(`op ${i}: sort needs a field and order asc|desc`);
    } else if ('pick' in o) {
      if (!Array.isArray(o.pick) || o.pick.some((f) => typeof f !== 'string'))
        problems.push(`op ${i}: pick needs a list of field names`);
    } else if ('limit' in o) {
      if (!Number.isInteger(o.limit) || (o.limit as number) < 0)
        problems.push(`op ${i}: limit needs a non-negative integer`);
    } else if (o[keys[0]!] !== true) {
      problems.push(`op ${i}: ${keys[0]} must be true`);
    }
  }
  return problems;
}

function field(item: JsonValue, path: string): JsonValue | undefined {
  return resolvePath(item, path) ?? undefined;
}

function compare(a: JsonValue | undefined, b: JsonValue | undefined): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1; // missing values sort last
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // ISO timestamps and plain strings compare correctly as strings.
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matches(v: JsonValue | undefined, op: string, value: JsonValue | undefined): boolean {
  switch (op) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'eq':
      return JSON.stringify(v) === JSON.stringify(value);
    case 'ne':
      return JSON.stringify(v) !== JSON.stringify(value);
    case 'gt':
      return compare(v, value) > 0 && v !== undefined && v !== null;
    case 'gte':
      return compare(v, value) >= 0 && v !== undefined && v !== null;
    case 'lt':
      return compare(v, value) < 0 && v !== undefined && v !== null;
    case 'lte':
      return compare(v, value) <= 0 && v !== undefined && v !== null;
    case 'contains':
      return typeof v === 'string'
        ? v.includes(String(value))
        : Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(value));
    case 'in':
      return Array.isArray(value) && value.some((x) => JSON.stringify(x) === JSON.stringify(v));
    default:
      return false;
  }
}

/**
 * Apply a pipeline. `value` may be a list or a single item (treated as a
 * list of one for filter/sort, returned as-is otherwise).
 */
export function applyTransform(value: JsonValue | undefined, ops: TransformOp[]): JsonValue {
  let current: JsonValue = value ?? null;
  for (const op of ops) {
    const list = Array.isArray(current) ? current : current === null ? [] : [current];
    if (list.length > MAX_TRANSFORM_ITEMS)
      throw new Error(`transform input has more than ${MAX_TRANSFORM_ITEMS} items`);
    if ('filter' in op)
      current = list.filter((it) =>
        matches(field(it, op.filter.field), op.filter.op, op.filter.value),
      );
    else if ('sort' in op) {
      const dir = op.sort.order === 'desc' ? -1 : 1;
      current = [...list].sort((a, b) => {
        const c = compare(field(a, op.sort.field), field(b, op.sort.field));
        // keep missing values last in both directions
        const am = field(a, op.sort.field) == null;
        const bm = field(b, op.sort.field) == null;
        return am || bm ? c : dir * c;
      });
    } else if ('pick' in op) {
      const pickOne = (it: JsonValue): JsonValue => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
        const out: Record<string, JsonValue> = {};
        for (const f of op.pick) if (f in it) out[f] = (it as Record<string, JsonValue>)[f]!;
        return out;
      };
      current = Array.isArray(current) ? list.map(pickOne) : pickOne(current);
    } else if ('limit' in op) current = list.slice(0, op.limit);
    else if ('first' in op) current = list[0] ?? null;
    else if ('last' in op) current = list[list.length - 1] ?? null;
    else if ('count' in op) current = list.length;
  }
  return current;
}
