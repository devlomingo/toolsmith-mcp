import { createHash } from 'node:crypto';
import type { TraceRecord } from '../observer/trace-store.js';
import type { JsonValue } from '../core/types.js';
import { resolvePath } from '../composite/refs.js';
import { isEmptyFingerprint } from '../security/redact.js';

/**
 * Workflow discovery over recorded traces.
 *
 * 1. Split each session into episodes at idle gaps.
 * 2. Link calls by data flow: an argument whose fingerprint equals a value in
 *    an earlier call's result is bound to that result path; one equal to an
 *    earlier argument is a shared input. Fingerprints are keyed hashes, so
 *    this works without storing payloads.
 * 3. Collapse runs of calls that iterate over the same array of an earlier
 *    result into a single loop element.
 * 4. Count element sequences per episode: contiguous n-grams, plus (by
 *    default) dependency-closed subsequences, where every step consumes a
 *    value from an earlier chosen step, so an optional linked side call in
 *    the middle does not hide a workflow. Keep those with enough support
 *    whose elements are connected by data flow, and drop sub-patterns that
 *    are explained by a longer pattern.
 */

export interface MinerOptions {
  minSupport: number;
  minConfidence: number;
  maxLength: number;
  episodeGapMs: number;
  /**
   * 'dataflow' (default) splits each episode into connected components of
   * the data-flow graph, so unrelated calls and interleaved agents sharing a
   * session do not break or merge workflows. 'contiguous' mines the raw
   * call order (kept for comparison in benchmarks).
   */
  segmentation?: 'dataflow' | 'contiguous';
  /**
   * Drop pattern P when a longer pattern containing it accounts for at least
   * this share of P's support (P is then mostly a prefix of abandoned runs).
   */
  closedRatio?: number;
  /**
   * AWO-style majority rule: each step of a pattern must take more than this
   * share of the sessions that continue past its prefix. Stops long tails
   * that only some sessions follow. 0 disables.
   */
  minStepShare?: number;
  /**
   * Treat adjacent independent reads as commutative (AWO's set of GETs):
   * order them canonically so getUser→getOrders and getOrders→getUser count
   * as one workflow.
   */
  commutativeReads?: boolean;
  /**
   * Also count non-contiguous steps inside a data-flow component, as long as
   * each step consumes something from an earlier chosen step. Default: on
   * with 'dataflow' segmentation.
   */
  subsequences?: boolean;
}

/** Enumeration bound per episode for non-contiguous subsequences. */
const MAX_SUBSEQUENCES_PER_EPISODE = 5000;

export type Binding =
  | { type: 'output'; from: number; path: string; tier: number }
  | { type: 'shared'; from: number; fromArg: string; tier: number };

interface EpisodeCall {
  trace: TraceRecord;
  bindings: Map<string, Binding>;
}

export type PatternElement =
  | { kind: 'call'; tool: string }
  | { kind: 'loop'; tools: string[]; sourceElement: number; arrayPath: string };

export type ArgSource =
  | { type: 'input' }
  | { type: 'output'; element: number; path: string }
  | { type: 'item'; path: string }
  | { type: 'shared'; element: number; tool: string; arg: string }
  /** Same value in every occurrence: baked into the composite as a literal. */
  | { type: 'constant'; value: JsonValue };

export interface ElementArgs {
  /** element index -> tool -> arg path -> where its value comes from */
  [tool: string]: Record<string, ArgSource>;
}

export interface Pattern {
  id: string;
  signature: string;
  elements: PatternElement[];
  args: ElementArgs[];
  support: number;
  occurrences: number;
  confidence: number;
  connectivity: number;
  /** For each step after the first: share of continuing sessions that take it. */
  stepShares: number[];
  stats: {
    medianMcpCalls: number;
    medianUpstreamRequests: number;
    /** Sum of the tool calls' own durations (server time). */
    medianToolTimeMs: number;
    /** First call start to last call end, including agent time between calls. */
    medianSpanMs: number;
    /** Share of occurrences that begin their run (AWO: shared session prefixes). */
    startsRun: number;
  };
  /** A few occurrences: the trace ids of member calls. */
  examples: string[][];
  /** Redacted arguments of the first member calls, for building test inputs. */
  exampleArgs: Array<Record<string, unknown>>;
}

