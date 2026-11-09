import * as grpc from '@grpc/grpc-js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import protobuf from 'protobufjs';
import protojson from 'protobufjs/ext/protojson.js';
import type { IntegrationConfig } from '../config/config.js';
import type { ErrorCode, JsonObject, JsonValue } from '../core/types.js';
import { ToolsmithError } from '../core/errors.js';
import type { HttpOutcome } from '../openapi/http-executor.js';
import type { OpenApiIntegrationDef, OperationDef } from '../openapi/types.js';
import { TokenBucket } from '../security/rate-limit.js';
import type { Redactor } from '../security/redact.js';
import { resolveEnvRefs } from '../security/secrets.js';
import { isPrivateAddress } from '../security/ssrf.js';
import { isLoopback } from '../server/net.js';

/** Split "host:port" / "[v6]:port" / "dns:///host:port". */
export function parseAddress(address: string): { host: string; port: number } {
  const a = address.replace(/^dns:\/\/\//, '');
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(a) ?? /^([^:]+):(\d+)$/.exec(a);
  if (!m)
    throw new ToolsmithError(`Invalid gRPC address "${address}" (use host:port)`, 'validation');
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536))
    throw new ToolsmithError(`Invalid port in "${address}"`, 'validation');
  return { host: m[1]!.toLowerCase(), port };
}

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 5 * 1024 * 1024;

/**
 * Opens a channel only to an address that passed the same egress rules as
 * HTTP integrations: the host is resolved once, private addresses are
 * refused unless allowed, and the channel connects to that checked address
 * (TLS still verifies the certificate for the original host name).
 */
export async function openChannel(cfg: IntegrationConfig, address: string): Promise<grpc.Client> {
  const { host, port } = parseAddress(address);
  const tls = cfg.grpc?.tls ?? !isLoopback(host);
  if (!tls && cfg.auth.type !== 'none' && !isLoopback(host))
    throw new ToolsmithError(
      `Refusing to send credentials to ${host} over plaintext gRPC`,
      'policy',
      'Use TLS (remove "tls": false), or drop the credentials.',
    );
  let ip = isIP(host) ? host : undefined;
  if (!ip) {
    const all = await lookup(host, { all: true }).catch(() => {
      throw new ToolsmithError(`Could not resolve ${host}`, 'network');
    });
    const bad = all.find((a) => isPrivateAddress(a.address));
    if (bad && !cfg.allowPrivateNetwork)
      throw new ToolsmithError(
        `Blocked: ${host} resolves to private address ${bad.address}`,
        'policy',
        'If the service really is on your network, set "allowPrivateNetwork": true.',
      );
    ip = all[0]!.address;
  } else if (isPrivateAddress(ip) && !cfg.allowPrivateNetwork) {
    throw new ToolsmithError(`Blocked: ${ip} is a private address`, 'policy');
  }
  const target = isIP(ip) === 6 ? `ipv6:[${ip}]:${port}` : `ipv4:${ip}:${port}`;
  return new grpc.Client(
    target,
    tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    {
      'grpc.default_authority': `${host}:${port}`,
      ...(tls && !isIP(host) ? { 'grpc.ssl_target_name_override': host } : {}),
      'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
      'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
      // No hidden retries: the executor decides what may be retried.
      'grpc.enable_retries': 0,
    },
  );
}

const STATUS: Partial<Record<number, { http: number; code: ErrorCode; text: string }>> = {
  [grpc.status.INVALID_ARGUMENT]: {
    http: 400,
    code: 'validation',
    text: 'The service rejected the request',
  },
  [grpc.status.FAILED_PRECONDITION]: { http: 400, code: 'validation', text: 'Failed precondition' },
  [grpc.status.OUT_OF_RANGE]: { http: 400, code: 'validation', text: 'Out of range' },
  [grpc.status.NOT_FOUND]: { http: 404, code: 'not_found', text: 'Not found' },
  [grpc.status.ALREADY_EXISTS]: { http: 409, code: 'validation', text: 'Already exists' },
  [grpc.status.UNAUTHENTICATED]: {
    http: 401,
    code: 'auth',
    text: 'The service rejected the credentials',
  },
  [grpc.status.PERMISSION_DENIED]: { http: 403, code: 'forbidden', text: 'Permission denied' },
  [grpc.status.RESOURCE_EXHAUSTED]: {
    http: 429,
    code: 'rate_limited',
    text: 'The service is rate limiting',
  },
  [grpc.status.DEADLINE_EXCEEDED]: { http: 504, code: 'timeout', text: 'The call timed out' },
  [grpc.status.UNAVAILABLE]: { http: 503, code: 'network', text: 'The service is unavailable' },
};

/** Executes gRPC operations for one integration (unary and server-streaming). */
export class GrpcIntegrationClient {
  private readonly bucket: TokenBucket;
  private readonly root: protobuf.Root;
  private channel?: Promise<grpc.Client>;

  constructor(
    private readonly cfg: IntegrationConfig,
    private readonly def: OpenApiIntegrationDef,
    private readonly redactor: Redactor,
  ) {
    if (!def.grpc) throw new ToolsmithError(`${def.name} is not a gRPC integration`, 'internal');
    if (
      !['none', 'bearer', 'apiKey', 'basic'].includes(cfg.auth.type) ||
      (cfg.auth.type === 'apiKey' && cfg.auth.in !== 'header')
    )
      throw new ToolsmithError(
        'gRPC integrations support none, bearer, basic and header apiKey auth',
        'validation',
      );
    this.bucket = new TokenBucket(cfg.rateLimit.requestsPerSecond, cfg.rateLimit.burst);
    this.root = protobuf.Root.fromJSON(def.grpc.root as protobuf.INamespace);
  }

