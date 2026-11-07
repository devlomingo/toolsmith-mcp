import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Toolsmith } from '../app.js';
import { resolveEnvRefs } from '../security/secrets.js';
import { handleAdminApi } from './admin-api.js';
import { createServerFactory } from './mcp.js';

export interface HttpServerOptions {
  host?: string;
  port?: number;
  mcpToken?: string;
  adminToken?: string;
}

const DASHBOARD_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dashboard');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * One HTTP listener: /mcp (Streamable HTTP, both protocol eras), /api (admin),
 * /dashboard (static UI), /healthz. Binds to loopback by default; binding
 * elsewhere requires an MCP token so the gateway is never open by accident.
 */
export async function startHttpServer(
  app: Toolsmith,
  opts: HttpServerOptions = {},
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = opts.host ?? app.config.server.host;
  const port = opts.port ?? app.config.server.port;
  const mcpToken =
    opts.mcpToken ??
    (app.config.server.mcpToken ? resolveEnvRefs(app.config.server.mcpToken) : undefined);
  const adminToken =
    opts.adminToken ??
    (app.config.server.adminToken ? resolveEnvRefs(app.config.server.adminToken) : undefined);
  const clientTokens: Array<{ name: string; token: string }> = [
    ...(mcpToken ? [{ name: 'default', token: mcpToken }] : []),
    ...app.config.server.clients.map((c) => ({ name: c.name, token: resolveEnvRefs(c.token) })),
  ];
  if (!isLoopback(host) && clientTokens.length === 0) {
    throw new Error(
      `Refusing to listen on ${host} without server.mcpToken. Set one, or bind to 127.0.0.1.`,
    );
  }
  if (!adminToken)
    throw new Error(
      'server.adminToken is required for the dashboard and admin API. `toolsmith-mcp init` generates one.',
    );

  const mcp = createMcpHandler(createServerFactory(app), {
    onerror: (e) => process.stderr.write(`[toolsmith] mcp: ${e.message}\n`),
  });
  const mcpNode = toNodeHandler(mcp);
  const hostGuard = isLoopback(host) ? localhostHostValidation() : undefined;
  const unsubscribe = app.onToolsChanged(() => mcp.notify.toolsChanged());

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // DNS-rebinding defence: on loopback, only answer requests addressed to localhost.
      if (hostGuard && !hostGuard(req, res)) return;
      res.setHeader('x-content-type-options', 'nosniff');

      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (url.pathname === '/mcp') {
        // Identify the client by its token. These headers are set only by
        // the gateway: anything a client sends under these names is dropped.
        delete req.headers['x-toolsmith-client'];
        delete req.headers['x-toolsmith-conn'];
        let client: string | undefined;
        if (clientTokens.length === 0) client = 'local';
        else
          client = clientTokens.find((c) => tokenMatches(req.headers.authorization, c.token))?.name;
        if (!client) {
          res.setHeader('www-authenticate', 'Bearer');
          return json(res, 401, { error: 'Missing or invalid bearer token for /mcp' });
        }
        req.headers['x-toolsmith-client'] = client;
        // The TCP connection groups a keep-alive client's calls for workflow
        // discovery when it sends no session header (2025-era HTTP is stateless).
        req.headers['x-toolsmith-conn'] =
          `${req.socket.remoteAddress ?? ''}:${req.socket.remotePort ?? ''}`;
        // Browsers must not be able to drive the gateway cross-site.
        const origin = req.headers.origin;
        if (origin && !sameOrigin(origin, req))
          return json(res, 403, { error: 'Cross-origin requests are not allowed' });
        return void (await mcpNode(req, res));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!tokenMatches(req.headers.authorization, adminToken))
          return json(res, 401, { error: 'Admin token required' });
        const origin = req.headers.origin;
        if (origin && !sameOrigin(origin, req))
          return json(res, 403, { error: 'Cross-origin requests are not allowed' });
        return void (await handleAdminApi(app, req, res, url));
      }
      if (url.pathname === '/') {
        res.writeHead(302, { location: '/dashboard/' });
        return void res.end();
      }
      if (url.pathname.startsWith('/dashboard'))
        return serveStatic(url.pathname.slice('/dashboard'.length) || '/', res);
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      process.stderr.write(`[toolsmith] http: ${(err as Error).stack ?? err}\n`);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    server,
    url: `http://${shownHost === '127.0.0.1' ? '127.0.0.1' : shownHost}:${addr.port}`,
    close: async () => {
      unsubscribe();
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function sameOrigin(origin: string, req: IncomingMessage): boolean {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveStatic(path: string, res: ServerResponse): void {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(DASHBOARD_DIR, rel);
  if (!file.startsWith(DASHBOARD_DIR) || !existsSync(file))
    return json(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(readFileSync(file));
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}
