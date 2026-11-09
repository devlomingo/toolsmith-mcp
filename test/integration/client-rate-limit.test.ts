import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/server/http.js';
import { approveShop, makeHarness, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function client(url: string, token: string) {
  const c = new Client(
    { name: 'x', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

const call = (c: Client) => c.callTool({ name: 'shop__getUser', arguments: { userId: 1 } });
const text = (r: Awaited<ReturnType<typeof call>>) =>
  (r.content as Array<{ text: string }>)[0]!.text;

describe('per-client rate limits', () => {
  it('limits each client separately; the server default applies to clients without their own', async () => {
    h = await makeHarness({
      config: {
        server: {
          rateLimit: { requestsPerSecond: 0.001, burst: 2 },
          clients: [
            {
              name: 'tight',
              token: 'tok-tight',
              rateLimit: { requestsPerSecond: 0.001, burst: 3 },
            },
            {
              name: 'free',
              token: 'tok-free',
              rateLimit: { requestsPerSecond: 1000, burst: 1000 },
            },
          ],
        },
      },
    });
    await approveShop(h.app);
    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'tok-default',
      adminToken: 'adm',
    });
    try {
      const tight = await client(gw.url, 'tok-tight');
      for (let i = 0; i < 3; i++) expect((await call(tight)).isError).toBeFalsy();
      const limited = await call(tight);
      expect(limited.isError).toBe(true);
      expect(text(limited)).toMatch(/rate limit is exceeded/);

      const free = await client(gw.url, 'tok-free');
      for (let i = 0; i < 10; i++) expect((await call(free)).isError).toBeFalsy();

      const dflt = await client(gw.url, 'tok-default');
      expect((await call(dflt)).isError).toBeFalsy();
      expect((await call(dflt)).isError).toBeFalsy();
      expect((await call(dflt)).isError).toBe(true);
      // A limited call never reaches the API or the traces.
      const before = h.shop.requestCount;
      await call(tight);
      expect(h.shop.requestCount).toBe(before);
      await Promise.all([tight.close(), free.close(), dflt.close()]);
    } finally {
      await gw.close();
    }
  });

  it('OAuth clients use their own, then the oauth default, then the server default', async () => {
    h = await makeHarness({
      config: {
        server: {
          rateLimit: { requestsPerSecond: 0.001, burst: 5 },
          oauth: {
            issuer: 'http://127.0.0.1:1',
            resource: 'http://127.0.0.1/mcp',
            jwksUri: 'http://127.0.0.1:1/jwks',
            rateLimit: { requestsPerSecond: 0.001, burst: 2 },
            clients: [{ clientId: 'big', rateLimit: { requestsPerSecond: 0.001, burst: 4 } }],
          },
        },
      },
      importNow: false,
    });
    const spend = (p: string) => {
      let n = 0;
      while (h!.app.takeClientCall(p) === 0 && n < 100) n++;
      return n;
    };
    const { oauthPrincipalName } = await import('../../src/server/oauth.js');
    const big = `http:${oauthPrincipalName('big', 'u1')}`;
    expect(spend(big)).toBe(4);
    expect(spend(`http:${oauthPrincipalName('other', 'u1')}`)).toBe(2);
    expect(spend('http:someone')).toBe(5);
    expect(h.app.takeClientCall(big)).toBeGreaterThan(0);
    // Limits are per user too: another user of the same client has its own bucket.
    expect(spend(`http:${oauthPrincipalName('big', 'u2')}`)).toBe(4);
  });

  it('off by default', async () => {
    h = await makeHarness({ importNow: false });
    for (let i = 0; i < 1000; i++) expect(h.app.takeClientCall('http:default')).toBe(0);
  });
});
