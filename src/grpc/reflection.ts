import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor.js';
import { ToolsmithError } from '../core/errors.js';

/**
 * A minimal gRPC server-reflection client (grpc.reflection.v1 with a
 * v1alpha fallback): list services, then fetch the file descriptors that
 * define them and everything they import, and build a protobuf.js root.
 */

const REFLECTION_PROTO = `
syntax = "proto3";
package grpc.reflection.v1;
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

const types = protobuf.parse(REFLECTION_PROTO, { keepCase: true }).root;
const Req = types.lookupType('grpc.reflection.v1.ServerReflectionRequest');
const Res = types.lookupType('grpc.reflection.v1.ServerReflectionResponse');

interface ReflectionResponse {
  file_descriptor_response?: { file_descriptor_proto: Uint8Array[] };
  list_services_response?: { service: Array<{ name: string }> };
  error_response?: { error_code: number; error_message: string };
}

const MAX_FILES = 500;

async function ask(
  client: grpc.Client,
  version: 'v1' | 'v1alpha',
  requests: Array<Record<string, string>>,
  deadlineMs: number,
): Promise<ReflectionResponse[]> {
  const path = `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`;
  return new Promise((resolve, reject) => {
    const out: ReflectionResponse[] = [];
    const call = client.makeBidiStreamRequest(
      path,
      (m: object) => Buffer.from(Req.encode(Req.fromObject(m)).finish()),
      (b: Buffer) => Res.toObject(Res.decode(b), { defaults: false }) as ReflectionResponse,
      new grpc.Metadata(),
      { deadline: Date.now() + deadlineMs },
    );
    call.on('data', (r: ReflectionResponse) => {
      out.push(r);
      if (out.length === requests.length) call.end();
    });
    call.on('error', reject);
    call.on('end', () => resolve(out));
    for (const r of requests) call.write(r);
  });
}

export async function reflectRoot(
  client: grpc.Client,
  deadlineMs: number,
): Promise<{ root: protobuf.Root; services: string[] }> {
  let version: 'v1' | 'v1alpha' = 'v1';
  let listed: ReflectionResponse[];
  try {
    listed = await ask(client, version, [{ list_services: '' }], deadlineMs);
  } catch (err) {
    if ((err as grpc.ServiceError).code !== grpc.status.UNIMPLEMENTED) throw wrap(err);
    version = 'v1alpha';
    listed = await ask(client, version, [{ list_services: '' }], deadlineMs).catch((e) => {
      throw wrap(e);
    });
  }
  const services = (listed[0]?.list_services_response?.service ?? [])
    .map((s) => s.name)
    .filter((n) => !n.startsWith('grpc.reflection.') && n !== 'grpc.health.v1.Health');
  if (services.length === 0)
    throw new ToolsmithError('The server lists no services over reflection', 'validation');

  const files = new Map<string, Uint8Array>();
  const take = (rs: ReflectionResponse[]): string[] => {
    const deps: string[] = [];
    for (const r of rs) {
      if (r.error_response)
        throw new ToolsmithError(`Reflection error: ${r.error_response.error_message}`, 'upstream');
      for (const bytes of r.file_descriptor_response?.file_descriptor_proto ?? []) {
        const fd = descriptor.FileDescriptorProto.decode(bytes);
        if (!fd.name || files.has(fd.name)) continue;
        if (files.size >= MAX_FILES)
          throw new ToolsmithError(
            `Reflection returned more than ${MAX_FILES} files`,
            'validation',
          );
        files.set(fd.name, bytes);
        deps.push(...(fd.dependency ?? []));
      }
    }
    return deps;
  };
  let pending = take(
    await ask(
      client,
      version,
      services.map((s) => ({ file_containing_symbol: s })),
      deadlineMs,
    ),
  );
  while (pending.length) {
    const need = [...new Set(pending)].filter((f) => !files.has(f));
    if (need.length === 0) break;
    if (files.size + need.length > MAX_FILES)
      throw new ToolsmithError(`Reflection returned more than ${MAX_FILES} files`, 'validation');
    pending = take(
      await ask(
        client,
        version,
        need.map((f) => ({ file_by_filename: f })),
        deadlineMs,
      ),
    );
  }
  const decoded = [...files.values()].map((b) => descriptor.FileDescriptorProto.decode(b));
  for (const f of decoded) for (const m of f.messageType ?? []) fillJsonNames(m);
  const set = descriptor.FileDescriptorSet.create({ file: decoded });
  return {
    root: protobuf.Root.fromDescriptor(descriptor.FileDescriptorSet.encode(set).finish()),
    services,
  };
}

/**
 * protoc always fills json_name; some reflection servers send descriptors
 * without it, and protobuf.js would then keep snake_case names. Fill it the
 * way protoc does, so both import paths produce the same (ProtoJSON) names.
 */
function fillJsonNames(m: descriptor.IDescriptorProto): void {
  for (const f of m.field ?? [])
    if (!f.jsonName && f.name)
      f.jsonName = f.name.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  for (const n of m.nestedType ?? []) fillJsonNames(n);
}

function wrap(err: unknown): ToolsmithError {
  const e = err as grpc.ServiceError;
  return new ToolsmithError(
    `gRPC reflection failed: ${e.details ?? e.message}`,
    e.code === grpc.status.UNAVAILABLE ? 'network' : 'upstream',
    'Enable server reflection on the service, or point "spec" at its .proto file.',
  );
}
