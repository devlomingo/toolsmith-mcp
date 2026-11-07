import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompositeDef } from '../../src/composite/plan.js';
import type { JsonValue } from '../../src/core/types.js';
import { approveShop, makeHarness, SHOP_TOKEN, type Harness } from '../helpers.js';

let h: Harness | undefined;
let stop: (() => void) | undefined;
afterEach(async () => {
  await h?.close();
  stop?.();
  h = undefined;
});

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number };
}

async function collector(): Promise<{ url: string; spans: Span[] }> {
  const spans: Span[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/v1/traces') {
        for (const rs of JSON.parse(body).resourceSpans)
          for (const ss of rs.scopeSpans) spans.push(...ss.spans);
      }
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  stop = () => srv.close();
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, spans };
}

describe('OpenTelemetry export', () => {
  it('exports tool calls as spans, composite steps as children, without arguments or secrets', async () => {
    const col = await collector();
    h = await makeHarness({ config: { telemetry: { otlpEndpoint: col.url } } });
    await approveShop(h.app);
    const art = h.app.registry.ensureArtifact('composite', 'flow-otel');
    const def: CompositeDef = {
      kind: 'composite',
      name: 'flow-otel',
      toolName: 'flow__otel',
      description: 'x',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'integer' } },
        required: ['userId'],
      },
      steps: [
        { id: 'u', tool: 'shop__getUser', args: { userId: { $ref: 'input.userId' } } },
        { id: 'o', tool: 'shop__getOrders', args: { userId: { $ref: 'input.userId' } } },
      ],
      provenance: { type: 'manual' },
      examples: [],
    };
    h.app.registry.addVersion(
      art.id,
      def as unknown as JsonValue,
      'manual',
      'awaiting_approval',
      'human:test',
    );
    h.app.approve('flow-otel', { allowWrite: false, allowDestructive: false }, 'human:test');
    await h.app.call('flow__otel', { userId: 3 }, { sessionId: 'otel-session' });
    await h.app.call('shop__getProduct', { id: 9999 }, { sessionId: 'otel-session' });
    await h.app.otel!.flush();
    const byName = (n: string) => col.spans.filter((s) => s.name === `tools/call ${n}`);
    const parent = byName('flow__otel')[0]!;
    const children = [...byName('shop__getUser'), ...byName('shop__getOrders')];
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c.parentSpanId).toBe(parent.spanId);
      expect(c.traceId).toBe(parent.traceId);
    }
    const attrs = Object.fromEntries(
      parent.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
    );
    expect(attrs).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'flow__otel',
      'mcp.session.id': 'otel-session',
      'toolsmith.upstream_requests': '2',
    });
    expect(attrs['gen_ai.tool.call.arguments']).toBeUndefined();
    const failed = byName('shop__getProduct')[0]!;
    expect(failed.status.code).toBe(2);
    expect(JSON.stringify(col.spans)).not.toContain(SHOP_TOKEN);
    expect(h.app.otel!.exported).toBe(col.spans.length);
  });

  it('never breaks tool calls when the collector is down', async () => {
    h = await makeHarness({ config: { telemetry: { otlpEndpoint: 'http://127.0.0.1:9' } } });
    await approveShop(h.app);
    expect((await h.app.call('shop__getProduct', { id: 1 }, { sessionId: 's' })).ok).toBe(true);
    await h.app.otel!.flush();
    expect(h.app.otel!.failed).toBe(1);
  });
});