const EXCLUDED_SOURCES = new Set(['builtin', 'composite']);

export function segmentEpisodes(traces: TraceRecord[], gapMs: number): TraceRecord[][] {
  const bySession = new Map<string, TraceRecord[]>();
  for (const t of traces) {
    if (
      !t.ok ||
      EXCLUDED_SOURCES.has(t.source) ||
      t.parentId ||
      t.sessionId.startsWith('evaluator:')
    )
      continue;
    (bySession.get(t.sessionId) ?? bySession.set(t.sessionId, []).get(t.sessionId)!).push(t);
  }
  const episodes: TraceRecord[][] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    let current: TraceRecord[] = [];
    let lastEnd = -Infinity;
    // result fingerprint -> where it appeared, in the current episode
    let produced = new Map<string, Array<{ path: string; tool: string }>>();
    for (const t of list) {
      // A new run begins at an idle gap, or when the call that started this
      // episode comes again with arguments nothing in the episode produced
      // (agents sharing a session key, or one agent running back to back).
      // "Produced" needs name evidence (userId <- user.id, orderId <- orderId):
      // small values like 2 appear everywhere as quantities and ids.
      const derived = Object.entries(t.argFingerprints).some(([argPath, h]) =>
        (produced.get(h) ?? []).some((src) => nameAffinity(argPath, src.path, src.tool) >= 3),
      );
      const restart =
        current.length >= 2 && t.tool === current[0]!.tool && !derived && startedRun(current);
      if (current.length && (t.startedAt - lastEnd > gapMs || restart)) {
        episodes.push(current);
        current = [];
        produced = new Map();
      }
      for (const [h, paths] of Object.entries(t.resultFingerprints)) {
        const list = produced.get(h) ?? produced.set(h, []).get(h)!;
        for (const path of paths) list.push({ path, tool: t.tool });
      }
      current.push(t);
      lastEnd = Math.max(lastEnd, t.startedAt + t.durationMs);
    }
    if (current.length) episodes.push(current);
  }
  return episodes;
}

/** True when the episode's first call fed a later call, i.e. it really started a run. */
function startedRun(episode: TraceRecord[]): boolean {
  const root = episode[0]!;
  return episode.slice(1).some((c) =>
    Object.entries(c.argFingerprints).some(([argPath, h]) => {
      if (isEmptyFingerprint(h)) return false;
      if (root.argFingerprints[argPath] === h) return true; // same input passed on
      return (root.resultFingerprints[h] ?? []).some(
        (p) => nameAffinity(argPath, p, root.tool) >= 3,
      );
    }),
  );
}

export function bindCalls(episode: TraceRecord[]): EpisodeCall[] {
  const calls: EpisodeCall[] = episode.map((trace) => ({ trace, bindings: new Map() }));
  for (let j = 0; j < calls.length; j++) {
    const cj = calls[j]!;
    for (const [argPath, hash] of Object.entries(cj.trace.argFingerprints)) {
      if (isEmptyFingerprint(hash)) continue; // empty values link nothing
      // Bind to the value's origin: the earliest place it appeared (an
      // earlier argument means the caller supplied it; an earlier result
      // means a tool produced it). Later echoes of the same id, such as
      // items carrying their orderId, are not origins. Equal values can be
      // coincidences, so a name match (orderId <- orders[*].id) outranks
      // an unrelated field, and voting across episodes removes the rest.
      let best: { b: Binding; rank: number } | undefined;
      for (let i = 0; i < j; i++) {
        const ci = calls[i]!.trace;
        const fromArg = Object.keys(ci.argFingerprints).find((k) => ci.argFingerprints[k] === hash);
        if (fromArg) {
          const t = tier(nameAffinity(argPath, fromArg, ci.tool));
          const rank = t * 1_000_000 - i * 2;
          if (!best || rank > best.rank)
            best = { b: { type: 'shared', from: i, fromArg, tier: t }, rank };
        }
        const paths = ci.resultFingerprints[hash];
        if (paths?.length) {
          const path = pickPath(paths, argPath);
          const t = tier(nameAffinity(argPath, path, ci.tool));
          const rank = t * 1_000_000 - i * 2 - 1;
          if (!best || rank > best.rank)
            best = { b: { type: 'output', from: i, path, tier: t }, rank };
        }
      }
      if (best) cj.bindings.set(argPath, best.b);
    }
  }
  return calls;
}

