import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/core/types.js';
import { applyTransform, validateTransform } from '../../src/composite/transform.js';
import { validatePlan, type CompositeDef } from '../../src/composite/plan.js';
import { CompositeExecutor } from '../../src/composite/executor.js';

const orders = [
  { id: 1, status: 'placed', total: 10, createdAt: '2026-01-02T00:00:00Z' },
  { id: 2, status: 'shipped', total: 30, createdAt: '2026-03-01T00:00:00Z' },
  { id: 3, status: 'shipped', total: 20, createdAt: '2026-02-01T00:00:00Z' },
  { id: 4, status: 'placed', total: 5 },
] as JsonValue[];

describe('transform steps', () => {
  it('filters, sorts, picks, limits and selects', () => {
    expect(
      applyTransform(orders, [{ sort: { field: 'createdAt', order: 'desc' } }, { first: true }]),
    ).toMatchObject({ id: 2 });
    expect(
      applyTransform(orders, [{ sort: { field: 'createdAt', order: 'asc' } }, { first: true }]),
    ).toMatchObject({ id: 1 });
    expect(
      applyTransform(orders, [
        { filter: { field: 'status', op: 'eq', value: 'shipped' } },
        { pick: ['id'] },
      ]),
    ).toEqual([{ id: 2 }, { id: 3 }]);
    expect(
      applyTransform(orders, [
        { filter: { field: 'total', op: 'gte', value: 20 } },
        { count: true },
      ]),
    ).toBe(2);
    expect(
      applyTransform(orders, [{ filter: { field: 'createdAt', op: 'exists' } }, { limit: 1 }]),
    ).toHaveLength(1);
    expect(
      applyTransform(orders, [
        { filter: { field: 'id', op: 'in', value: [1, 4] } },
        { last: true },
      ]),
    ).toMatchObject({ id: 4 });
    expect(applyTransform([], [{ first: true }])).toBeNull();
  });

  it('rejects anything outside the vocabulary', () => {
    expect(validateTransform([{ eval: 'process.exit()' }])[0]).toMatch(/exactly one of/);
    expect(validateTransform([{ filter: { field: 'x', op: 'regex' } }])[0]).toMatch(/filter needs/);
    expect(validateTransform([{ sort: { field: 'x' }, limit: 1 }])[0]).toMatch(/exactly one of/);
    expect(validateTransform([])[0]).toMatch(/non-empty/);
  });

  it('runs inside a composite and is validated statically', async () => {
    const def: CompositeDef = {
      kind: 'composite',
      name: 'f',
      toolName: 'flow__latest',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      steps: [
        { id: 'orders', tool: 't__list', args: {} },
        {
          id: 'latest',
          tool: '$transform',
          args: {},
          transform: {
            from: 'steps.orders.result',
            ops: [{ sort: { field: 'createdAt', order: 'desc' } }, { first: true }],
          },
        },
        { id: 'payments', tool: 't__pay', args: { orderId: { $ref: 'steps.latest.result.id' } } },
      ],
      provenance: { type: 'manual' },
      examples: [],
    };
    expect(validatePlan(def, (t) => t.startsWith('t__'), { maxSteps: 10, maxFanOut: 10 })).toEqual(
      [],
    );
    const calls: Array<[string, unknown]> = [];
    const exec = new CompositeExecutor(
      async (tool, args) => {
        calls.push([tool, args]);
        return {
          ok: true,
          data: tool === 't__list' ? orders : { paid: true },
          upstreamRequests: 1,
          retries: 0,
        };
      },
      { maxFanOut: 10, concurrency: 4, timeoutMs: 5000 },
    );
    const r = await exec.run(def, {}, { sessionId: 's' });
    expect(calls).toEqual([
      ['t__list', {}],
      ['t__pay', { orderId: 2 }],
    ]);
    expect((r.data as { results: Record<string, unknown> }).results.latest).toMatchObject({
      id: 2,
    });
    const bad: CompositeDef = {
      ...def,
      steps: [
        {
          id: 'x',
          tool: '$transform',
          args: {},
          transform: { from: 'nope', ops: [{ first: true as const }] },
        },
      ],
    };
    expect(validatePlan(bad, () => true, { maxSteps: 10, maxFanOut: 10 })[0]).toMatch(
      /needs "from"/,
    );
  });
});
