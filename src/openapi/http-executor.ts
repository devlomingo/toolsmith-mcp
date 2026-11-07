import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AuthConfig, IntegrationConfig } from '../config/config.js';
import { ToolsmithError } from '../core/errors.js';
import type { ErrorCode, JsonObject, JsonValue } from '../core/types.js';
import { TokenBucket, sleep } from '../security/rate-limit.js';
import type { Redactor } from '../security/redact.js';
import { resolveEnvRefs, envRefNames } from '../security/secrets.js';
import { assertHostAllowed, guardedLookup, type EgressPolicy } from '../security/ssrf.js';
import type { OperationDef } from './types.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface HttpOutcome {
  ok: boolean;
  status: number;
  data?: JsonValue;
  error?: string;
  errorCode?: ErrorCode;
  requests: number;
  retries: number;
}

interface RawResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * Executes OpenAPI operations for one integration. Every request goes through
 * the same choke point: host allow-list, connect-time private-address check,
 * no redirects, rate limit, timeout, bounded retries for idempotent methods.
 */
export class HttpIntegrationClient {
  private readonly bucket: TokenBucket;
  private readonly policy: EgressPolicy;

  constructor(
    private readonly cfg: IntegrationConfig,
    private readonly baseUrl: string,
    private readonly redactor: Redactor,
  ) {
    this.bucket = new TokenBucket(cfg.rateLimit.requestsPerSecond, cfg.rateLimit.burst);
    const baseHost = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    this.policy = {
      allowedHosts: [baseHost, ...cfg.allowedHosts],
      allowPrivateNetwork: cfg.allowPrivateNetwork,
    };
    assertHostAllowed(new URL(baseUrl), this.policy);
  }

