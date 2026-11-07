import { describe, expect, it } from 'vitest';
import { CompositeExecutor } from '../../src/composite/executor.js';
import { compositeName } from '../../src/composite/generator.js';
import { planStages, validatePlan, type CompositeDef } from '../../src/composite/plan.js';
import { materialize, resolvePath } from '../../src/composite/refs.js';
import { camelCase, toolName } from '../../src/core/naming.js';
import { synthesizeName } from '../../src/openapi/import.js';
import { toJsonSchema } from '../../src/openapi/schema-utils.js';
import { minePatterns } from '../../src/patterns/miner.js';
import { generateTraces, NOISE_TOOLS, STANDARD_WORKFLOWS } from '../../src/patterns/synthetic.js';
import { Registry } from '../../src/registry/registry.js';
import { TokenBucket } from '../../src/security/rate-limit.js';
import { parseConfig } from '../../src/config/config.js';
import { resolveEnvRefs } from '../../src/security/secrets.js';
import { openDb } from '../../src/store/db.js';

describe('naming', () => {
  it('builds client-safe namespaced tool names', () => {
    expect(toolName('shop', 'getProduct')).toBe('shop__getProduct');
    expect(toolName('my-api', 'get.user/by id')).toBe('my-api__get_user_by_id');
    expect(toolName('a', 'x'.repeat(100))).toHaveLength(64);
    expect(camelCase('get user by ID')).toBe('getUserByID');
  });

  it('synthesizes REST-style names when operationId is missing', () => {
    expect(synthesizeName('get', '/products')).toBe('getProducts');
    expect(synthesizeName('get', '/products/{id}')).toBe('getProduct');
    expect(synthesizeName('post', '/products')).toBe('createProduct');
    expect(synthesizeName('put', '/products/{id}')).toBe('updateProduct');
    expect(synthesizeName('delete', '/products/{id}')).toBe('deleteProduct');
    expect(synthesizeName('get', '/users/{id}/orders')).toBe('getUserOrders');
    expect(synthesizeName('get', '/categories/{id}')).toBe('getCategory');
  });

  it('names composites from their steps', () => {
    expect(
      compositeName([
        'shop__getUser',
        'shop__getOrders',
        'shop__getOrderItems',
        'shop__getPayments',
      ]),
    ).toBe('getUserOrdersDetails');
    expect(compositeName(['a__getTicket', 'a__getCustomer'])).toBe('getTicketWithCustomer');
  });
});

describe('schema conversion', () => {
  it('handles nullable, drops OpenAPI-only keys and unknown formats', () => {
    expect(toJsonSchema({ type: 'string', nullable: true, example: 'x', format: 'int64' })).toEqual(
      { type: ['string', 'null'] },
    );
    expect(
      toJsonSchema({
        type: 'object',
        properties: { a: { type: 'integer', format: 'int32', readOnly: true } },
        'x-foo': 1,
      }),
    ).toEqual({ type: 'object', properties: { a: { type: 'integer' } } });
  });

  it('terminates on recursive schemas', () => {
    const node: Record<string, unknown> = { type: 'object', properties: {} };
    (node.properties as Record<string, unknown>).child = node;
    expect(() => JSON.stringify(toJsonSchema(node))).not.toThrow();
  });
});

describe('references', () => {
  const scope = {
    input: { id: 7 },
    steps: {
      o: {
        result: [
          { id: 1, items: [{ sku: 'a' }] },
          { id: 2, items: [{ sku: 'b' }, { sku: 'c' }] },
        ],
      },
    },
  };
  it('resolves paths with [*] flattening and indices', () => {
    expect(resolvePath(scope, 'steps.o.result[*].id')).toEqual([1, 2]);
    expect(resolvePath(scope, 'steps.o.result[*].items[*].sku')).toEqual(['a', 'b', 'c']);
    expect(resolvePath(scope, 'steps.o.result[1].id')).toBe(2);
    expect(resolvePath(scope, 'steps.o.result[5].id')).toBeUndefined();
  });
  it('materializes templates and drops undefined refs', () => {
    expect(
      materialize(
        { a: { $ref: 'input.id' }, b: { $ref: 'item.id' }, c: 'lit', d: { $ref: 'input.missing' } },
        { ...scope, item: { id: 9 } },
      ),
    ).toEqual({ a: 7, b: 9, c: 'lit' });
  });
});

