import { randomUUID } from 'node:crypto';
import {
  COMPOSITE_NAMESPACE,
  COMPOSITE_OUTPUT_SCHEMA,
  compositeArtifactName,
  useInsteadOf,
} from '../composite/generator.js';
import { TRANSFORM_TOOL, type CompositeDef, type PlanStep } from '../composite/plan.js';
import { camelCase, toolName } from '../core/naming.js';
import type { AccessLevel, JsonSchema, JsonValue } from '../core/types.js';
import type { OpenApiIntegrationDef, OperationDef } from '../openapi/types.js';
import type { Registry } from '../registry/registry.js';
import { nowIso, type Db } from '../store/db.js';

/**
 * Missing-capability analysis. Deterministic and offline: the request and
 * every known operation are reduced to canonical terms (with a small synonym
 * table), then matched. It cannot understand arbitrary language the way an
 * LLM would; it is a transparent first pass that never invents endpoints.
 * Every operation it proposes exists in an imported spec.
 */

const SYNONYMS: Record<string, string[]> = {
  user: ['user', 'customer', 'client', 'buyer', 'member', 'account', 'person', 'shopper'],
  order: ['order', 'purchase', 'checkout'],
  payment: ['payment', 'charge', 'transaction', 'invoice', 'billing', 'pay', 'paid'],
  product: ['product', 'sku', 'catalog', 'goods', 'merchandise'],
  item: ['item', 'line', 'lineitem'],
  review: ['review', 'rating', 'feedback'],
  shipment: ['shipment', 'shipping', 'delivery', 'tracking', 'ship'],
  inventory: ['inventory', 'stock'],
  price: ['price', 'cost', 'amount', 'total'],
  status: ['status', 'state'],
  address: ['address', 'location'],
};

const VERBS: Record<string, AccessLevel> = {
  get: 'read',
  show: 'read',
  find: 'read',
  fetch: 'read',
  retrieve: 'read',
  view: 'read',
  display: 'read',
  lookup: 'read',
  read: 'read',
  see: 'read',
  list: 'read',
  check: 'read',
  search: 'read',
  what: 'read',
  which: 'read',
  create: 'write',
  add: 'write',
  new: 'write',
  make: 'write',
  post: 'write',
  insert: 'write',
  place: 'write',
  update: 'write',
  change: 'write',
  modify: 'write',
  edit: 'write',
  set: 'write',
  rename: 'write',
  delete: 'destructive',
  remove: 'destructive',
  cancel: 'destructive',
  destroy: 'destructive',
  refund: 'destructive',
};

const MAX_OPEN_PROPOSALS = 50;

const MODIFIERS = new Set([
  'latest',
  'recent',
  'last',
  'newest',
  'first',
  'oldest',
  'all',
  'every',
  'top',
  'most',
  'least',
  'today',
  'yesterday',
]);

const STOP = new Set(
  'a an the of for to in on and or with by from me my our your their its is are was be it this that these those please can could would you i we some any how do does whose there'.split(
    ' ',
  ),
);

const CANON = new Map<string, string>();
for (const [canon, words] of Object.entries(SYNONYMS)) for (const w of words) CANON.set(w, canon);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us'))
    return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => CANON.get(w) ?? CANON.get(stem(w)) ?? stem(w));
}

interface Op {
  tool: string;
  integration: string;
  op: OperationDef;
  published: boolean;
  granted: boolean;
  status: string;
  terms: Set<string>;
  resource: string;
  outputFields: Set<string>;
}

export type Verdict = 'available' | 'composable' | 'needs_approval' | 'unsupported';

export interface CapabilityAnalysis {
  id: string;
  request: string;
  verdict: Verdict;
  explanation: string;
  intent: AccessLevel;
  concepts: string[];
  uncovered: string[];
  modifiers: string[];
  matches: Array<{
    tool: string;
    score: number;
    published: boolean;
    status: string;
    access: AccessLevel;
    reason?: string;
  }>;
  chain?: Array<{ tool: string; published: boolean; access: AccessLevel; feeds?: string }>;
  proposal?: { artifact: string; toolName: string; status: string };
}

