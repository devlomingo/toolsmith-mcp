import SwaggerParser from '@apidevtools/swagger-parser';
import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ToolsmithError } from '../core/errors.js';
import { isPrivateAddress } from '../security/ssrf.js';
import { isPostmanCollection, postmanToOpenApi } from './postman.js';
import { camelCase } from '../core/naming.js';
import type { AccessLevel, JsonSchema, JsonValue } from '../core/types.js';
import { cleanText, toJsonSchema, wrapAsObjectSchema } from './schema-utils.js';
import type {
  OpenApiIntegrationDef,
  OperationDef,
  OperationParam,
  ParamLocation,
  SpecFinding,
} from './types.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
const MAX_SPEC_BYTES = 10 * 1024 * 1024;

type Doc = Record<string, unknown>;

export interface ImportOptions {
  name: string;
  /** Overrides servers[0].url. */
  baseUrl?: string;
  include?: string[];
  exclude?: string[];
  /** Allow downloading the spec from private / loopback addresses. */
  allowPrivateNetwork?: boolean;
}

/** Load a spec from a path, an http(s) URL, or an already-parsed object. */
/**
 * Download a spec with the same egress rules as tool calls: no private,
 * loopback or metadata addresses unless allowed, and every redirect hop
 * re-checked. (Resolve-then-fetch leaves a DNS-rebinding window that the
 * tool executor's connect-time check does not; spec URLs come from the
 * operator, not the agent.)
 */
export async function fetchSpec(url: string, allowPrivateNetwork: boolean): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new ToolsmithError(`Refusing to fetch the spec over ${current.protocol}`, 'policy');
    }
    if (!allowPrivateNetwork) {
      const host = current.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host)
        ? [host]
        : (
            await lookup(host, { all: true }).catch(() => {
              // Fail closed: an address we could not check is not fetched.
              throw new ToolsmithError(
                `Could not resolve ${host} to check where the spec download would go`,
                'network',
                'Check the hostname, or download the spec and pass the local file path.',
              );
            })
          ).map((a) => a.address);
      const bad = addresses.find((a) => isPrivateAddress(a));
      if (bad) {
        throw new ToolsmithError(
          `Refusing to download the spec from ${current.host}: it resolves to private address ${bad}`,
          'policy',
          'If the spec really is on your local network, pass --allow-private-network (or set "allowPrivateNetwork": true).',
        );
      }
    }
    let res: Response;
    try {
      res = await fetch(current, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    } catch (err) {
      throw new ToolsmithError(
        `Could not reach ${current.host} to download the API spec (${(err as Error).cause ? String((err as { cause: { code?: string } }).cause.code ?? (err as Error).message) : (err as Error).message})`,
        'network',
        'Check the URL and your connection, or download the spec and pass the local file path instead.',
      );
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      continue;
    }
    return res;
  }
  throw new ToolsmithError('Too many redirects while downloading the spec', 'network');
}

export async function loadSpecDocument(
  source: string | Doc,
  opts: { allowPrivateNetwork?: boolean } = {},
): Promise<Doc> {
  if (typeof source !== 'string') return structuredClone(source);
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchSpec(source, opts.allowPrivateNetwork ?? false);
    if (!res.ok) {
      throw new ToolsmithError(
        `Could not download the API spec (${res.status} ${res.statusText}) from ${source}`,
        'network',
        'Check the URL, or download the spec and pass the local file path instead.',
      );
    }
    text = await res.text();
  } else {
    try {
      text = await readFile(source, 'utf8');
    } catch {
      throw new ToolsmithError(
        `Could not read the API spec file: ${source}`,
        'validation',
        'Check the path. Relative paths resolve against the config file directory.',
      );
    }
  }
  if (text.length > MAX_SPEC_BYTES)
    throw new ToolsmithError('API spec is larger than 10 MB', 'validation');
  try {
    const parsed = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Doc;
  } catch (err) {
    throw new ToolsmithError(
      `The API spec is not valid JSON or YAML: ${(err as Error).message}`,
      'validation',
    );
  }
}