describe('composite plans', () => {
  const def = (steps: CompositeDef['steps']): CompositeDef => ({
    kind: 'composite',
    name: 'f',
    toolName: 'flow__f',
    description: '',
    inputSchema: { type: 'object', properties: { id: {} } },
    steps,
    provenance: { type: 'manual' },
    examples: [],
  });
  it('computes parallel stages', () => {
    expect(
      planStages([
        { id: 'a', tool: 't', args: { x: { $ref: 'input.id' } } },
        { id: 'b', tool: 't', args: { x: { $ref: 'input.id' } } },
        { id: 'c', tool: 't', args: { x: { $ref: 'steps.a.result.id' } } },
        { id: 'd', tool: 't', forEach: 'steps.b.result[*]', args: { x: { $ref: 'item.id' } } },
      ]),
    ).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('rejects cycles, unknown tools, undeclared inputs and oversize plans', () => {
    const exists = (t: string) => t === 't';
    expect(
      validatePlan(
        def([
          { id: 'a', tool: 't', args: { x: { $ref: 'steps.b.result' } } },
          { id: 'b', tool: 't', args: { x: { $ref: 'steps.a.result' } } },
        ]),
        exists,
        { maxSteps: 10, maxFanOut: 10 },
      ),
    ).toContain('Composite plan has a dependency cycle');
    expect(
      validatePlan(def([{ id: 'a', tool: 'nope', args: {} }]), exists, {
        maxSteps: 10,
        maxFanOut: 10,
      })[0],
    ).toMatch(/unknown or unpublished/);
    expect(
      validatePlan(def([{ id: 'a', tool: 't', args: { x: { $ref: 'input.zzz' } } }]), exists, {
        maxSteps: 10,
        maxFanOut: 10,
      })[0],
    ).toMatch(/undeclared input/);
    expect(
      validatePlan(
        def([
          { id: 'a', tool: 't', args: {} },
          { id: 'b', tool: 't', args: {} },
        ]),
        exists,
        { maxSteps: 1, maxFanOut: 10 },
      )[0],
    ).toMatch(/limit 1/);
  });
  it('caps fan-out and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const exec = new CompositeExecutor(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true, data: { v: 1 }, upstreamRequests: 1, retries: 0 };
      },
      { maxFanOut: 10, concurrency: 3, timeoutMs: 5000 },
    );
    const r = await exec.run(
      def([{ id: 'many', tool: 't', forEach: 'input.list', args: { x: { $ref: 'item' } } }]),
      { list: Array.from({ length: 25 }, (_, i) => i) },
      { sessionId: 's' },
    );
    expect(peak).toBe(3);
    expect(r.upstreamRequests).toBe(10);
    expect((r.data as { truncated: string[]; partial: boolean }).partial).toBe(true);
  });
});