export class DiscoveryEngine {
  constructor(
    private readonly db: Db,
    private readonly registry: Registry,
    /** Tools currently exposed (to know what is "published and granted"). */
    private readonly exposed: () => Set<string>,
  ) {}

  private operations(): Op[] {
    const exposed = this.exposed();
    const out: Op[] = [];
    for (const artifact of this.registry.listArtifacts('openapi')) {
      const versions = this.registry.listVersions(artifact.id);
      const v =
        versions.find((x) => x.version === artifact.publishedVersion) ??
        versions.find((x) => !['rejected', 'failed'].includes(x.status));
      if (!v) continue;
      const def = v.definition as unknown as OpenApiIntegrationDef;
      for (const op of def.operations) {
        const tool = toolName(artifact.name, op.name);
        const outputFields = new Set<string>();
        collectFields(op.outputSchema, outputFields, 0);
        const resource = resourceOf(op.path);
        out.push({
          tool,
          integration: artifact.name,
          op,
          published: v.status === 'published',
          granted: exposed.has(tool),
          status: exposed.has(tool)
            ? 'published'
            : v.status === 'published'
              ? `published (needs ${op.access} permission)`
              : v.status,
          terms: new Set([
            ...terms(op.name),
            ...terms(op.summary),
            ...terms(op.description),
            ...terms(op.path.replace(/\{[^}]+\}/g, '')),
            ...op.params.flatMap((p) => terms(p.name)),
            ...[...outputFields].flatMap((f) => terms(f)),
            ...op.tags.flatMap((t) => terms(t)),
          ]),
          resource,
          outputFields,
        });
      }
    }
    return out;
  }

  analyze(request: string, sessionId?: string): CapabilityAnalysis {
    const words = terms(request);
    const intent = words.reduce<AccessLevel>(
      (acc, w) => (rank(VERBS[w]) > rank(acc) ? VERBS[w]! : acc),
      'read',
    );
    const modifiers = [...new Set(words.filter((w) => MODIFIERS.has(w)))];
    const concepts = [...new Set(words.filter((w) => !VERBS[w] && !MODIFIERS.has(w)))];
    const ops = this.operations().filter(
      (o) => rank(o.op.access) <= rank(intent) || o.op.access === intent,
    );

    const id = randomUUID().slice(0, 8);
    const base = { id, request, intent, concepts, modifiers };

    if (concepts.length === 0) {
      return this.persist(sessionId, {
        ...base,
        verdict: 'unsupported',
        explanation:
          'The request names no resource or attribute to look for. Describe what data or action you need.',
        uncovered: [],
        matches: [],
      });
    }

    const scored = ops
      .map((o) => {
        const hit = concepts.filter((c) => o.terms.has(c));
        const resourceBonus = concepts.includes(o.resource) ? 0.5 : 0;
        return {
          o,
          hit,
          // An operation whose verb matches the request (delete → DELETE) beats a read of the same resource.
          score:
            hit.length / concepts.length +
            resourceBonus * (hit.length > 0 ? 1 : 0) +
            (intent !== 'read' && o.op.access === intent && hit.length > 0 ? 0.3 : 0),
        };
      })
      .filter((x) => x.hit.length > 0)
      .sort((a, b) => b.score - a.score || Number(b.o.granted) - Number(a.o.granted));

    const matches = scored.slice(0, 8).map((x) => ({
      tool: x.o.tool,
      score: Math.round(x.score * 100) / 100,
      published: x.o.granted,
      status: x.o.status,
      access: x.o.op.access,
    }));

    const covered = new Set(scored.flatMap((x) => x.hit));
    const uncovered = concepts.filter((c) => !covered.has(c));
    if (scored.length === 0 || covered.size / concepts.length < 0.5) {
      return this.persist(sessionId, {
        ...base,
        verdict: 'unsupported',
        explanation: `No imported API documents ${uncovered.map((u) => `"${u}"`).join(', ')}. Toolsmith does not invent endpoints: import an API spec that covers this, or tell the user it is not possible with the connected APIs.`,
        uncovered,
        matches,
      });
    }

    const best = scored[0]!;
    if (
      best.hit.length === concepts.length &&
      best.o.granted &&
      rank(best.o.op.access) >= rank(intent)
    ) {
      return this.persist(sessionId, {
        ...base,
        verdict: 'available',
        explanation: `${best.o.tool} already covers this.${modifiers.length ? ` Apply "${modifiers.join(', ')}" to its result yourself.` : ''}`,
        uncovered,
        matches,
      });
    }

    const chain = buildChain(
      concepts,
      scored.map((x) => x.o),
    );
    const chainCovers = new Set(
      chain.flatMap((c) => [...c.op.terms].filter((t) => concepts.includes(t))),
    );
    const chainUncovered = concepts.filter((c) => !chainCovers.has(c));
    const chainView = chain.map((c) => ({
      tool: c.op.tool,
      published: c.op.granted,
      access: c.op.op.access,
      feeds: c.feeds,
    }));

    if (chain.length >= 2 && chainUncovered.length === 0) {
      const blocked = chain.filter((c) => !c.op.granted);
      if (blocked.length > 0) {
        return this.persist(sessionId, {
          ...base,
          verdict: 'needs_approval',
          explanation: `The connected APIs can do this by chaining ${chain.map((c) => c.op.tool).join(' → ')}, but ${blocked.map((b) => `${b.op.tool} (${b.op.status})`).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not available yet. A human must approve ${blocked.length === 1 ? 'it' : 'them'} first.`,
          uncovered: [],
          matches,
          chain: chainView,
        });
      }
      const def = chainToComposite(request, chain, modifiers);
      // Agents can call request_capability freely; cap how many unreviewed
      // proposals they can leave behind.
      const open =
        this.registry.versionsByStatus('proposed').length +
        this.registry.versionsByStatus('awaiting_approval').length;
      if (open >= MAX_OPEN_PROPOSALS && !this.registry.getArtifactByName(def.name)) {
        return this.persist(sessionId, {
          ...base,
          verdict: 'composable',
          explanation: `${chain.map((c) => c.op.tool).join(' → ')} can do this when called in order. No new tool was proposed: ${open} proposals already await review.`,
          uncovered: [],
          matches,
          chain: chainView,
        });
      }
      const artifact = this.registry.ensureArtifact('composite', def.name);
      const { version } = this.registry.addVersion(
        artifact.id,
        def as unknown as JsonValue,
        `capability:${id}`,
        'proposed',
        'discovery',
      );
      return this.persist(sessionId, {
        ...base,
        verdict: 'composable',
        explanation: `No single tool does this, but ${chain.map((c) => c.op.tool).join(' → ')} can be combined. Proposed composite ${def.toolName} (awaiting evaluation and human approval). Until then, call the tools in that order.${def.steps.some((st) => st.transform) ? ` The proposed tool also selects the ${modifiers.join(', ')} item for you.` : modifiers.length ? ` Note: "${modifiers.join(', ')}" is not applied by the API; filter the result yourself.` : ''}`,
        uncovered: [],
        matches,
        chain: chainView,
        proposal: { artifact: def.name, toolName: def.toolName, status: version.status },
      });
    }

    const partialHint = best.o.granted
      ? `Closest available tool: ${best.o.tool}.`
      : `Closest operation: ${best.o.tool} (${best.o.status}).`;
    return this.persist(sessionId, {
      ...base,
      verdict:
        chainUncovered.length === 0 || uncovered.length === 0 ? 'needs_approval' : 'unsupported',
      explanation:
        uncovered.length > 0
          ? `Only part of this is supported. Nothing documents ${uncovered.map((u) => `"${u}"`).join(', ')}. ${partialHint}`
          : `The data exists in the connected APIs, but no available tool or chain returns it directly. ${partialHint}`,
      uncovered,
      matches,
      chain: chainView.length ? chainView : undefined,
    });
  }

  private persist(sessionId: string | undefined, a: CapabilityAnalysis): CapabilityAnalysis {
    this.db
      .prepare(
        'INSERT INTO capability_requests (id, session_id, request, verdict, analysis, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        a.id,
        sessionId ?? null,
        a.request.slice(0, 2000),
        a.verdict,
        JSON.stringify(a),
        nowIso(),
      );
    return a;
  }

  list(limit = 100): CapabilityAnalysis[] {
    return (
      this.db
        .prepare('SELECT analysis FROM capability_requests ORDER BY at DESC LIMIT ?')
        .all(limit) as Array<{ analysis: string }>
    ).map((r) => JSON.parse(r.analysis) as CapabilityAnalysis);
  }
}