/**
 * Turn an OpenAPI 3.x or Swagger 2.0 document into an integration definition.
 * Problems that make the API unusable throw; gaps in documentation become
 * findings so a human can decide. Nothing is invented: an operation without
 * a server URL, or a spec without paths, is an error asking for more input.
 */
export async function importOpenApi(
  source: string | Doc,
  opts: ImportOptions,
): Promise<OpenApiIntegrationDef> {
  let raw = await loadSpecDocument(source, { allowPrivateNetwork: opts.allowPrivateNetwork });
  const fromPostman = isPostmanCollection(raw);
  if (fromPostman) raw = postmanToOpenApi(raw, opts.baseUrl);
  const findings: SpecFinding[] = [];
  if (fromPostman) {
    findings.push({
      severity: 'info',
      code: 'from_postman',
      message:
        'Imported from a Postman collection: parameter types are strings and body/response schemas are inferred from saved examples. Review them.',
    });
  }
  const specVersion = String(raw.openapi ?? raw.swagger ?? '');
  if (!specVersion) {
    throw new ToolsmithError(
      'This document is not an OpenAPI or Swagger specification (no "openapi" or "swagger" field).',
      'validation',
      'Provide an OpenAPI 3.x / Swagger 2.0 document, or list the endpoints in a .endpoints file (one `METHOD /path  description` per line) and import that.',
    );
  }

  try {
    await SwaggerParser.validate(structuredClone(raw) as never, {
      resolve: { external: false },
      validate: { schema: true, spec: true },
    });
  } catch (err) {
    findings.push({
      severity: 'warning',
      code: 'spec_invalid',
      message: `Spec does not fully validate: ${(err as Error).message.split('\n')[0]}`,
    });
  }

  let doc: Doc;
  try {
    doc = (await SwaggerParser.dereference(structuredClone(raw) as never, {
      resolve: { external: false },
      dereference: { circular: 'ignore' },
    })) as unknown as Doc;
  } catch (err) {
    throw new ToolsmithError(
      `Could not resolve the spec's $refs: ${(err as Error).message}`,
      'validation',
      'External $refs are not followed for security; bundle the spec into one file first.',
    );
  }

  const baseUrl = resolveBaseUrl(
    doc,
    opts.baseUrl,
    typeof source === 'string' ? source : undefined,
  );
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(paths).length === 0) {
    throw new ToolsmithError(
      'The spec defines no paths, so there is nothing to turn into tools.',
      'validation',
      'Toolsmith does not guess endpoints. Provide a spec that documents the operations you need.',
    );
  }

  const securityHeaderNames = collectSecurityParamNames(doc);
  const operations: OperationDef[] = [];
  const usedNames = new Set<string>();

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    const sharedParams = (item.parameters as unknown[]) ?? [];
    for (const method of METHODS) {
      const op = item[method] as Doc | undefined;
      if (!op) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!matchesFilters(op, path, opts)) continue;

      let name = op.operationId ? camelCase(String(op.operationId)) : synthesizeName(method, path);
      if (!op.operationId) {
        findings.push({
          severity: 'info',
          code: 'no_operation_id',
          message: `${label} has no operationId; named it "${name}"`,
          operation: name,
        });
      }
      if (usedNames.has(name)) {
        let i = 2;
        while (usedNames.has(`${name}${i}`)) i++;
        name = `${name}${i}`;
      }
      usedNames.add(name);

      const params = mergeParams(sharedParams, (op.parameters as unknown[]) ?? []).filter(
        (p) => !(p.in === 'header' && securityHeaderNames.has(p.name.toLowerCase())),
      );
      const body = extractBody(op, findings, name);
      const { schema: outSchema, wrapped } = wrapAsObjectSchema(extractResponseSchema(op));
      if (!outSchema) {
        findings.push({
          severity: 'info',
          code: 'no_response_schema',
          message: `${label} documents no JSON response schema; output will not be validated`,
          operation: name,
        });
      }
      const summary = cleanText(String(op.summary ?? '')).trim();
      const description = cleanText(String(op.description ?? '')).trim();
      if (!summary && !description) {
        findings.push({
          severity: 'warning',
          code: 'no_description',
          message: `${label} has no summary or description; agents will only see the method and path`,
          operation: name,
        });
      }
      for (const text of [summary, description]) {
        const hit = detectInjection(text);
        if (hit) {
          findings.push({
            severity: 'error',
            code: 'suspicious_description',
            message: `${label} description contains instruction-like text ("${hit}"). Review before approving: tool descriptions are shown to the agent verbatim.`,
            operation: name,
          });
        }
      }

      operations.push({
        name,
        operationId: op.operationId ? String(op.operationId) : undefined,
        method: method.toUpperCase(),
        path,
        summary,
        description,
        params,
        body,
        inputSchema: buildInputSchema(params, body),
        outputSchema: outSchema,
        outputWrapped: wrapped,
        access: accessFor(method),
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
      });
    }
  }

  if (operations.length === 0) {
    throw new ToolsmithError(
      'No operations left after applying include/exclude filters.',
      'validation',
    );
  }

  linkParamSources(operations);

  const info = (doc.info ?? {}) as Doc;
  return {
    kind: 'openapi',
    name: opts.name,
    title: cleanText(String(info.title ?? opts.name)).slice(0, 200),
    description: cleanText(String(info.description ?? '')).slice(0, 2000),
    specSource: typeof source === 'string' ? source : '(inline)',
    specVersion,
    baseUrl,
    operations,
    findings,
  };
}

