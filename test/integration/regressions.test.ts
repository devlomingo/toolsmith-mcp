/**
 * Regression tests for the findings of the independent validation
 * (FINAL_VALIDATION_REPORT.md, first round). Each block names its finding.
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Toolsmith } from '../../src/app.js';
import { IntegrationSchema, parseConfig } from '../../src/config/config.js';
import type { CompositeDef } from '../../src/composite/plan.js';
import type { JsonValue } from '../../src/core/types.js';
import { HttpIntegrationClient } from '../../src/openapi/http-executor.js';
import type { OperationDef } from '../../src/openapi/types.js';
import { Redactor } from '../../src/security/redact.js';
import { isPrivateAddress } from '../../src/security/ssrf.js';
import { approveShop, makeHarness, SHOP_TOKEN, type Harness } from '../helpers.js';

const CLI = resolve('dist/cli/index.js');
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const op = (path: string): OperationDef => ({
  name: 'x',
  method: 'GET',
  path,
  summary: '',
  description: '',
  params: [],
  inputSchema: { type: 'object' },
  outputWrapped: false,
  access: 'read',
  tags: [],
});

describe('C1: SSRF through IPv4-embedding IPv6 spellings', () => {
  it('treats every embedding of a private IPv4 address as private', () => {
    for (const ip of [
      '::ffff:7f00:1',
      '[::ffff:a9fe:a9fe]',
      '0:0:0:0:0:ffff:7f00:0001',
      '::7f00:1',
      '::127.0.0.1',
      '64:ff9b::808:808',
      '2002:a9fe:a9fe::1',
      '2001:0:4136:e378::1',
      'fec0::1',
      '2001:db8::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '2606:4700:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses a base URL that WHATWG-normalises to the hex mapped form', () => {
    expect(new URL('http://[::ffff:127.0.0.1]:1/').hostname).toBe('[::ffff:7f00:1]');
    const cfg = IntegrationSchema.parse({ name: 't', spec: 'x' });
    expect(
      () => new HttpIntegrationClient(cfg, 'http://[::ffff:127.0.0.1]:7442', new Redactor()),
    ).toThrow(/private address/);
    expect(
      () => new HttpIntegrationClient(cfg, 'http://[::ffff:a9fe:a9fe]/', new Redactor()),
    ).toThrow(/private address/);
  });
});

describe('M1: credentials echoed in successful responses', () => {
  it('scrubs a reflected credential from 200 bodies before the agent sees them', async () => {
    const srv = createServer((q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(
        JSON.stringify({
          youSent: q.headers.authorization,
          nested: [{ h: String(q.headers.authorization) }],
        }),
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.ECHO_OK_SECRET = 'very-secret-token-0042';
    const cfg = IntegrationSchema.parse({
      name: 't',
      spec: 'x',
      allowPrivateNetwork: true,
      auth: { type: 'bearer', token: '${env:ECHO_OK_SECRET}' },
    });
    const port = (srv.address() as { port: number }).port;
    const r = await new HttpIntegrationClient(cfg, `http://127.0.0.1:${port}`, new Redactor()).call(
      op('/echo'),
      {},
    );
    srv.close();
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain('very-secret-token-0042');
    expect(JSON.stringify(r.data)).toContain('[REDACTED_SECRET]');
  });

  it('end to end: the shop token never reaches a tool result', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    const r = await h.app.call('shop__getProduct', { id: 1 }, { sessionId: 's' });
    expect(JSON.stringify(r)).not.toContain(SHOP_TOKEN);
  });
});

describe('M2: destructive upstream tools need per-call approval', () => {
  const fixture = resolve('test/fixtures/upstream-server.mjs');
  const makeApp = (extra: Record<string, unknown> = {}) =>
    new Toolsmith(
      parseConfig(
        { upstreams: [{ name: 'mini', command: process.execPath, args: [fixture], ...extra }] },
        process.cwd(),
      ),
      { dbPath: ':memory:' },
    );

  it('asks a human before running destructive or unannotated upstream tools', async () => {
    const app = makeApp();
    await app.start();
    try {
      expect((await app.call('mini__read_note', {}, { sessionId: 's' })).ok).toBe(true);
      const wipe = await app.call('mini__wipe_disk', {}, { sessionId: 's' });
      expect(wipe).toMatchObject({ ok: false, errorCode: 'approval_required' });
      expect(wipe.error).not.toMatch(/toolsmith-mcp approve-call/); // the agent is not told how to approve itself
      expect((await app.call('mini__mystery', {}, { sessionId: 's' })).errorCode).toBe(
        'approval_required',
      );
      app.approvals.decide(wipe.approvalId!, true, 'human:test');
      const done = await app.call('mini__wipe_disk', {}, { sessionId: 's' });
      expect(done.ok).toBe(true);
      expect(JSON.stringify(done.data)).toContain('"wiped":1');
    } finally {
      await app.close();
    }
  });

  it('honours an explicit opt-out per tool', async () => {
    const app = makeApp({ trustedTools: ['wipe_disk'] });
    await app.start();
    try {
      expect((await app.call('mini__wipe_disk', {}, { sessionId: 's' })).ok).toBe(true);
      expect((await app.call('mini__mystery', {}, { sessionId: 's' })).errorCode).toBe(
        'approval_required',
      );
    } finally {
      await app.close();
    }
  });
});

describe('M3: write composites', () => {
  const writeDef = (steps: CompositeDef['steps']): CompositeDef => ({
    kind: 'composite',
    name: 'flow-update-product',
    toolName: 'flow__updateProductFlow',
    description: 'x',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    steps,
    provenance: { type: 'manual' },
    examples: [],
  });

  it('stays hidden unless its own approval granted write access', async () => {
    h = await makeHarness();
    await approveShop(h.app, { allowWrite: true, allowDestructive: false });
    const art = h.app.registry.ensureArtifact('composite', 'flow-update-product');
    const def = writeDef([
      { id: 'getProduct', tool: 'shop__getProduct', args: { id: { $ref: 'input.id' } } },
      {
        id: 'updateProduct',
        tool: 'shop__updateProduct',
        args: { id: { $ref: 'input.id' }, body: { stock: 1 } },
        after: ['getProduct'],
      },
    ]);
    h.app.registry.addVersion(
      art.id,
      def as unknown as JsonValue,
      'manual',
      'awaiting_approval',
      'human:test',
    );
    h.app.approve(
      'flow-update-product',
      { allowWrite: false, allowDestructive: false },
      'human:test',
    );
    expect(h.app.catalog.has('flow__updateProductFlow')).toBe(false);
    expect(
      h.app.catalog.problems.find((p) => p.artifact === 'flow-update-product')!.problem,
    ).toMatch(/without --allow-writes/);
  });

  it('generated plans that write run in recorded order and are named for the write', async () => {
    const { patternToComposite } = await import('../../src/composite/generator.js');
    const lookup = (name: string) => ({
      name,
      description: '',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      access: name.includes('update') ? ('write' as const) : ('read' as const),
      source: 'openapi' as const,
      artifactId: 'a',
      artifactVersion: 1,
    });
    const def = patternToComposite(
      {
        id: 'p',
        signature: 'shop__getProduct > shop__updateProduct',
        elements: [
          { kind: 'call', tool: 'shop__getProduct' },
          { kind: 'call', tool: 'shop__updateProduct' },
        ],
        args: [
          { shop__getProduct: { id: { type: 'input' } } },
          {
            shop__updateProduct: {
              id: { type: 'shared', element: 0, tool: 'shop__getProduct', arg: 'id' },
            },
          },
        ],
        support: 4,
        occurrences: 4,
        confidence: 1,
        connectivity: 1,
        stepShares: [1],
        stats: {
          medianMcpCalls: 2,
          medianUpstreamRequests: 2,
          medianToolTimeMs: 1,
          medianSpanMs: 1,
          startsRun: 1,
        },
        examples: [],
        exampleArgs: [],
      },
      lookup,
    );
    expect(def.toolName).toBe('flow__updateProductFlow');
    expect(def.steps[1]!.after).toEqual(['getProduct']);
    const { planStages } = await import('../../src/composite/plan.js');
    expect(planStages(def.steps)).toEqual([['getProduct'], ['updateProduct']]);
    expect(def.description).toMatch(
      /^Use this instead of calling shop__getProduct, shop__updateProduct one by one\./,
    );
    expect(def.description).toMatch(/Changes data; steps run in order/);
  });

  it('uses the reviewer-written description when one was given at approval', async () => {
    h = await makeHarness();
    await approveShop(h.app);
    const art = h.app.registry.ensureArtifact('composite', 'flow-read');
    const def = writeDef([
      { id: 'getProduct', tool: 'shop__getProduct', args: { id: { $ref: 'input.id' } } },
    ]);
    def.name = 'flow-read';
    def.toolName = 'flow__read';
    h.app.registry.addVersion(
      art.id,
      def as unknown as JsonValue,
      'manual',
      'awaiting_approval',
      'human:test',
    );
    h.app.approve(
      'flow-read',
      {
        allowWrite: false,
        allowDestructive: false,
        description: 'Use when the user asks about one product.',
      },
      'human:test',
    );
    expect(h.app.catalog.get('flow__read')!.def.description).toBe(
      'Use when the user asks about one product.',
    );
  });
});

describe('approvals are bound to the requesting session', () => {
  it('an approval granted to one session cannot be spent by another', async () => {
    h = await makeHarness();
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const first = await h.app.call('shop__deleteProduct', { id: 7 }, { sessionId: 'agent-a' });
    h.app.approvals.decide(first.approvalId!, true, 'human:test');
    expect(
      await h.app.call('shop__deleteProduct', { id: 7 }, { sessionId: 'agent-b' }),
    ).toMatchObject({ errorCode: 'approval_required' });
    expect((await h.app.call('shop__deleteProduct', { id: 7 }, { sessionId: 'agent-a' })).ok).toBe(
      true,
    );
  });
});

describe('timeouts are not retried', () => {
  it('fails after one timeout, not three', async () => {
    h = await makeHarness({
      shop: { hangPaths: ['^/orders/'] },
      integration: { timeoutMs: 400, maxRetries: 2 },
    });
    await approveShop(h.app);
    const t0 = Date.now();
    const r = await h.app.call('shop__getOrder', { orderId: 1 }, { sessionId: 's' });
    expect(r).toMatchObject({ ok: false, errorCode: 'timeout', retries: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe.runIf(existsSync(CLI))('CLI (built)', () => {
  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  // Async variant for commands that call the in-process demo API: a blocking
  // spawnSync would stop this process from serving the API it calls.
  const runAsync = async (args: string[], cwd: string) => {
    try {
      const r = await promisify(execFile)(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
      return { status: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { status: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  it('C2: discover completes and leaves the composite awaiting approval; M6: usage is a command', async () => {
    h = await makeHarness({ importNow: false });
    const dir = mkdtempSync(join(tmpdir(), 'ts-cli-'));
    writeFileSync(
      join(dir, 'toolsmith.config.json'),
      JSON.stringify({
        integrations: [
          {
            name: 'shop',
            spec: `${h.shop.baseUrl}/openapi.json`,
            auth: { type: 'bearer', token: '${env:TEST_SHOP_TOKEN}' },
            allowPrivateNetwork: true,
            rateLimit: { requestsPerSecond: 10000, burst: 10000 },
          },
        ],
      }),
    );
    const app = new Toolsmith(
      (await import('../../src/config/config.js')).loadConfig(join(dir, 'toolsmith.config.json')),
    );
    await app.importIntegration('shop', 'human:test', { live: false });
    app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:test');
    for (const userId of [1, 2, 3, 4]) {
      const ctx = { sessionId: `cli-${userId}` };
      await app.call('shop__getUser', { userId }, ctx);
      const orders = await app.call('shop__getOrders', { userId }, ctx);
      for (const o of orders.data as Array<{ id: number }>)
        await app.call('shop__getOrderItems', { orderId: o.id }, ctx);
    }
    await app.close();

    const d = await runAsync(['discover'], dir);
    expect(d.stderr).not.toMatch(/database is not open|failed to record trace/);
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/flow__\w+\s+awaiting_approval/);

    const u = run(['usage'], dir);
    expect(u.status).toBe(0);
    expect(u.stdout).toMatch(/No published composite tools yet/);
  });

  it('M4: granting commands refuse to run without an interactive terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-cli-'));
    writeFileSync(join(dir, 'toolsmith.config.json'), '{}');
    for (const args of [
      ['approve', 'x'],
      ['approve-call', 'abc'],
      ['publish', 'x'],
      ['enable', 'x'],
      ['rollback', 'x'],
    ]) {
      const r = run(args, dir);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(
        /needs a person at an interactive terminal|No approval request|No integration or tool/,
      );
    }
    const r = run(['approve', 'x'], dir);
    expect(r.stderr).toMatch(/No integration or tool named "x"|interactive terminal/);
  });

  it('M8: start does not print the admin token when stdout is not a terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-cli-'));
    writeFileSync(
      join(dir, 'toolsmith.config.json'),
      JSON.stringify({ server: { port: 0, adminToken: 'admin-secret-zzz', mcpToken: 'm' } }),
    );
    const r = spawnSync(process.execPath, [CLI, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 4000,
      env: { ...process.env, NO_COLOR: '1', TOOLSMITH_ADMIN_TOKEN: 'admin-secret-zzz' },
    });
    expect(r.stdout).toMatch(/Dashboard:/);
    expect(r.stdout).not.toContain('admin-secret-zzz');
  });
});

// ---- Round 2 (FINAL_VALIDATION_REPORT.md) ----------------------------------

describe('N1: Basic-auth credentials echoed back', () => {
  it('scrubs the encoded header value and the decoded password', async () => {
    const srv = createServer((q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      const auth = String(q.headers.authorization);
      s.end(
        JSON.stringify({
          header: auth,
          [auth]: 'as a key',
          decoded: Buffer.from(auth.slice(6), 'base64').toString(),
        }),
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.ECHO_U = 'echouser';
    process.env.ECHO_P = 'echo-PASS-55555';
    const cfg = IntegrationSchema.parse({
      name: 't',
      spec: 'x',
      allowPrivateNetwork: true,
      auth: { type: 'basic', username: '${env:ECHO_U}', password: '${env:ECHO_P}' },
    });
    const port = (srv.address() as { port: number }).port;
    const r = await new HttpIntegrationClient(cfg, `http://127.0.0.1:${port}`, new Redactor()).call(
      op('/echo'),
      {},
    );
    srv.close();
    const text = JSON.stringify(r.data);
    expect(text).not.toContain(Buffer.from('echouser:echo-PASS-55555').toString('base64'));
    expect(text).not.toContain('echo-PASS-55555');
  });
});

describe('N2: approvals bound to the authenticated client over HTTP', () => {
  it('a second client (own token) cannot spend the first client approval, and cannot spoof identity headers', async () => {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const { startHttpServer } = await import('../../src/server/http.js');
    h = await makeHarness({
      config: { server: { clients: [{ name: 'agent-b', token: 'token-for-agent-b' }] } },
    });
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'token-for-agent-a',
      adminToken: 'adm',
    });
    const connect = async (
      token: string,
      mode: 'legacy' | 'auto',
      extra: Record<string, string> = {},
    ) => {
      const c = new Client(
        { name: 'same-name', version: '1' },
        { capabilities: {}, versionNegotiation: { mode } },
      );
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}`, ...extra } },
        }),
      );
      return c;
    };
    try {
      for (const mode of ['legacy', 'auto'] as const) {
        const id = mode === 'legacy' ? 5 : 6;
        const a = await connect('token-for-agent-a', mode);
        const first = await a.callTool({ name: 'shop__deleteProduct', arguments: { id } });
        expect(first.isError).toBe(true);
        const pending = h.app.approvals
          .list('pending')
          .find((p) => JSON.stringify(p.args).includes(`"id":${id}`))!;
        expect(pending.sessionId).toBe('http:default');
        h.app.approvals.decide(pending.id, true, 'human:test');
        // agent-b: same client name, same arguments, plus a forged identity header
        const b = await connect('token-for-agent-b', mode, { 'x-toolsmith-client': 'default' });
        const stolen = await b.callTool({ name: 'shop__deleteProduct', arguments: { id } });
        expect(stolen.isError, `${mode}: agent-b must not use agent-a's approval`).toBe(true);
        expect(h.shop.products.some((p) => p.id === id)).toBe(true);
        const ok = await a.callTool({ name: 'shop__deleteProduct', arguments: { id } });
        expect(ok.isError).toBeFalsy();
        await a.close();
        await b.close();
      }
    } finally {
      await gw.close();
    }
  });
});

describe('n6 / m1: more SSRF shapes', () => {
  it('blocks IPv4-translated IPv6 (::ffff:0:a.b.c.d)', () => {
    expect(isPrivateAddress('::ffff:0:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:0:127.0.0.1')).toBe(true);
  });

  it('refuses to download a spec from a private address unless allowed', async () => {
    const { importOpenApi } = await import('../../src/openapi/import.js');
    let hits = 0;
    const srv = createServer((_q, s) => {
      hits++;
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await expect(
      importOpenApi(`http://127.0.0.1:${port}/openapi.json`, { name: 'x' }),
    ).rejects.toThrow(/private address/);
    await expect(
      importOpenApi(`http://localhost:${port}/openapi.json`, { name: 'x' }),
    ).rejects.toThrow(/private address/);
    expect(hits).toBe(0);
    srv.close();
  });

  it('reports an unreachable spec URL as a normal error, not a crash', async () => {
    const { importOpenApi } = await import('../../src/openapi/import.js');
    await expect(
      importOpenApi('http://127.0.0.1:9/openapi.json', { name: 'x', allowPrivateNetwork: true }),
    ).rejects.toMatchObject({ name: 'ToolsmithError', code: 'network' });
  });
});

describe('m12: capability verbs', () => {
  it('"delete a product" points at the delete operation, not a read', async () => {
    h = await makeHarness();
    await approveShop(h.app, { allowWrite: true, allowDestructive: true });
    const a = h.app.discovery.analyze('delete a product', 's');
    expect(a.matches[0]!.tool).toBe('shop__deleteProduct');
  });
});

// ---- Round 3 -------------------------------------------------------------

describe('N6: secrets survive no truncation trick in error bodies', () => {
  it('a padded reflection still has the credential fully redacted', async () => {
    const srv = createServer((q, s) => {
      const pad = Number(new URL(q.url ?? '/', 'http://x').searchParams.get('pad') ?? 0);
      s.writeHead(400, { 'content-type': 'text/plain' });
      s.end(`${'x'.repeat(pad)}${q.headers.authorization}`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.N6_U = 'echouser';
    process.env.N6_P = 'echo-PASS-55555';
    const cfg = IntegrationSchema.parse({
      name: 't',
      spec: 'x',
      allowPrivateNetwork: true,
      maxRetries: 0,
      auth: { type: 'basic', username: '${env:N6_U}', password: '${env:N6_P}' },
    });
    const port = (srv.address() as { port: number }).port;
    const client = new HttpIntegrationClient(cfg, `http://127.0.0.1:${port}`, new Redactor());
    const o = {
      ...op('/e'),
      params: [{ name: 'pad', in: 'query' as const, required: false, schema: { type: 'integer' } }],
    };
    const b64 = Buffer.from('echouser:echo-PASS-55555').toString('base64');
    for (let pad = 230; pad <= 300; pad++) {
      const r = await client.call(o, { pad });
      for (let k = 8; k <= b64.length; k++)
        expect(r.error ?? '', `pad ${pad}`).not.toContain(b64.slice(0, k));
    }
    srv.close();
  });
});

describe('N7: secrets reflected in encoded form', () => {
  it('scrubs percent-encoded and form-encoded query keys', async () => {
    const srv = createServer((q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify({ url: q.url }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.N7_KEY = 'eq+QUERY/KEY=88888 x';
    const cfg = IntegrationSchema.parse({
      name: 't',
      spec: 'x',
      allowPrivateNetwork: true,
      auth: { type: 'apiKey', in: 'query', name: 'api_key', value: '${env:N7_KEY}' },
    });
    const port = (srv.address() as { port: number }).port;
    const r = await new HttpIntegrationClient(cfg, `http://127.0.0.1:${port}`, new Redactor()).call(
      op('/echo'),
      {},
    );
    srv.close();
    const text = JSON.stringify(r.data);
    expect(text).not.toMatch(/88888/);
    expect(text).toContain('[REDACTED_SECRET]');
  });

  it('scrubs literal credentials written in the config and flags them in evaluation', async () => {
    h = await makeHarness({
      importNow: false,
      integration: { auth: { type: 'bearer', token: SHOP_TOKEN } },
    });
    const v = await h.app.importIntegration('shop', 'human:test');
    expect(
      v.evaluation!.checks.find((c) => c.name === 'credentials kept out of config'),
    ).toBeTruthy();
    expect(JSON.stringify(v)).not.toContain(SHOP_TOKEN);
  });
});

describe('N5: workflow discovery over HTTP without a session header', () => {
  it('finds both workflows from 8 back-to-back header-less legacy runs', async () => {
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const { startHttpServer } = await import('../../src/server/http.js');
    h = await makeHarness();
    await approveShop(h.app);
    const gw = await startHttpServer(h.app, {
      host: '127.0.0.1',
      port: 0,
      mcpToken: 'tok',
      adminToken: 'adm',
    });
    try {
      const unwrap = (r: { structuredContent?: unknown }) => {
        const sc = r.structuredContent as Record<string, unknown>;
        return (Object.keys(sc).length === 1 && 'result' in sc ? sc.result : sc) as never;
      };
      for (let run = 0; run < 8; run++) {
        const c = new Client(
          { name: 'agent', version: '1' },
          { capabilities: {}, versionNegotiation: { mode: 'legacy' } },
        );
        await c.connect(
          new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
            requestInit: { headers: { authorization: 'Bearer tok' } },
          }),
        );
        if (run % 2 === 0) {
          const userId = run / 2 + 1;
          await c.callTool({ name: 'shop__getUser', arguments: { userId } });
          const orders = unwrap(
            await c.callTool({ name: 'shop__getOrders', arguments: { userId } }),
          ) as Array<{ id: number }>;
          for (const o of orders)
            await c.callTool({ name: 'shop__getOrderItems', arguments: { orderId: o.id } });
        } else {
          const orderId = 40 + run;
          const order = unwrap(
            await c.callTool({ name: 'shop__getOrder', arguments: { orderId } }),
          ) as { userId: number };
          await c.callTool({ name: 'shop__getPayments', arguments: { orderId } });
          await c.callTool({ name: 'shop__getUser', arguments: { userId: order.userId } });
        }
        await c.close();
      }
      const sigs = h.app.mine().map((p) => p.signature);
      expect(sigs).toContain('shop__getOrders > shop__getUser > loop(shop__getOrderItems)');
      expect(
        sigs.some((s) => s.includes('shop__getOrder >') && s.includes('shop__getPayments')),
      ).toBe(true);
    } finally {
      await gw.close();
    }
  });
});
