// Scalability: (1) pattern mining time vs trace volume, (2) gateway
// throughput and latency vs concurrent clients, (3) tools/list and import
// time vs catalog size.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Toolsmith } from '../../dist/app.js';
import { parseConfig } from '../../dist/config/config.js';
import { ShopApi } from '../../dist/demo/shop.js';
import { importOpenApi } from '../../dist/openapi/import.js';
import { minePatterns } from '../../dist/patterns/miner.js';
import { generateTraces, NOISE_TOOLS, STANDARD_WORKFLOWS } from '../../dist/patterns/synthetic.js';
import { startHttpServer } from '../../dist/server/http.js';
import { quick, save, summarize } from './lib.mjs';

// 1. Mining
const mining = [];
for (const sessions of quick ? [200, 1000] : [200, 1000, 5000, 20000]) {
  const { traces } = generateTraces({
    workflows: STANDARD_WORKFLOWS,
    noiseTools: NOISE_TOOLS,
    sessions,
    workflowRate: 0.6,
    noiseRate: 0.3,
    seed: 1,
  });
  const times = [];
  for (let i = 0; i < (quick ? 1 : 3); i++) {
    const t0 = performance.now();
    minePatterns(traces, {
      minSupport: 3,
      minConfidence: 0.6,
      maxLength: 6,
      episodeGapMs: 120_000,
    });
    times.push(performance.now() - t0);
  }
  mining.push({ sessions, traces: traces.length, ms: summarize(times) });
  console.log(`mining ${traces.length} traces: ${mining.at(-1).ms.p50} ms`);
}

// 2. Gateway throughput
const shop = new ShopApi({ token: 't', latencyMs: 5 });
await shop.start();
process.env.SCALE_TOKEN = 't';
const loaded = parseConfig(
  {
    integrations: [
      {
        name: 'shop',
        spec: `${shop.baseUrl}/openapi.json`,
        auth: { type: 'bearer', token: '${env:SCALE_TOKEN}' },
        allowPrivateNetwork: true,
        rateLimit: { requestsPerSecond: 1e6, burst: 1e6 },
      },
    ],
  },
  process.cwd(),
);
const app = await Toolsmith.open(loaded, { dbPath: ':memory:' });
await app.importIntegration('shop', 'human:bench', { live: false });
await app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:bench');
const http = await startHttpServer(app, {
  host: '127.0.0.1',
  port: 0,
  mcpToken: 'm',
  adminToken: 'a',
});
const throughput = [];
const PER_CLIENT = quick ? 20 : 100;
for (const concurrency of quick ? [1, 10] : [1, 10, 50, 100]) {
  const clients = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const c = new Client(
        { name: 'scale', version: '1' },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      );
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), {
          requestInit: { headers: { authorization: 'Bearer m' } },
        }),
      );
      return c;
    }),
  );
  const lat = [];
  let errors = 0;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await Promise.all(
    clients.map(async (c, k) => {
      for (let i = 0; i < PER_CLIENT; i++) {
        const s = performance.now();
        const r = await c.callTool({
          name: 'shop__getProduct',
          arguments: { id: ((k + i) % 20) + 1 },
        });
        if (r.isError) errors++;
        lat.push(performance.now() - s);
      }
    }),
  );
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  throughput.push({
    concurrency,
    calls: lat.length,
    errors,
    callsPerSec: Math.round((lat.length / wall) * 1000),
    latency: summarize(lat),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  });
  console.log(
    `concurrency ${concurrency}: ${throughput.at(-1).callsPerSec} calls/s, p95 ${throughput.at(-1).latency.p95} ms, errors ${errors}`,
  );
  await Promise.all(clients.map((c) => c.close()));
}
await http.close();
await app.close();
await shop.stop();

// 3. Catalog size
function bigSpec(n) {
  const paths = {};
  for (let i = 0; i < n; i++) {
    paths[`/resource${i}/{id}`] = {
      get: {
        operationId: `getResource${i}`,
        summary: `Get resource ${i}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: `Big ${n}`, version: '1' },
    servers: [{ url: 'https://big.example.com' }],
    paths,
  };
}
const catalog = [];
for (const n of quick ? [50, 500] : [50, 200, 1000, 2000]) {
  const t0 = performance.now();
  const def = await importOpenApi(bigSpec(n), { name: 'big' });
  const importMs = performance.now() - t0;
  const cfg = parseConfig({ integrations: [{ name: 'big', spec: 'inline' }] }, process.cwd());
  const a = await Toolsmith.open(cfg, { dbPath: ':memory:' });
  const art = await a.registry.ensureArtifact('openapi', 'big');
  await a.registry.addVersion(art.id, def, 'bench', 'approved', 'human:bench');
  const t1 = performance.now();
  await a.registry.publish(art.id, 1, 'human:bench'); // triggers catalog rebuild
  const rebuildMs = performance.now() - t1;
  const http2 = await startHttpServer(a, {
    host: '127.0.0.1',
    port: 0,
    mcpToken: 'm',
    adminToken: 'a',
  });
  const c = new Client(
    { name: 'list', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${http2.url}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer m' } },
    }),
  );
  const lt = [];
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    count = (await c.listTools()).tools.length;
    lt.push(performance.now() - s);
  }
  await c.close();
  await http2.close();
  await a.close();
  catalog.push({
    operations: n,
    tools: count,
    importMs: Math.round(importMs),
    catalogRebuildMs: Math.round(rebuildMs * 10) / 10,
    listToolsMs: summarize(lt),
  });
  console.log(
    `${n} operations: import ${Math.round(importMs)} ms, tools/list p50 ${catalog.at(-1).listToolsMs.p50} ms`,
  );
}

save('scalability', {
  notes: [
    'Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.',
  ],
  mining,
  throughput,
  catalog,
});
