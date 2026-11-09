import * as grpc from '@grpc/grpc-js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import protobuf from 'protobufjs';
import type { IntegrationConfig } from '../config/config.js';
import type { AccessLevel } from '../core/types.js';
import { ToolsmithError } from '../core/errors.js';
import { cleanFindings, detectInjection, sanitizeOperation } from '../openapi/import.js';
import { cleanText, wrapAsObjectSchema } from '../openapi/schema-utils.js';
import type { OpenApiIntegrationDef, OperationDef, SpecFinding } from '../openapi/types.js';
import { openChannel } from './executor.js';
import { reflectRoot } from './reflection.js';
import { messageSchema } from './schema.js';

/** Load the service definitions: .proto files, or the server's reflection API. */
export async function loadGrpcRoot(
  cfg: IntegrationConfig,
  baseDir: string,
): Promise<{ root: protobuf.Root; services?: string[] }> {
  const g = cfg.grpc!;
  if (
    !['none', 'bearer', 'apiKey', 'basic'].includes(cfg.auth.type) ||
    (cfg.auth.type === 'apiKey' && cfg.auth.in !== 'header')
  )
    throw new ToolsmithError(
      'gRPC integrations support none, bearer, basic and header apiKey auth',
      'validation',
    );
  if (cfg.spec === 'reflection') {
    const client = await openChannel(cfg, g.address);
    try {
      return await reflectRoot(client, cfg.timeoutMs);
    } finally {
      client.close();
    }
  }
  const files = cfg.spec.split(',').map((f) => resolve(baseDir, f.trim()));
  const includeDirs = [...g.includeDirs.map((d) => resolve(baseDir, d)), ...files.map(dirname)];
  const root = new protobuf.Root();
  // Imports resolve against the include directories, like protoc -I.
  root.resolvePath = (origin, target) => {
    if (isAbsolute(target)) return target;
    for (const dir of includeDirs) {
      const p = resolve(dir, target);
      if (existsSync(p)) return p;
    }
    return protobuf.util.path.resolve(origin, target);
  };
  try {
    // loadSync: the async loader resolves types inside an fs callback, where a
    // missing type would throw past this try and take the process down.
    root.loadSync(files, { keepCase: false, alternateCommentMode: true });
    root.resolveAll();
  } catch (err) {
    throw new ToolsmithError(`Could not load ${cfg.spec}: ${(err as Error).message}`, 'validation');
  }
  return { root };
}

const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'describe',
  'read',
  'lookup',
  'count',
  'query',
  'fetch',
  'watch',
  'stream',
  'batch',
]);
const DESTRUCTIVE_VERBS = new Set([
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'drop',
  'revoke',
  'cancel',
  'truncate',
  'wipe',
]);
// Any of these anywhere in the name means the call changes something
// (CheckAndMutateRow, GetAndDelete, FindOrCreate, ReadModifyWriteRow).
const MUTATING_WORDS = new Set([
  'and',
  'or',
  'create',
  'update',
  'mutate',
  'modify',
  'write',
  'set',
  'put',
  'insert',
  'upsert',
  'add',
  'apply',
  'commit',
  'send',
  'execute',
  'run',
  'start',
  'stop',
  'reset',
  'increment',
  'move',
  'copy',
  'rename',
  'import',
  'export',
  'out',
  'submit',
  'publish',
  'approve',
  ...DESTRUCTIVE_VERBS,
]);

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * gRPC carries no HTTP-style method semantics, so err towards caution: a
 * name that says delete is destructive even if the proto claims
 * NO_SIDE_EFFECTS; a read needs NO_SIDE_EFFECTS or a read verb with no
 * mutating word anywhere in the name; everything else is a write.
 */
export function accessOf(m: { name: string; options?: Record<string, unknown> }): {
  access: AccessLevel;
  from: string;
} {
  const w = words(m.name);
  if (w.some((x) => DESTRUCTIVE_VERBS.has(x)))
    return { access: 'destructive', from: 'method name' };
  const level = m.options?.idempotency_level as string | undefined;
  const mutating = w.slice(1).some((x) => MUTATING_WORDS.has(x));
  if (level === 'NO_SIDE_EFFECTS' && !mutating)
    return { access: 'read', from: 'idempotency_level' };
  if (!level && READ_VERBS.has(w[0] ?? '') && !mutating)
    return { access: 'read', from: 'method name' };
  return { access: 'write', from: level ? 'idempotency_level' : 'default' };
}

function services(ns: protobuf.NamespaceBase): protobuf.Service[] {
  const out: protobuf.Service[] = [];
  for (const o of ns.nestedArray) {
    if (o instanceof protobuf.Service) out.push(o);
    if (o instanceof protobuf.Namespace || o instanceof protobuf.Type) out.push(...services(o));
  }
  return out;
}