/** Strong (exact name or entity+id), weak (any xId <- id), or no name evidence. */
function tier(affinity: number): number {
  return affinity >= 3 ? 2 : affinity >= 1 ? 1 : 0;
}

function lastSegment(path: string): string {
  const seg = path.split(/[.[\]*]+/).filter(Boolean);
  return (seg[seg.length - 1] ?? '').toLowerCase();
}

/** orderId <- orders[*].id or order.id or orderId; userId <- user.id, etc. */
function nameAffinity(argPath: string, sourcePath: string, sourceTool: string): number {
  const arg = lastSegment(argPath);
  const field = lastSegment(sourcePath);
  if (arg === field) return 4;
  if (field === 'id' && arg.endsWith('id')) {
    const entity = arg.slice(0, -2);
    if (entity && sourceTool.toLowerCase().includes(entity)) return 3;
    return 1;
  }
  return 0;
}

/** When a value appears at several paths, prefer the one named like the argument. */
function pickPath(paths: string[], argPath: string): string {
  const arg = lastSegment(argPath);
  return [...paths].sort((a, b) => score(b) - score(a))[0]!;
  function score(p: string): number {
    const f = lastSegment(p);
    return (f === arg ? 100 : 0) + (f === 'id' ? 50 : 0) - p.length;
  }
}

function arrayPrefix(path: string): string | undefined {
  const i = path.lastIndexOf('[*]');
  return i < 0 ? undefined : path.slice(0, i + 3);
}

interface Element {
  token: string;
  element: PatternElement;
  members: number[]; // call indices
  /** For loops: source call index (resolved to element later). */
  sourceCall?: number;
}

export function toElements(calls: EpisodeCall[]): { elements: Element[]; callElement: number[] } {
  const elements: Element[] = [];
  const callElement: number[] = [];
  const loopKey = (c: EpisodeCall): string | undefined => {
    for (const b of c.bindings.values()) {
      if (b.type === 'output') {
        const prefix = arrayPrefix(b.path);
        if (prefix) return `${b.from}|${prefix}`;
      }
    }
    return undefined;
  };
  for (let j = 0; j < calls.length; j++) {
    const key = loopKey(calls[j]!);
    const prev = elements[elements.length - 1];
    if (
      key &&
      prev &&
      prev.element.kind === 'loop' &&
      `${prev.sourceCall}|${prev.element.arrayPath}` === key
    ) {
      prev.members.push(j);
      const tool = calls[j]!.trace.tool;
      if (!prev.element.tools.includes(tool)) prev.element.tools.push(tool);
      prev.token = `loop(${prev.element.tools.join('+')})`;
      callElement[j] = elements.length - 1;
      continue;
    }
    if (key) {
      const [from, prefix] = [Number(key.split('|')[0]), key.slice(key.indexOf('|') + 1)];
      const tool = calls[j]!.trace.tool;
      elements.push({
        token: `loop(${tool})`,
        element: { kind: 'loop', tools: [tool], sourceElement: -1, arrayPath: prefix },
        members: [j],
        sourceCall: from,
      });
    } else {
      const tool = calls[j]!.trace.tool;
      elements.push({ token: tool, element: { kind: 'call', tool }, members: [j] });
    }
    callElement[j] = elements.length - 1;
  }
  for (const el of elements) {
    if (el.element.kind === 'loop' && el.sourceCall !== undefined)
      el.element.sourceElement = callElement[el.sourceCall]!;
  }
  return { elements, callElement };
}