describe('registry lifecycle', () => {
  it('enforces the state machine and human-only approval', () => {
    const reg = new Registry(openDb(':memory:'));
    const a = reg.ensureArtifact('composite', 'x');
    const { version } = reg.addVersion(a.id, { k: 1 }, 'manual');
    expect(version.status).toBe('proposed');
    expect(() => reg.transition(a.id, 1, 'published', 'human:x')).toThrow(/Cannot move/);
    reg.transition(a.id, 1, 'generating', 'system');
    reg.transition(a.id, 1, 'testing', 'system');
    reg.transition(a.id, 1, 'awaiting_approval', 'system');
    expect(() => reg.transition(a.id, 1, 'approved', 'system')).toThrow(/Only a human/);
    reg.approve(a.id, 1, { allowWrite: false, allowDestructive: false }, 'human:x');
    reg.publish(a.id, 1, 'human:x');
    expect(reg.publishedVersions()).toHaveLength(1);
    expect(reg.addVersion(a.id, { k: 1 }, 'manual').created).toBe(false); // identical content deduplicated
    expect(
      reg
        .events(a.id)
        .map((e) => e.toStatus)
        .reverse(),
    ).toEqual(['proposed', 'generating', 'testing', 'awaiting_approval', 'approved', 'published']);
  });

  it('refuses to approve a version that failed evaluation', () => {
    const reg = new Registry(openDb(':memory:'));
    const a = reg.ensureArtifact('openapi', 'y');
    reg.addVersion(a.id, {}, 'x', 'awaiting_approval');
    reg.setEvaluation(a.id, 1, { passed: false, ranAt: '', checks: [] });
    expect(() =>
      reg.approve(a.id, 1, { allowWrite: false, allowDestructive: false }, 'human:x'),
    ).toThrow(/failed evaluation/);
  });
});

describe('pattern mining on synthetic traces', () => {
  const opts = { minSupport: 3, minConfidence: 0.6, maxLength: 6, episodeGapMs: 120_000 };
  it('recovers every planted workflow exactly, with no false positives (low noise)', () => {
    const { traces, truth } = generateTraces({
      workflows: STANDARD_WORKFLOWS,
      sessions: 120,
      workflowRate: 0.7,
      noiseRate: 0.2,
      noiseTools: NOISE_TOOLS,
      seed: 7,
    });
    const mined = minePatterns(traces, opts).map((p) => p.signature);
    expect(mined.sort()).toEqual([...truth].sort());
  });

  it('handles block-style loops as well as interleaved ones', () => {
    const { traces, truth } = generateTraces({
      workflows: STANDARD_WORKFLOWS.slice(0, 1),
      sessions: 30,
      workflowRate: 1,
      noiseRate: 0,
      noiseTools: NOISE_TOOLS,
      seed: 3,
      interleave: false,
    });
    const p = minePatterns(traces, opts);
    expect(p[0]!.signature).toBe(truth[0]);
  });

  it('finds nothing in pure noise', () => {
    const { traces } = generateTraces({
      workflows: STANDARD_WORKFLOWS,
      sessions: 200,
      workflowRate: 0,
      noiseRate: 1,
      noiseTools: NOISE_TOOLS,
      seed: 11,
    });
    expect(minePatterns(traces, opts)).toEqual([]);
  });

  it('respects minimum support', () => {
    const { traces } = generateTraces({
      workflows: STANDARD_WORKFLOWS.slice(1, 2),
      sessions: 2,
      workflowRate: 1,
      noiseRate: 0,
      noiseTools: NOISE_TOOLS,
      seed: 5,
    });
    expect(minePatterns(traces, opts)).toEqual([]);
  });
});

describe('misc', () => {
  it('token bucket refills over time', () => {
    let now = 0;
    const b = new TokenBucket(2, 2, () => now);
    expect(b.tryTake() && b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.waitMs()).toBe(500);
    now = 500;
    expect(b.tryTake()).toBe(true);
  });
  it('resolves env refs and explains missing ones', () => {
    expect(resolveEnvRefs('Bearer ${env:A_B}', { A_B: 'x' })).toBe('Bearer x');
    expect(() => resolveEnvRefs('${env:NOPE_NOPE}', {})).toThrow(/NOPE_NOPE is not set/);
  });
  it('reports config errors with field paths', () => {
    expect(() => parseConfig({ integrations: [{ name: 'Bad Name', spec: 'x' }] }, '.')).toThrow(
      /integrations\.0\.name/,
    );
    expect(() =>
      parseConfig(
        {
          integrations: [
            { name: 'a', spec: 'x' },
            { name: 'a', spec: 'y' },
          ],
        },
        '.',
      ),
    ).toThrow(/Duplicate/);
  });
});