function rank(a: AccessLevel | undefined): number {
  return a === 'destructive' ? 2 : a === 'write' ? 1 : 0;
}

function resourceOf(path: string): string {
  const segs = path.split('/').filter((s) => s && !s.startsWith('{'));
  const last = segs[segs.length - 1] ?? '';
  return terms(last)[0] ?? last;
}

function collectFields(schema: JsonSchema | undefined, out: Set<string>, depth: number): void {
  if (!schema || depth > 3) return;
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      out.add(k);
      collectFields(v, out, depth + 1);
    }
  }
  if (schema.items) collectFields(schema.items as JsonSchema, out, depth + 1);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key]))
      for (const s of schema[key] as JsonSchema[]) collectFields(s, out, depth + 1);
  }
}

interface ChainLink {
  op: Op;
  /** How this op's required inputs are fed: "param <- prevTool.field". */
  feeds?: string;
  binding?: { param: string; fromIndex: number; field: string; forEach: boolean };
}

/**
 * Greedy chain: start from the op that covers the most concepts and needs only
 * caller-supplied inputs, then add ops that cover remaining concepts and whose
 * required path parameter can be fed from an earlier op's output fields.
 */
function buildChain(concepts: string[], candidates: Op[]): ChainLink[] {
  const chain: ChainLink[] = [];
  const remaining = new Set(concepts);
  const usable = candidates.filter((o) => o.op.method === 'GET');
  const start = usable.find((o) => o.op.params.filter((p) => p.required).length <= 1);
  if (!start) return chain;
  chain.push({ op: start });
  for (const t of start.terms) remaining.delete(t);
  for (let guard = 0; guard < 4 && remaining.size > 0; guard++) {
    let next: ChainLink | undefined;
    for (const o of usable) {
      if (chain.some((c) => c.op.tool === o.tool)) continue;
      if (![...remaining].some((r) => o.terms.has(r))) continue;
      const pathParams = o.op.params.filter((p) => p.in === 'path' && p.required);
      if (pathParams.length !== 1) continue;
      const param = pathParams[0]!;
      for (let i = chain.length - 1; i >= 0 && !next; i--) {
        const prev = chain[i]!.op;
        const field = fieldFeeding(param.name, prev, o);
        if (field) {
          const isList = prev.op.outputSchema ? isArrayOutput(prev.op.outputSchema) : false;
          next = {
            op: o,
            feeds: `${param.name} ← ${prev.tool}.${field}${isList ? ' (each)' : ''}`,
            binding: { param: param.name, fromIndex: i, field, forEach: isList },
          };
        }
      }
      if (next) break;
    }
    if (!next) break;
    chain.push(next);
    for (const t of next.op.terms) remaining.delete(t);
  }
  return chain;
}

