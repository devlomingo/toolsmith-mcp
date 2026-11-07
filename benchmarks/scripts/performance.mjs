// Baseline vs optimized: the same workflows executed by an MCP client over
// Streamable HTTP, (a) one tool call at a time, (b) a best-case client that
// parallelizes every independent call itself, (c) one call to an approved
// composite. Upstream API requests are counted at the API server.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isDeepStrictEqual } from 'node:util';
import { Toolsmith } from '../../dist/app.js';
import { parseConfig } from '../../dist/config/config.js';
import { ShopApi } from '../../dist/demo/shop.js';
import { startHttpServer } from '../../dist/server/http.js';
import { quick, save, summarize } from './lib.mjs';

const ITER = quick ? 8 : 40;
const WARMUP = quick ? 2 : 5;
const LATENCIES = quick ? [0, 25] : [0, 10, 25, 50];

const SCENARIOS = {
  'order-details': {
    description: 'Customer + orders + items and payments of every order (fan-out, parallelizable)',
    input: (i) => ({ userId: (i % 25) + 1 }),
    composite: [
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
    async sequential(call, input) {
      const user = await call('shop__getUser', { userId: input.userId });
      const orders = await call('shop__getOrders', { userId: input.userId });
      const items = [];
      const payments = [];
      for (const o of orders) {
        items.push(await call('shop__getOrderItems', { orderId: o.id }));
        payments.push(await call('shop__getPayments', { orderId: o.id }));
      }
      return { getUser: user, getOrders: orders, getOrderItems: items, getPayments: payments };
    },
    async parallel(call, input) {
      const [user, orders] = await Promise.all([
        call('shop__getUser', { userId: input.userId }),
        call('shop__getOrders', { userId: input.userId }),
      ]);
      const [items, payments] = await Promise.all([
        Promise.all(orders.map((o) => call('shop__getOrderItems', { orderId: o.id }))),
        Promise.all(orders.map((o) => call('shop__getPayments', { orderId: o.id }))),
      ]);
      return { getUser: user, getOrders: orders, getOrderItems: items, getPayments: payments };
    },
  },
  'dependent-chain': {
    description:
      'Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)',
    input: (i) => ({ orderId: (i % 70) + 1 }),
    composite: [
      { id: 'getOrder', tool: 'shop__getOrder', args: { orderId: { $ref: 'input.orderId' } } },
      {
        id: 'getUser',
        tool: 'shop__getUser',
        args: { userId: { $ref: 'steps.getOrder.result.userId' } },
      },
      {
        id: 'getOrders',
        tool: 'shop__getOrders',
        args: { userId: { $ref: 'steps.getUser.result.id' } },
      },
    ],
    async sequential(call, input) {
      const order = await call('shop__getOrder', { orderId: input.orderId });
      const user = await call('shop__getUser', { userId: order.userId });
      const orders = await call('shop__getOrders', { userId: user.id });
      return { getOrder: order, getUser: user, getOrders: orders };
    },
    parallel: null, // no independent calls: identical to sequential
  },
};

async function setup(latencyMs) {
  const shop = new ShopApi({ token: 'bench-token', latencyMs });
  await shop.start();
  process.env.BENCH_SHOP_TOKEN = 'bench-token';
  const loaded = parseConfig(
    {
      integrations: [
        {
          name: 'shop',
          spec: `${shop.baseUrl}/openapi.json`,
          auth: { type: 'bearer', token: '${env:BENCH_SHOP_TOKEN}' },
          allowPrivateNetwork: true,
          rateLimit: { requestsPerSecond: 100000, burst: 100000 },
        },
      ],
      traces: { captureArguments: 'redacted' },
      composites: { maxSteps: 20, maxFanOut: 50, concurrency: 16, timeoutMs: 60000 },
    },
    process.cwd(),
  );
  const app = new Toolsmith(loaded, { dbPath: ':memory:' });
  await app.importIntegration('shop', 'human:bench', { live: false });
  app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:bench');
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    const props = Object.fromEntries(Object.keys(sc.input(0)).map((k) => [k, { type: 'integer' }]));
    const def = {
      kind: 'composite',
      name: `flow-${name}`,
      toolName: `flow__${name.replace(/-/g, '_')}`,
      description: sc.description,
      inputSchema: { type: 'object', properties: props, required: Object.keys(props) },
      steps: sc.composite,
      provenance: { type: 'manual' },
      examples: [],
    };
    const a = app.registry.ensureArtifact('composite', def.name);
    const { version } = app.registry.addVersion(a.id, def, 'benchmark', 'proposed', 'human:bench');
    const v = await app.runEvaluation(a.id, version.version, 'human:bench', {
      inputs: [sc.input(0)],
    });
    if (v.status !== 'awaiting_approval')
      throw new Error(`composite ${name} failed evaluation: ${JSON.stringify(v.evaluation)}`);
    app.approve(def.name, { allowWrite: false, allowDestructive: false }, 'human:bench');
  }
  const http = await startHttpServer(app, {
    host: '127.0.0.1',
    port: 0,
    mcpToken: 'bench-mcp',
    adminToken: 'bench-admin',
  });
  const client = new Client(
    { name: 'bench', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer bench-mcp' } },
    }),
  );
  return { shop, app, http, client };
}

