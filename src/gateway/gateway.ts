import type { Config, IntegrationConfig } from '../config/config.js';
import { CompositeExecutor } from '../composite/executor.js';
import { COMPOSITE_OUTPUT_SCHEMA } from '../composite/generator.js';
import { isTransform, maxAccess, type CompositeDef } from '../composite/plan.js';
import { errorMessage } from '../core/errors.js';
import { toolName } from '../core/naming.js';
import {
  NAMESPACE_SEP,
  type CallContext,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type ToolCallResult,
  type ToolDefinition,
} from '../core/types.js';
import { createHash } from 'node:crypto';
import { integrationClient, type IntegrationClient } from '../integration-client.js';
import type { OpenApiIntegrationDef, OperationDef } from '../openapi/types.js';
import { describeParamSources } from '../openapi/verify.js';
import type { UsageObserver } from '../observer/observer.js';
import type { Permissions, Registry } from '../registry/registry.js';
import type { Redactor } from '../security/redact.js';
import type { UpstreamManager } from '../upstream/upstream-manager.js';
import { CallApprovals } from './approvals.js';
import { validateAgainst } from './validation.js';

type Exec =
  | { type: 'openapi'; integration: string; op: OperationDef }
  | {
      type: 'upstream';
      upstream: string;
      remoteName: string;
      annotations?: Record<string, unknown>;
    }
  | { type: 'composite'; def: CompositeDef }
  | { type: 'builtin'; handler: (args: JsonObject, ctx: CallContext) => Promise<ToolCallResult> };

export interface CatalogEntry {
  def: ToolDefinition;
  exec: Exec;
  /** Each call needs its own human approval (destructive operations). */
  perCallApproval: boolean;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: JsonObject, ctx: CallContext) => Promise<ToolCallResult>;
}

export interface CatalogProblem {
  artifact: string;
  problem: string;
}

/**
 * The set of tools the gateway exposes, rebuilt from the registry's published
 * versions plus connected upstream servers. Only published versions appear;
 * write and destructive operations appear only if a human granted them.
 */
export class Catalog {
  private entries = new Map<string, CatalogEntry>();
  private clients = new Map<string, IntegrationClient>();
  problems: CatalogProblem[] = [];

  constructor(
    private readonly config: Config,
    private readonly registry: Registry,
    private readonly upstreams: UpstreamManager,
    private readonly redactor: Redactor,
    private readonly builtins: BuiltinTool[] = [],
  ) {}

