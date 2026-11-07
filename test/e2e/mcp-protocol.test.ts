import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveShop, connectClient, makeHarness, startGateway, type Harness } from '../helpers.js';

describe('MCP protocol: both eras over Streamable HTTP', () => {
  let h: Harness;
  let gw: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    h = await makeHarness();
    await approveShop(h.app);
    gw = await startGateway(h.app);
  });
  afterAll(async () => {
    await gw.close();
    await h.close();
  });

  for (const mode of ['legacy', 'auto'] as const) {
    it(`${mode} client lists generated tools with schemas and annotations`, async () => {
      const client = await connectClient(gw.url, mode);
      expect(client.getNegotiatedProtocolVersion()).toBe(
        mode === 'auto' ? '2026-07-28' : '2025-11-25',
      );
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'shop__getProducts',
          'shop__getProduct',
          'shop__getOrders',
          'shop__getOrder',
          'toolsmith__request_capability',
        ]),
      );
      // write/destructive tools are hidden until granted
      expect(names).not.toContain('shop__createProduct');
      expect(names).not.toContain('shop__deleteProduct');
      const getProduct = tools.find((t) => t.name === 'shop__getProduct')!;
      expect(getProduct.inputSchema).toMatchObject({ type: 'object', required: ['id'] });
      expect(getProduct.outputSchema).toMatchObject({ type: 'object' });
      expect(getProduct.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      await client.close();
    });

    it(`${mode} client calls a generated tool and gets structured content`, async () => {
      const client = await connectClient(gw.url, mode);
      const res = await client.callTool({ name: 'shop__getProduct', arguments: { id: 3 } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ id: 3, name: 'Product 3' });
      const list = await client.callTool({
        name: 'shop__getProducts',
        arguments: { category: 'books' },
      });
      expect((list.structuredContent as { result: unknown[] }).result.length).toBeGreaterThan(0);
      await client.close();
    });
  }

  it('rejects requests without the MCP bearer token', async () => {
    const res = await fetch(`${gw.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin browser requests', async () => {
    const res = await fetch(`${gw.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-mcp-token-abcdef',
        origin: 'https://evil.example',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});
