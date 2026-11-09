import { describe, expect, it } from 'vitest';
import { minePatterns } from '../../src/patterns/miner.js';
import {
  generateTraces,
  NOISE_TOOLS,
  SIDE_TOOLS,
  STANDARD_WORKFLOWS,
} from '../../src/patterns/synthetic.js';

const MINER = { minSupport: 3, minConfidence: 0.6, maxLength: 6, episodeGapMs: 120_000 };
const gen = (seed: number) =>
  generateTraces({
    workflows: STANDARD_WORKFLOWS,
    noiseTools: NOISE_TOOLS,
    seed,
    sessions: 150,
    workflowRate: 0.5,
    noiseRate: 0.2,
    interleave: true,
    linkedSideRate: 0.3,
  });

describe('non-contiguous mining inside a data-flow component', () => {
  it('finds every planted workflow despite optional linked side calls', () => {
    for (const seed of [1, 2, 3]) {
      const { traces, truthVariants } = gen(seed);
      const mined = minePatterns(traces, MINER).map((p) => p.signature);
      for (const variants of truthVariants)
        expect(
          mined.some((m) => variants.includes(m)),
          `seed ${seed}: ${variants[0]}`,
        ).toBe(true);
    }
  });

  it('wires a value from a step in the pattern when its first holder was left out', () => {
    const { traces } = gen(1);
    const shop = minePatterns(traces, MINER).find((p) =>
      p.signature.startsWith('shop__getOrders > shop__getUser'),
    )!;
    expect(shop).toBeDefined();
    expect(shop.elements.some((e) => e.kind === 'call' && SIDE_TOOLS.includes(e.tool))).toBe(false);
    // getUser's userId is the same input getOrders took: shared or input, never a missing step.
    const userArgs = shop.args.flatMap((byTool) => Object.values(byTool['shop__getUser'] ?? {}));
    for (const src of userArgs) expect(['shared', 'input']).toContain(src.type);
  });

  it('can be turned off, and then the side calls hide the workflow more often', () => {
    const { traces, truthVariants } = gen(1);
    const off = minePatterns(traces, { ...MINER, subsequences: false }).map((p) => p.signature);
    const on = minePatterns(traces, MINER).map((p) => p.signature);
    const hits = (m: string[]) => truthVariants.filter((v) => m.some((x) => v.includes(x))).length;
    expect(hits(on)).toBeGreaterThanOrEqual(hits(off));
    expect(hits(on)).toBe(truthVariants.length);
  });
});