interface Occurrence {
  episode: number;
  /** Element indices in the episode, increasing. */
  positions: number[];
}

interface EpisodeModel {
  calls: EpisodeCall[];
  elements: Element[];
  callElement: number[];
  /**
   * call -> argPath -> earlier calls that hold this value: the binding's
   * origin plus every earlier call that took the same value under the same
   * argument name. When a pattern leaves out the origin (an optional side
   * call that happened to see userId first), the value still flows from a
   * step that is in the pattern.
   */
  carriers: Array<Map<string, number[]>>;
}

function valueCarriers(calls: EpisodeCall[]): Array<Map<string, number[]>> {
  return calls.map((c, j) => {
    const out = new Map<string, number[]>();
    for (const [argPath, b] of c.bindings) {
      const hash = c.trace.argFingerprints[argPath]!;
      const name = lastSegment(argPath);
      const list = new Set<number>([b.from]);
      for (let i = 0; i < j; i++)
        for (const [p, h] of Object.entries(calls[i]!.trace.argFingerprints))
          if (h === hash && lastSegment(p) === name) list.add(i);
      out.set(
        argPath,
        [...list].sort((x, y) => x - y),
      );
    }
    return out;
  });
}

export function minePatterns(traces: TraceRecord[], opts: MinerOptions): Pattern[] {
  const segmentation = opts.segmentation ?? 'dataflow';
  const episodes: EpisodeModel[] = segmentEpisodes(traces, opts.episodeGapMs)
    .flatMap((ep) => (segmentation === 'dataflow' ? dataflowComponents(ep) : [ep]))
    .map((ep) => (opts.commutativeReads === false ? ep : canonicalizeReads(ep)))
    .map((ep) => {
      const calls = bindCalls(ep);
      return { calls, ...toElements(calls), carriers: valueCarriers(calls) };
    });

  const gaps = opts.subsequences ?? segmentation === 'dataflow';
  const grams = new Map<string, Occurrence[]>();
  const firstTokenEpisodes = new Map<string, Set<number>>();
  // prefix signature -> next token -> episodes (the weighted edges of AWO's state graph)
  const successors = new Map<string, Map<string, number>>();
  episodes.forEach((ep, e) => {
    const tokens = ep.elements.map((x) => x.token);
    tokens.forEach((t) =>
      (firstTokenEpisodes.get(t) ?? firstTokenEpisodes.set(t, new Set()).get(t)!).add(e),
    );
    const seenInEpisode = new Set<string>();
    const count = (positions: number[]): void => {
      const sig = positions.map((i) => tokens[i]!).join(' > ');
      if (seenInEpisode.has(sig)) return; // count once per episode
      seenInEpisode.add(sig);
      (grams.get(sig) ?? grams.set(sig, []).get(sig)!).push({ episode: e, positions });
      const prefix = positions
        .slice(0, -1)
        .map((i) => tokens[i]!)
        .join(' > ');
      const last = tokens[positions.at(-1)!]!;
      const next = successors.get(prefix) ?? successors.set(prefix, new Map()).get(prefix)!;
      next.set(last, (next.get(last) ?? 0) + 1);
    };
    for (let n = 2; n <= opts.maxLength; n++)
      for (let s = 0; s + n <= tokens.length; s++)
        count(Array.from({ length: n }, (_, k) => s + k));
    if (gaps) for (const positions of closedSubsequences(ep, opts.maxLength)) count(positions);
  });

  const candidates: Pattern[] = [];
  for (const [sig, occs] of grams) {
    const support = new Set(occs.map((o) => o.episode)).size;
    if (support < opts.minSupport) continue;
    const n = sig.split(' > ').length;
    const connected = occs.filter((o) => isConnected(episodes[o.episode]!, o.positions));
    const connectivity = connected.length / occs.length;
    if (connectivity < opts.minConfidence || connected.length < opts.minSupport) continue;
    const tokensOf = sig.split(' > ');
    const firstToken = tokensOf[0]!;
    const confidence = support / (firstTokenEpisodes.get(firstToken)?.size ?? support);
    const stepShares: number[] = [];
    for (let k = 1; k < tokensOf.length; k++) {
      if (gaps) {
        // With gaps, "next" is not one edge: the share is how many of the
        // sessions that reached this prefix went on to this step later.
        const prefix = tokensOf.slice(0, k).join(' > ');
        const reached =
          k === 1
            ? (firstTokenEpisodes.get(prefix)?.size ?? 0)
            : new Set((grams.get(prefix) ?? []).map((o) => o.episode)).size;
        const went = new Set(
          (grams.get(tokensOf.slice(0, k + 1).join(' > ')) ?? []).map((o) => o.episode),
        ).size;
        stepShares.push(reached ? Math.round((went / reached) * 1000) / 1000 : 0);
        continue;
      }
      const next = successors.get(tokensOf.slice(0, k).join(' > '));
      const total = next ? [...next.values()].reduce((a, b) => a + b, 0) : 0;
      stepShares.push(
        total ? Math.round(((next!.get(tokensOf[k]!) ?? 0) / total) * 1000) / 1000 : 0,
      );
    }
    const minShare = opts.minStepShare ?? 0.5;
    if (minShare > 0 && stepShares.some((x) => x <= minShare)) continue;
    const pattern = buildPattern(
      sig,
      n,
      connected,
      episodes,
      support,
      confidence,
      connectivity,
      opts,
    );
    pattern.stepShares = stepShares;
    candidates.push(pattern);
  }

  // Keep closed patterns: drop P when a longer Q containing it occurs
  // (almost) as often, because then P is just a fragment of Q.
  const kept = candidates.filter(
    (p) =>
      !candidates.some(
        (q) =>
          q !== p &&
          q.elements.length > p.elements.length &&
          (gaps
            ? containsSubsequence(q.signature, p.signature)
            : containsContiguous(q.signature, p.signature)) &&
          q.support >= (opts.closedRatio ?? 0.6) * p.support,
      ),
  );
  return kept.sort((a, b) => b.support * b.elements.length - a.support * a.elements.length);
}

