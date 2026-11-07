import { ToolsmithError } from '../core/errors.js';
import type { JsonSchema } from '../core/types.js';

/**
 * Postman Collection (v2.0 / v2.1) to OpenAPI 3.0, so collections go through
 * the same import, verification and approval as specs. Request bodies and
 * response shapes are inferred from the collection's raw JSON bodies and
 * saved example responses; nothing is invented when a collection has none.
 */

type Doc = Record<string, unknown>;

export function isPostmanCollection(doc: unknown): boolean {
  const info = (doc as Doc | undefined)?.info as Doc | undefined;
  return Boolean(
    info &&
    (typeof info._postman_id === 'string' ||
      /schema\.getpostman\.com/.test(String(info.schema ?? ''))) &&
    Array.isArray((doc as Doc).item),
  );
}

/** Infer a JSON Schema from an example value (shallow types, depth-limited). */
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (depth > 6) return {};
  if (value === null) return {};
  if (Array.isArray(value))
    return { type: 'array', items: value.length ? inferSchema(value[0], depth + 1) : {} };
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Doc)) properties[k] = inferSchema(v, depth + 1);
      return { type: 'object', properties };
    }
    default:
      return {};
  }
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return JSON.parse(text.replace(/\{\{[^}]+\}\}/g, '0'));
  } catch {
    return undefined;
  }
}

interface FlatRequest {
  name: string;
  description: string;
  method: string;
  url: Doc | string;
  body?: Doc;
  responses: Doc[];
}

function flatten(items: unknown[], prefix: string[] = [], out: FlatRequest[] = []): FlatRequest[] {
  for (const it of items as Doc[]) {
    if (Array.isArray(it.item)) {
      flatten(it.item as unknown[], [...prefix, String(it.name ?? '')], out);
      continue;
    }
    const req = it.request as Doc | string | undefined;
    if (!req) continue;
    const r: Doc = typeof req === 'string' ? { method: 'GET', url: req } : req;
    out.push({
      name: String(it.name ?? ''),
      description: [
        prefix.filter(Boolean).join(' / '),
        typeof r.description === 'string'
          ? r.description
          : String((r.description as Doc | undefined)?.content ?? ''),
      ]
        .filter(Boolean)
        .join(': '),
      method: String(r.method ?? 'GET').toLowerCase(),
      url: (r.url as Doc | string) ?? '',
      body: r.body as Doc | undefined,
      responses: Array.isArray(it.response) ? (it.response as Doc[]) : [],
    });
  }
  return out;
}

/**
 * Normalise a Postman URL into { origin, path segments, query keys }.
 * Variables are resolved only in the origin. In the path they stay as
 * `{{name}}` and become parameters: substituting them would bake values
 * (ids, tokens) into the tool definition the agent reads.
 */
function splitUrl(
  url: Doc | string,
  vars: Record<string, string>,
): { origin?: string; segments: string[]; query: string[] } {
  const subHost = (s: string) =>
    s.replace(/\{\{([^}]+)\}\}/g, (m, k: string) => vars[k.trim()] ?? m);
  if (typeof url === 'string' || typeof url.raw === 'string') {
    let raw = typeof url === 'string' ? url : String(url.raw);
    let origin: string | undefined;
    const lead = raw.match(/^\{\{([^}]+)\}\}/);
    if (lead) {
      const value = vars[lead[1]!.trim()];
      raw = raw.slice(lead[0].length);
      if (value && /^https?:\/\//.test(value)) origin = value.replace(/\/+$/, '');
      // An unresolved {{baseUrl}} is the origin, not a path parameter: --base-url supplies it.
    } else {
      const m = raw.match(/^(https?:\/\/[^/?#]+)/);
      if (m) {
        origin = subHost(m[1]!);
        raw = raw.slice(m[1]!.length);
      }
    }
    const m = raw.match(/^([^?#]*)(\?[^#]*)?/);
    const segments = (m?.[1] ?? '').split('/').filter(Boolean);
    const query = (m?.[2] ?? '')
      .slice(1)
      .split('&')
      .map((q) => q.split('=')[0]!)
      .filter(Boolean);
    if (typeof url !== 'string' && Array.isArray(url.query))
      query.push(...(url.query as Doc[]).map((q) => String(q.key)));
    return { origin, segments, query: [...new Set(query)] };
  }
  const host = Array.isArray(url.host) ? (url.host as string[]).join('.') : String(url.host ?? '');
  const protocol = String(url.protocol ?? 'https');
  const segments = (
    Array.isArray(url.path) ? (url.path as string[]) : String(url.path ?? '').split('/')
  ).filter(Boolean);
  const query = Array.isArray(url.query) ? (url.query as Doc[]).map((q) => String(q.key)) : [];
  const h = subHost(host);
  const origin =
    h && !h.includes('{{') ? (/^https?:\/\//.test(h) ? h : `${protocol}://${h}`) : undefined;
  return { origin, segments, query };
}

export function postmanToOpenApi(collection: Doc, baseUrlOverride?: string): Doc {
  const info = (collection.info ?? {}) as Doc;
  const vars: Record<string, string> = {};
  for (const v of (collection.variable as Doc[] | undefined) ?? [])
    if (v.key) vars[String(v.key)] = String(v.value ?? '');
  const requests = flatten(collection.item as unknown[]);
  if (requests.length === 0)
    throw new ToolsmithError('The Postman collection contains no requests', 'validation');

  const origins = new Set<string>();
  const paths: Record<string, Record<string, Doc>> = {};
  for (const r of requests) {
    const { origin, segments, query } = splitUrl(r.url, vars);
    if (origin && !origin.includes('{{')) origins.add(origin.replace(/\/+$/, ''));
    const params: Doc[] = [];
    const pathSegs = segments.map((seg) => {
      const m = seg.match(/^:([A-Za-z_][A-Za-z0-9_]*)$/);
      if (m) {
        params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
        return `{${m[1]}}`;
      }
      // {{var}} anywhere in a segment (/bot{{token}}/getMe) becomes a path
      // parameter; its value is never written into the tool definition.
      return seg.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
        if (!params.some((p) => p.name === name))
          params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
        return `{${name}}`;
      });
    });
    for (const q of query)
      params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
    const path = `/${pathSegs.join('/')}`;
    const op: Doc = {
      summary: r.name || `${r.method.toUpperCase()} ${path}`,
      ...(r.description ? { description: r.description } : {}),
      operationId: r.name ? r.name.replace(/[^A-Za-z0-9]+/g, ' ').trim() : undefined,
      parameters: params,
      responses: { '200': { description: 'OK' } },
    };
    if (['post', 'put', 'patch'].includes(r.method)) {
      const example = r.body?.mode === 'raw' ? parseJson(r.body.raw) : undefined;
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema:
              example !== undefined
                ? inferSchema(example)
                : { type: 'object', additionalProperties: true },
          },
        },
      };
    }
    const okExample = r.responses.find((x) => Number(x.code ?? 200) < 300);
    const parsed = okExample ? parseJson(okExample.body) : undefined;
    if (parsed !== undefined) {
      op.responses = {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: inferSchema(parsed) } },
        },
      };
    }
    (paths[path] ??= {})[r.method] = op;
  }

  const base = baseUrlOverride ?? (origins.size === 1 ? [...origins][0] : undefined);
  return {
    openapi: '3.0.3',
    info: {
      title: String(info.name ?? 'Postman collection'),
      version: '1.0.0',
      description: typeof info.description === 'string' ? info.description : '',
    },
    ...(base ? { servers: [{ url: base }] } : {}),
    paths,
  };
}
