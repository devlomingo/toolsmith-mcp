import type { JsonSchema } from '../core/types.js';

/**
 * The only JSON Schema keywords passed on to agents. Everything else
 * (`$comment`, vendor extensions, made-up keys) is dropped: any string a
 * third-party spec can place in a schema is a place to hide instructions,
 * so the agent only gets keywords that mean something to a validator.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'enum',
  'const',
  'format',
  'description',
  'title',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'patternProperties',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

/**
 * Remove characters that change how text is displayed without being
 * visible: zero-width characters, bidi overrides, other control characters.
 * They can split a phrase so filters miss it, or reorder what a human sees.
 *
 * Visible characters are never rewritten: no Unicode normalization here, so
 * `m²`, ligatures and enum values reach the agent exactly as the API spells
 * them. ZWNJ and ZWJ are kept because Persian, Indic scripts and emoji need
 * them, as do emoji (U+FE0E/U+FE0F); the scanner (scanText) removes them
 * too. Bidi marks (RLM, ALM) are still removed.
 */
// Needed by Persian and Indic text (ZWNJ, ZWJ) and emoji sequences
// (text/emoji presentation selectors). Prompts still show them as escapes.
const KEEP_VISIBLE = new Set(['\u200C', '\u200D', '\uFE0E', '\uFE0F']);

export function cleanText(text: string): string {
  return text.replace(/[\u2028\u2029]/g, '\n').replace(INVISIBLE, (ch, at: number, all: string) => {
    if (!KEEP_VISIBLE.has(ch)) return '';
    // A presentation selector only means something right after an emoji;
    // anywhere else it is just a hidden character.
    if (ch === '\uFE0E' || ch === '\uFE0F') {
      const prev = String.fromCodePoint(
        all.codePointAt(at - 1 - (at >= 2 && /[\uDC00-\uDFFF]/.test(all[at - 1]!) ? 1 : 0)) ?? 0,
      );
      return /\p{Emoji}/u.test(prev) ? ch : '';
    }
    return ch;
  });
}

/**
 * The form used only for scanning, never shown or sent anywhere: every
 * invisible character removed and compatibility forms folded (NFKC), so
 * full-width or ligature spellings cannot slip a phrase past the filters.
 */
export function scanText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(INVISIBLE, '');
}

/**
 * Characters that change or hide what is displayed. Removed by category
 * rather than by list: every format character (Cf: zero-width, bidi
 * controls, Unicode tags, U+061C, U+FFF9\u2026), every control character except
 * newline and tab, private-use and unassigned code points, plus the
 * invisible "filler" letters and joiners that sit in other categories
 * (Hangul and Khitan fillers, the musical null notehead, variation
 * selectors, the blank Braille pattern).
 */
export const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class, no-control-regex -- removing these is the point
  /[\p{Cf}\p{Co}\p{Cn}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{16FE4}\u{1D159}\u{E0100}-\u{E01EF}]/gu;

/** Clean every string and every key in a schema (any depth). */
export function sanitizeDeep<T>(value: T, depth = 0): T {
  if (depth > 64) return value;
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[cleanText(k)] = sanitizeDeep(v, depth + 1);
    return out as T;
  }
  return value;
}

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
    if (!ALLOWED_KEYWORDS.has(k)) continue;
    if ((k === 'description' || k === 'title') && typeof v === 'string') {
      out[k] = cleanText(v);
      continue;
    }
    if (k === 'readOnly' || k === 'writeOnly') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = toJsonSchema(pv, depth + 1, seen);
      }
      out.properties = props;
    } else if (
      (k === 'items' || k === 'additionalProperties' || k === 'not') &&
      v &&
      typeof v === 'object'
    ) {
      out[k] = toJsonSchema(v, depth + 1, seen);
    } else if (
      (k === 'patternProperties' || k === 'dependentSchemas') &&
      v &&
      typeof v === 'object'
    ) {
      const map: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>))
        map[pk] = toJsonSchema(pv, depth + 1, seen);
      out[k] = map;
    } else if (
      [
        'contains',
        'propertyNames',
        'if',
        'then',
        'else',
        'unevaluatedProperties',
        'unevaluatedItems',
      ].includes(k) &&
      v &&
      typeof v === 'object'
    ) {
      out[k] = toJsonSchema(v, depth + 1, seen);
    } else if (
      (k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') &&
      Array.isArray(v)
    ) {
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