  rebuild(): void {
    const next = new Map<string, CatalogEntry>();
    const problems: CatalogProblem[] = [];
    const add = (
      input: Omit<CatalogEntry, 'perCallApproval'> & { perCallApproval?: boolean },
    ): void => {
      const entry: CatalogEntry = {
        ...input,
        perCallApproval:
          input.perCallApproval ??
          (input.def.access === 'destructive' && input.def.source === 'openapi'),
      };
      if (next.has(entry.def.name)) {
        problems.push({
          artifact: entry.def.artifactId,
          problem: `duplicate tool name ${entry.def.name}; later one ignored`,
        });
        return;
      }
      next.set(entry.def.name, entry);
    };

    for (const b of this.builtins) {
      add({
        def: {
          name: b.name,
          description: b.description,
          inputSchema: b.inputSchema,
          access: 'read',
          source: 'builtin',
          artifactId: 'builtin',
          artifactVersion: 1,
        },
        exec: { type: 'builtin', handler: b.handler },
      });
    }

    const integrationCfg = new Map(this.config.integrations.map((i) => [i.name, i]));
    const composites: Array<{
      def: CompositeDef;
      artifactId: string;
      version: number;
      permissions: Permissions;
    }> = [];
    const upstreamCfg = new Map(this.config.upstreams.map((u) => [u.name, u]));

    for (const { artifact, version } of this.registry.publishedVersions()) {
      if (artifact.kind === 'openapi') {
        const def = version.definition as unknown as OpenApiIntegrationDef;
        const cfg = integrationCfg.get(artifact.name);
        if (!cfg) {
          problems.push({
            artifact: artifact.name,
            problem: 'published but missing from toolsmith.config.json; its tools are hidden',
          });
          continue;
        }
        try {
          this.ensureClient(cfg, def);
        } catch (err) {
          problems.push({ artifact: artifact.name, problem: errorMessage(err) });
          continue;
        }
        for (const op of def.operations) {
          if (op.access === 'write' && !version.permissions.allowWrite) continue;
          if (op.access === 'destructive' && !version.permissions.allowDestructive) continue;
          add({
            def: {
              name: toolName(artifact.name, op.name),
              title: op.summary || undefined,
              description: describeOperation(def, op),
              inputSchema: op.inputSchema,
              outputSchema: cfg.validateOutput ? op.outputSchema : undefined,
              access: op.access,
              source: 'openapi',
              artifactId: artifact.id,
              artifactVersion: version.version,
            },
            exec: { type: 'openapi', integration: artifact.name, op },
          });
        }
      } else if (artifact.kind === 'composite') {
        composites.push({
          def: version.definition as unknown as CompositeDef,
          artifactId: artifact.id,
          version: version.version,
          permissions: version.permissions,
        });
      }
    }

    for (const ut of this.upstreams.tools()) {
      const ucfg = upstreamCfg.get(ut.upstream);
      add({
        // Upstream servers are trusted to exist by configuration, but their
        // destructive tools still need a human per call unless the operator
        // opted out for that server or tool.
        perCallApproval:
          ut.access === 'destructive' &&
          (ucfg?.approval ?? 'destructive') === 'destructive' &&
          !(ucfg?.trustedTools ?? []).includes(ut.tool.name),
        def: {
          name: toolName(ut.upstream, ut.tool.name),
          title: ut.tool.title,
          description: ut.tool.description ?? '',
          inputSchema: ut.tool.inputSchema as JsonSchema,
          outputSchema: ut.tool.outputSchema as JsonSchema | undefined,
          access: ut.access,
          source: 'upstream',
          artifactId: `upstream:${ut.upstream}`,
          artifactVersion: 1,
        },
        exec: {
          type: 'upstream',
          upstream: ut.upstream,
          remoteName: ut.tool.name,
          annotations: ut.tool.annotations as Record<string, unknown> | undefined,
        },
      });
    }

    // Composites last: they are only exposed when every tool they call is
    // itself exposed, so revoking a step's permission also hides the composite.
    for (const c of composites) {
      const missing = c.def.steps
        .filter((s) => !isTransform(s))
        .filter((s) => !next.has(s.tool) || next.get(s.tool)!.exec.type === 'composite');
      if (missing.length) {
        problems.push({
          artifact: c.def.name,
          problem: `hidden: depends on unavailable tools ${missing.map((s) => s.tool).join(', ')}`,
        });
        continue;
      }
      const access = maxAccess(
        c.def.steps.filter((s) => !isTransform(s)).map((s) => next.get(s.tool)!.def.access),
      );
      // A composite that writes is exposed only if its own approval granted
      // that level, independently of what its steps were granted.
      if (
        (access === 'write' && !c.permissions.allowWrite) ||
        (access === 'destructive' && !c.permissions.allowDestructive)
      ) {
        problems.push({
          artifact: c.def.name,
          problem: `hidden: it performs ${access} operations but was approved without --allow-${access === 'write' ? 'writes' : 'destructive'}`,
        });
        continue;
      }
      add({
        def: {
          name: c.def.toolName,
          description: c.permissions.description ?? c.def.description,
          inputSchema: c.def.inputSchema,
          outputSchema: c.def.outputSchema ?? COMPOSITE_OUTPUT_SCHEMA,
          access,
          source: 'composite',
          artifactId: c.artifactId,
          artifactVersion: c.version,
        },
        exec: { type: 'composite', def: c.def },
      });
    }

    this.entries = next;
    this.problems = problems;
  }

  private ensureClient(cfg: IntegrationConfig, def: OpenApiIntegrationDef): IntegrationClient {
    // A gRPC client holds the message types, so a new version gets a new client.
    const types = def.grpc
      ? createHash('sha256').update(JSON.stringify(def.grpc)).digest('hex').slice(0, 16)
      : '';
    const key = `${cfg.name}|${cfg.baseUrl ?? def.baseUrl}|${types}`;
    let client = this.clients.get(key);
    if (!client) {
      for (const [k, old] of [...this.clients])
        if (k.startsWith(`${cfg.name}|`)) {
          old.close?.();
          this.clients.delete(k);
        }
      client = integrationClient(cfg, def, this.redactor);
      this.clients.set(key, client);
    }
    return client;
  }

  client(integration: string): IntegrationClient | undefined {
    for (const [key, c] of this.clients) if (key.startsWith(`${integration}|`)) return c;
    return undefined;
  }

  get(name: string): CatalogEntry | undefined {
    return this.entries.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.def);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }
}

