import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveShop, connectClient, makeHarness, startGateway, type Harness } from '../helpers.js';

type Row = Record<string, unknown>;

/** What an agent does by hand: user, their orders, then items + payments per order. */
async function agentWorkflow(client: Client, userId: number): Promise<number> {
  let calls = 0;
  const call = async (name: string, args: Row) => {
    calls++;
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Row;
  };
  await call('shop__getUser', { userId });
  const orders = (await call('shop__getOrders', { userId })).result as Row[];
  for (const o of orders) {
    await call('shop__getOrderItems', { orderId: o.id });
    await call('shop__getPayments', { orderId: o.id });
  }
  return calls;
}

describe('end-to-end lifecycle: API → tools → traces → pattern → composite → approval → use', () => {
  let h: Harness;
  let gw: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    h = await makeHarness({
      config: {
        patterns: { minSupport: 3, minConfidence: 0.6, maxLength: 6, episodeGapMs: 60_000 },
      },
    });
    await approveShop(h.app);
    gw = await startGateway(h.app);
  });
  afterAll(async () => {
    await gw.close();
    await h.close();
  });

  it('records traces for agent calls, with redaction and no raw results', async () => {
    for (const userId of [1, 2, 3, 4]) {
      const client = await connectClient(gw.url, 'auto', {
        'x-toolsmith-session': `agent-${userId}`,
      });
      await agentWorkflow(client, userId);
      await client.close();
    }
    const traces = h.app.traces.query({ limit: 500 });
    expect(traces.length).toBe(4 * (2 + 3 * 2));
    const t = traces.find((x) => x.tool === 'shop__getUser')!;
    expect(t.args).toEqual({ userId: expect.any(Number) });
    expect(JSON.stringify(t.resultFingerprints)).not.toContain('example.test'); // emails never stored
    expect(t.upstreamRequests).toBe(1);
  });

  it('discovers the repeated workflow with its data dependencies and loop', () => {
    const patterns = h.app.mine();
    const p = patterns[0]!;
    expect(p.signature).toBe(
      'shop__getOrders > shop__getUser > loop(shop__getOrderItems+shop__getPayments)',
    );
    expect(p.support).toBe(4);
    expect(p.elements[2]).toMatchObject({ kind: 'loop', sourceElement: 1, arrayPath: '[*]' });
    expect(p.args[2]!['shop__getOrderItems']).toEqual({ orderId: { type: 'item', path: 'id' } });
    expect(p.args[1]!['shop__getOrders']!.userId).toMatchObject({ type: 'shared', element: 0 });
  });

  it('proposes a composite, evaluates it against the original tools, and awaits approval', async () => {
    const out = await h.app.proposeComposites('system');
    const prop = out.find((o) => o.def?.steps.length === 4)!;
    expect(prop.error).toBeUndefined();
    expect(prop.def!.toolName).toBe('flow__getUserOrdersDetails');
    expect(prop.def!.inputSchema).toMatchObject({
      properties: { userId: expect.any(Object) },
      required: ['userId'],
    });
    expect(prop.version!.status).toBe('awaiting_approval');
    const ev = prop.version!.evaluation!;
    expect(ev.passed).toBe(true);
    expect(ev.checks.filter((c) => c.name.startsWith('equivalence')).every((c) => c.passed)).toBe(
      true,
    );
    expect(ev.metrics!.compositeMcpCalls).toBe(1);
    // not exposed before a human approves
    expect(h.app.catalog.has('flow__getUserOrdersDetails')).toBe(false);
  });

  it('refuses approval by a non-human actor', () => {
    expect(() =>
      h.app.approve(
        'flow-get-user-orders-details',
        { allowWrite: false, allowDestructive: false },
        'system',
      ),
    ).toThrow(/human/);
  });

  it('after approval the agent gets the same data in one MCP call', async () => {
    h.app.approve(
      'flow-get-user-orders-details',
      { allowWrite: false, allowDestructive: false },
      'human:test',
    );
    const client = await connectClient(gw.url, 'legacy');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('flow__getUserOrdersDetails');
    const before = h.shop.requestCount;
    const r = await client.callTool({
      name: 'flow__getUserOrdersDetails',
      arguments: { userId: 2 },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { results: Record<string, unknown>; partial: boolean };
    expect(sc.partial).toBe(false);
    expect((sc.results.getUser as Row).id).toBe(2);
    expect((sc.results.getOrders as Row[]).length).toBe(3);
    expect((sc.results.getOrderItems as unknown[]).length).toBe(3);
    expect(
      (sc.results.getPayments as unknown[][]).flat().every((p) => (p as Row).orderId !== undefined),
    ).toBe(true);
    // same underlying API requests as the manual workflow: 1 + 1 + 3 + 3
    expect(h.shop.requestCount - before).toBe(8);
    // the composite's own steps are traced as children
    const top = h.app.traces.query({ tool: 'flow__getUserOrdersDetails' })[0]!;
    expect(h.app.traces.children(top.id).length).toBe(8);
    await client.close();
  });

  it('disables and rolls back', async () => {
    const name = 'flow-get-user-orders-details';
    h.app.disable(name, 'human:test');
    expect(h.app.catalog.has('flow__getUserOrdersDetails')).toBe(false);
    h.app.enable(name, 'human:test');
    expect(h.app.catalog.has('flow__getUserOrdersDetails')).toBe(true);
  });
});
