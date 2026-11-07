import { camelCase, toolName } from '../core/naming.js';
import type { JsonSchema, JsonValue, ToolDefinition } from '../core/types.js';
import type { ArgSource, Pattern } from '../patterns/miner.js';
import { planStages, type CompositeDef, type PlanStep, type ValueExpr } from './plan.js';

export const COMPOSITE_NAMESPACE = 'flow';

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'object',
      description:
        'Each step result keyed by step id; forEach steps give an array aligned with their input items.',
    },
    partial: {
      type: 'boolean',
      description: 'True when some step failed, was skipped or truncated.',
    },
    errors: { type: 'array', items: { type: 'object' } },
    skippedSteps: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'array', items: { type: 'string' } },
    stats: { type: 'object' },
  },
  required: ['results', 'partial', 'errors', 'skippedSteps', 'stats'],
};

function shortName(tool: string): string {
  const i = tool.indexOf('__');
  return i < 0 ? tool : tool.slice(i + 2);
}

/** "getUser", "getOrders", "getOrderItems" -> "getUserOrdersDetails". */
export function compositeName(tools: string[]): string {
  const nouns = tools
    .map((t) =>
      shortName(t).replace(/^(get|list|fetch|find|read|search|create|update|delete)/i, ''),
    )
    .filter(Boolean);
  const unique = [...new Set(nouns)];
  const verb = /^(get|list|fetch|find|read|search)/i.test(shortName(tools[0]!)) ? 'get' : 'run';
  const core = unique.length >= 3 ? `${unique[0]}${unique[1]}Details` : unique.join('With');
  return camelCase(`${verb} ${core}`).slice(0, 50) || 'workflow';
}

/** Kebab-case registry name for a composite. */
export function compositeArtifactName(base: string): string {
  return `flow-${base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
    .slice(0, 31)
    .replace(/-+$/, '');
}

/**
 * Build a composite plan from a mined pattern. Arguments bound by data flow
 * become references; everything else becomes an input of the composite,
 * typed from the underlying tool's own schema. Shared inputs (the same value
 * passed to several calls) collapse into one input.
 */
export function patternToComposite(
  pattern: Pattern,
  lookup: (name: string) => ToolDefinition | undefined,
  nameOverride?: string,
): CompositeDef {
  const steps: PlanStep[] = [];
  const stepIds: string[][] = []; // element -> tool -> step id
  const usedIds = new Set<string>();
  const inputProps: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const inputFor = new Map<string, string>(); // "element|tool|arg" -> input name

  const idFor = (tool: string): string => {
    let id = shortName(tool);
    let i = 2;
    while (usedIds.has(id)) id = `${shortName(tool)}${i++}`;
    usedIds.add(id);
    return id;
  };

  const allocInput = (arg: string, schema: JsonSchema | undefined, isRequired: boolean): string => {
    let name = arg;
    let i = 2;
    while (inputProps[name] && JSON.stringify(inputProps[name]) !== JSON.stringify(schema ?? {}))
      name = `${arg}${i++}`;
    inputProps[name] = schema ?? {};
    if (isRequired) required.add(name);
    return name;
  };

  pattern.elements.forEach((el, k) => {
    const tools = el.kind === 'call' ? [el.tool] : el.tools;
    stepIds[k] = [];
    for (const tool of tools) {
      const def = lookup(tool);
      if (!def) throw new Error(`Pattern uses tool "${tool}" which is not currently available`);
      const id = idFor(tool);
      stepIds[k]!.push(id);
      const props = (def.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set((def.inputSchema.required as string[] | undefined) ?? []);
      const observed = pattern.args[k]?.[tool] ?? {};
      const args: Record<string, ValueExpr> = {};
      // Group nested arg paths (body.x) under their top-level key.
      const topLevel = new Map<string, ArgSource[]>();
      for (const [path, src] of Object.entries(observed)) {
        const top = path.split(/[.[]/)[0]!;
        (topLevel.get(top) ?? topLevel.set(top, []).get(top)!).push(
          path === top ? src : { type: 'input' },
        );
      }
      for (const [arg, sources] of topLevel) {
        const src = sources.length === 1 ? sources[0]! : { type: 'input' as const };
        args[arg] = sourceToExpr(src, arg, k, tool, def, props, req);
      }
      steps.push({ id, tool, args, ...(el.kind === 'loop' ? { forEach: '' } : {}) });
    }
  });

  function sourceToExpr(
    src: ArgSource,
    arg: string,
    k: number,
    tool: string,
    _def: ToolDefinition,
    props: Record<string, JsonSchema>,
    req: Set<string>,
  ): ValueExpr {
    switch (src.type) {
      case 'item':
        return { $ref: src.path ? `item.${src.path}` : 'item' };
      case 'output': {
        const stepId = stepIds[src.element]![0]!;
        return { $ref: `steps.${stepId}.result${src.path.startsWith('[') ? '' : '.'}${src.path}` };
      }
      case 'shared': {
        const key = `${src.element}|${src.tool}|${src.arg}`;
        const existing = inputFor.get(key);
        if (existing) {
          inputFor.set(`${k}|${tool}|${arg}`, existing);
          return { $ref: `input.${existing}` };
        }
        break;
      }
      case 'input':
        break;
    }
    const name = allocInput(arg, props[arg], req.has(arg));
    inputFor.set(`${k}|${tool}|${arg}`, name);
    return { $ref: `input.${name}` };
  }

  // Wire forEach sources now that every step id is known.
  let s = 0;
  pattern.elements.forEach((el, k) => {
    const count = el.kind === 'call' ? 1 : el.tools.length;
    for (let i = 0; i < count; i++, s++) {
      if (el.kind !== 'loop') continue;
      const srcStep = stepIds[el.sourceElement]![0]!;
      const path = el.arrayPath.startsWith('[') ? el.arrayPath : `.${el.arrayPath}`;
      steps[s]!.forEach = `steps.${srcStep}.result${path}`;
    }
    void k;
  });

  const tools = pattern.elements.flatMap((e) => (e.kind === 'call' ? [e.tool] : e.tools));
  const base = nameOverride ?? compositeName(tools);
  const stages = planStages(steps);
  const flow = steps.map((st) => `${st.id}${st.forEach ? ' (for each item)' : ''}`).join(' → ');
  const parallel = stages.some((st) => st.length > 1)
    ? ` Independent steps run in parallel (${stages.length} stages for ${steps.length} steps).`
    : '';
  const description = `Runs ${flow} in one call.${parallel} Discovered from ${pattern.support} observed sessions (confidence ${pattern.confidence}). Returns each step's result under "results"; "partial" is true if any step failed.`;

  const examples = pattern.exampleArgs
    .map((a) => {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(a)) if (k in inputProps) out[k] = v as JsonValue;
      return out;
    })
    .filter((e) => [...required].every((r) => r in e));

  return {
    kind: 'composite',
    name: compositeArtifactName(base),
    toolName: toolName(COMPOSITE_NAMESPACE, base),
    description,
    inputSchema: {
      type: 'object',
      properties: inputProps,
      ...(required.size ? { required: [...required] } : {}),
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    steps,
    provenance: {
      type: 'pattern',
      ref: pattern.id,
      support: pattern.support,
      confidence: pattern.confidence,
    },
    examples,
  };
}

export { OUTPUT_SCHEMA as COMPOSITE_OUTPUT_SCHEMA };