  private secret(value: string): string {
    const v = resolveEnvRefs(value);
    this.redactor.registerSecret(v);
    return v;
  }

  private metadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    const auth = this.cfg.auth;
    if (auth.type === 'bearer') md.set('authorization', `Bearer ${this.secret(auth.token)}`);
    if (auth.type === 'basic') {
      const enc = Buffer.from(
        `${this.secret(auth.username)}:${this.secret(auth.password)}`,
      ).toString('base64');
      this.redactor.registerSecret(enc);
      md.set('authorization', `Basic ${enc}`);
    }
    if (auth.type === 'apiKey') md.set(auth.name.toLowerCase(), this.secret(auth.value));
    return md;
  }

  async call(op: OperationDef, args: JsonObject, signal?: AbortSignal): Promise<HttpOutcome> {
    const g = op.grpc;
    if (!g)
      return {
        ok: false,
        status: 0,
        errorCode: 'internal',
        error: 'not a gRPC operation',
        requests: 0,
        retries: 0,
      };
    let reqType: protobuf.Type;
    let resType: protobuf.Type;
    let message: protobuf.Message;
    try {
      reqType = this.root.lookupType(g.requestType);
      resType = this.root.lookupType(g.responseType);
      message = protojson.fromJson(reqType, args);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        errorCode: 'validation',
        error: `Arguments do not fit ${g.requestType}: ${this.redactor.redactString((err as Error).message)}`,
        requests: 0,
        retries: 0,
      };
    }
    const payload = Buffer.from(reqType.encode(message).finish());
    let requests = 0;
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      if (!(await this.bucket.take(this.cfg.timeoutMs, signal)))
        return {
          ok: false,
          status: 0,
          errorCode: 'rate_limited',
          error: `Local rate limit for "${this.cfg.name}" exceeded. Try again shortly.`,
          requests,
          retries,
        };
      requests++;
      try {
        const client = await (this.channel ??= openChannel(
          this.cfg,
          this.cfg.grpc?.address ?? this.def.grpc!.address,
        ).catch((e) => {
          this.channel = undefined;
          throw e;
        }));
        const data = await this.invoke(client, op, payload, resType, signal);
        return {
          ok: true,
          status: 200,
          data: this.redactor.scrubSecrets(data) as JsonValue,
          requests,
          retries,
        };
      } catch (err) {
        if (err instanceof ToolsmithError)
          return {
            ok: false,
            status: 0,
            errorCode: err.code,
            error: err.message,
            requests,
            retries,
          };
        const e = err as grpc.ServiceError;
        if (typeof e.code !== 'number')
          return {
            ok: false,
            status: 0,
            errorCode: 'network',
            error: `gRPC call failed: ${this.redactor.redactString(e.message ?? String(err)).slice(0, 300)}`,
            requests,
            retries,
          };
        const m = STATUS[e.code];
        // Only reads retry, and only when the service was unavailable.
        if (
          e.code === grpc.status.UNAVAILABLE &&
          op.access === 'read' &&
          attempt < this.cfg.maxRetries &&
          !signal?.aborted
        ) {
          retries++;
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          continue;
        }
        const detail = e.details ? `: ${this.redactor.redactString(e.details).slice(0, 300)}` : '';
        return {
          ok: false,
          status: m?.http ?? 502,
          errorCode: m?.code ?? 'upstream',
          error: `${m?.text ?? `gRPC error ${grpc.status[e.code] ?? e.code}`}${detail}`,
          requests,
          retries,
        };
      }
    }
  }

  private invoke(
    client: grpc.Client,
    op: OperationDef,
    payload: Buffer,
    resType: protobuf.Type,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const g = op.grpc!;
    const options = { deadline: Date.now() + this.cfg.timeoutMs };
    const decode = (b: Buffer): JsonValue =>
      protojson.toJson(resType, resType.decode(b)) as JsonValue;
    return new Promise((resolve, reject) => {
      if (!g.serverStreaming) {
        const call = client.makeUnaryRequest(
          g.path,
          (b: Buffer) => b,
          decode,
          payload,
          this.metadata(),
          options,
          (err, value) => (err ? reject(err) : resolve(value ?? null)),
        );
        signal?.addEventListener('abort', () => call.cancel(), { once: true });
        return;
      }
      const max = this.cfg.grpc?.maxStreamMessages ?? 100;
      const items: JsonValue[] = [];
      let bytes = 0;
      const call = client.makeServerStreamRequest(
        g.path,
        (b: Buffer) => b,
        (b: Buffer) => {
          bytes += b.length;
          return decode(b);
        },
        payload,
        this.metadata(),
        options,
      );
      signal?.addEventListener('abort', () => call.cancel(), { once: true });
      let truncated = false;
      call.on('data', (m: JsonValue) => {
        // Same total cap as an HTTP response body: a stream of large messages
        // must not grow without bound.
        if (bytes > MAX_STREAM_BYTES) {
          truncated = true;
          return call.cancel();
        }
        items.push(m);
        if (items.length >= max) {
          truncated = true;
          call.cancel();
        }
      });
      call.on('error', (err: grpc.ServiceError) =>
        (truncated && err.code === grpc.status.CANCELLED) ||
        // Watch-style streams rarely end: at the deadline, return what came in.
        (err.code === grpc.status.DEADLINE_EXCEEDED && items.length > 0)
          ? resolve({ items, truncated: true })
          : reject(err),
      );
      call.on('end', () => resolve({ items, truncated }));
    });
  }

  close(): void {
    void this.channel?.then((c) => c.close()).catch(() => undefined);
  }
}
