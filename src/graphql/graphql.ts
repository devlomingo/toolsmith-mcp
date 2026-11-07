import { ToolsmithError } from '../core/errors.js';
import { camelCase } from '../core/naming.js';
import type { AccessLevel, JsonSchema, JsonValue } from '../core/types.js';
import { detectInjection, sanitizeOperation } from '../openapi/import.js';
import { cleanText } from '../openapi/schema-utils.js';
import type { OpenApiIntegrationDef, OperationDef, SpecFinding } from '../openapi/types.js';

/**
 * GraphQL as a tool source. The schema comes from introspection (fetched
 * live through the integration's guarded client, or a saved introspection
 * JSON file). Every Query field becomes a read tool and every Mutation field
 * a write tool (destructive when its name says delete/remove/destroy). The
 * selection set is generated from the return type: scalars and enums, plus
 * one level of nested objects, so a tool returns useful data without the
 * agent writing GraphQL.
 */

export const INTROSPECTION_QUERY = `query ToolsmithIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) {
        name description
        args { name description defaultValue type { ...T } }
        type { ...T }
      }
      inputFields { name description defaultValue type { ...T } }
      enumValues(includeDeprecated: false) { name }
    }
  }
}
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  description?: string | null;
  args?: Array<{ name: string; description?: string | null; type: TypeRef }>;
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: Field[] | null;
  inputFields?: Array<{ name: string; description?: string | null; type: TypeRef }> | null;
  enumValues?: Array<{ name: string }> | null;
}

export interface Introspection {
  __schema: {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    types: FullType[];
  };
}

export function isIntrospection(doc: unknown): doc is { data: Introspection } | Introspection {
  const d = doc as { data?: Introspection; __schema?: unknown };
  return Boolean(d?.__schema || d?.data?.__schema);
}

const unwrap = (t: TypeRef): TypeRef =>
  t.ofType && (t.kind === 'NON_NULL' || t.kind === 'LIST') ? unwrap(t.ofType) : t;

function typeString(t: TypeRef): string {
  if (t.kind === 'NON_NULL') return `${typeString(t.ofType!)}!`;
  if (t.kind === 'LIST') return `[${typeString(t.ofType!)}]`;
  return t.name ?? 'String';
}

class SchemaIndex {
  readonly types = new Map<string, FullType>();
  constructor(readonly intro: Introspection) {
    for (const t of intro.__schema.types) this.types.set(t.name, t);
  }

  jsonSchema(t: TypeRef, depth = 0): JsonSchema {
    if (t.kind === 'NON_NULL') return this.jsonSchema(t.ofType!, depth);
    if (t.kind === 'LIST') return { type: 'array', items: this.jsonSchema(t.ofType!, depth + 1) };
    const name = t.name ?? '';
    switch (name) {
      case 'Int':
        return { type: 'integer' };
      case 'Float':
        return { type: 'number' };
      case 'Boolean':
        return { type: 'boolean' };
      case 'String':
      case 'ID':
        return { type: 'string' };
    }
    const full = this.types.get(name);
    if (full?.kind === 'ENUM')
      return { type: 'string', enum: (full.enumValues ?? []).map((e) => e.name) };
    if (full?.kind === 'INPUT_OBJECT' && depth < 4) {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const f of full.inputFields ?? []) {
        properties[f.name] = {
          ...this.jsonSchema(f.type, depth + 1),
          ...(f.description ? { description: cleanText(f.description) } : {}),
        };
        if (f.type.kind === 'NON_NULL') required.push(f.name);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    if ((full?.kind === 'OBJECT' || full?.kind === 'INTERFACE') && depth < 3) {
      const properties: Record<string, JsonSchema> = {};
      for (const f of full.fields ?? []) {
        const inner = unwrap(f.type);
        const innerFull = this.types.get(inner.name ?? '');
        if (!innerFull || innerFull.kind === 'SCALAR' || innerFull.kind === 'ENUM' || depth < 1) {
          properties[f.name] = this.jsonSchema(f.type, depth + 1);
        }
      }
      return { type: 'object', properties };
    }
    return {};
  }

  /** Scalars and enums of the type, plus scalars of directly nested objects. */
  selection(t: TypeRef, depth = 0): string {
    const full = this.types.get(unwrap(t).name ?? '');
    if (!full || (full.kind !== 'OBJECT' && full.kind !== 'INTERFACE')) return '';
    const parts: string[] = [];
    for (const f of full.fields ?? []) {
      if (f.args?.some((a) => a.type.kind === 'NON_NULL')) continue; // needs arguments we don't have
      const inner = this.types.get(unwrap(f.type).name ?? '');
      if (!inner || inner.kind === 'SCALAR' || inner.kind === 'ENUM') parts.push(f.name);
      else if (depth < 1 && (inner.kind === 'OBJECT' || inner.kind === 'INTERFACE')) {
        const sub = this.selection(f.type, depth + 1);
        if (sub) parts.push(`${f.name} ${sub}`);
      }
    }
    return parts.length ? `{ ${parts.join(' ')} }` : '{ __typename }';
  }
}

function accessFor(kind: 'query' | 'mutation', name: string): AccessLevel {
  if (kind === 'query') return 'read';
  return /^(delete|remove|destroy|purge|drop)/i.test(name) ? 'destructive' : 'write';
}

export function introspectionToDef(
  name: string,
  endpoint: string,
  input: { data: Introspection } | Introspection,
): OpenApiIntegrationDef {
  const intro = 'data' in input ? input.data : input;
  const idx = new SchemaIndex(intro);
  const findings: SpecFinding[] = [
    {
      severity: 'info',
      code: 'from_graphql',
      message:
        'Imported from GraphQL introspection: one tool per Query/Mutation field, with a generated selection set (scalars plus one nested level).',
    },
  ];
  const url = new URL(endpoint);
  const operations: OperationDef[] = [];
  for (const [kind, root] of [
    ['query', intro.__schema.queryType?.name],
    ['mutation', intro.__schema.mutationType?.name],
  ] as const) {
    const type = root ? idx.types.get(root) : undefined;
    for (const field of type?.fields ?? []) {
      if (field.name.startsWith('__')) continue;
      const args = field.args ?? [];
      const varDefs = args.map((a) => `$${a.name}: ${typeString(a.type)}`).join(', ');
      const argUse = args.map((a) => `${a.name}: $${a.name}`).join(', ');
      const sel = idx.selection(field.type);
      const opName = camelCase(`${kind === 'query' ? '' : ''}${field.name}`);
      const document = `${kind} ${camelCase(`toolsmith ${field.name}`)}${varDefs ? `(${varDefs})` : ''} { ${field.name}${argUse ? `(${argUse})` : ''}${sel ? ` ${sel}` : ''} }`;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const a of args) {
        properties[a.name] = {
          ...idx.jsonSchema(a.type),
          ...(a.description ? { description: cleanText(a.description) } : {}),
        };
        if (a.type.kind === 'NON_NULL') required.push(a.name);
      }
      const out = idx.jsonSchema(field.type);
      const description = cleanText(field.description ?? '').trim();
      const hit = detectInjection(description);
      if (hit) {
        findings.push({
          severity: 'error',
          code: 'suspicious_description',
          message: `${field.name} description contains instruction-like text ("${hit}").`,
          operation: opName,
        });
      }
      operations.push({
        name: opName,
        operationId: field.name,
        method: 'POST',
        path: url.pathname || '/',
        summary: description.split('\n')[0]!.slice(0, 200) || `GraphQL ${kind} ${field.name}`,
        description,
        params: [],
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { result: out }, required: ['result'] },
        outputWrapped: true,
        access: accessFor(kind, field.name),
        tags: [kind],
        graphql: { document, field: field.name },
      });
    }
  }
  for (const op of operations) sanitizeOperation(op);
  if (operations.length === 0)
    throw new ToolsmithError('The GraphQL schema has no query or mutation fields', 'validation');
  return {
    kind: 'openapi',
    name,
    title: `${name} (GraphQL)`,
    description: 'GraphQL API',
    specSource: endpoint,
    specVersion: 'graphql',
    baseUrl: url.origin,
    operations,
    findings,
  };
}

/** Shape a GraphQL response: data for the field, or a readable error. */
export function graphqlResult(
  field: string,
  body: JsonValue,
): { ok: true; data: JsonValue } | { ok: false; error: string } {
  const b = (body ?? {}) as {
    data?: Record<string, JsonValue> | null;
    errors?: Array<{ message?: string }>;
  };
  if (Array.isArray(b.errors) && b.errors.length) {
    return {
      ok: false,
      error: `GraphQL error: ${b.errors
        .map((e) => e.message ?? 'unknown')
        .slice(0, 3)
        .join('; ')}`,
    };
  }
  if (!b.data || !(field in b.data))
    return { ok: false, error: 'GraphQL response has no data for this field' };
  return { ok: true, data: b.data[field] ?? null };
}