/**
 * Split an episode into groups of calls linked by data flow (union-find over
 * argument bindings). Each group keeps time order; singletons are dropped
 * because a one-call "workflow" has nothing to compose.
 */
/**
 * Reorder adjacent reads that do not depend on each other into a canonical
 * (tool name) order. Only output-to-argument links count as dependencies; a
 * shared input (both calls take the same userId) does not.
 */
export function canonicalizeReads(episode: TraceRecord[]): TraceRecord[] {
  const out = [...episode];
  if (out.length > 60) return out; // quadratic; long components are left as recorded
  for (let pass = 0; pass < out.length * out.length; pass++) {
    let swapped = false;
    const calls = bindCalls(out);
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i]!;
      const b = out[i + 1]!;
      if (a.access !== 'read' || b.access !== 'read' || a.tool <= b.tool) continue;
      const bDependsOnA = [...calls[i + 1]!.bindings.values()].some(
        (x) => x.type === 'output' && x.from === i,
      );
      if (bDependsOnA) continue;
      // Loop iterations are barriers: reads never move across them.
      const iterates = (k: number) =>
        [...calls[k]!.bindings.values()].some((x) => x.type === 'output' && x.path.includes('[*]'));
      if (iterates(i) || iterates(i + 1)) continue;
      out[i] = b;
      out[i + 1] = a;
      swapped = true;
      break; // indices changed: recompute bindings
    }
    if (!swapped) break;
  }
  return out;
}

export function dataflowComponents(episode: TraceRecord[]): TraceRecord[][] {
  const calls = bindCalls(episode);
  const parent = calls.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  calls.forEach((c, j) => {
    // Only links with naming evidence (orderId <- id, userId <- userId) join
    // groups; a bare value match is too often a coincidence between small ids.
    for (const b of c.bindings.values()) if (b.tier >= 1) parent[find(j)] = find(b.from);
  });
  const groups = new Map<number, TraceRecord[]>();
  calls.forEach((c, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(c.trace);
  });
  return [...groups.values()].filter((g) => g.length >= 2);
}

