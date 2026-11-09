import { randomUUID } from 'node:crypto';
import type { TraceRecord } from '../observer/trace-store.js';
import { Fingerprinter } from '../security/redact.js';

/**
 * Synthetic trace generator with planted workflows, for measuring pattern
 * discovery precision and recall. Calls carry real data flow (ids returned by
 * one call are passed to the next), noise calls carry unrelated values, and
 * the ground truth is the list of planted workflows.
 */

export type StepSource = { from: 'input' } | { from: number; each?: boolean };

export interface PlantedStep {
  tool: string;
  arg: string;
  source: StepSource;
  /** Returns an array of this many objects (1..n). Otherwise a single object. */
  list?: number;
}

export interface PlantedWorkflow {
  name: string;
  steps: PlantedStep[];
}

export interface SyntheticOptions {
  workflows: PlantedWorkflow[];
  sessions: number;
  /** Fraction of sessions that run a planted workflow (the rest are pure noise). */
  workflowRate: number;
  /** Probability of a noise call before/after/inside a workflow run. */
  noiseRate: number;
  noiseTools: string[];
  seed: number;
  /** Interleave loop bodies per item (agent style) or run them in blocks. */
  interleave?: boolean;
  /** Probability of an unrelated call between two workflow steps. */
  innerNoiseRate?: number;
  /** Probability that a workflow run is abandoned after a random step. */
  truncateRate?: number;
  /** Draw ids from 1..N so values collide across calls (0 = unique ids). */
  smallIdRange?: number;
  /** Probability that a session is merged into the previous one (two agents sharing a session key, calls interleaved). */
  mergeRate?: number;
  /** Probability that the agent runs the first two independent reads in swapped order. */
  swapReadsRate?: number;
  /**
   * Probability of an optional side call after a step that takes the same
   * value (a settings or audit lookup on the same userId): linked by data
   * flow, so it lands inside the workflow's component, but not part of it.
   */
  linkedSideRate?: number;
}

/** Tools used for optional linked side calls (one is picked at random). */
export const SIDE_TOOLS = ['prefs__getSettings', 'audit__logView', 'notes__listNotes'];

export interface SyntheticResult {
  traces: TraceRecord[];
  /** Expected mined signatures (canonical form), one per planted workflow. */
  truth: string[];
  /** Acceptable signatures per workflow: canonical and as-recorded order. */
  truthVariants: string[][];
  runsPerWorkflow: Record<string, number>;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** The signature the miner should produce for a planted workflow. */
export function expectedSignature(w: PlantedWorkflow, canonical = true): string {
  // Mirror the miner's canonical form: adjacent reads that do not consume
  // each other's output are ordered by tool name.
  const steps = [...w.steps];
  const idx = steps.map((_, i) => i);
  for (let pass = 0; canonical && pass < steps.length * steps.length; pass++) {
    let swapped = false;
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i]!;
      const b = steps[i + 1]!;
      const loop = (s: PlantedStep) => typeof s.source.from === 'number' && s.source.each;
      if (loop(a) || loop(b) || a.tool <= b.tool || b.source.from === idx[i]) continue;
      [steps[i], steps[i + 1]] = [b, a];
      [idx[i], idx[i + 1]] = [idx[i + 1]!, idx[i]!];
      swapped = true;
    }
    if (!swapped) break;
  }
  w = {
    ...w,
    steps: steps.map((s) =>
      typeof s.source.from === 'number'
        ? { ...s, source: { ...s.source, from: idx.indexOf(s.source.from) } }
        : s,
    ),
  };
  const tokens: string[] = [];
  let i = 0;
  while (i < w.steps.length) {
    const s = w.steps[i]!;
    if (typeof s.source.from === 'number' && s.source.each) {
      const src = s.source.from;
      const body: string[] = [];
      while (i < w.steps.length) {
        const t = w.steps[i]!;
        if (typeof t.source.from === 'number' && t.source.each && t.source.from === src) {
          if (!body.includes(t.tool)) body.push(t.tool);
          i++;
        } else break;
      }
      tokens.push(`loop(${body.join('+')})`);
    } else {
      tokens.push(s.tool);
      i++;
    }
  }
  return tokens.join(' > ');
}

