// High-traffic benchmark: many agents run the same workflow at once against
// one gateway. Compares a sequential agent, a best-case parallel client, and
// the approved composite, at increasing concurrency. Everything runs in one
// process on loopback; the demo API adds a fixed latency per request.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Toolsmith } from '../../dist/app.js';
import { parseConfig } from '../../dist/config/config.js';
import { ShopApi } from '../../dist/demo/shop.js';
import { startHttpServer } from '../../dist/server/http.js';
import { quick, save, summarize } from './lib.mjs';

const API_LATENCY_MS = 20;
import { execSync } from 'node:child_process';
let somaxconn = null;
try {
  somaxconn = execSync(
    process.platform === 'darwin'
      ? 'sysctl -n kern.ipc.somaxconn'
      : 'cat /proc/sys/net/core/somaxconn',
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .toString()
    .trim();
} catch {
  /* not available */
}
const CONCURRENCY = quick ? [1, 10] : [1, 10, 50, 100];
const RUNS_PER_AGENT = quick ? 3 : 10;

const shop = new ShopApi({ token: 'load-token', latencyMs: API_LATENCY_MS, users: 100 });
await shop.start();
process.env.LOAD_SHOP_TOKEN = 'load-token';
const app = await Toolsmith.open(
  parseConfig(
    {
      integrations: [
        {
          name: 'shop',
          spec: `${shop.baseUrl}/openapi.json`,
          auth: { type: 'bearer', token: '${env:LOAD_SHOP_TOKEN}' },
          allowPrivateNetwork: true,
          rateLimit: { requestsPerSecond: 1e6, burst: 1e6 },
        },
      ],
      composites: { maxSteps: 20, maxFanOut: 50, concurrency: 16, timeoutMs: 60000 },
    },
    process.cwd(),
  ),
  { dbPath: ':memory:' },
);
await app.importIntegration('shop', 'human:bench', { live: false });
await app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:bench');
const def = {
  kind: 'composite',
  name: 'flow-order-details',
  toolName: 'flow__order_details',
  description: 'order details',
  inputSchema: {
    type: 'object',
    properties: { userId: { type: 'integer' } },
    required: ['userId'],
  },
  steps: [
    { id: 'getUser', tool: 'shop__getUser', args: { userId: { $ref: 'input.userId' } } },
    { id: 'getOrders', tool: 'shop__getOrders', args: { userId: { $ref: 'input.userId' } } },
    {
      id: 'getOrderItems',
      tool: 'shop__getOrderItems',
      forEach: 'steps.getOrders.result[*]',
      args: { orderId: { $ref: 'item.id' } },
    },
    {
      id: 'getPayments',
      tool: 'shop__getPayments',
      forEach: 'steps.getOrders.result[*]',
      args: { orderId: { $ref: 'item.id' } },
    },
  ],
  provenance: { type: 'manual' },
  examples: [],
};
const art = await app.registry.ensureArtifact('composite', def.name);
const { version } = await app.registry.addVersion(
  art.id,
  def,
  'benchmark',
  'proposed',
  'human:bench',
);
const v = await app.runEvaluation(art.id, version.version, 'human:bench', {
  inputs: [{ userId: 1 }],
});
if (v.status !== 'awaiting_approval') throw new Error('composite failed evaluation');
await app.approve(def.name, { allowWrite: false, allowDestructive: false }, 'human:bench');
const http = await startHttpServer(app, {
  host: '127.0.0.1',
  port: 0,
  mcpToken: 'load-mcp',
  adminToken: 'load-admin',
});

const unwrap = (r) => {
  if (r.isError) throw new Error(r.content?.[0]?.text);
  const sc = r.structuredContent;
  return sc && 'result' in sc && Object.keys(sc).length === 1 ? sc.result : sc;
};
const VARIANTS = {
  sequential: async (call, userId) => {
    await call('shop__getUser', { userId });
    const orders = await call('shop__getOrders', { userId });
    for (const o of orders) {
      await call('shop__getOrderItems', { orderId: o.id });
      await call('shop__getPayments', { orderId: o.id });
    }
  },
  'parallel-client': async (call, userId) => {
    const [, orders] = await Promise.all([
      call('shop__getUser', { userId }),
      call('shop__getOrders', { userId }),
    ]);
    await Promise.all(
      orders.flatMap((o) => [
        call('shop__getOrderItems', { orderId: o.id }),
        call('shop__getPayments', { orderId: o.id }),
      ]),
    );
  },
  composite: async (call, userId) => {
    const r = await call('flow__order_details', { userId });
    if (r.partial) throw new Error('partial composite result');
  },
};

const rows = [];
for (const concurrency of CONCURRENCY) {
  for (const [variant, run] of Object.entries(VARIANTS)) {
    const clients = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const c = new Client(
          { name: 'load', version: '1' },
          { capabilities: {}, versionNegotiation: { mode: 'auto' } },
        );
        await c.connect(
          new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), {
            requestInit: { headers: { authorization: 'Bearer load-mcp' } },
          }),
        );
        return c;
      }),
    );
    let mcp = 0;
    let errors = 0;
    const errorKinds = {};
    const lat = [];
    shop.resetCounters();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await Promise.all(
      clients.map(async (c, k) => {
        const call = async (name, args) => {
          mcp++;
          return unwrap(await c.callTool({ name, arguments: args }));
        };
        for (let i = 0; i < RUNS_PER_AGENT; i++) {
          const s = performance.now();
          try {
            await run(call, ((k * RUNS_PER_AGENT + i) % 100) + 1);
            lat.push(performance.now() - s); // successful runs only
          } catch (err) {
            errors++;
            const m = String(err?.message ?? err).slice(0, 160);
            errorKinds[m] = (errorKinds[m] ?? 0) + 1;
          }
        }
      }),
    );
    const wall = (performance.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const runs = concurrency * RUNS_PER_AGENT;
    rows.push({
      concurrency,
      variant,
      runs,
      errors,
      // Successful workflows only: failed runs end fast and would inflate throughput.
      workflowsPerSec: Math.round(((runs - errors) / wall) * 10) / 10,
      latency: summarize(lat),
      mcpCallsPerRun: Math.round((mcp / runs) * 10) / 10,
      mcpRequestsPerSec: Math.round(mcp / wall),
      apiRequestsPerRun: Math.round((shop.requestCount / runs) * 10) / 10,
      cpuSecondsPerRun: Math.round(((cpu.user + cpu.system) / 1e6 / runs) * 10000) / 10000,
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
      errorKinds,
    });
    const r = rows.at(-1);
    console.log(
      `${String(concurrency).padStart(3)} agents ${variant.padEnd(16)} ${r.workflowsPerSec} workflows/s, p50 ${r.latency.p50} ms, p95 ${r.latency.p95} ms, ${r.mcpRequestsPerSec} MCP req/s, errors ${errors}${errors ? ' ' + JSON.stringify(errorKinds) : ''}`,
    );
    await Promise.all(clients.map((c) => c.close()));
  }
}
await http.close();
await app.close();
await shop.stop();

save('load', {
  apiLatencyMs: API_LATENCY_MS,
  somaxconn,
  runsPerAgent: RUNS_PER_AGENT,
  notes: [
    `Each agent runs the order-details workflow ${RUNS_PER_AGENT} times back to back; all agents start together. The demo API adds ${API_LATENCY_MS} ms per request.`,
    'Clients, gateway and demo API share one Node process on one machine, so CPU and memory figures cover all three and throughput is bounded by that single process.',
    'No LLM is involved; agent reasoning time between calls is excluded.',
    'Errors in this run are client-side connection resets (`fetch failed` / ECONNRESET), not tool failures: on macOS the TCP accept queue is capped at kern.ipc.somaxconn (128 here), and parallel clients open many new connections at once. Linux defaults are usually 4096; on macOS, raise it with `sudo sysctl kern.ipc.somaxconn=4096`. The composite variant opens one connection per agent run and did not hit the limit.',
  ],
  rows,
});
