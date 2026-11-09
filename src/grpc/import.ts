import * as grpc from '@grpc/grpc-js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import protobuf from 'protobufjs';
import type { IntegrationConfig } from '../config/config.js';
import type { AccessLevel } from '../core/types.js';
import { ToolsmithError } from '../core/errors.js';
import { cleanFindings, detectInjection, sanitizeOperation } from '../openapi/import.js';
import { cleanText } from '../openapi/schema-utils.js';
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
    await root.load(files, { keepCase: false, alternateCommentMode: true });
  } catch (err) {
    throw new ToolsmithError(`Could not load ${cfg.spec}: ${(err as Error).message}`, 'validation');
  }
  root.resolveAll();
  return { root };
}

const READ = /^(Get|List|Search|Describe|Read|Lookup|Find|Count|Check|Query|Fetch|Watch|Stream)/;
const DESTRUCTIVE = /^(Delete|Remove|Destroy|Purge|Erase|Drop|Revoke|Cancel)/;

/**
 * gRPC carries no HTTP-style method semantics. The proto's own
 * idempotency_level wins; otherwise the method name decides, and anything
 * that is not clearly a read is treated as a write.
 */
function accessOf(m: protobuf.Method): { access: AccessLevel; from: string } {
  const level = m.options?.idempotency_level as string | undefined;
  if (level === 'NO_SIDE_EFFECTS') return { access: 'read', from: 'idempotency_level' };
  if (DESTRUCTIVE.test(m.name)) return { access: 'destructive', from: 'method name' };
  if (!level && READ.test(m.name)) return { access: 'read', from: 'method name' };
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
  const methodNames = all.flatMap((s) => s.methodsArray.map((m) => m.name));
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
      const dup = methodNames.filter((n) => n === m.name).length > 1;
      const name = (dup ? `${svc.name}${m.name}` : m.name).replace(/^./, (c) => c.toLowerCase());
      const req = m.resolvedRequestType!;
      const res = m.resolvedResponseType!;
      const { access, from } = accessOf(m);
      const comment = cleanText(m.comment ?? '').trim();
      const hit = detectInjection(`${comment} ${m.name} ${full}`);
      if (hit)
        findings.push({
          severity: 'warning',
          code: 'suspicious-description',
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
          : outSchema,
        outputWrapped: false,
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