export function generateTraces(opts: SyntheticOptions): SyntheticResult {
  const rand = rng(opts.seed);
  const fp = new Fingerprinter('synthetic');
  const traces: TraceRecord[] = [];
  const runs: Record<string, number> = {};
  let clock = 1_700_000_000_000;
  let nextId = 1_000_000;
  const id = () =>
    opts.smallIdRange
      ? 1 + Math.floor(rand() * opts.smallIdRange)
      : (nextId += 1 + Math.floor(rand() * 7));

  const record = (
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => {
    const duration = 5 + rand() * 40;
    traces.push({
      id: randomUUID(),
      sessionId,
      parentId: null,
      tool,
      artifactId: null,
      source: 'openapi',
      access: 'read',
      startedAt: clock,
      durationMs: duration,
      ok: true,
      errorCode: null,
      error: null,
      upstreamRequests: 1,
      retries: 0,
      args: args as never,
      argFingerprints: fp.argFingerprints(args),
      resultFingerprints: fp.resultFingerprints(result),
      resultBytes: JSON.stringify(result).length,
    });
    clock += duration + 200 + rand() * 3000; // agent "think time"
  };

  const noise = (sessionId: string) => {
    const tool = opts.noiseTools[Math.floor(rand() * opts.noiseTools.length)]!;
    // With small ids, noise also carries colliding numeric values.
    const q = opts.smallIdRange ? id() : `n${Math.floor(rand() * 1e9)}`;
    const value = opts.smallIdRange ? id() : Math.floor(rand() * 1e9) + 5_000_000_000;
    record(sessionId, tool, { q }, { value });
  };
  const inner = (sessionId: string) => {
    if (opts.innerNoiseRate && rand() < opts.innerNoiseRate) noise(sessionId);
  };

  for (let s = 0; s < opts.sessions; s++) {
    const sessionId = `syn-${s}`;
    if (rand() < opts.workflowRate && opts.workflows.length) {
      const w = opts.workflows[Math.floor(rand() * opts.workflows.length)]!;
      runs[w.name] = (runs[w.name] ?? 0) + 1;
      if (rand() < opts.noiseRate) noise(sessionId);
      const input = id();
      const outputs: unknown[] = [];
      const stopAt =
        opts.truncateRate && rand() < opts.truncateRate
          ? 1 + Math.floor(rand() * (w.steps.length - 1))
          : w.steps.length;
      const stepTrace: number[] = [];
      let i = 0;
      while (i < stopAt) {
        const step = w.steps[i]!;
        if (typeof step.source.from === 'number' && step.source.each) {
          const src = step.source.from;
          const group: number[] = [];
          while (i < w.steps.length) {
            const t = w.steps[i]!;
            if (typeof t.source.from === 'number' && t.source.each && t.source.from === src)
              group.push(i++);
            else break;
          }
          const items = (outputs[src] as Array<{ id: number }>) ?? [];
          const order: Array<[number, number]> =
            opts.interleave === false
              ? group.flatMap((g) => items.map((_, k) => [g, k] as [number, number]))
              : items.flatMap((_, k) => group.map((g) => [g, k] as [number, number]));
          const groupOut: Record<number, unknown[]> = {};
          for (const [g, k] of order) {
            const st = w.steps[g]!;
            const result = { id: id(), parent: items[k]!.id, status: rand() < 0.5 ? 'a' : 'b' };
            record(sessionId, st.tool, { [st.arg]: items[k]!.id }, result);
            (groupOut[g] ??= []).push(result);
            inner(sessionId);
          }
          for (const g of group) outputs[g] = groupOut[g] ?? [];
          if (rand() < opts.noiseRate / 2) noise(sessionId);
          continue;
        }
        const value =
          step.source.from === 'input'
            ? input
            : (outputs[step.source.from as number] as { id: number }).id;
        const result = step.list
          ? Array.from({ length: 1 + Math.floor(rand() * step.list) }, () => ({
              id: id(),
              ref: value,
            }))
          : {
              id: step.source.from === 'input' ? value : id(),
              ref: value,
              name: `x${Math.floor(rand() * 1000)}`,
            };
        stepTrace[i] = traces.length;
        record(sessionId, step.tool, { [step.arg]: value }, result);
        outputs[i] = result;
        if (i + 1 < stopAt && opts.linkedSideRate && rand() < opts.linkedSideRate) {
          const side = SIDE_TOOLS[Math.floor(rand() * SIDE_TOOLS.length)]!;
          record(sessionId, side, { [step.arg]: value }, { note: `s${Math.floor(rand() * 1e9)}` });
        }
        i++;
        if (i < stopAt) inner(sessionId);
      }
      // Agents do not always run independent reads in the same order.
      const s0 = w.steps[0];
      const s1 = w.steps[1];
      if (
        opts.swapReadsRate &&
        s0?.source.from === 'input' &&
        s1?.source.from === 'input' &&
        stepTrace[0] !== undefined &&
        stepTrace[1] !== undefined &&
        rand() < opts.swapReadsRate
      ) {
        const a = traces[stepTrace[0]]!;
        const b = traces[stepTrace[1]]!;
        [a.startedAt, b.startedAt] = [b.startedAt, a.startedAt];
        traces[stepTrace[0]] = b;
        traces[stepTrace[1]] = a;
      }
      if (rand() < opts.noiseRate) noise(sessionId);
    } else {
      const n = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) noise(sessionId);
    }
    clock += 10 * 60_000; // gap between sessions
  }
  if (opts.mergeRate) {
    // Two agents behind one session key: shift a session onto the previous
    // one's timeline so their calls interleave, and give it the same key.
    const bySession = new Map<string, TraceRecord[]>();
    for (const t of traces)
      (bySession.get(t.sessionId) ?? bySession.set(t.sessionId, []).get(t.sessionId)!).push(t);
    const keys = [...bySession.keys()];
    for (let k = 1; k < keys.length; k++) {
      if (rand() >= opts.mergeRate) continue;
      const prev = bySession.get(keys[k - 1]!)!;
      const cur = bySession.get(keys[k]!)!;
      const shift = prev[0]!.startedAt + 700 - cur[0]!.startedAt;
      for (const t of cur) {
        t.startedAt += shift;
        t.sessionId = prev[0]!.sessionId;
      }
      k++; // do not chain merges
    }
    traces.sort((a, b) => a.startedAt - b.startedAt);
  }
  return {
    traces,
    truth: opts.workflows.map((w) => expectedSignature(w)),
    truthVariants: opts.workflows.map((w) => [
      ...new Set([expectedSignature(w), expectedSignature(w, false)]),
    ]),
    runsPerWorkflow: runs,
  };
}

