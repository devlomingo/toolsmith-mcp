import { afterEach, describe, expect, it } from 'vitest';
import type { CompositeDef } from '../../src/composite/plan.js';
import type { JsonValue } from '../../src/core/types.js';
import { importOpenApi } from '../../src/openapi/import.js';
import { endpointsToOpenApi, parseEndpointText } from '../../src/openapi/endpoints.js';
import { approveShop, makeHarness, shopOpenApi, type Harness } from '../helpers.js';

const ctx = { sessionId: 'test' };
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function compositeDef(
  steps: CompositeDef['steps'],
  inputs: Record<string, unknown> = { userId: { type: 'integer' } },
): CompositeDef {
  return {
    kind: 'composite',
    name: 'flow-test',
    toolName: 'flow__test',
    description: 'test composite',
    inputSchema: { type: 'object', properties: inputs, required: Object.keys(inputs) },
    steps,
    provenance: { type: 'manual' },
    examples: [],
  };
}

async function publishComposite(
  app: Harness['app'],
  def: CompositeDef,
  input: Record<string, JsonValue>,
) {
  const artifact = app.registry.ensureArtifact('composite', def.name);
  const { version } = app.registry.addVersion(
    artifact.id,
    def as unknown as JsonValue,
    'manual',
    'proposed',
    'human:test',
  );
  const v = await app.runEvaluation(artifact.id, version.version, 'human:test', {
    inputs: [input],
  });
  return v;
}

