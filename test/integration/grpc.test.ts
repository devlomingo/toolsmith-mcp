import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Toolsmith } from '../../src/app.js';
import { parseConfig } from '../../src/config/config.js';
import { GRPC_TOKEN, PROTO, startGrpcShop } from '../fixtures/grpc-server.js';

let shop: Awaited<ReturnType<typeof startGrpcShop>>;
beforeAll(async () => {
  shop = await startGrpcShop({ reflection: true });
  process.env.TEST_GRPC_TOKEN = GRPC_TOKEN;
});
afterAll(() => shop.stop());

function makeApp(integration: Record<string, unknown> = {}) {
  return new Toolsmith(
    parseConfig(
      {
        integrations: [
          {
            name: 'gshop',
            type: 'grpc',
            spec: PROTO,
            grpc: { address: shop.address },
            auth: { type: 'bearer', token: '${env:TEST_GRPC_TOKEN}' },
            allowPrivateNetwork: true,
            rateLimit: { requestsPerSecond: 10_000, burst: 10_000 },
            ...integration,
          },
        ],
      },
      process.cwd(),
    ),
    { dbPath: ':memory:' },
  );
}

const ctx = { sessionId: 'g1' };

describe('gRPC sources', () => {
  it('imports a .proto: unary and server-streaming methods become typed tools with access levels', async () => {
    const app = makeApp();
    try {
      const v = await app.importIntegration('gshop', 'human:test');
      expect(v.status).toBe('awaiting_approval');
      const def = v.definition as unknown as {
        operations: Array<{
          name: string;
          access: string;
          inputSchema: Record<string, unknown>;
          outputSchema: Record<string, unknown>;
        }>;
        findings: Array<{ code: string }>;
      };
      const access = Object.fromEntries(def.operations.map((o) => [o.name, o.access]));
      expect(access).toEqual({
        getUser: 'read',
        listOrders: 'read',
        getOrderItems: 'read',
        watchOrders: 'read',
        placeOrder: 'write',
        deleteOrder: 'destructive',
      });
      expect(def.findings.some((f) => f.code === 'unsupported-streaming')).toBe(true); // Upload
      const getUser = def.operations.find((o) => o.name === 'getUser')!;
      expect(getUser.inputSchema).toMatchObject({
        type: 'object',
        properties: { userId: { type: ['string', 'integer'] } },
      });
      expect(getUser.outputSchema).toMatchObject({
        properties: {
          tier: { type: 'string', enum: ['TIER_UNSPECIFIED', 'TIER_GOLD', 'TIER_SILVER'] },
          createdAt: { type: 'string', format: 'date-time' },
          labels: { type: 'object', additionalProperties: { type: 'string' } },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('calls through the gateway with ProtoJSON in and out, validated against the output schema', async () => {
    const app = makeApp();
    try {
      await app.importIntegration('gshop', 'human:test');
      app.approve('gshop', { allowWrite: false, allowDestructive: false }, 'human:test');
      const r = await app.call('gshop__getUser', { userId: '7' }, ctx);
      expect(r.ok, r.error).toBe(true);
      expect(r.data).toMatchObject({
        id: '7',
        name: 'User 7',
        tier: 'TIER_GOLD',
        createdAt: '2023-11-14T22:13:27Z',
        labels: { region: 'eu' },
      });
      const n = await app.call('gshop__getUser', { userId: 7 }, ctx); // numbers accepted for int64
      expect(n.ok).toBe(true);
      const missing = await app.call('gshop__getUser', { userId: '99' }, ctx);
      expect(missing).toMatchObject({ ok: false, errorCode: 'not_found' });
      const bad = await app.call('gshop__getUser', { nope: 1 }, ctx);
      expect(bad.ok).toBe(false);
      // Writes stay hidden until granted.
      expect((await app.call('gshop__placeOrder', { userId: '1' }, ctx)).ok).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('server streaming collects messages up to the cap and says when it cut off', async () => {
    const app = makeApp({ grpc: { address: shop.address, maxStreamMessages: 25 } });
    try {
      await app.importIntegration('gshop', 'human:test');
      app.approve('gshop', { allowWrite: false, allowDestructive: false }, 'human:test');
      const r = await app.call('gshop__watchOrders', { userId: '3' }, ctx);
      expect(r.ok, r.error).toBe(true);
      const d = r.data as { items: unknown[]; truncated: boolean };
      expect(d.items).toHaveLength(25);
      expect(d.truncated).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('imports through server reflection', async () => {
    const app = makeApp({ spec: 'reflection' });
    try {
      const v = await app.importIntegration('gshop', 'human:test');
      const ops = (v.definition as unknown as { operations: Array<{ name: string }> }).operations;
      expect(ops.map((o) => o.name).sort()).toEqual(
        [
          'deleteOrder',
          'getOrderItems',
          'getUser',
          'listOrders',
          'placeOrder',
          'watchOrders',
        ].sort(),
      );
      app.approve('gshop', { allowWrite: false, allowDestructive: false }, 'human:test');
      const r = await app.call('gshop__getUser', { userId: '2' }, ctx);
      expect(r.ok, r.error).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('bad credentials map to auth errors; echoed secrets are scrubbed', async () => {
    const app = makeApp();
    try {
      await app.importIntegration('gshop', 'human:test');
      app.approve('gshop', { allowWrite: true, allowDestructive: false }, 'human:test');
      const echoed = await app.call('gshop__placeOrder', { userId: '666' }, ctx);
      expect(echoed.ok).toBe(false);
      expect(JSON.stringify(echoed)).not.toContain(GRPC_TOKEN);
      process.env.TEST_GRPC_TOKEN = 'wrong';
      const app2 = makeApp();
      await app2.importIntegration('gshop', 'human:test', { live: false });
      app2.approve('gshop', { allowWrite: false, allowDestructive: false }, 'human:test');
      expect(await app2.call('gshop__getUser', { userId: '1' }, ctx)).toMatchObject({
        ok: false,
        errorCode: 'auth',
      });
      await app2.close();
    } finally {
      process.env.TEST_GRPC_TOKEN = GRPC_TOKEN;
      await app.close();
    }
  });

  it('egress rules: private addresses need allowPrivateNetwork; no credentials over plaintext off loopback', async () => {
    const priv = makeApp({ allowPrivateNetwork: false });
    try {
      const v = await priv.importIntegration('gshop', 'human:test');
      expect(v.status).toBe('failed');
      expect(JSON.stringify(v.evaluation)).toMatch(/private\/loopback address/);
    } finally {
      await priv.close();
    }
    const { openChannel } = await import('../../src/grpc/executor.js');
    const cfg = parseConfig(
      {
        integrations: [
          {
            name: 'x',
            type: 'grpc',
            spec: 'reflection',
            grpc: { address: 'api.example.com:443', tls: false },
            auth: { type: 'bearer', token: 't' },
          },
        ],
      },
      process.cwd(),
    ).config.integrations[0]!;
    await expect(openChannel(cfg, 'api.example.com:443')).rejects.toThrow(/plaintext/);
  });

  it('full cycle: traffic over gRPC tools is mined into a composite that passes the equivalence check', async () => {
    const app = makeApp();
    try {
      await app.importIntegration('gshop', 'human:test');
      app.approve('gshop', { allowWrite: false, allowDestructive: false }, 'human:test');
      for (let u = 1; u <= 5; u++) {
        const c = { sessionId: `run-${u}` };
        await app.call('gshop__getUser', { userId: String(u) }, c);
        const list = (await app.call('gshop__listOrders', { userId: String(u) }, c)).data as {
          orders: Array<{ id: string }>;
        };
        for (const o of list.orders) await app.call('gshop__getOrderItems', { orderId: o.id }, c);
      }
      const out = await app.proposeComposites('system');
      const hit = out.find((o) =>
        o.def?.steps.some((s) => s.tool === 'gshop__getOrderItems' && s.forEach),
      );
      expect(hit, JSON.stringify(out.map((o) => [o.pattern.signature, o.error]))).toBeDefined();
      expect(hit!.version?.status).toBe('awaiting_approval');
      app.approve(hit!.def!.name, { allowWrite: false, allowDestructive: false }, 'human:test');
      const r = await app.call(hit!.def!.toolName, { userId: '4' }, { sessionId: 'use' });
      expect(r.ok, r.error).toBe(true);
    } finally {
      await app.close();
    }
  });
});