/** Workflows used by tests and the pattern benchmark. */
export const STANDARD_WORKFLOWS: PlantedWorkflow[] = [
  {
    name: 'order-details',
    steps: [
      { tool: 'shop__getUser', arg: 'userId', source: { from: 'input' } },
      { tool: 'shop__getOrders', arg: 'userId', source: { from: 'input' }, list: 4 },
      { tool: 'shop__getOrderItems', arg: 'orderId', source: { from: 1, each: true } },
      { tool: 'shop__getPayments', arg: 'orderId', source: { from: 1, each: true } },
    ],
  },
  {
    name: 'ticket-triage',
    steps: [
      { tool: 'desk__getTicket', arg: 'ticketId', source: { from: 'input' } },
      { tool: 'desk__getCustomer', arg: 'customerId', source: { from: 0 } },
      { tool: 'crm__getAccount', arg: 'accountId', source: { from: 1 } },
    ],
  },
  {
    name: 'repo-review',
    steps: [
      { tool: 'git__listPullRequests', arg: 'repo', source: { from: 'input' }, list: 3 },
      { tool: 'git__getPullRequestFiles', arg: 'prId', source: { from: 0, each: true } },
    ],
  },
];

export const NOISE_TOOLS = [
  'web__search',
  'fs__readFile',
  'time__now',
  'shop__getProducts',
  'desk__listTickets',
  'git__getRepo',
  'calc__eval',
];
