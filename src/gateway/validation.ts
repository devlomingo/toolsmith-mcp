import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { JsonSchema } from '../core/types.js';

// ajv and ajv-formats are CommonJS; under NodeNext the default import is the
// module object, so unwrap `.default` when present.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as typeof addFormatsModule.default;

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true, coerceTypes: false });
addFormats(ajv);

const cache = new WeakMap<object, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    try {
      fn = ajv.compile(schema);
    } catch {
      // A schema Ajv cannot compile (bad third-party spec) should not make the
      // tool unusable; fall back to accepting any object and let the API judge.
      fn = ajv.compile({ type: 'object' });
    }
    cache.set(schema, fn);
  }
  return fn;
}

export function validateAgainst(schema: JsonSchema, value: unknown): { valid: true } | { valid: false; message: string } {
  const fn = compile(schema);
  if (fn(value)) return { valid: true };
  const message = (fn.errors ?? [])
    .slice(0, 5)
    .map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'arguments';
      if (e.keyword === 'required') return `missing required "${String(e.params.missingProperty)}"`;
      if (e.keyword === 'additionalProperties') return `unknown argument "${String(e.params.additionalProperty)}"`;
      return `${where} ${e.message ?? 'is invalid'}`;
    })
    .join('; ');
  return { valid: false, message };
}
