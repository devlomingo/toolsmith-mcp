import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Toolsmith } from '../src/app.js';
import { parseConfig } from '../src/config/config.js';
import { ShopApi, shopOpenApi, type ShopOptions } from '../src/demo/shop.js';
import { startHttpServer } from '../src/server/http.js';

export const SHOP_TOKEN = 'test-shop-token-123456';
export const MCP_TOKEN = 'test-mcp-token-abcdef';
export const ADMIN_TOKEN = 'test-admin-token-xyz123';

export interface Harness {
  shop: ShopApi;
  app: Toolsmith;
  close: () => Promise<void>;
}

/** A shop API plus a Toolsmith instance with the shop imported (not yet approved). */
export async function makeHarness(
  opts: {
    shop?: ShopOptions;
    integration?: Record<string, unknown>;
    config?: Record<string, unknown>;
    importNow?: boolean;
  } = {},
): Promise<Harness> {
  const shop = new ShopApi({ token: SHOP_TOKEN, ...opts.shop });
  await shop.start();
  process.env.TEST_SHOP_TOKEN = SHOP_TOKEN;
  const loaded = parseConfig(
    {
      integrations: [
        {
          name: 'shop',
          spec: `${shop.baseUrl}/openapi.json`,
          auth: { type: 'bearer', token: '${env:TEST_SHOP_TOKEN}' },
          allowPrivateNetwork: true,
          rateLimit: { requestsPerSecond: 10_000, burst: 10_000 },
          ...opts.integration,
        },
      ],
      ...opts.config,
    },
    process.cwd(),
  );
  const pg = await testDatabase();
  if (pg) loaded.config.database = { url: pg.url, poolSize: 4 };
  const app = await Toolsmith.open(loaded, pg ? {} : { dbPath: ':memory:' });
  if (opts.importNow !== false) await app.importIntegration('shop', 'human:test');
  return {
    shop,
    app,
    close: async () => {
      await app.close();
      await shop.stop();
      await pg?.drop();
    },
  };
}

export async function approveShop(
  app: Toolsmith,
  perms = { allowWrite: false, allowDestructive: false },
): Promise<void> {
  await app.approve('shop', perms, 'human:test');
}

export async function connectClient(
  url: string,
  mode: 'legacy' | 'auto',
  headers: Record<string, string> = {},
): Promise<Client> {
  const client = new Client(
    { name: `test-${mode}`, version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}`, ...headers } },
    }),
  );
  return client;
}

export async function startGateway(app: Toolsmith) {
  return startHttpServer(app, {
    host: '127.0.0.1',
    port: 0,
    mcpToken: MCP_TOKEN,
    adminToken: ADMIN_TOKEN,
  });
}

export { shopOpenApi };

/**
 * With TOOLSMITH_TEST_DATABASE_URL set (a postgres:// URL), every harness
 * gets its own fresh schema on that server, so the suite runs on PostgreSQL.
 */
export async function testDatabase(): Promise<
  { url: string; drop: () => Promise<void> } | undefined
> {
  const base = process.env.TOOLSMITH_TEST_DATABASE_URL;
  if (!base) return undefined;
  const { default: pg } = await import('pg');
  const schema = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}