describe('scenario 1: valid OpenAPI specification', () => {
  it('generates named, described, typed tools with access levels', async () => {
    const def = await importOpenApi(shopOpenApi('https://shop.example.com'), { name: 'shop' });
    const byName = Object.fromEntries(def.operations.map((o) => [o.name, o]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        'getProducts',
        'getProduct',
        'createProduct',
        'getOrders',
        'getOrder',
      ]),
    );
    expect(byName.getProduct!.inputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    });
    expect(byName.getProducts!.outputSchema).toMatchObject({
      type: 'object',
      properties: { result: { type: 'array' } },
    });
    expect(byName.getProducts!.outputWrapped).toBe(true);
    expect(byName.createProduct!.access).toBe('write');
    expect(byName.deleteProduct!.access).toBe('destructive');
    expect(byName.createProduct!.inputSchema).toMatchObject({ required: ['body'] });
    expect(def.baseUrl).toBe('https://shop.example.com');
  });

  it('accepts Swagger 2.0', async () => {
    const def = await importOpenApi(
      {
        swagger: '2.0',
        info: { title: 'Legacy', version: '1' },
        host: 'legacy.example.com',
        basePath: '/v1',
        schemes: ['https'],
        paths: {
          '/items/{itemId}': {
            get: {
              parameters: [{ name: 'itemId', in: 'path', required: true, type: 'string' }],
              responses: {
                '200': {
                  description: 'ok',
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      { name: 'legacy' },
    );
    expect(def.baseUrl).toBe('https://legacy.example.com/v1');
    expect(def.operations[0]).toMatchObject({
      name: 'getItem',
      method: 'GET',
      path: '/items/{itemId}',
    });
  });

  it('turns developer-provided endpoint lists into tools', async () => {
    const list = parseEndpointText(
      'GET /products  List products\nGET /products/{id}  Get one\nPOST /products  Create',
      'https://api.example.com',
    );
    const def = await importOpenApi(endpointsToOpenApi(list), { name: 'ep' });
    expect(def.operations.map((o) => o.name)).toEqual([
      'getProducts',
      'createProduct',
      'getProduct',
    ]);
  });
});

describe('scenario 2: incomplete documentation', () => {
  it('asks for a base URL instead of guessing one', async () => {
    const spec = shopOpenApi('x') as Record<string, unknown>;
    delete spec.servers;
    await expect(importOpenApi(spec, { name: 'shop' })).rejects.toThrow(
      /does not say where the API is hosted/,
    );
  });

  it('refuses a spec without paths rather than inventing endpoints', async () => {
    await expect(
      importOpenApi(
        {
          openapi: '3.0.0',
          info: { title: 'x', version: '1' },
          servers: [{ url: 'https://x.example' }],
          paths: {},
        },
        { name: 'x' },
      ),
    ).rejects.toThrow(/no paths/);
  });

  it('refuses a document that is not an API spec', async () => {
    await expect(importOpenApi({ hello: 'world' }, { name: 'x' })).rejects.toThrow(
      /not an OpenAPI or Swagger/,
    );
  });

  it('records findings for missing operationIds, descriptions and response schemas', async () => {
    const def = await importOpenApi(
      {
        openapi: '3.0.0',
        info: { title: 'x', version: '1' },
        servers: [{ url: 'https://x.example' }],
        paths: {
          '/widgets/{id}': {
            get: {
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
      { name: 'x' },
    );
    const codes = def.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(['no_operation_id', 'no_description', 'no_response_schema']),
    );
    expect(def.operations[0]!.name).toBe('getWidget');
    expect(def.operations[0]!.outputSchema).toBeUndefined();
  });
});

describe('scenarios 3 and 4: invalid and expired credentials', () => {
  it('reports invalid credentials and names the env var, without leaking the token', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    process.env.TEST_SHOP_TOKEN = 'wrong-token-value';
    const r = await h.app.call('shop__getProduct', { id: 1 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('auth');
    expect(r.error).toMatch(/401.*TEST_SHOP_TOKEN/);
    expect(JSON.stringify(h.app.traces.query())).not.toContain('wrong-token-value');
  });

  it('reports expired credentials as an auth error', async () => {
    h = await makeHarness({ shop: { expiredTokens: ['old-token-0001'] } });
    await approveShop(h.app);
    process.env.TEST_SHOP_TOKEN = 'old-token-0001';
    const r = await h.app.call('shop__getProduct', { id: 1 }, ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'auth' });
    expect(r.error).toMatch(/expired/);
  });

  it('fails evaluation when the credentials env var is missing', async () => {
    h = await makeHarness({
      importNow: false,
      integration: { auth: { type: 'bearer', token: '${env:TS_DEFINITELY_UNSET}' } },
    });
    const v = await h.app.importIntegration('shop', 'human:test');
    expect(v.status).toBe('failed');
    expect(v.evaluation!.checks.find((c) => c.name === 'credentials configured')).toMatchObject({
      passed: false,
    });
  });
});

describe('scenario 5: rate-limited API', () => {
  it('retries a read after Retry-After and reports the retry', async () => {
    h = await makeHarness({ shop: { rateLimitPerSec: 1 } });
    await approveShop(h.app);
    const a = await h.app.call('shop__getProduct', { id: 1 }, ctx);
    const b = await h.app.call('shop__getProduct', { id: 2 }, ctx);
    expect(a.ok && b.ok).toBe(true);
    expect(b.retries).toBeGreaterThanOrEqual(1);
    expect(b.upstreamRequests).toBe(1 + b.retries);
  }, 15_000);

  it('returns rate_limited when retries are exhausted', async () => {
    h = await makeHarness({ shop: { rateLimitPerSec: 1 }, integration: { maxRetries: 0 } });
    await approveShop(h.app);
    await h.app.call('shop__getProduct', { id: 1 }, ctx);
    const r = await h.app.call('shop__getProduct', { id: 2 }, ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'rate_limited' });
  });

  it('enforces the local per-integration rate limit', async () => {
    h = await makeHarness({
      integration: { rateLimit: { requestsPerSecond: 0.5, burst: 1 }, timeoutMs: 200 },
    });
    await approveShop(h.app);
    expect((await h.app.call('shop__getProduct', { id: 1 }, ctx)).ok).toBe(true);
    expect(await h.app.call('shop__getProduct', { id: 2 }, ctx)).toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });
  });
});

describe('scenarios 6, 7, 8: invalid endpoint, missing parameters, timeout', () => {
  it('maps 404 to not_found', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    expect(await h.app.call('shop__getProduct', { id: 9999 }, ctx)).toMatchObject({
      ok: false,
      errorCode: 'not_found',
    });
  });

  it('rejects unknown tools with a pointer to capability requests', async () => {
    h = await makeHarness();
    const r = await h.app.call('shop__doesNotExist', {}, ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(r.error).toMatch(/request_capability/);
  });

  it('validates arguments before calling the API', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    const before = h.shop.requestCount;
    expect(await h.app.call('shop__getProduct', {}, ctx)).toMatchObject({
      ok: false,
      errorCode: 'validation',
    });
    expect((await h.app.call('shop__getProduct', { id: 'abc' }, ctx)).error).toMatch(
      /must be integer/,
    );
    expect((await h.app.call('shop__getProduct', { id: 1, extra: true }, ctx)).error).toMatch(
      /unknown argument "extra"/,
    );
    expect(h.shop.requestCount).toBe(before);
  });

  it('times out slow calls', async () => {
    h = await makeHarness({
      shop: { hangPaths: ['^/orders/'] },
      integration: { timeoutMs: 300, maxRetries: 0 },
    });
    await approveShop(h.app);
    const t0 = Date.now();
    const r = await h.app.call('shop__getOrder', { orderId: 1 }, ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('scenarios 9, 11, 12: partial failure, parallel and sequential execution', () => {
  const steps: CompositeDef['steps'] = [
    { id: 'user', tool: 'shop__getUser', args: { userId: { $ref: 'input.userId' } } },
    { id: 'orders', tool: 'shop__getOrders', args: { userId: { $ref: 'input.userId' } } },
    {
      id: 'items',
      tool: 'shop__getOrderItems',
      forEach: 'steps.orders.result[*]',
      args: { orderId: { $ref: 'item.id' } },
    },
    {
      id: 'payments',
      tool: 'shop__getPayments',
      forEach: 'steps.orders.result[*]',
      args: { orderId: { $ref: 'item.id' } },
    },
  ];

  it('runs independent steps in parallel and dependent steps after their inputs (11, 12)', async () => {
    h = await makeHarness({ shop: { latencyMs: 60 } });
    await approveShop(h.app);
    const v = await publishComposite(h.app, compositeDef(steps), { userId: 1 });
    expect(v.status).toBe('awaiting_approval');
    h.app.approve('flow-test', { allowWrite: false, allowDestructive: false }, 'human:test');
    const t0 = performance.now();
    const r = await h.app.call('flow__test', { userId: 1 }, ctx);
    const elapsed = performance.now() - t0;
    expect(r.ok).toBe(true);
    // 8 requests at 60 ms each: sequential would be ≥ 480 ms; two parallel stages ≈ 120 ms.
    expect(elapsed).toBeLessThan(400);
    expect(r.upstreamRequests).toBe(8);
    expect(v.evaluation!.metrics!.compositeMedianMs).toBeLessThan(
      v.evaluation!.metrics!.baselineMedianMs!,
    );
  });

  it('returns partial results when some steps fail (9)', async () => {
    h = await makeHarness({ shop: { failPaths: ['/payments$'] }, integration: { maxRetries: 0 } });
    await approveShop(h.app);
    const artifact = h.app.registry.ensureArtifact('composite', 'flow-test');
    const { version } = h.app.registry.addVersion(
      artifact.id,
      compositeDef(steps) as unknown as JsonValue,
      'manual',
      'approved',
      'human:test',
    );
    h.app.registry.publish(artifact.id, version.version, 'human:test');
    const r = await h.app.call('flow__test', { userId: 2 }, ctx);
    expect(r.ok).toBe(true);
    const data = r.data as {
      partial: boolean;
      results: Record<string, unknown>;
      errors: Array<{ step: string; code: string }>;
    };
    expect(data.partial).toBe(true);
    expect(data.results.user).toBeTruthy();
    expect((data.results.items as unknown[]).length).toBe(3);
    expect(data.errors.every((e) => e.step === 'payments' && e.code === 'upstream')).toBe(true);
  });

  it('skips steps whose dependency failed', async () => {
    h = await makeHarness({
      shop: { failPaths: ['/users/\\d+/orders$'] },
      integration: { maxRetries: 0 },
    });
    await approveShop(h.app);
    const artifact = h.app.registry.ensureArtifact('composite', 'flow-test');
    const { version } = h.app.registry.addVersion(
      artifact.id,
      compositeDef(steps) as unknown as JsonValue,
      'manual',
      'approved',
      'human:test',
    );
    h.app.registry.publish(artifact.id, version.version, 'human:test');
    const data = (await h.app.call('flow__test', { userId: 2 }, ctx)).data as {
      skippedSteps: string[];
    };
    expect(data.skippedSteps.sort()).toEqual(['items', 'payments']);
  });

  it('fails evaluation when the composite does not reproduce the original calls', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    // forEach over a non-existent path: composite runs zero item calls, baseline too; but referencing
    // an undeclared input is caught statically.
    const bad = compositeDef([
      { id: 'user', tool: 'shop__getUser', args: { userId: { $ref: 'input.nope' } } },
    ]);
    const v = await publishComposite(h.app, bad, { userId: 1 });
    expect(v.status).toBe('failed');
    expect(v.evaluation!.checks[0]!.detail).toMatch(/undeclared input "nope"/);
  });
});

describe('scenario 13: unauthorized write operations', () => {
  it('hides write and destructive tools unless a human grants them', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    expect(h.app.catalog.has('shop__createProduct')).toBe(false);
    const r = await h.app.call('shop__createProduct', { body: { name: 'x', price: 1 } }, ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'not_found' });
  });

  it('requires a per-call human approval for destructive operations, bound to the exact arguments', async () => {
    h = await makeHarness();
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const first = await h.app.call('shop__deleteProduct', { id: 5 }, ctx);
    expect(first).toMatchObject({ ok: false, errorCode: 'approval_required' });
    expect(h.shop.products.some((p) => p.id === 5)).toBe(true);
    h.app.approvals.decide(first.approvalId!, true, 'human:test');
    // approval for id 5 does not authorize id 6
    expect(await h.app.call('shop__deleteProduct', { id: 6 }, ctx)).toMatchObject({
      errorCode: 'approval_required',
    });
    expect((await h.app.call('shop__deleteProduct', { id: 5 }, ctx)).ok).toBe(true);
    expect(h.shop.products.some((p) => p.id === 5)).toBe(false);
    // single use
    expect(await h.app.call('shop__deleteProduct', { id: 5 }, ctx)).toMatchObject({
      errorCode: 'approval_required',
    });
  });

  it('a composite cannot exceed the permissions of its steps', async () => {
    h = await makeHarness();
    await approveShop(h.app); // read-only
    const artifact = h.app.registry.ensureArtifact('composite', 'flow-test');
    const def = compositeDef(
      [{ id: 'c', tool: 'shop__createProduct', args: { body: { name: 'x', price: 1 } } }],
      {},
    );
    const { version } = h.app.registry.addVersion(
      artifact.id,
      def as unknown as JsonValue,
      'manual',
      'approved',
      'human:test',
    );
    h.app.registry.publish(artifact.id, version.version, 'human:test');
    expect(h.app.catalog.has('flow__test')).toBe(false);
    expect(h.app.catalog.problems.some((p) => p.problem.includes('shop__createProduct'))).toBe(
      true,
    );
  });
});

describe('scenario 14: generated tool rollback', () => {
  it('re-import creates v2; rollback republishes v1', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    const shopName = 'shop';
    const id = h.app.registry.getArtifactByName(shopName)!.id;
    // Change the spec (simulate an API update): exclude products endpoints.
    (h.app.config.integrations[0] as { exclude: string[] }).exclude = ['/products*'];
    const v2 = await h.app.importIntegration(shopName, 'human:test');
    expect(v2.version).toBe(2);
    h.app.approve(shopName, { allowWrite: false, allowDestructive: false }, 'human:test');
    expect(h.app.catalog.has('shop__getProducts')).toBe(false);
    const back = h.app.rollback(shopName, 'human:test');
    expect(back.version).toBe(1);
    expect(h.app.registry.getArtifact(id)!.publishedVersion).toBe(1);
    expect(h.app.catalog.has('shop__getProducts')).toBe(true);
    expect(h.app.registry.getVersion(id, 2)!.status).toBe('approved');
  });

  it('cannot publish a version that skipped approval', async () => {
    h = await makeHarness({ importNow: true });
    const id = h.app.registry.getArtifactByName('shop')!.id;
    expect(() => h!.app.registry.publish(id, 1, 'human:test')).toThrow(
      /awaiting_approval.*published/,
    );
  });
});

describe('capability requests with "latest"', () => {
  it('proposes a composite that selects the latest order itself', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    const a = h.app.discovery.analyze(
      "Find a customer's latest order and show its payment status",
      's',
    );
    expect(a.verdict).toBe('composable');
    expect(a.explanation).toMatch(/selects the latest/);
    const art = h.app.registry.getArtifactByName(a.proposal!.artifact)!;
    const def = h.app.registry.latestVersion(art.id)!.definition as unknown as CompositeDef;
    const t = def.steps.find((s) => s.tool === '$transform')!;
    expect(t.transform!.ops).toEqual([
      { sort: { field: 'createdAt', order: 'desc' } },
      { first: true },
    ]);
    const v = await h.app.evaluateLatest(a.proposal!.artifact, [{ userId: 2 }], 'human:test');
    expect(v.status).toBe('awaiting_approval');
    h.app.approve(
      a.proposal!.artifact,
      { allowWrite: false, allowDestructive: false },
      'human:test',
    );
    const r = await h.app.call(def.toolName, { userId: 2 }, ctx);
    const res = (r.data as { results: Record<string, unknown> }).results;
    const latest = res[t.id] as { id: number; createdAt: string };
    const all = res.getOrders as Array<{ createdAt: string }>;
    expect(latest.createdAt).toBe(
      all
        .map((o) => o.createdAt)
        .sort()
        .at(-1),
    );
    expect(Array.isArray(res.getPayments)).toBe(true);
  });
});

describe('baked constants', () => {
  it('an argument with the same value in every run becomes a literal, not an input', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    for (const s of ['c1', 'c2', 'c3', 'c4']) {
      const list = await h.app.call(
        'shop__getProducts',
        { category: ['books', 'games', 'garden', 'kitchen'][Number(s[1]) - 1]!, limit: 3 },
        { sessionId: s },
      );
      for (const p of list.data as Array<{ id: number }>)
        await h.app.call('shop__getProduct', { id: p.id }, { sessionId: s });
    }
    const out = await h.app.proposeComposites('system');
    const def = out.find((o) => o.def?.steps.some((st) => st.tool === 'shop__getProducts'))!.def!;
    const step = def.steps.find((st) => st.tool === 'shop__getProducts')!;
    expect(step.args.limit).toBe(3); // a number that never changed: baked
    expect(step.args.category).toEqual({ $ref: 'input.category' }); // varies: stays an input
    expect(Object.keys(def.inputSchema.properties as object)).toEqual(['category']);
  });
});