export function grpcRootToDef(
  root: protobuf.Root,
  cfg: IntegrationConfig,
  only?: string[],
): OpenApiIntegrationDef {
  const findings: SpecFinding[] = [];
  const operations: OperationDef[] = [];
  const all = services(root).filter((s) => {
    const full = s.fullName.slice(1);
    if (full.startsWith('grpc.reflection.') || full === 'grpc.health.v1.Health') return false;
    if (only && !only.includes(full)) return false;
    return cfg.grpc!.services.length === 0 || cfg.grpc!.services.includes(full);
  });
  // Tool names are case-insensitive in practice: GetThing and getThing clash.
  const methodNames = all.flatMap((s) => s.methodsArray.map((m) => m.name.toLowerCase()));
  const used = new Set<string>();
  const filter = (keys: string[]): boolean => {
    const hit = (pattern: string): boolean => {
      const re = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      return keys.some((k) => re.test(k));
    };
    if (cfg.include?.length && !cfg.include.some(hit)) return false;
    if (cfg.exclude?.length && cfg.exclude.some(hit)) return false;
    return true;
  };
  for (const svc of all) {
    const full = svc.fullName.slice(1);
    for (const m of svc.methodsArray) {
      m.resolve();
      const label = `${full}/${m.name}`;
      if (m.requestStream) {
        findings.push({
          severity: 'info',
          code: 'unsupported-streaming',
          message: `${label} streams requests from the client; only unary and server-streaming methods become tools`,
          operation: m.name,
        });
        continue;
      }
      // Methods with the same name in two services are told apart by service.
      const dup = methodNames.filter((n) => n === m.name.toLowerCase()).length > 1;
      let name = (dup ? `${svc.name}${m.name}` : m.name).replace(/^./, (c) => c.toLowerCase());
      for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.replace(/\d+$/, '')}${k}`;
      // include/exclude match the tool name, the method name or the full path.
      if (!filter([name, m.name, `/${full}/${m.name}`, `${full}/${m.name}`])) continue;
      used.add(name.toLowerCase());
      const req = m.resolvedRequestType!;
      const res = m.resolvedResponseType!;
      const { access, from } = accessOf(m);
      const comment = cleanText(m.comment ?? '').trim();
      const hit = detectInjection(`${comment} ${m.name} ${full}`);
      if (hit)
        findings.push({
          severity: 'warning',
          code: 'suspicious_description',
          message: `${label} description contains instruction-like text ("${hit}"). Review before approving.`,
          operation: name,
        });
      if (from === 'default')
        findings.push({
          severity: 'info',
          code: 'access-assumed',
          message: `${label}: no idempotency_level and the name does not say read or delete; treated as a write`,
          operation: name,
        });
      const outSchema = messageSchema(res);
      // Wrapper types (StringValue, …) are JSON scalars: MCP needs an object.
      const unary = wrapAsObjectSchema(outSchema);
      const op: OperationDef = {
        name,
        method: 'GRPC',
        path: `/${full}/${m.name}`,
        summary: comment.split('\n')[0]!.slice(0, 200),
        description: comment,
        params: [],
        inputSchema: messageSchema(req),
        outputSchema: m.responseStream
          ? {
              type: 'object',
              properties: {
                items: { type: 'array', items: outSchema },
                truncated: { type: 'boolean' },
              },
              required: ['items', 'truncated'],
            }
          : unary.schema,
        outputWrapped: !m.responseStream && unary.wrapped,
        access,
        tags: [full],
        grpc: {
          path: `/${full}/${m.name}`,
          requestType: req.fullName.slice(1),
          responseType: res.fullName.slice(1),
          serverStreaming: Boolean(m.responseStream),
        },
      };
      sanitizeOperation(op);
      operations.push(op);
    }
  }
  if (operations.length === 0)
    findings.push({
      severity: 'error',
      code: 'no-operations',
      message: 'No usable gRPC methods found',
    });
  return {
    kind: 'openapi',
    name: cfg.name,
    title: cleanText(all.map((s) => s.fullName.slice(1)).join(', ') || cfg.name).slice(0, 200),
    description: `gRPC service at ${cfg.grpc!.address}`,
    specSource: cfg.spec,
    specVersion: 'grpc',
    baseUrl: `grpc://${cfg.grpc!.address}`,
    operations,
    findings: cleanFindings(findings),
    grpc: { address: cfg.grpc!.address, root: root.toJSON() as unknown as Record<string, unknown> },
  };
}

export { grpc };
