import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompositeDef } from '../../src/composite/plan.js';
import type { JsonValue } from '../../src/core/types.js';
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

describe('tool exposure per client', () => {
  it('allow-lists restrict listing and calling; search mode lists only meta and pinned tools', async () => {
    h = await makeHarness({
      config: {
        server: {
          clients: [
            {
              name: 'orders-only',
              token: 'tok-orders',
              exposure: { tools: ['shop__*Order*', 'flow__*'] },
            },
            {
              name: 'searcher',
              token: 'tok-search',
              exposure: { list: 'search', pinned: ['shop__getProducts'] },
            },
          ],
        },
      },
    });
    await approveShop(h.app);
    // a composite that reaches outside the orders-only allow-list
    const art = await h.app.registry.ensureArtifact('composite', 'flow-mixed');
    const def: CompositeDef = {
      kind: 'composite',
      name: 'flow-mixed',
      toolName: 'flow__mixed',
      description: 'x',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'integer' } },
        required: ['userId'],
      },
      steps: [{ id: 'u', tool: 'shop__getUser', args: { userId: { $ref: 'input.userId' } } }],
      provenance: { type: 'manual' },
      examples: [],
    };
    await h.app.registry.addVersion(
      art.id,
      def as unknown as JsonValue,
      'manual',
      'awaiting_approval',
      'human:test',
    );
    await h.app.approve('flow-mixed', { allowWrite: false, allowDestructive: false }, 'human:test');

    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'tok-all',
      adminToken: 'adm',
    });
    try {
      const all = await client(gw.url, 'tok-all');
      const allNames = (await all.listTools()).tools.map((t) => t.name);
      expect(allNames).toEqual(
        expect.arrayContaining([
          'shop__getProducts',
          'shop__getUser',
          'flow__mixed',
          'toolsmith__search_tools',
        ]),
      );

      const orders = await client(gw.url, 'tok-orders');
      const names = (await orders.listTools()).tools.map((t) => t.name).sort();
      expect(names.filter((n) => !n.startsWith('toolsmith__'))).toEqual([
        'shop__getOrder',
        'shop__getOrderItems',
        'shop__getOrders',
        'shop__listOrders',
      ]);
      const denied = await orders.callTool({ name: 'shop__getUser', arguments: { userId: 1 } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toMatch(/not available to this client/);
      // the composite matches flow__* but calls shop__getUser, which this client may not use
      expect(
        (await orders.callTool({ name: 'flow__mixed', arguments: { userId: 1 } })).isError,
      ).toBe(true);
      expect(
        (await orders.callTool({ name: 'shop__getOrder', arguments: { orderId: 1 } })).isError,
      ).toBeFalsy();

      const searcher = await client(gw.url, 'tok-search');
      const listed = (await searcher.listTools()).tools.map((t) => t.name).sort();
      expect(listed).toEqual([
        'shop__getProducts',
        'toolsmith__request_capability',
        'toolsmith__search_tools',
      ]);
      const found = await searcher.callTool({
        name: 'toolsmith__search_tools',
        arguments: { query: 'payments for an order' },
      });
      const tools =
        (found.structuredContent as { tools: Array<{ name: string }> } | undefined)?.tools ??
        JSON.parse((found.content as Array<{ text: string }>)[0]!.text).tools;
      expect(tools[0].name).toBe('shop__getPayments');
      // unlisted but allowed: callable after search
      expect(
        (await searcher.callTool({ name: 'shop__getPayments', arguments: { orderId: 1 } })).isError,
      ).toBeFalsy();
      for (const c of [all, orders, searcher]) await c.close();
    } finally {
      await gw.close();
    }
  });
});
