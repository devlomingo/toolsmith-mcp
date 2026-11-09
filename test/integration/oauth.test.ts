import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { approveShop, makeHarness, SHOP_TOKEN, type Harness } from '../helpers.js';

let h: Harness | undefined;
let close: (() => void) | undefined;
afterEach(async () => {
  close?.();
  await h?.close();
  h = undefined;
});

/** A token endpoint: first token it issues is already "expired" at the API, later ones are valid. */
async function tokenServer(): Promise<{ url: string; requests: () => number }> {
  let n = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      n++;
      if (
        form.get('grant_type') !== 'client_credentials' ||
        form.get('client_secret') !== 'oauth-client-secret-xyz'
      ) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"invalid_client"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: n === 1 ? 'stale-token-0001' : SHOP_TOKEN,
          token_type: 'bearer',
          expires_in: 3600,
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  close = () => srv.close();
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/token`,
    requests: () => n,
  };
}

describe('OAuth 2.0 client credentials', () => {
  it('fetches, caches, and refreshes a rejected token once; never exposes it', async () => {
    const ts = await tokenServer();
    process.env.OAUTH_SECRET = 'oauth-client-secret-xyz';
    h = await makeHarness({
      shop: { expiredTokens: ['stale-token-0001'] },
      importNow: false,
      integration: {
        auth: {
          type: 'oauth2ClientCredentials',
          tokenUrl: ts.url,
          clientId: 'toolsmith',
          clientSecret: '${env:OAUTH_SECRET}',
          scope: 'read',
        },
      },
    });
    await h.app.importIntegration('shop', 'human:test', { live: false });
    await approveShop(h.app);
    const r1 = await h.app.call('shop__getProduct', { id: 1 }, { sessionId: 's' });
    expect(r1.ok).toBe(true); // first token rejected (401), refreshed once, retried
    expect(r1.retries).toBe(1);
    expect(ts.requests()).toBe(2);
    const r2 = await h.app.call('shop__getProduct', { id: 2 }, { sessionId: 's' });
    expect(r2.ok).toBe(true);
    expect(ts.requests()).toBe(2); // cached
    const stored = JSON.stringify(await h.app.traces.query({ limit: 100 }));
    expect(stored).not.toContain(SHOP_TOKEN);
    expect(stored).not.toContain('oauth-client-secret-xyz');
  });

  it('reports refused client credentials as an auth error naming the variable', async () => {
    const ts = await tokenServer();
    process.env.OAUTH_SECRET_BAD = 'wrong';
    h = await makeHarness({
      importNow: false,
      integration: {
        auth: {
          type: 'oauth2ClientCredentials',
          tokenUrl: ts.url,
          clientId: 'toolsmith',
          clientSecret: '${env:OAUTH_SECRET_BAD}',
        },
      },
    });
    await h.app.importIntegration('shop', 'human:test', { live: false });
    await approveShop(h.app);
    const r = await h.app.call('shop__getProduct', { id: 1 }, { sessionId: 's' });
    expect(r).toMatchObject({ ok: false, errorCode: 'auth' });
    expect(r.error).toMatch(/OAUTH_SECRET_BAD/);
  });
});
