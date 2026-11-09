// Pattern discovery precision / recall / F1 on synthetic traces with planted
// workflows (ground truth known). Sweeps noise and workflow frequency over
// several seeds. A mined pattern is a true positive only if its signature is
// exactly a planted workflow; fragments and over-long patterns count as false
// positives.
import { minePatterns } from '../../dist/patterns/miner.js';
import { generateTraces, NOISE_TOOLS, STANDARD_WORKFLOWS } from '../../dist/patterns/synthetic.js';
import { quick, save, summarize } from './lib.mjs';

const SEEDS = quick ? [1, 2] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const MINER = { minSupport: 3, minConfidence: 0.6, maxLength: 6, episodeGapMs: 120_000 };
// Ablation: the shipped defaults vs the first version (contiguous order, 0.9 closed-pattern ratio).
const VARIANTS = {
  default: { ...MINER },
  'no AWO rules': { ...MINER, minStepShare: 0, commutativeReads: false },
  'no gaps (contiguous within components)': { ...MINER, subsequences: false },
  'contiguous (v0 baseline)': {
    ...MINER,
    segmentation: 'contiguous',
    closedRatio: 0.9,
    minStepShare: 0,
    commutativeReads: false,
  },
};

// Each condition adds one realistic difficulty on top of a common base
// (150 sessions, 50% of them running a workflow, 20% boundary noise).
const BASE = { sessions: 150, workflowRate: 0.5, noiseRate: 0.2, interleave: true };
const grid = [
  { condition: 'clean', ...BASE, noiseRate: 0 },
  { condition: 'boundary noise 80%', ...BASE, noiseRate: 0.8 },
  { condition: 'rare workflows (10% of sessions)', ...BASE, workflowRate: 0.1 },
  { condition: 'block-style loops', ...BASE, interleave: false },
  { condition: 'noise between steps 10%', ...BASE, innerNoiseRate: 0.1 },
  { condition: 'noise between steps 30%', ...BASE, innerNoiseRate: 0.3 },
  { condition: 'abandoned runs 30%', ...BASE, truncateRate: 0.3 },
  { condition: 'colliding small ids (1..50)', ...BASE, smallIdRange: 50 },
  { condition: 'colliding small ids (1..10)', ...BASE, smallIdRange: 10 },
  { condition: 'two agents share a session key 30%', ...BASE, mergeRate: 0.3 },
  { condition: 'independent reads in random order 50%', ...BASE, swapReadsRate: 0.5 },
  { condition: 'optional linked side calls 30%', ...BASE, linkedSideRate: 0.3 },
  { condition: 'optional linked side calls 60%', ...BASE, linkedSideRate: 0.6 },
  {
    condition: 'all of the above (moderate)',
    ...BASE,
    noiseRate: 0.5,
    innerNoiseRate: 0.1,
    truncateRate: 0.2,
    smallIdRange: 50,
    mergeRate: 0.1,
    linkedSideRate: 0.2,
  },
];

const rows = [];
for (const cell of grid) {
  for (const [variant, minerOpts] of Object.entries(VARIANTS)) {
    const p = [];
    const r = [];
    const f = [];
    const ms = [];
    for (const seed of SEEDS) {
      const { condition: _c, ...gen } = cell;
      const { traces, truthVariants } = generateTraces({
        workflows: STANDARD_WORKFLOWS,
        noiseTools: NOISE_TOOLS,
        seed,
        ...gen,
      });
      const t0 = performance.now();
      const mined = minePatterns(traces, minerOpts).map((x) => x.signature);
      ms.push(performance.now() - t0);
      // A workflow counts once: its first matching signature (canonical or
      // as-recorded order) is a true positive, any further match is a duplicate (FP).
      const found = new Set();
      let tp = 0;
      for (const m of mined) {
        const w = truthVariants.findIndex((v) => v.includes(m));
        if (w >= 0 && !found.has(w)) {
          found.add(w);
          tp++;
        }
      }
      const precision = mined.length ? tp / mined.length : 1;
      const recall = found.size / truthVariants.length;
      p.push(precision);
      r.push(recall);
      f.push(precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
    }
    const row = {
      ...cell,
      variant,
      precision: summarize(p),
      recall: summarize(r),
      f1: summarize(f),
      mineMs: summarize(ms),
    };
    rows.push(row);
    console.log(
      `${cell.condition.padEnd(38)} ${variant.padEnd(26)} P ${row.precision.mean} R ${row.recall.mean} F1 ${row.f1.mean}`,
    );
  }
}

const all = (k, v = 'default') =>
  summarize(rows.filter((x) => x.variant === v).map((x) => x[k].mean));
save('patterns', {
  seeds: SEEDS.length,
  miner: MINER,
  workflows: STANDARD_WORKFLOWS.map((w) => w.name),
  notes: [
    'Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.',
    'Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.',
    'Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.',
  ],
  overall: { precision: all('precision'), recall: all('recall'), f1: all('f1') },
  overallBaseline: {
    precision: all('precision', 'contiguous (v0 baseline)'),
    recall: all('recall', 'contiguous (v0 baseline)'),
    f1: all('f1', 'contiguous (v0 baseline)'),
  },
  grid: rows,
});