async function measure(env, scenario, variant) {
  const sc = SCENARIOS[scenario];
  const latencies = [];
  let mcpCalls = 0;
  let resultBytes = 0;
  let errors = 0;
  let correct = 0;
  const apiBefore = env.shop.requestCount;
  const cpu0 = process.cpuUsage();
  let peakRss = 0;
  const call = async (name, args) => {
    mcpCalls++;
    const r = await env.client.callTool({ name, arguments: args });
    resultBytes += JSON.stringify(r.content).length;
    if (r.isError) throw new Error(r.content?.[0]?.text);
    const sc2 = r.structuredContent;
    return sc2 && 'result' in sc2 && Object.keys(sc2).length === 1 ? sc2.result : sc2;
  };
  const toolName = `flow__${scenario.replace(/-/g, '_')}`;
  for (let i = -WARMUP; i < ITER; i++) {
    const input = sc.input(i + WARMUP);
    const callsBefore = mcpCalls;
    const bytesBefore = resultBytes;
    const apiAt = env.shop.requestCount;
    const t0 = performance.now();
    let out;
    try {
      if (variant === 'sequential') out = await sc.sequential(call, input);
      else if (variant === 'parallel-client') out = await sc.parallel(call, input);
      else out = (await call(toolName, input)).results;
    } catch {
      errors++;
    }
    const dt = performance.now() - t0;
    if (i < 0) {
      mcpCalls = callsBefore;
      resultBytes = bytesBefore;
      env.shop.requestCount = apiAt;
      continue;
    }
    latencies.push(dt);
    // correctness: compare against a fresh sequential reference for the same input
    if (out) {
      const savedCalls = mcpCalls;
      const savedBytes = resultBytes;
      const savedApi = env.shop.requestCount;
      const ref = await sc.sequential(call, input);
      mcpCalls = savedCalls;
      resultBytes = savedBytes;
      env.shop.requestCount = savedApi;
      if (isDeepStrictEqual(ref, out)) correct++;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const cpu = process.cpuUsage(cpu0);
  return {
    name: variant,
    latency: summarize(latencies),
    mcpCalls: Math.round((mcpCalls / ITER) * 100) / 100,
    apiRequests: Math.round(((env.shop.requestCount - apiBefore) / ITER) * 100) / 100,
    resultBytesPerRun: Math.round(resultBytes / ITER),
    successRate: (ITER - errors) / ITER,
    correctness: correct / (ITER - errors || 1),
    errors,
    cpuMsPerRun: Math.round(((cpu.user + cpu.system) / 1000 / ITER) * 100) / 100,
    peakRssMb: Math.round(peakRss / 1e6),
  };
}

const scenarios = [];
for (const latencyMs of LATENCIES) {
  const env = await setup(latencyMs);
  for (const name of Object.keys(SCENARIOS)) {
    const variants = [
      'sequential',
      ...(SCENARIOS[name].parallel ? ['parallel-client'] : []),
      'composite',
    ];
    const results = [];
    for (const v of variants) results.push(await measure(env, name, v));
    scenarios.push({
      name: `${name} @ ${latencyMs} ms API latency`,
      scenario: name,
      apiLatencyMs: latencyMs,
      description: SCENARIOS[name].description,
      variants: results,
    });
    const line = results
      .map(
        (r) =>
          `${r.name}: p50 ${r.latency.p50} ms, ${r.mcpCalls} MCP, ${r.apiRequests} API, correct ${r.correctness}`,
      )
      .join(' | ');
    console.log(`${name} @${latencyMs}ms → ${line}`);
  }
  await env.client.close();
  await env.http.close();
  await env.app.close();
  await env.shop.stop();
}

save('performance', {
  iterations: ITER,
  warmup: WARMUP,
  notes: [
    'Latency is measured at the MCP client: one workflow run, end to end, over Streamable HTTP on loopback (protocol 2026-07-28).',
    'No LLM is involved. Agent reasoning time between tool calls is NOT included, so real agents see larger absolute savings per avoided round-trip; this benchmark does not measure that and makes no claim about it.',
    'LLM requests and tokens are not measured. resultBytesPerRun is the size of tool results returned to the client, not a token count.',
    'apiRequests is counted by the demo API server itself.',
    'correctness = fraction of runs whose result deep-equals a sequential reference run for the same input.',
  ],
  scenarios,
});
