import { afterEach, describe, expect, it } from 'vitest';
import { Toolsmith } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';
import { ShopApi } from '../../src/demo/shop.js';
import { SHOP_TOKEN, testDatabase } from '../helpers.js';

/**
 * Several gateway nodes on one PostgreSQL database. Runs only when
 * TOOLSMITH_TEST_DATABASE_URL points at a server (CI starts one).
 */
const enabled = Boolean(process.env.TOOLSMITH_TEST_DATABASE_URL);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function cluster(nodes: number) {
  const shop = new ShopApi({ token: SHOP_TOKEN });
  await shop.start();
  process.env.TEST_SHOP_TOKEN = SHOP_TOKEN;
  const db = (await testDatabase())!;
  const loaded = parseConfig(
    {
      database: { url: db.url, poolSize: 4 },
      integrations: [
        {
          name: 'shop',
          spec: `${shop.baseUrl}/openapi.json`,
          auth: { type: 'bearer', token: '${env:TEST_SHOP_TOKEN}' },
          allowPrivateNetwork: true,
          rateLimit: { requestsPerSecond: 10_000, burst: 10_000 },
        },
      ],
    },
    process.cwd(),
  );
  // All nodes start at once on an empty database: migrations must serialise.
  const apps = await Promise.all(Array.from({ length: nodes }, () => Toolsmith.open(loaded)));
  cleanup.push(async () => {
    for (const a of apps) await a.close();
    await shop.stop();
    await db.drop();
  });
  return { apps, shop };
}

describe.skipIf(!enabled)('PostgreSQL: several gateway nodes, one database', () => {
  it('nodes started together share one schema and one fingerprint key', async () => {
    const { apps } = await cluster(4);
    const keys = await Promise.all(
      apps.map((a) =>
        a.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'fingerprint_key'"),
      ),
    );
    expect(new Set(keys.map((k) => k!.value)).size).toBe(1);
    const v = await apps[0]!.db.get<{ version: number }>('SELECT version FROM schema_version');
    expect(v!.version).toBe(1);
  });

  it('a tool published on one node is served by the others', async () => {
    const { apps } = await cluster(2);
    const [a, b] = apps as [Toolsmith, Toolsmith];
    await a.importIntegration('shop', 'human:test');
    await a.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:test');
    expect(b.catalog.has('shop__getUser')).toBe(false);
    await b.refresh();
    expect(b.catalog.has('shop__getUser')).toBe(true);
    const r = await b.call('shop__getUser', { userId: 1 }, { sessionId: 's' });
    expect(r.ok, r.error).toBe(true);
    // Traces from both nodes land in one store, so mining sees all traffic.
    await a.call('shop__getUser', { userId: 2 }, { sessionId: 's' });
    expect((await b.traces.chronological()).filter((t) => t.tool === 'shop__getUser')).toHaveLength(
      2,
    );
  });

  it('an approval raced from several nodes is spent exactly once', async () => {
    const { apps, shop } = await cluster(3);
    const [a] = apps as [Toolsmith];
    await a.importIntegration('shop', 'human:test');
    await a.approve('shop', { allowWrite: true, allowDestructive: true }, 'human:test');
    for (const n of apps) await n.refresh();
    const ctx = { sessionId: 'agent-1' };
    const first = await a.call('shop__deleteProduct', { id: 5 }, ctx);
    expect(first).toMatchObject({ errorCode: 'approval_required' });
    await a.approvals.decide(first.approvalId!, true, 'human:test');
    shop.resetCounters();
    const results = await Promise.all(
      apps.flatMap((n) =>
        Array.from({ length: 5 }, () => n.call('shop__deleteProduct', { id: 5 }, ctx)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(shop.requestCount).toBe(1);
  });

  it('concurrent version creation from several nodes never collides', async () => {
    const { apps } = await cluster(3);
    await Promise.all(
      apps.flatMap((n, k) =>
        Array.from({ length: 5 }, async (_, i) => {
          const art = await n.registry.ensureArtifact('composite', 'flow-race');
          await n.registry.addVersion(
            art.id,
            { kind: 'composite', node: k, i },
            'test',
            'proposed',
            'human:test',
          );
        }),
      ),
    );
    const rows = await apps[0]!.db.all<{ version: number }>(
      'SELECT version FROM artifact_versions ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});