function fieldFeeding(param: string, prev: Op, target: Op): string | undefined {
  if (prev.outputFields.has(param)) return param;
  // "{orderId}" on /orders/{orderId}/payments is fed by an order's "id".
  const p = param.toLowerCase();
  if ((p === 'id' || p === `${prev.resource}id`) && prev.outputFields.has('id')) {
    const targetParent = target.op.path.split('/').filter(Boolean)[0] ?? '';
    if (terms(targetParent)[0] === prev.resource || p === `${prev.resource}id`) return 'id';
  }
  return undefined;
}

function isArrayOutput(schema: JsonSchema): boolean {
  if (schema.type === 'array') return true;
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  return Boolean(props?.result && props.result.type === 'array');
}

function chainToComposite(request: string, chain: ChainLink[], modifiers: string[]): CompositeDef {
  const steps: PlanStep[] = [];
  const inputProps: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const stepOf: string[] = []; // chain index -> id of the step holding its (possibly selected) result
  // "latest"/"oldest" become a transform step on the first list that has a
  // date field: sort by it and take one item, instead of telling the agent.
  const wantsLatest = modifiers.some((m) => ['latest', 'recent', 'last', 'newest'].includes(m));
  const wantsOldest = modifiers.some((m) => ['oldest', 'first'].includes(m));
  const applied: string[] = [];
  const selected = new Set<number>();
  chain.forEach((link, i) => {
    const args: PlanStep['args'] = {};
    let forEach = link.binding?.forEach ?? false;
    if (link.binding && forEach && (wantsLatest || wantsOldest) && !selected.size) {
      const src = chain[link.binding.fromIndex]!.op;
      const dateField = [...src.outputFields].find((f) =>
        /(created|updated|date|time|At$)/i.test(f),
      );
      if (dateField) {
        const id = `${wantsLatest ? 'latest' : 'oldest'}${camelCase(src.resource).replace(/^./, (c) => c.toUpperCase())}`;
        steps.push({
          id,
          tool: TRANSFORM_TOOL,
          args: {},
          transform: {
            from: `steps.${stepOf[link.binding.fromIndex]}.result`,
            ops: [
              { sort: { field: dateField, order: wantsLatest ? 'desc' : 'asc' } },
              { first: true },
            ],
          },
        });
        stepOf[link.binding.fromIndex] = id;
        selected.add(link.binding.fromIndex);
        applied.push(`${wantsLatest ? 'latest' : 'oldest'} by ${dateField}`);
        forEach = false;
      }
    }
    for (const p of link.op.op.params) {
      if (link.binding && p.name === link.binding.param) {
        const src = stepOf[link.binding.fromIndex]!;
        args[p.name] = forEach
          ? { $ref: `item.${link.binding.field}` }
          : { $ref: `steps.${src}.result.${link.binding.field}` };
        continue;
      }
      if (!p.required && i > 0) continue;
      inputProps[p.name] = p.schema;
      if (p.required) required.push(p.name);
      args[p.name] = { $ref: `input.${p.name}` };
    }
    const step: PlanStep = { id: link.op.op.name, tool: link.op.tool, args };
    if (forEach && link.binding) step.forEach = `steps.${stepOf[link.binding.fromIndex]}.result[*]`;
    steps.push(step);
    stepOf[i] = step.id;
  });
  const unapplied = modifiers.filter(
    (m) =>
      !(applied.length && ['latest', 'recent', 'last', 'newest', 'oldest', 'first'].includes(m)),
  );
  const base = camelCase(
    `get ${chain
      .map((c) => c.op.resource)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' ')} details`,
  ).slice(0, 50);
  return {
    kind: 'composite',
    name: compositeArtifactName(base),
    toolName: toolName(COMPOSITE_NAMESPACE, base),
    description: `${useInsteadOf(steps)} Answers requests like "${request.slice(0, 160)}" by running ${steps.map((s) => s.id + (s.forEach ? ' (for each)' : '')).join(' → ')} in one call.${applied.length ? ` Selects the ${applied.join(', ')}.` : ''}${unapplied.length ? ` Does not apply "${unapplied.join(', ')}"; filter the result.` : ''} Returns each step's result under "results".`,
    inputSchema: {
      type: 'object',
      properties: inputProps,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    outputSchema: COMPOSITE_OUTPUT_SCHEMA,
    steps,
    provenance: { type: 'capability', ref: request.slice(0, 200) },
    examples: [],
  };
}
