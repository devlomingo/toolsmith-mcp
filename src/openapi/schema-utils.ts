import type { JsonSchema } from '../core/types.js';

const DROP_KEYS = new Set([
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
  'x-examples',
]);

/**
 * Convert an OpenAPI 3.0 / Swagger schema object into plain JSON Schema that
 * MCP clients and Ajv understand: `nullable` becomes a null type, OpenAPI-only
 * keywords are dropped, and depth is capped so recursive models stay finite.
 */
export function toJsonSchema(schema: unknown, depth = 0, seen = new WeakSet<object>()): JsonSchema {
  if (!schema || typeof schema !== 'object') return {};
  if (depth > 8 || seen.has(schema as object)) return {};
  seen.add(schema as object);
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEYS.has(k) || k.startsWith('x-') || k === 'nullable' || k === '$ref') continue;
    if (k === 'readOnly' || k === 'writeOnly') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = toJsonSchema(pv, depth + 1, seen);
      }
      out.properties = props;
    } else if ((k === 'items' || k === 'additionalProperties' || k === 'not') && v && typeof v === 'object') {
      out[k] = toJsonSchema(v, depth + 1, seen);
    } else if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf') && Array.isArray(v)) {
      out[k] = v.map((s) => toJsonSchema(s, depth + 1, seen));
    } else if (k === 'format' && typeof v === 'string' && !KNOWN_FORMATS.has(v)) {
      continue; // unknown formats (int32, binary, …) would fail strict validators
    } else {
      out[k] = v;
    }
  }
  if (src.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.enum)) out.enum = [...(out.enum as unknown[]), null];
  }
  seen.delete(schema as object);
  return out;
}

const KNOWN_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'email',
  'uri',
  'uuid',
  'hostname',
  'ipv4',
  'ipv6',
]);

/** MCP requires object-typed input/output schemas. Wrap anything else. */
export function wrapAsObjectSchema(schema: JsonSchema | undefined): {
  schema: JsonSchema | undefined;
  wrapped: boolean;
} {
  if (!schema || Object.keys(schema).length === 0) return { schema: undefined, wrapped: false };
  if (schema.type === 'object') return { schema, wrapped: false };
  return {
    schema: { type: 'object', properties: { result: schema }, required: ['result'] },
    wrapped: true,
  };
}