  async call(op: OperationDef, args: JsonObject, signal?: AbortSignal): Promise<HttpOutcome> {
    const { url, headers, body } = this.buildRequest(op, args);
    assertHostAllowed(url, this.policy);
    const idempotent = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(op.method);
    // Only retry methods that cannot double-apply. DELETE/PUT are idempotent by
    // HTTP semantics but APIs often violate that, so only safe reads retry.
    const retryable = idempotent && op.access === 'read';
    let requests = 0;
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      if (!(await this.bucket.take(this.cfg.timeoutMs, signal))) {
        return {
          ok: false,
          status: 0,
          requests,
          retries,
          errorCode: 'rate_limited',
          error: `Local rate limit for "${this.cfg.name}" exceeded (${this.cfg.rateLimit.requestsPerSecond}/s). Try again shortly.`,
        };
      }
      requests++;
      let res: RawResponse;
      try {
        res = await this.send(op.method, url, headers, body, signal);
      } catch (err) {
        const out = this.networkError(err);
        if (
          retryable &&
          attempt < this.cfg.maxRetries &&
          out.errorCode !== 'policy' &&
          // A timeout is not retried: three silent attempts would triple the wait.
          out.errorCode !== 'timeout' &&
          !signal?.aborted
        ) {
          retries++;
          await sleep(backoff(attempt), signal);
          continue;
        }
        return { ...out, requests, retries };
      }
      if (res.status >= 200 && res.status < 300) {
        // An API that echoes the credential (debug endpoints, reflected
        // headers) must not hand it to the agent.
        return {
          ok: true,
          status: res.status,
          data: this.redactor.scrubSecrets(parseBody(res)),
          requests,
          retries,
        };
      }
      const transient =
        res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (transient && retryable && attempt < this.cfg.maxRetries) {
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        const wait = retryAfter ?? backoff(attempt);
        if (wait <= 10_000) {
          retries++;
          await sleep(wait, signal);
          continue;
        }
      }
      return { ...this.httpError(op, res), requests, retries };
    }
  }

  buildRequest(
    op: OperationDef,
    args: JsonObject,
  ): { url: URL; headers: Record<string, string>; body?: string } {
    let path = op.path;
    for (const p of op.params.filter((x) => x.in === 'path')) {
      const v = args[p.name];
      if (v === undefined || v === null || v === '') {
        throw new ToolsmithError(`Missing required path parameter "${p.name}"`, 'validation');
      }
      // encodeURIComponent keeps "/", "?", "#" and ".." out of the path so an
      // argument can never change which endpoint or host is called.
      const encoded = encodeURIComponent(String(v));
      if (encoded === '.' || encoded === '..') {
        throw new ToolsmithError(`Invalid value for path parameter "${p.name}"`, 'validation');
      }
      path = path.split(`{${p.name}}`).join(encoded);
    }
    const url = new URL(this.baseUrl + path);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new ToolsmithError('Request URL escaped the integration base URL', 'policy');
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'toolsmith-mcp',
    };
    for (const [k, v] of Object.entries(this.cfg.headers))
      headers[k.toLowerCase()] = this.secret(v);
    for (const p of op.params) {
      const v = args[p.name];
      if (v === undefined || v === null) continue;
      if (p.in === 'query') {
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(p.name, scalar(item));
        else url.searchParams.set(p.name, scalar(v));
      } else if (p.in === 'header') {
        const value = scalar(v);
        if (/[\r\n]/.test(value))
          throw new ToolsmithError(`Invalid header value for "${p.name}"`, 'validation');
        headers[p.name.toLowerCase()] = value;
      } else if (p.in === 'cookie') {
        headers.cookie = [headers.cookie, `${p.name}=${encodeURIComponent(scalar(v))}`]
          .filter(Boolean)
          .join('; ');
      }
    }
    this.applyAuth(this.cfg.auth, headers, url);
    let body: string | undefined;
    if (op.body && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers['content-type'] = op.body.contentType.includes('json')
        ? op.body.contentType
        : 'application/json';
    }
    return { url, headers, body };
  }

  private secret(value: string): string {
    const resolved = resolveEnvRefs(value);
    if (envRefNames(value).length > 0) this.redactor.registerSecret(resolved);
    return resolved;
  }

  private applyAuth(auth: AuthConfig, headers: Record<string, string>, url: URL): void {
    switch (auth.type) {
      case 'none':
        return;
      case 'bearer':
        headers.authorization = `Bearer ${this.secret(auth.token)}`;
        return;
      case 'basic':
        headers.authorization = `Basic ${Buffer.from(`${this.secret(auth.username)}:${this.secret(auth.password)}`).toString('base64')}`;
        return;
      case 'apiKey':
        if (auth.in === 'query') url.searchParams.set(auth.name, this.secret(auth.value));
        else headers[auth.name.toLowerCase()] = this.secret(auth.value);
        return;
    }
  }

  private send(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<RawResponse> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = requestFn(
        url,
        {
          method,
          headers: body
            ? { ...headers, 'content-length': Buffer.byteLength(body).toString() }
            : headers,
          lookup: guardedLookup(this.policy) as never,
          signal: combined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new ToolsmithError('Response larger than 5 MB', 'upstream'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', (err) =>
        reject(timeout.aborted ? new ToolsmithError('timeout', 'timeout') : err),
      );
      if (body) req.write(body);
      req.end();
    });
  }

  private networkError(err: unknown): Omit<HttpOutcome, 'requests' | 'retries'> {
    if (err instanceof ToolsmithError) {
      if (err.code === 'timeout') {
        return {
          ok: false,
          status: 0,
          errorCode: 'timeout',
          error: `The API did not respond within ${this.cfg.timeoutMs} ms`,
        };
      }
      return { ok: false, status: 0, errorCode: err.code, error: err.message };
    }
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ESSRF') return { ok: false, status: 0, errorCode: 'policy', error: e.message };
    if (e?.name === 'AbortError')
      return {
        ok: false,
        status: 0,
        errorCode: 'timeout',
        error: 'Request was cancelled or timed out',
      };
    return {
      ok: false,
      status: 0,
      errorCode: 'network',
      error: `Could not reach the API: ${this.redactor.redactString(e?.code ?? e?.message ?? String(err))}`,
    };
  }

  private httpError(op: OperationDef, res: RawResponse): Omit<HttpOutcome, 'requests' | 'retries'> {
    const snippet = this.redactor.redactString(res.body.slice(0, 300));
    const detail = snippet ? ` Response: ${snippet}` : '';
    const s = res.status;
    if (s === 401) {
      const envs = credentialEnvNames(this.cfg.auth);
      return {
        ok: false,
        status: s,
        errorCode: 'auth',
        error: `The API rejected the credentials (401). They may be missing, invalid or expired${envs.length ? `; check ${envs.join(', ')}` : ''}.`,
      };
    }
    if (s === 403)
      return {
        ok: false,
        status: s,
        errorCode: 'forbidden',
        error: `The API denied access to ${op.method} ${op.path} (403). The credentials lack permission for this operation.`,
      };
    if (s === 404)
      return { ok: false, status: s, errorCode: 'not_found', error: `Not found (404).${detail}` };
    if (s === 429)
      return {
        ok: false,
        status: s,
        errorCode: 'rate_limited',
        error: 'The API rate limit was hit (429). Wait before retrying.',
      };
    if (s === 400 || s === 422)
      return {
        ok: false,
        status: s,
        errorCode: 'validation',
        error: `The API rejected the request (${s}).${detail}`,
      };
    if (s >= 300 && s < 400)
      return {
        ok: false,
        status: s,
        errorCode: 'policy',
        error: `The API answered with a redirect (${s}); redirects are not followed.`,
      };
    return {
      ok: false,
      status: s,
      errorCode: 'upstream',
      error: `The API returned an error (${s}).${detail}`,
    };
  }
}

function credentialEnvNames(auth: AuthConfig): string[] {
  switch (auth.type) {
    case 'bearer':
      return envRefNames(auth.token);
    case 'apiKey':
      return envRefNames(auth.value);
    case 'basic':
      return [...envRefNames(auth.username), ...envRefNames(auth.password)];
    default:
      return [];
  }
}

function scalar(v: JsonValue): string {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function parseBody(res: RawResponse): JsonValue {
  if (!res.body) return null;
  const type = String(res.headers['content-type'] ?? '');
  if (/json/i.test(type) || /^[[{]/.test(res.body.trimStart())) {
    try {
      return JSON.parse(res.body) as JsonValue;
    } catch {
      return res.body;
    }
  }
  return res.body;
}

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function backoff(attempt: number): number {
  return Math.min(2000, 100 * 2 ** attempt) + Math.floor(Math.random() * 50);
}