function resolveBaseUrl(doc: Doc, override: string | undefined, source?: string): string {
  if (override) return override.replace(/\/+$/, '');
  let candidate: string | undefined;
  if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    const server = doc.servers[0] as {
      url?: string;
      variables?: Record<string, { default?: string }>;
    };
    candidate = server.url?.replace(
      /\{([^}]+)\}/g,
      (_m, v: string) => server.variables?.[v]?.default ?? `{${v}}`,
    );
  } else if (typeof doc.host === 'string') {
    const scheme =
      Array.isArray(doc.schemes) && doc.schemes.includes('https')
        ? 'https'
        : ((doc.schemes as string[] | undefined)?.[0] ?? 'https');
    candidate = `${scheme}://${doc.host}${String(doc.basePath ?? '')}`;
  }
  if (candidate && candidate.startsWith('/') && source && /^https?:\/\//.test(source)) {
    candidate = new URL(candidate, source).toString();
  }
  if (!candidate || !/^https?:\/\//.test(candidate) || candidate.includes('{')) {
    throw new ToolsmithError(
      'The spec does not say where the API is hosted (no absolute server URL).',
      'validation',
      'Pass the API base URL explicitly: --base-url https://api.example.com (or "baseUrl" in the config).',
    );
  }
  return candidate.replace(/\/+$/, '');
}

