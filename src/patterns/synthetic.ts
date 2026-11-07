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
}

export interface SyntheticResult {
  traces: TraceRecord[];
  /** Expected mined signatures, one per planted workflow. */
  truth: string[];
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
export function expectedSignature(w: PlantedWorkflow): string {
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
  const id = () => (nextId += 1 + Math.floor(rand() * 7));

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
    record(
      sessionId,
      tool,
      { q: `n${Math.floor(rand() * 1e9)}` },
      { value: Math.floor(rand() * 1e9) + 5_000_000_000 },
    );
  };

  for (let s = 0; s < opts.sessions; s++) {
    const sessionId = `syn-${s}`;
    if (rand() < opts.workflowRate && opts.workflows.length) {
      const w = opts.workflows[Math.floor(rand() * opts.workflows.length)]!;
      runs[w.name] = (runs[w.name] ?? 0) + 1;
      if (rand() < opts.noiseRate) noise(sessionId);
      const input = id();
      const outputs: unknown[] = [];
      let i = 0;
      while (i < w.steps.length) {
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
        record(sessionId, step.tool, { [step.arg]: value }, result);
        outputs[i] = result;
        i++;
      }
      if (rand() < opts.noiseRate) noise(sessionId);
    } else {
      const n = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) noise(sessionId);
    }
    clock += 10 * 60_000; // gap between sessions
  }
  return { traces, truth: opts.workflows.map(expectedSignature), runsPerWorkflow: runs };
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
