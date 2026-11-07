import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationSchema } from '../../src/config/config.js';
import { parseEndpointText } from '../../src/openapi/endpoints.js';
import { HttpIntegrationClient } from '../../src/openapi/http-executor.js';
import { importOpenApi } from '../../src/openapi/import.js';
import { looksLikeError, verifyOperations } from '../../src/openapi/verify.js';
import { Redactor } from '../../src/security/redact.js';
import { makeHarness, shopOpenApi, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('ToolFactory-style verification', () => {
  it('links required parameters to endpoints that return them', async () => {
    const def = await importOpenApi(shopOpenApi('https://x.example'), { name: 'shop' });
    const src = (name: string) => def.operations.find((o) => o.name === name)!.paramSources;
    expect(src('getOrder')).toEqual([
      { param: 'orderId', from: 'listOrders', field: 'id', list: true },
    ]);
    expect(src('getUser')).toEqual([
      { param: 'userId', from: 'listOrders', field: 'userId', list: true },
    ]);
    expect(src('getProduct')).toEqual([
      { param: 'id', from: 'getProducts', field: 'id', list: true },
    ]);
    expect(src('getProducts')).toBeUndefined();
  });

  it('verifies every read operation of the demo API with live values and never calls writes', async () => {
    h = await makeHarness();
    const v = h.app.registry.latestVersion(h.app.registry.getArtifactByName('shop')!.id)!;
    expect(v.evaluation!.metrics).toMatchObject({ verifiedOperations: 8, probedOperations: 8 });
    const checks = v.evaluation!.checks.filter((c) => c.name.startsWith('live: '));
    expect(checks.find((c) => c.name === 'live: getOrderItems')!.detail).toMatch(
      /verified.*orderId←listOrders\.id/,
    );
    expect(h.shop.requestsByRoute.createProduct ?? 0).toBe(0);
    expect(h.shop.requestsByRoute.deleteProduct ?? 0).toBe(0);
  });

  it('adds parameter-source hints to tool descriptions', async () => {
    h = await makeHarness();
    h.app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:test');
    expect(h.app.catalog.get('shop__getOrderItems')!.def.description).toMatch(
      /Tip: get "orderId" from shop__listOrders \(each item's id\)/,
    );
  });

  it('classifies wrong example values, missing values and error-shaped bodies', async () => {
    h = await makeHarness({ importNow: false });
    const spec = shopOpenApi(h.shop.baseUrl) as {
      paths: Record<string, Record<string, { parameters?: Array<Record<string, unknown>> }>>;
    };
    spec.paths['/orders/{orderId}']!.get!.parameters![0]!.example = 999999; // documented example that does not exist
    delete spec.paths['/orders']; // removes the only source of order ids
    const def = await importOpenApi(spec, { name: 'shop' });
    const cfg = IntegrationSchema.parse({
      name: 'shop',
      spec: 'x',
      allowPrivateNetwork: true,
      auth: { type: 'bearer', token: '${env:TEST_SHOP_TOKEN}' },
    });
    const report = await verifyOperations(
      def,
      cfg,
      new HttpIntegrationClient(cfg, h.shop.baseUrl, new Redactor()),
    );
    const status = Object.fromEntries(report.results.map((r) => [r.operation, r.status]));
    expect(status.getOrder).toBe('wrong_parameter_value');
    expect(status.getOrderItems).toBe('no_parameter_value');
    expect(status.createProduct).toBe('not_probed_write');
    expect(looksLikeError({ error: 'boom', code: 12 })).toBeTruthy();
    expect(looksLikeError({ success: false, data: 1 })).toBeTruthy();
    expect(looksLikeError({ id: 1, status: 'ok' })).toBeUndefined();
    expect(looksLikeError([])).toBeUndefined();
  });

  it('accepts :param and <param> path syntax in endpoint lists', () => {
    const list = parseEndpointText('GET /a/:id  one\nGET /b/<code>  two', 'https://x.example');
    expect(list.endpoints.map((e) => e.path)).toEqual(['/a/{id}', '/b/{code}']);
  });
});
