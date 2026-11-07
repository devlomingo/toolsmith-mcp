import type { IntegrationConfig } from '../config/config.js';
import { errorMessage } from '../core/errors.js';
import type { JsonObject, JsonValue } from '../core/types.js';
import { validateAgainst } from '../gateway/validation.js';
import { resolvePath } from '../composite/refs.js';
import type { HttpIntegrationClient } from './http-executor.js';
import type { OpenApiIntegrationDef, OperationDef } from './types.js';

/**
 * Live verification of generated read tools, after ToolFactory (Ni et al.,
 * 2025, §4.3–4.4): call each tool with real parameter values and classify
 * the outcome. Two deliberate differences from the paper: the "is this an
 * error message?" judge is a deterministic heuristic instead of an LLM, and
 * parameter values come from the spec's own examples or, failing that, live
 * from another endpoint that returns them (orderId <- listOrders[*].id),
 * rather than from an embedding-retrieved knowledge base. Values are used
 * for the probe only and are never stored.
 *
 * Only read operations are ever called. Writes are reported as not probed.
 */

export type VerifyStatus =
  | 'verified'
  | 'no_parameter_value'
  | 'wrong_parameter_value'
  | 'auth_failed'
  | 'http_error'
  | 'error_shaped_response'
  | 'schema_mismatch'
  | 'network_error'
  | 'not_probed_write';

export interface OperationVerification {
  operation: string;
  status: VerifyStatus;
  detail?: string;
  /** Where each parameter value came from: "example", "default" or "<op>.<field>". */
  valueSources?: Record<string, string>;
  ms?: number;
}

export interface VerificationReport {
  results: OperationVerification[];
  verified: number;
  probed: number;
}

const ERROR_KEYS = new Set([
  'error',
  'errors',
  'message',
  'detail',
  'details',
  'fault',
  'code',
  'status',
  'success',
  'reason',
]);

/** A 2xx body that is really an error message (ToolFactory's "Abnormal Response"). */
export function looksLikeError(data: JsonValue | undefined): string | undefined {
  if (data === null || data === undefined || data === '') return 'empty response body';
  if (typeof data === 'string') {
    return /^\s*(error|exception|invalid|not found|unauthori[sz]ed|forbidden)\b/i.test(data)
      ? 'text body reads as an error'
      : undefined;
  }
  if (Array.isArray(data) || typeof data !== 'object') return undefined;
  const keys = Object.keys(data);
  if (keys.length === 0) return 'empty object';
  if ((data as Record<string, JsonValue>).success === false) return '"success": false';
  if (
    keys.every((k) => ERROR_KEYS.has(k.toLowerCase())) &&
    keys.some((k) => /^(error|errors|fault)$/i.test(k))
  ) {
    return `body has only error fields (${keys.join(', ')})`;
  }
  return undefined;
}

export async function verifyOperations(
  def: OpenApiIntegrationDef,
  cfg: IntegrationConfig,
  client: HttpIntegrationClient,
  maxProbes = 25,
): Promise<VerificationReport> {
  const byName = new Map(def.operations.map((o) => [o.name, o]));
  const sourceCache = new Map<string, Promise<JsonValue | undefined>>();
  const fetchSource = (name: string): Promise<JsonValue | undefined> => {
    if (!sourceCache.has(name)) {
      const op = byName.get(name);
      sourceCache.set(
        name,
        op
          ? client
              .call(op, {})
              .then((r) => (r.ok ? r.data : undefined))
              .catch(() => undefined)
          : Promise.resolve(undefined),
      );
    }
    return sourceCache.get(name)!;
  };

  const results: OperationVerification[] = [];
  let probed = 0;
  for (const op of def.operations) {
    if (op.access !== 'read') {
      results.push({
        operation: op.name,
        status: 'not_probed_write',
        detail: `${op.method} is never called during verification`,
      });
      continue;
    }
    if (probed >= maxProbes) break;
    probed++;
    const args: JsonObject = {};
    const valueSources: Record<string, string> = {};
    let missing: string | undefined;
    for (const p of op.params.filter((x) => x.required)) {
      if (p.example !== undefined) {
        args[p.name] = p.example;
        valueSources[p.name] = 'example';
        continue;
      }
      const src = op.paramSources?.find((s) => s.param === p.name);
      if (src) {
        const data = await fetchSource(src.from);
        const value = pickValue(data, src.field, src.list);
        if (value !== undefined) {
          args[p.name] = coerce(value, p.schema);
          valueSources[p.name] = `${src.from}.${src.field}`;
          continue;
        }
      }
      missing = p.name;
      break;
    }
    if (missing) {
      results.push({
        operation: op.name,
        status: 'no_parameter_value',
        detail: `no example for required "${missing}" and no endpoint found that returns it; add an example to the spec`,
      });
      continue;
    }
    const t0 = performance.now();
    try {
      const out = await client.call(op, args);
      const ms = Math.round(performance.now() - t0);
      if (!out.ok) {
        const status: VerifyStatus =
          out.errorCode === 'auth' || out.errorCode === 'forbidden'
            ? 'auth_failed'
            : (out.status === 400 || out.status === 404 || out.status === 422) &&
                Object.keys(valueSources).length > 0
              ? 'wrong_parameter_value'
              : out.errorCode === 'network' ||
                  out.errorCode === 'timeout' ||
                  out.errorCode === 'policy'
                ? 'network_error'
                : 'http_error';
        results.push({ operation: op.name, status, detail: out.error, valueSources, ms });
        continue;
      }
      const errorShape = looksLikeError(out.data);
      if (errorShape) {
        results.push({
          operation: op.name,
          status: 'error_shaped_response',
          detail: `HTTP ${out.status} but ${errorShape}`,
          valueSources,
          ms,
        });
        continue;
      }
      if (op.outputSchema && cfg.validateOutput) {
        const data = out.data ?? null;
        const shaped =
          op.outputWrapped || !data || typeof data !== 'object' || Array.isArray(data)
            ? { result: data }
            : data;
        const v = validateAgainst(op.outputSchema, shaped);
        if (!v.valid) {
          results.push({
            operation: op.name,
            status: 'schema_mismatch',
            detail: `response does not match the documented schema (${v.message})`,
            valueSources,
            ms,
          });
          continue;
        }
      }
      results.push({
        operation: op.name,
        status: 'verified',
        detail: `HTTP ${out.status}`,
        valueSources,
        ms,
      });
    } catch (err) {
      results.push({
        operation: op.name,
        status: 'network_error',
        detail: errorMessage(err),
        valueSources,
      });
    }
  }
  return { results, verified: results.filter((r) => r.status === 'verified').length, probed };
}

function pickValue(
  data: JsonValue | undefined,
  field: string,
  list: boolean,
): JsonValue | undefined {
  if (data === undefined) return undefined;
  const v = resolvePath(data, list ? `[*].${field}` : field);
  if (Array.isArray(v)) return v.find((x) => x !== null && x !== undefined);
  return v ?? undefined;
}

function coerce(value: JsonValue, schema: Record<string, unknown>): JsonValue {
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === 'string' && typeof value !== 'string') return String(value);
  if (
    (t === 'integer' || t === 'number') &&
    typeof value === 'string' &&
    value.trim() !== '' &&
    !Number.isNaN(Number(value))
  )
    return Number(value);
  return value;
}

export function describeParamSources(op: OperationDef, integration: string): string {
  if (!op.paramSources?.length) return '';
  return op.paramSources
    .map(
      (s) =>
        `get "${s.param}" from ${integration}__${s.from} (${s.list ? "each item's " : ''}${s.field})`,
    )
    .join('; ');
}