function containsContiguous(longer: string, shorter: string): boolean {
  return ` > ${longer} > `.includes(` > ${shorter} > `);
}

function containsSubsequence(longer: string, shorter: string): boolean {
  const a = longer.split(' > ');
  let i = 0;
  for (const t of shorter.split(' > ')) {
    while (i < a.length && a[i] !== t) i++;
    if (i++ >= a.length) return false;
  }
  return true;
}

/** Element indices each element consumes from (bindings and loop sources). */
function elementDeps(ep: EpisodeModel): Array<Set<number>> {
  return ep.elements.map((el, j) => {
    const deps = new Set<number>();
    for (const m of el.members)
      for (const from of ep.carriers[m]!.values())
        for (const c of from) {
          const src = ep.callElement[c]!;
          if (src < j) deps.add(src);
        }
    if (el.element.kind === 'loop') deps.add(el.element.sourceElement);
    return deps;
  });
}

/**
 * Non-contiguous, dependency-closed subsequences of length 2..maxLength:
 * each chosen element consumes something from an earlier chosen one (and a
 * loop's source is always chosen). Contiguous ones are counted separately.
 */
function closedSubsequences(ep: EpisodeModel, maxLength: number): number[][] {
  const deps = elementDeps(ep);
  const out: number[][] = [];
  const walk = (chosen: number[]): void => {
    if (out.length >= MAX_SUBSEQUENCES_PER_EPISODE) return;
    const last = chosen.at(-1)!;
    if (chosen.length >= 2 && last - chosen[0]! >= chosen.length) out.push([...chosen]);
    if (chosen.length >= maxLength) return;
    for (let j = last + 1; j < ep.elements.length; j++) {
      const el = ep.elements[j]!;
      if (el.element.kind === 'loop' && !chosen.includes(el.element.sourceElement)) continue;
      if (![...deps[j]!].some((d) => chosen.includes(d))) continue;
      chosen.push(j);
      walk(chosen);
      chosen.pop();
    }
  };
  ep.elements.forEach((el, i) => {
    if (el.element.kind !== 'loop') walk([i]);
  });
  return out;
}

function isConnected(ep: EpisodeModel, positions: number[]): boolean {
  // A loop iterates over an earlier call's result; that call must be part of
  // the pattern, also when the loop is the pattern's first element.
  if (ep.elements[positions[0]!]!.element.kind === 'loop') return false;
  for (let k = 1; k < positions.length; k++) {
    const earlier = positions.slice(0, k);
    const el = ep.elements[positions[k]!]!;
    if (el.element.kind === 'loop' && !earlier.includes(el.element.sourceElement)) return false;
    const linked = el.members.some((m) =>
      [...ep.carriers[m]!.values()].some((from) =>
        from.some((c) => earlier.includes(ep.callElement[c]!)),
      ),
    );
    if (!linked) return false;
  }
  return true;
}