function describeOperation(def: OpenApiIntegrationDef, op: OperationDef): string {
  const text = [op.summary, op.description].filter(Boolean).join('. ').replace(/\s+/g, ' ').trim();
  const base = text || `${op.method} ${op.path}`;
  const access =
    op.access === 'read'
      ? ''
      : op.access === 'write'
        ? ' [modifies data]'
        : ' [destructive: needs per-call approval]';
  const hints = describeParamSources(op, def.name);
  const full = `${base} (${def.title}: ${op.method} ${op.path})${access}${hints ? ` Tip: ${hints}.` : ''}`;
  return full.length > 1024 ? `${full.slice(0, 1021)}...` : full;
}

export interface DispatchOptions {
  limits: Config['composites'];
}

/**
 * The single path every tool call takes: lookup, input validation, approval
 * policy, tracing, execution, output validation.
 */
export class Dispatcher {
  private readonly composite: CompositeExecutor;

  constructor(
    readonly catalog: Catalog,
    private readonly observer: UsageObserver,
    private readonly approvals: CallApprovals,
    private readonly upstreams: UpstreamManager,
    opts: DispatchOptions,
  ) {
    this.composite = new CompositeExecutor(
      (tool, args, ctx) => this.call(tool, args, ctx),
      opts.limits,
    );
  }

  async call(name: string, args: JsonObject, ctx: CallContext): Promise<ToolCallResult> {
    const entry = this.catalog.get(name);
    if (!entry) {
      return fail(
        'not_found',
        `Unknown tool "${name}". It may be unpublished or disabled. Call toolsmith__request_capability to describe what you need.`,
      );
    }
    const { def } = entry;
    const check = validateAgainst(def.inputSchema, args);
    if (!check.valid) return fail('validation', `Invalid arguments for ${name}: ${check.message}`);

    if (entry.perCallApproval) {
      const principal = ctx.principal ?? ctx.sessionId;
      if (!this.approvals.consume(name, args, principal, ctx.approvalId)) {
        const pending = this.approvals.request(name, args, principal);
        return {
          ...fail(
            'approval_required',
            `${name} is destructive and needs a human to approve this exact call. Approval id: ${pending.id}. Ask the user to approve it themselves in the toolsmith dashboard (Approvals) or in their own terminal; you cannot approve it. Then call the tool again with the same arguments.`,
          ),
          approvalId: pending.id,
        };
      }
    }

    return this.observer.observe(def, args, ctx, async (callId) => {
      const inner: CallContext = { ...ctx, parentCallId: callId };
      switch (entry.exec.type) {
        case 'builtin':
          return entry.exec.handler(args, ctx);
        case 'upstream':
          return this.upstreams.call(entry.exec.upstream, entry.exec.remoteName, args, ctx.signal);
        case 'composite':
          return this.composite.run(entry.exec.def, args, inner);
        case 'openapi': {
          const client = this.catalog.client(entry.exec.integration);
          if (!client)
            return fail('internal', `Integration ${entry.exec.integration} is not configured`);
          let out;
          try {
            out = await client.call(entry.exec.op, args, ctx.signal);
          } catch (err) {
            return fail('validation', errorMessage(err));
          }
          if (!out.ok)
            return {
              ok: false,
              error: out.error,
              errorCode: out.errorCode,
              upstreamRequests: out.requests,
              retries: out.retries,
            };
          const result: ToolCallResult = {
            ok: true,
            data: out.data,
            upstreamRequests: out.requests,
            retries: out.retries,
          };
          if (def.outputSchema) {
            const v = validateAgainst(
              def.outputSchema,
              structured(out.data ?? null, entry.exec.op.outputWrapped),
            );
            if (!v.valid) {
              return {
                ...result,
                ok: false,
                errorCode: 'upstream',
                error: `The API response does not match its documented schema (${v.message}). The API documentation may be out of date; an admin can set "validateOutput": false for this integration.`,
              };
            }
          }
          return result;
        }
      }
    });
  }
}

/** Shape data as MCP structuredContent (must be an object). */
export function structured(data: JsonValue, wrapped: boolean): Record<string, JsonValue> {
  if (!wrapped && data && typeof data === 'object' && !Array.isArray(data))
    return data as Record<string, JsonValue>;
  return { result: data };
}

export function fail(code: ToolCallResult['errorCode'], error: string): ToolCallResult {
  return { ok: false, errorCode: code, error, upstreamRequests: 0, retries: 0 };
}

export function splitToolName(name: string): { namespace: string; tool: string } {
  const i = name.indexOf(NAMESPACE_SEP);
  return i < 0
    ? { namespace: '', tool: name }
    : { namespace: name.slice(0, i), tool: name.slice(i + NAMESPACE_SEP.length) };
}
