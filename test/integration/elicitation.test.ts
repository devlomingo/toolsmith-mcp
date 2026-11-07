import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/server/http.js';
import { approveShop, makeHarness, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function elicitingClient(answer: 'accept' | 'decline', mode: 'auto' | 'legacy') {
  const c = new Client(
    { name: 'ui-client', version: '1' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode } },
  );
  const prompts: string[] = [];
  c.setRequestHandler('elicitation/create', async (req) => {
    prompts.push(String((req.params as { message: string }).message));
    return answer === 'accept'
      ? { action: 'accept', content: { approve: true } }
      : { action: 'decline' };
  });
  return { c, prompts };
}

describe('in-client approval through elicitation (opt-in)', () => {
  it('2026-07-28 over HTTP: the client is asked; accept runs the call once, decline falls back', async () => {
    h = await makeHarness({ config: { approvals: { inClient: true } } });
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'tok',
      adminToken: 'adm',
    });
    try {
      const yes = elicitingClient('accept', 'auto');
      await yes.c.connect(
        new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
          requestInit: { headers: { authorization: 'Bearer tok' } },
        }),
      );
      const r = await yes.c.callTool({ name: 'shop__deleteProduct', arguments: { id: 3 } });
      expect(r.isError).toBeFalsy();
      expect(yes.prompts[0]).toMatch(/Allow ONE call to shop__deleteProduct\?[\s\S]*"id": 3/);
      expect(h.shop.products.some((p) => p.id === 3)).toBe(false);
      expect(h.app.audit.list().some((a) => a.actor === 'human:client-elicitation')).toBe(true);

      const no = elicitingClient('decline', 'auto');
      await no.c.connect(
        new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
          requestInit: { headers: { authorization: 'Bearer tok' } },
        }),
      );
      const d = await no.c.callTool({ name: 'shop__deleteProduct', arguments: { id: 4 } });
      expect(d.isError).toBe(true);
      expect(JSON.stringify(d.content)).toMatch(/needs a human to approve/);
      expect(h.shop.products.some((p) => p.id === 4)).toBe(true);
      await yes.c.close();
      await no.c.close();
    } finally {
      await gw.close();
    }
  });

  it('clients without elicitation support keep the dashboard flow', async () => {
    h = await makeHarness({ config: { approvals: { inClient: true } } });
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'tok',
      adminToken: 'adm',
    });
    try {
      const c = new Client(
        { name: 'plain', version: '1' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      );
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
          requestInit: { headers: { authorization: 'Bearer tok' } },
        }),
      );
      const r = await c.callTool({ name: 'shop__deleteProduct', arguments: { id: 5 } });
      expect(r.isError).toBe(true);
      expect(h.shop.products.some((p) => p.id === 5)).toBe(true);
      await c.close();
    } finally {
      await gw.close();
    }
  });

  it('2025-11-25 over stdio: the legacy elicitation request reaches the client', async () => {
    h = await makeHarness({ importNow: false });
    const dir = mkdtempSync(join(tmpdir(), 'ts-elicit-'));
    writeFileSync(
      join(dir, 'toolsmith.config.json'),
      JSON.stringify({
        approvals: { inClient: true },
        integrations: [
          {
            name: 'shop',
            spec: `${h.shop.baseUrl}/openapi.json`,
            auth: { type: 'bearer', token: '${env:TEST_SHOP_TOKEN}' },
            allowPrivateNetwork: true,
          },
        ],
      }),
    );
    const { Toolsmith } = await import('../../src/app.js');
    const { loadConfig } = await import('../../src/config/config.js');
    const setup = new Toolsmith(loadConfig(join(dir, 'toolsmith.config.json')));
    await setup.importIntegration('shop', 'human:test', { live: false });
    setup.approve('shop', { allowWrite: true, allowDestructive: true }, 'human:test');
    await setup.close();
    const { c, prompts } = elicitingClient('accept', 'legacy');
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve('dist/cli/index.js'),
          'start',
          '--stdio',
          '--config',
          join(dir, 'toolsmith.config.json'),
        ],
        env: { ...process.env } as Record<string, string>,
      }),
    );
    const r = await c.callTool({ name: 'shop__deleteProduct', arguments: { id: 6 } });
    expect(prompts.length).toBe(1);
    expect(r.isError).toBeFalsy();
    expect(h.shop.products.some((p) => p.id === 6)).toBe(false);
    await c.close();
  });
});
