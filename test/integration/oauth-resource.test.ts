import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/server/http.js';
import { approveShop, makeHarness, type Harness } from '../helpers.js';

const RESOURCE = 'http://127.0.0.1/mcp';
let issuerServer: Server;
let issuer = '';
let key: CryptoKey;
let otherKey: CryptoKey;
let jwk: JWK;
let jwksHits = 0;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  ({ privateKey: otherKey } = await generateKeyPair('ES256'));
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  issuerServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/oauth-authorization-server')
      return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    if (req.url === '/jwks') {
      jwksHits++;
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => issuerServer.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => issuerServer.close(() => r())));

async function token(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; exp?: string | number; iss?: string; aud?: string } = {},
): Promise<string> {
  return new SignJWT({ client_id: 'agent-a', scope: 'mcp:tools', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? key);
}

async function connect(url: string, bearer: string) {
  const c = new Client(
    { name: 'oauth-test', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );
  return c;
}

async function withGateway(
  oauth: Record<string, unknown>,
  fn: (url: string, h: Harness) => Promise<void>,
): Promise<void> {
  const h = await makeHarness({
    config: { server: { oauth: { issuer, resource: RESOURCE, ...oauth } } },
  });
  await approveShop(h.app);
  const gw = await startHttpServer(h.app, {
    host: '127.0.0.1',
    port: 0,
    mcpToken: 'static-tok',
    adminToken: 'adm',
  });
  try {
    await fn(gw.url, h);
  } finally {
    await gw.close();
    await h.close();
  }
}

const post = (url: string, bearer?: string) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('gateway as an OAuth 2.1 resource server', () => {
  it('serves protected-resource metadata and challenges unauthenticated calls', async () => {
    await withGateway({ requiredScopes: ['mcp:tools'] }, async (url) => {
      const meta = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(meta).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [issuer],
        scopes_supported: ['mcp:tools'],
      });
      const r = await post(url);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain(
        'resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
      );
    });
  });

  it('a valid token runs the full cycle: list, call, trace under the token client', async () => {
    await withGateway({}, async (url, h) => {
      const c = await connect(url, await token());
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toContain('shop__getUser');
      const r = await c.callTool({ name: 'shop__getUser', arguments: { userId: 1 } });
      expect(r.isError).toBeFalsy();
      await c.close();
      const sessions = h.app.traces.chronological().map((t) => t.sessionId);
      expect(sessions.some((s) => s.startsWith('http:oauth:agent-a/'))).toBe(true);
    });
  });

  it('refuses wrong audience, wrong issuer, expired, foreign-key and unsigned tokens', async () => {
    await withGateway({}, async (url) => {
      const now = Math.floor(Date.now() / 1000);
      const bad = [
        await token({}, { aud: 'https://other.example/mcp' }),
        await token({}, { iss: 'https://evil.example' }),
        await token({}, { exp: now - 3600 }),
        await token({}, { key: otherKey }),
        // alg "none"
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
          JSON.stringify({ iss: issuer, aud: RESOURCE, exp: now + 300, client_id: 'x' }),
        ).toString('base64url')}.`,
        'not-a-jwt',
      ];
      for (const t of bad) {
        const r = await post(url, t);
        expect(r.status, t.slice(0, 40)).toBe(401);
      }
    });
  });

  it('missing scope is 403 insufficient_scope; static tokens still work', async () => {
    await withGateway({ requiredScopes: ['mcp:tools'] }, async (url) => {
      const r = await post(url, await token({ scope: 'other' }));
      expect(r.status).toBe(403);
      expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
      expect((await post(url, 'static-tok')).status).toBe(200);
    });
  });

  it('per-client exposure applies to OAuth clients; client ids cannot impersonate static clients', async () => {
    await withGateway(
      {
        clients: [{ clientId: 'agent-a', exposure: { tools: ['shop__getUser'] } }],
        exposure: { tools: ['shop__getProducts'] },
      },
      async (url) => {
        const a = await connect(url, await token());
        expect((await a.listTools()).tools.map((t) => t.name)).not.toContain('shop__getOrders');
        const denied = await a.callTool({ name: 'shop__getOrders', arguments: { userId: 1 } });
        expect(denied.isError).toBe(true);
        await a.close();
        // An unlisted client gets the oauth default, and a client id that
        // looks like a static client name maps to an oauth: principal.
        const b = await connect(url, await token({ client_id: 'default' }));
        const names = (await b.listTools()).tools.map((t) => t.name);
        expect(names).toContain('shop__getProducts');
        expect(names).not.toContain('shop__getUser');
        await b.close();
        const weird = await connect(url, await token({ client_id: '\ud800x%' + 'y'.repeat(500) }));
        await weird.listTools();
        await weird.close();
      },
    );
  });

  it('discovers the JWKS from issuer metadata and caches it', async () => {
    const before = jwksHits;
    await withGateway({}, async (url) => {
      for (let i = 0; i < 5; i++) expect((await post(url, await token())).status).toBe(200);
    });
    expect(jwksHits - before).toBe(1);
  });
});
