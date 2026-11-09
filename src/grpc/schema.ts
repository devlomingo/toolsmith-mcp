import protobuf from 'protobufjs';
import type { JsonSchema } from '../core/types.js';
import { cleanText } from '../openapi/schema-utils.js';

/**
 * Protobuf message types → JSON Schema for the ProtoJSON mapping (the JSON
 * form gRPC transcoding and every official runtime use): field names in
 * lowerCamelCase, 64-bit integers as decimal strings (numbers accepted on
 * input), enums by name, bytes as base64, well-known types in their JSON
 * forms. ProtoJSON omits default values, so output fields are never required.
 */

const INT32 = new Set(['int32', 'uint32', 'sint32', 'fixed32', 'sfixed32']);
const INT64 = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const MAX_DEPTH = 8;

const WELL_KNOWN: Record<string, JsonSchema> = {
  '.google.protobuf.Timestamp': { type: 'string', format: 'date-time' },
  '.google.protobuf.Duration': {
    type: 'string',
    pattern: '^-?[0-9]+(\\.[0-9]{1,9})?s$',
    description: 'Duration, e.g. "1.5s"',
  },
  '.google.protobuf.FieldMask': { type: 'string', description: 'Comma-separated field paths' },
  '.google.protobuf.Struct': { type: 'object' },
  '.google.protobuf.Value': {},
  '.google.protobuf.ListValue': { type: 'array' },
  '.google.protobuf.Empty': { type: 'object' },
  '.google.protobuf.Any': {
    type: 'object',
    properties: { '@type': { type: 'string' } },
    required: ['@type'],
  },
  '.google.protobuf.DoubleValue': { type: ['number', 'null'] },
  '.google.protobuf.FloatValue': { type: ['number', 'null'] },
  '.google.protobuf.Int64Value': { type: ['string', 'integer', 'null'] },
  '.google.protobuf.UInt64Value': { type: ['string', 'integer', 'null'] },
  '.google.protobuf.Int32Value': { type: ['integer', 'null'] },
  '.google.protobuf.UInt32Value': { type: ['integer', 'null'] },
  '.google.protobuf.BoolValue': { type: ['boolean', 'null'] },
  '.google.protobuf.StringValue': { type: ['string', 'null'] },
  '.google.protobuf.BytesValue': { type: ['string', 'null'], contentEncoding: 'base64' },
};

function scalar(type: string): JsonSchema | undefined {
  if (type === 'double' || type === 'float') return { type: 'number' };
  if (INT32.has(type)) return { type: 'integer' };
  if (INT64.has(type))
    return { type: ['string', 'integer'], pattern: '^-?[0-9]+$', description: '64-bit integer' };
  if (type === 'bool') return { type: 'boolean' };
  if (type === 'string') return { type: 'string' };
  if (type === 'bytes') return { type: 'string', contentEncoding: 'base64' };
  return undefined;
}

function described(schema: JsonSchema, comment: string | null | undefined): JsonSchema {
  const text = comment ? cleanText(comment).trim() : '';
  return text ? { ...schema, description: text.slice(0, 1000) } : schema;
}

function valueSchema(field: protobuf.Field, depth: number, seen: Set<string>): JsonSchema {
  const s = scalar(field.type);
  if (s) return s;
  const resolved = field.resolve().resolvedType;
  if (resolved instanceof protobuf.Enum)
    return { type: 'string', enum: Object.keys(resolved.values) };
  if (resolved instanceof protobuf.Type) return messageSchema(resolved, depth + 1, seen);
  return {};
}

export function messageSchema(
  type: protobuf.Type,
  depth = 0,
  seen = new Set<string>(),
): JsonSchema {
  const wk = WELL_KNOWN[type.fullName];
  if (wk) return wk;
  // Recursive messages (a tree node holding nodes) stop at the first repeat.
  if (depth > MAX_DEPTH || seen.has(type.fullName)) return { type: 'object' };
  seen.add(type.fullName);
  const properties: Record<string, JsonSchema> = {};
  for (const field of type.fieldsArray) {
    let schema: JsonSchema;
    if (field instanceof protobuf.MapField) {
      schema = { type: 'object', additionalProperties: valueSchema(field, depth, seen) };
    } else if (field.repeated) {
      schema = { type: 'array', items: valueSchema(field, depth, seen) };
    } else {
      schema = valueSchema(field, depth, seen);
    }
    properties[field.name] = described(schema, field.comment);
  }
  seen.delete(type.fullName);
  const oneofs = type.oneofsArray.filter((o) => !o.name.startsWith('_'));
  const note = oneofs.length
    ? ` Set at most one of: ${oneofs.map((o) => o.oneof.join(' / ')).join('; ')}.`
    : '';
  return described(
    { type: 'object', properties, additionalProperties: false },
    `${type.comment ?? ''}${note}`.trim(),
  );
}