function buildPattern(
  sig: string,
  n: number,
  occs: Occurrence[],
  episodes: EpisodeModel[],
  support: number,
  confidence: number,
  connectivity: number,
  opts: MinerOptions,
): Pattern {
  const ref = episodes[occs[0]!.episode]!;
  const refPositions = occs[0]!.positions;
  const elements: PatternElement[] = refPositions
    .map((p) => ref.elements[p]!)
    .map((e) => {
      if (e.element.kind === 'loop')
        return {
          ...e.element,
          tools: [...e.element.tools],
          sourceElement: refPositions.indexOf(e.element.sourceElement),
        };
      return { ...e.element };
    });

  // Tally argument sources per element/tool/arg across occurrences.
  const tallies: Array<
    Record<string, Record<string, Map<string, { src: ArgSource; count: number }>>>
  > = elements.map(() => ({}));
  const constants: Array<
    Record<string, Record<string, { hashes: Set<string>; value: JsonValue | undefined }>>
  > = elements.map(() => ({}));
  const seenCount: Array<Record<string, Record<string, number>>> = elements.map(() => ({}));
  for (const o of occs) {
    const ep = episodes[o.episode]!;
    for (let k = 0; k < n; k++) {
      const el = ep.elements[o.positions[k]!]!;
      const doneForTool = new Set<string>();
      for (const m of el.members) {
        const call = ep.calls[m]!;
        const tool = call.trace.tool;
        if (doneForTool.has(tool)) continue; // one vote per element occurrence
        doneForTool.add(tool);
        for (const argPath of Object.keys(call.trace.argFingerprints)) {
          const b = call.bindings.get(argPath);
          let src: ArgSource = { type: 'input' };
          if (b) {
            const srcEl = o.positions.indexOf(ep.callElement[b.from]!);
            if (srcEl >= 0 && srcEl < k) {
              if (b.type === 'output') {
                const prefix = arrayPrefix(b.path);
                const loopEl = elements[k]!;
                if (
                  loopEl.kind === 'loop' &&
                  prefix &&
                  prefix === loopEl.arrayPath &&
                  srcEl === loopEl.sourceElement
                ) {
                  src = { type: 'item', path: b.path.slice(prefix.length).replace(/^\./, '') };
                } else if (!prefix && elements[srcEl]!.kind === 'call') {
                  src = { type: 'output', element: srcEl, path: b.path };
                }
              } else {
                src = {
                  type: 'shared',
                  element: srcEl,
                  tool: ep.calls[b.from]!.trace.tool,
                  arg: b.fromArg,
                };
              }
            } else {
              // The origin is not part of this pattern: take the value from
              // the earliest step in it that received the same value.
              const hash = call.trace.argFingerprints[argPath]!;
              for (const c of ep.carriers[m]!.get(argPath) ?? []) {
                const at = o.positions.indexOf(ep.callElement[c]!);
                if (at < 0 || at >= k || c === b.from) continue;
                const carrier = ep.calls[c]!.trace;
                const arg = Object.keys(carrier.argFingerprints).find(
                  (p) =>
                    carrier.argFingerprints[p] === hash && lastSegment(p) === lastSegment(argPath),
                );
                if (arg) {
                  src = { type: 'shared', element: at, tool: carrier.tool, arg };
                  break;
                }
              }
            }
          }
          // Remember every value this argument took (as fingerprints) and one
          // readable example, to spot constants.
          const cst = ((constants[k]![tool] ??= {})[argPath] ??= {
            hashes: new Set(),
            value: undefined,
          });
          cst.hashes.add(call.trace.argFingerprints[argPath]!);
          if (cst.value === undefined && call.trace.args)
            cst.value = resolvePath(call.trace.args, argPath);
          const t = ((tallies[k]![tool] ??= {})[argPath] ??= new Map());
          const key = JSON.stringify(src);
          const entry = t.get(key) ?? { src, count: 0 };
          entry.count++;
          t.set(key, entry);
          (seenCount[k]![tool] ??= {})[argPath] = ((seenCount[k]![tool] ??= {})[argPath] ?? 0) + 1;
        }
      }
    }
  }
  const args: ElementArgs[] = tallies.map((byTool, k) => {
    const out: ElementArgs = {};
    for (const [tool, byArg] of Object.entries(byTool)) {
      out[tool] = {};
      for (const [argPath, map] of Object.entries(byArg)) {
        const best = [...map.values()].sort((a, b) => b.count - a.count)[0]!;
        const total = [...map.values()].reduce((s, x) => s + x.count, 0);
        const cst = constants[k]?.[tool]?.[argPath];
        // Ids are what a workflow is about (which user, which order); a run of
        // sessions that happened to use the same one must not freeze it.
        const leaf = argPath.split('.').pop() ?? '';
        // Ids and identities: what a workflow is about, never a fixed value.
        const idLike =
          /(id|ids|uuid|guid|key|name|owner|email|handle|slug|login|account|user)$/i.test(leaf);
        const isConstant =
          !idLike &&
          cst !== undefined &&
          cst.hashes.size === 1 &&
          total >= opts.minSupport &&
          cst.value !== undefined &&
          cst.value !== null &&
          typeof cst.value !== 'object' &&
          !String(cst.value).includes('[REDACTED');
        out[tool]![argPath] =
          best.src.type !== 'input' && best.count / total >= opts.minConfidence
            ? best.src
            : isConstant
              ? { type: 'constant', value: cst!.value! }
              : { type: 'input' };
      }
    }
    return out;
  });

  const callsPer: number[] = [];
  const upstreamPer: number[] = [];
  const toolTime: number[] = [];
  const spans: number[] = [];
  const examples: string[][] = [];
  const exampleArgs: Array<Record<string, unknown>> = [];
  for (const o of occs) {
    const ep = episodes[o.episode]!;
    const members = o.positions
      .map((p) => ep.elements[p]!)
      .flatMap((e) => e.members)
      .map((m) => ep.calls[m]!.trace);
    callsPer.push(members.length);
    upstreamPer.push(members.reduce((s, t) => s + t.upstreamRequests, 0));
    toolTime.push(members.reduce((s, t) => s + t.durationMs, 0));
    const first = Math.min(...members.map((t) => t.startedAt));
    const last = Math.max(...members.map((t) => t.startedAt + t.durationMs));
    spans.push(last - first);
    if (examples.length < 5) examples.push(members.map((t) => t.id));
    const firstArgs = members[0]?.args;
    if (
      exampleArgs.length < 3 &&
      firstArgs &&
      typeof firstArgs === 'object' &&
      !Array.isArray(firstArgs)
    ) {
      if (!JSON.stringify(firstArgs).includes('[REDACTED'))
        exampleArgs.push(firstArgs as Record<string, unknown>);
    }
  }

  // Counting uses the canonical order; present the steps in the order the
  // agent actually ran them (reference occurrence), which reads naturally and
  // keeps every data source before its consumer.
  const window = refPositions.map((p) => ref.elements[p]!);
  const firstStart = window.map((e) =>
    Math.min(...e.members.map((m) => ref.calls[m]!.trace.startedAt)),
  );
  const order = elements.map((_, i) => i).sort((a, b) => firstStart[a]! - firstStart[b]!);
  const pos = new Map(order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const naturalElements = order.map((i) => {
    const e = elements[i]!;
    return e.kind === 'loop'
      ? { ...e, sourceElement: pos.get(e.sourceElement) ?? e.sourceElement }
      : e;
  });
  const naturalArgs = order.map((i) => {
    const out: ElementArgs = {};
    for (const [tool, byArg] of Object.entries(args[i]!)) {
      out[tool] = {};
      for (const [arg, src] of Object.entries(byArg)) {
        out[tool]![arg] =
          src.type === 'output' || src.type === 'shared'
            ? { ...src, element: pos.get(src.element)! }
            : src;
      }
    }
    return out;
  });

  // A shared input must point back to the earliest step that takes it.
  naturalArgs.forEach((byTool, k) => {
    for (const [tool, byArg] of Object.entries(byTool)) {
      for (const [arg, src] of Object.entries(byArg)) {
        if (src.type !== 'shared' || src.element < k) continue;
        const target = naturalArgs[src.element]?.[src.tool];
        if (target && target[src.arg]?.type === 'input') {
          target[src.arg] = { type: 'shared', element: k, tool, arg };
          byArg[arg] = { type: 'input' };
        } else byArg[arg] = { type: 'input' };
      }
    }
  });

  return {
    id: createHash('sha256').update(sig).digest('hex').slice(0, 12),
    signature: sig,
    elements: naturalElements,
    args: naturalArgs,
    support,
    occurrences: occs.length,
    confidence: round(confidence),
    connectivity: round(connectivity),
    stepShares: [],
    stats: {
      medianMcpCalls: median(callsPer),
      medianUpstreamRequests: median(upstreamPer),
      medianToolTimeMs: round(median(toolTime)),
      medianSpanMs: round(median(spans)),
      startsRun: round(occs.filter((o) => o.positions[0] === 0).length / occs.length),
    },
    examples,
    exampleArgs,
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