function matchesFilters(op: Doc, path: string, opts: ImportOptions): boolean {
  const keys = [String(op.operationId ?? ''), path];
  const hit = (pattern: string): boolean => {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return keys.some((k) => re.test(k));
  };
  if (opts.include?.length && !opts.include.some(hit)) return false;
  if (opts.exclude?.length && opts.exclude.some(hit)) return false;
  return true;
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** GET /users/{id}/orders -> getUserOrders, POST /products -> createProduct. */
export function synthesizeName(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const endsWithParam = segments.length > 0 && /^\{.+\}$/.test(segments[segments.length - 1]!);
  const words: string[] = [];
  segments.forEach((seg, i) => {
    if (/^\{.+\}$/.test(seg)) return;
    const nextIsParam = i + 1 < segments.length && /^\{.+\}$/.test(segments[i + 1]!);
    words.push(nextIsParam ? singular(seg) : seg);
  });
  const verb =
    method === 'get'
      ? 'get'
      : method === 'post'
        ? endsWithParam
          ? 'post'
          : 'create'
        : method === 'put' || method === 'patch'
          ? 'update'
          : method === 'delete'
            ? 'delete'
            : method;
  if (verb === 'create' && words.length > 0)
    words[words.length - 1] = singular(words[words.length - 1]!);
  return camelCase([verb, ...words].join(' ')) || `${method}Root`;
}

const fieldsOf = (schema: JsonSchema | undefined): { fields: Set<string>; list: boolean } => {
  const fields = new Set<string>();
  let node = schema;
  let list = false;
  if (
    node?.properties &&
    (node.properties as Record<string, JsonSchema>).result &&
    Object.keys(node.properties as object).length === 1
  ) {
    node = (node.properties as Record<string, JsonSchema>).result;
  }
  if (node?.type === 'array') {
    list = true;
    node = node.items as JsonSchema | undefined;
  }
  for (const k of Object.keys((node?.properties as object) ?? {})) fields.add(k);
  return { fields, list };
};

/**
 * Link each required parameter of a read operation to a parameter-free read
 * operation whose response carries the value: same field name, or "id" of
 * the matching resource (orderId <- /orders → [*].id). Purely schema-based;
 * live verification later confirms or refutes each link.
 */
export function linkParamSources(operations: OperationDef[]): void {
  const roots = operations.filter((o) => o.method === 'GET' && !o.params.some((p) => p.required));
  for (const op of operations) {
    const sources: NonNullable<OperationDef['paramSources']> = [];
    for (const p of op.params.filter((x) => x.required && (x.in === 'path' || x.in === 'query'))) {
      const name = p.name.toLowerCase();
      for (const root of roots) {
        if (root === op) continue;
        const { fields, list } = fieldsOf(root.outputSchema);
        const resource = singular(
          root.path
            .split('/')
            .filter((x) => x && !x.startsWith('{'))
            .pop() ?? '',
        ).toLowerCase();
        let field: string | undefined;
        if (fields.has(p.name)) field = p.name;
        else if (
          fields.has('id') &&
          (name === `${resource}id` ||
            name === `${resource}_id` ||
            (name === 'id' && op.path.toLowerCase().includes(`/${resource}`)))
        )
          field = 'id';
        if (field) {
          sources.push({ param: p.name, from: root.name, field, list });
          break;
        }
      }
    }
    if (sources.length) op.paramSources = sources;
  }
}

function accessFor(method: string): AccessLevel {
  if (method === 'delete') return 'destructive';
  if (method === 'get' || method === 'head' || method === 'options') return 'read';
  return 'write';
}

function mergeParams(shared: unknown[], own: unknown[]): OperationParam[] {
  const byKey = new Map<string, OperationParam>();
  for (const p of [...shared, ...own]) {
    if (!p || typeof p !== 'object') continue;
    const param = p as Doc;
    const loc = String(param.in) as ParamLocation | 'body' | 'formData';
    if (loc === 'body' || loc === 'formData') continue; // Swagger 2 body handled separately
    if (!['path', 'query', 'header', 'cookie'].includes(loc)) continue;
    const schema = toJsonSchema(param.schema ?? pickSwagger2Schema(param));
    byKey.set(`${loc}:${String(param.name)}`, {
      name: String(param.name),
      in: loc,
      required: loc === 'path' ? true : Boolean(param.required),
      schema: Object.keys(schema).length > 0 ? schema : { type: 'string' },
      description: param.description ? cleanText(String(param.description)) : undefined,
      example: pickExample(param),
    });
  }
  return [...byKey.values()];
}

function pickExample(param: Doc): JsonValue | undefined {
  const schema = (param.schema ?? {}) as Doc;
  if (param.example !== undefined) return param.example as JsonValue;
  if (param.examples && typeof param.examples === 'object') {
    const first = Object.values(param.examples as Record<string, Doc>)[0];
    if (first && typeof first === 'object' && 'value' in first) return first.value as JsonValue;
  }
  if (schema.example !== undefined) return schema.example as JsonValue;
  if (param['x-example'] !== undefined) return param['x-example'] as JsonValue;
  if (schema.default !== undefined) return schema.default as JsonValue;
  if (param.default !== undefined) return param.default as JsonValue;
  const en = (schema.enum ?? param.enum) as JsonValue[] | undefined;
  return Array.isArray(en) && en.length ? en[0] : undefined;
}

function pickSwagger2Schema(param: Doc): Doc {
  const out: Doc = {};
  for (const k of ['type', 'format', 'enum', 'items', 'minimum', 'maximum', 'default', 'pattern']) {
    if (param[k] !== undefined) out[k] = param[k];
  }
  return out;
}

function extractBody(op: Doc, findings: SpecFinding[], name: string): OperationDef['body'] {
  const rb = op.requestBody as Doc | undefined;
  if (rb && typeof rb === 'object') {
    const content = (rb.content ?? {}) as Record<string, Doc>;
    const type = Object.keys(content).find((t) => /json/i.test(t));
    if (!type) {
      if (Object.keys(content).length > 0) {
        findings.push({
          severity: 'warning',
          code: 'unsupported_body',
          message: `${name}: request body types ${Object.keys(content).join(', ')} are not supported (JSON only)`,
          operation: name,
        });
      }
      return undefined;
    }
    return {
      required: Boolean(rb.required),
      contentType: type,
      schema: toJsonSchema(content[type]?.schema),
    };
  }
  const bodyParam = ((op.parameters as Doc[]) ?? []).find((p) => p?.in === 'body');
  if (bodyParam) {
    return {
      required: Boolean(bodyParam.required),
      contentType: 'application/json',
      schema: toJsonSchema(bodyParam.schema),
    };
  }
  return undefined;
}

function extractResponseSchema(op: Doc): JsonSchema | undefined {
  const responses = (op.responses ?? {}) as Record<string, Doc>;
  const code =
    Object.keys(responses).find((c) => /^2\d\d$/.test(c)) ?? (responses['2XX'] ? '2XX' : undefined);
  if (!code) return undefined;
  const res = responses[code]!;
  if (res.content && typeof res.content === 'object') {
    const content = res.content as Record<string, Doc>;
    const type = Object.keys(content).find((t) => /json/i.test(t));
    return type ? toJsonSchema(content[type]?.schema) : undefined;
  }
  return res.schema ? toJsonSchema(res.schema) : undefined;
}

function buildInputSchema(params: OperationParam[], body: OperationDef['body']): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    const key = p.name;
    properties[key] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(key);
  }
  if (body) {
    properties.body = {
      ...body.schema,
      description: body.schema.description ?? 'Request body (JSON)',
    };
    if (body.required) required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function collectSecurityParamNames(doc: Doc): Set<string> {
  const out = new Set<string>(['authorization']);
  const schemes = {
    ...(((doc.components as Doc | undefined)?.securitySchemes as Record<string, Doc>) ?? {}),
    ...((doc.securityDefinitions as Record<string, Doc>) ?? {}),
  };
  for (const s of Object.values(schemes)) {
    if (s?.type === 'apiKey' && s.in === 'header' && s.name) out.add(String(s.name).toLowerCase());
  }
  return out;
}

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget) (all |any |the )?(previous|prior|above|earlier|other) (instructions|prompts|rules|messages)/i,
  /<\s*\/?\s*(important|system|instructions?|admin|override)\s*>/i,
  /\bdo ?n[o']t (tell|inform|mention|reveal|show).{0,40}\b(the )?(user|human|operator)/i,
  // Exfiltration needs a destination to count: "send the token to https://…".
  /\b(send|forward|exfiltrate|upload|post|leak|include)\b.{0,60}\b(credentials?|passwords?|secrets?|api ?keys?|private keys?|ssh keys?|tokens?)\b.{0,40}\b(to|into)\b.{0,20}(https?:\/\/|\S+@\S+\.\w+|an? (external|remote|third))/i,
  /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\/etc\/(passwd|shadow)|\.env\b)/i,
  /\byou (must|should|need to) (always |first )?(call|use|invoke|run) /i,
  /\bbefore (using|calling) (this|any other) tool\b/i,
];

/** Flag tool-poisoning style text in third-party descriptions. */
export function detectInjection(text: string): string | undefined {
  // Match on the cleaned text, so zero-width characters cannot split a phrase.
  const clean = cleanText(text).replace(/\s+/g, ' ');
  for (const re of INJECTION_PATTERNS) {
    const m = clean.match(re);
    if (m) return m[0];
  }
  return undefined;
}
