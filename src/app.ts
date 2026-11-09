import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ClientRateLimit,
  Exposure,
  IntegrationConfig,
  LoadedConfig,
} from './config/config.js';
import { TokenBucket } from './security/rate-limit.js';
import { resolvePath } from './config/config.js';
import { patternToComposite } from './composite/generator.js';
import type { CompositeDef } from './composite/plan.js';
import { ToolsmithError } from './core/errors.js';
import type { CallContext, JsonObject, JsonValue, ToolDefinition } from './core/types.js';
import { DiscoveryEngine, terms } from './discovery/discovery.js';
import { globMatch } from './core/naming.js';
import { isTransform } from './composite/plan.js';
import { evaluateComposite, evaluateIntegration } from './evaluator/evaluator.js';
import { CallApprovals } from './gateway/approvals.js';
import { Catalog, Dispatcher, type BuiltinTool } from './gateway/gateway.js';
import { UsageObserver } from './observer/observer.js';
import { OtlpExporter } from './observer/otel.js';
import { resolveEnvRefs } from './security/secrets.js';
import { TraceStore } from './observer/trace-store.js';
import { endpointsToOpenApi, parseEndpointText } from './openapi/endpoints.js';
import { fetchSpec, importOpenApi } from './openapi/import.js';
import { LlmStage, extractedToOpenApi } from './llm/llm.js';
import { HttpIntegrationClient } from './openapi/http-executor.js';
import { INTROSPECTION_QUERY, introspectionToDef, isIntrospection } from './graphql/graphql.js';
import type { OpenApiIntegrationDef } from './openapi/types.js';
import { minePatterns, type Pattern } from './patterns/miner.js';
import { Registry, type Permissions, type VersionRow } from './registry/registry.js';
import { Fingerprinter, Redactor } from './security/redact.js';
import { AuditLog } from './store/audit.js';
import { openDb, type Db } from './store/db.js';
import { UpstreamManager } from './upstream/upstream-manager.js';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

export interface ToolsmithOptions {
  /** Override the database path (tests use ':memory:'). */
  dbPath?: string;
}

/**
 * Composition root. Owns every component and exposes the operations the CLI,
 * the MCP server and the admin API share, so all three behave identically.
 */
/** Crude HTML to text for documentation pages: drop scripts/styles/tags, keep the words. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export class Toolsmith {
  readonly db: Db;
  readonly redactor = new Redactor();
  readonly registry: Registry;
  readonly traces: TraceStore;
  readonly approvals: CallApprovals;
  readonly audit: AuditLog;
  readonly upstreams: UpstreamManager;
  readonly catalog: Catalog;
  readonly dispatcher: Dispatcher;
  readonly discovery: DiscoveryEngine;
  private readonly observer: UsageObserver;
  readonly otel?: OtlpExporter;
  /** In-client approval prompts sent and not yet answered (principal, tool, args). */
  readonly inClientAsks = new Map<string, number>();
  private changeListeners = new Set<() => void>();
  private lastRevision = -1;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    readonly loaded: LoadedConfig,
    opts: ToolsmithOptions = {},
  ) {
    const cfg = loaded.config;
    const dbPath = opts.dbPath ?? resolve(loaded.baseDir, cfg.dataDir, 'toolsmith.db');
    this.db = openDb(dbPath);
    this.registry = new Registry(this.db);
    this.traces = new TraceStore(this.db);
    this.audit = new AuditLog(this.db);
    this.approvals = new CallApprovals(this.db, this.redactor);
    if (cfg.telemetry.otlpEndpoint) {
      this.otel = new OtlpExporter({
        endpoint: cfg.telemetry.otlpEndpoint,
        headers: Object.fromEntries(
          Object.entries(cfg.telemetry.headers).map(([k, v]) => [k, resolveEnvRefs(v)]),
        ),
        serviceName: cfg.telemetry.serviceName,
        exportArguments: cfg.telemetry.exportArguments,
      });
    }
    this.observer = new UsageObserver(
      this.traces,
      this.redactor,
      new Fingerprinter(this.fingerprintKey()),
      {
        captureArguments: cfg.traces.captureArguments,
        onTrace: (r) => this.otel?.record(r),
      },
    );
    this.upstreams = new UpstreamManager(() => this.refresh(), this.redactor);
    this.discovery = new DiscoveryEngine(
      this.db,
      this.registry,
      () => new Set(this.catalog.list().map((t) => t.name)),
    );
    this.catalog = new Catalog(
      cfg,
      this.registry,
      this.upstreams,
      this.redactor,
      cfg.metaTools ? this.builtinTools() : [],
    );
    this.dispatcher = new Dispatcher(this.catalog, this.observer, this.approvals, this.upstreams, {
      limits: cfg.composites,
    });
    this.registry.onChange(() => this.refresh());
    this.refresh();
  }

  get config() {
    return this.loaded.config;
  }

  /** Connect upstreams, apply retention, and watch for changes made by other processes. */
  async start(): Promise<void> {
    this.traces.applyRetention(this.config.traces.retentionDays);
    if (this.config.upstreams.length) {
      await this.upstreams.connectAll(this.config.upstreams);
      for (const u of this.config.upstreams) this.registerUpstream(u.name);
    }
    this.refresh();
    // The CLI and the dashboard may run in other processes; a revision
    // counter in SQLite lets every gateway notice published/disabled tools.
    this.pollTimer = setInterval(() => {
      if (this.registry.revision() !== this.lastRevision) this.refresh();
    }, 1500);
    this.pollTimer.unref();
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.otel?.close();
    await this.upstreams.closeAll();
    this.db.close();
  }

  onToolsChanged(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  refresh(): void {
    this.lastRevision = this.registry.revision();
    this.catalog.rebuild();
    for (const fn of this.changeListeners) fn();
  }

  call(name: string, args: JsonObject, ctx: CallContext) {
    return this.dispatcher.call(name, args, ctx);
  }

  private fingerprintKey(): string {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'fingerprint_key'")
      .get() as { value: string } | undefined;
    if (row) return row.value;
    const key = randomBytes(32).toString('hex');
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('fingerprint_key', ?)").run(key);
    return key;
  }

  private registerUpstream(name: string): void {
    const artifact = this.registry.ensureArtifact('upstream', name);
    const status = this.upstreams.status().find((s) => s.name === name);
    const def = { kind: 'upstream', name, transport: status?.transport ?? 'stdio' } as JsonValue;
    const { version, created } = this.registry.addVersion(
      artifact.id,
      def,
      'config',
      'approved',
      'human:config',
    );
    if (created || artifact.publishedVersion !== version.version) {
      if (version.status === 'approved')
        this.registry.publish(artifact.id, version.version, 'human:config');
    }
  }

  // ---- Exposure (which tools a client sees and may call) ------------------

  /** The configured client entry behind a principal, if any. */
  private clientConfig(principal?: string): {
    exposure?: Exposure;
    rateLimit?: ClientRateLimit;
    oauth: boolean;
  } {
    const name = principal?.startsWith('http:') ? principal.slice(5) : undefined;
    if (name?.startsWith('oauth:')) {
      const oauth = this.config.server.oauth;
      let clientId = '';
      try {
        clientId = decodeURIComponent(name.slice(6));
      } catch {
        /* never matches a configured client */
      }
      const c = oauth?.clients.find((x) => x.clientId === clientId);
      return {
        exposure: c?.exposure ?? oauth?.exposure,
        rateLimit: c?.rateLimit ?? oauth?.rateLimit,
        oauth: true,
      };
    }
    const c = name ? this.config.server.clients.find((x) => x.name === name) : undefined;
    return { exposure: c?.exposure, rateLimit: c?.rateLimit, oauth: false };
  }

  exposureFor(principal?: string): Exposure {
    return this.clientConfig(principal).exposure ?? this.config.exposure;
  }

  private readonly clientBuckets = new Map<string, TokenBucket>();

  /**
   * Spend one call from this client's rate limit. Returns 0 when allowed,
   * else the milliseconds until the next call would be. Never waits: a
   * client over its limit is told so at once.
   */
  takeClientCall(principal: string): number {
    const limit = this.clientConfig(principal).rateLimit ?? this.config.server.rateLimit;
    if (!limit) return 0;
    let bucket = this.clientBuckets.get(principal);
    if (!bucket) {
      bucket = new TokenBucket(limit.requestsPerSecond, limit.burst);
      this.clientBuckets.set(principal, bucket);
      // Bounded: principals are authenticated, but OAuth client ids are open-ended.
      if (this.clientBuckets.size > 10_000)
        this.clientBuckets.delete(this.clientBuckets.keys().next().value!);
    }
    return bucket.tryTake() ? 0 : Math.max(1, bucket.waitMs());
  }

  /**
   * May this client call this tool? Builtins are always allowed. A composite
   * is allowed only if every tool it calls is, so an allow-list cannot be
   * sidestepped through a composite.
   */
  allowed(principal: string | undefined, tool: string): boolean {
    const exp = this.exposureFor(principal);
    const entry = this.catalog.get(tool);
    if (entry?.def.source === 'builtin') return true;
    if (exp.tools.length === 0) return true;
    const ok = (name: string) => exp.tools.some((p) => globMatch(p, name));
    if (!ok(tool)) return false;
    if (entry?.exec.type === 'composite')
      return entry.exec.def.steps.filter((s) => !isTransform(s)).every((s) => ok(s.tool));
    return true;
  }

  /** The tool list a client gets from tools/list. */
  listedTools(principal?: string): ToolDefinition[] {
    const exp = this.exposureFor(principal);
    return this.catalog
      .list()
      .filter((t) => this.allowed(principal, t.name))
      .filter(
        (t) =>
          exp.list === 'all' ||
          t.source === 'builtin' ||
          exp.pinned.some((p) => globMatch(p, t.name)),
      );
  }

  /** Rank the tools a client may call against a free-text query. */
  searchTools(
    query: string,
    principal?: string,
    limit = 8,
  ): Array<ToolDefinition & { score: number }> {
    const q = new Set(terms(query));
    if (q.size === 0) return [];
    return this.catalog
      .list()
      .filter((t) => t.source !== 'builtin' && this.allowed(principal, t.name))
      .map((t) => {
        const tt = new Set([...terms(t.name), ...terms(t.description)]);
        const hits = [...q].filter((w) => tt.has(w)).length;
        return { ...t, score: Math.round((hits / q.size) * 100) / 100 };
      })
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  private builtinTools(): BuiltinTool[] {
    return [
      {
        name: 'toolsmith__search_tools',
        description:
          'Find tools by describing what you need ("customer orders", "delete a product"). Returns matching tool names with their descriptions and input schemas; call them directly afterwards. Use this when the tool list is short (large catalogs list only a few tools).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 2, maxLength: 500 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const found = this.searchTools(
            String(args.query),
            ctx.principal ?? ctx.sessionId,
            typeof args.limit === 'number' ? args.limit : 8,
          );
          return {
            ok: true,
            data: {
              tools: found.map((t) => ({
                name: t.name,
                description: t.description,
                access: t.access,
                score: t.score,
                inputSchema: t.inputSchema as JsonValue,
              })),
              hint: found.length
                ? 'Call any of these by name.'
                : 'Nothing matched. If the task needs something new, call toolsmith__request_capability.',
            } as JsonValue,
            upstreamRequests: 0,
            retries: 0,
          };
        },
      },
      {
        name: 'toolsmith__request_capability',
        description:
          'Call this when none of the available tools can do what the user asked. Describe the task in plain words. Toolsmith checks the connected APIs and answers whether it is already possible, can be built from existing operations (and proposes a tool for human approval), needs approval of an existing operation, or is not supported.',
        inputSchema: {
          type: 'object',
          properties: {
            request: {
              type: 'string',
              minLength: 3,
              maxLength: 2000,
              description: 'What the user wants to do',
            },
          },
          required: ['request'],
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const analysis = await this.analyzeCapability(
            String(args.request),
            ctx.sessionId,
            ctx.principal,
          );
          if (analysis.proposal)
            await this.evaluateLatest(analysis.proposal.artifact, [], 'discovery').catch(
              () => undefined,
            );
          return {
            ok: true,
            data: analysis as unknown as JsonValue,
            upstreamRequests: 0,
            retries: 0,
          };
        },
      },
    ];
  }

  // ---- Lifecycle operations -------------------------------------------------

  integrationConfig(name: string): IntegrationConfig {
    const cfg = this.config.integrations.find((i) => i.name === name);
    if (!cfg) {
      throw new ToolsmithError(
        `Integration "${name}" is not in ${this.loaded.path ?? 'toolsmith.config.json'}`,
        'not_found',
        'Add it with `toolsmith-mcp import <spec> --name <name>`.',
      );
    }
    return cfg;
  }

  /** Import (or re-import) a configured integration and evaluate it. */
  async importIntegration(
    name: string,
    actor: string,
    opts: { live?: boolean; endpointsText?: string } = {},
  ): Promise<VersionRow> {
    const cfg = this.integrationConfig(name);
    let source: string | Record<string, unknown> = resolvePath(this.loaded, cfg.spec);
    if (
      cfg.type === 'openapi' &&
      (cfg.spec.endsWith('.endpoints') || cfg.spec.endsWith('.txt') || opts.endpointsText)
    ) {
      const text = opts.endpointsText ?? readFileSync(source as string, 'utf8');
      if (!cfg.baseUrl)
        throw new ToolsmithError(
          'Endpoint lists need "baseUrl" in the integration config',
          'validation',
        );
      source = endpointsToOpenApi(parseEndpointText(text, cfg.baseUrl, name));
    }
    const def =
      cfg.type === 'graphql'
        ? await this.importGraphql(cfg)
        : cfg.type === 'docs'
          ? await this.importFromDocs(cfg, source as string)
          : await importOpenApi(source, {
              name,
              baseUrl: cfg.baseUrl,
              include: cfg.include,
              exclude: cfg.exclude,
              allowPrivateNetwork: cfg.allowPrivateNetwork,
            });
    def.specSource = cfg.spec;
    const artifact = this.registry.ensureArtifact('openapi', name);
    const { version, created } = this.registry.addVersion(
      artifact.id,
      def as unknown as JsonValue,
      `import:${cfg.spec}`,
      'generating',
      actor,
    );
    this.audit.write(actor, 'import', name, {
      version: version.version,
      operations: def.operations.length,
      created,
    });
    if (!created) return version;
    return this.runEvaluation(artifact.id, version.version, actor, { live: opts.live ?? true });
  }

  /** Free-text documentation → endpoints via the optional LLM stage, then the normal import. */
  private async importFromDocs(
    cfg: IntegrationConfig,
    source: string,
  ): Promise<OpenApiIntegrationDef> {
    const llm = this.llmStage();
    if (!llm) {
      throw new ToolsmithError(
        'Importing from free-text documentation needs the optional LLM stage, which is off',
        'validation',
        'Set "llm": { "enabled": true } in toolsmith.config.json (it sends the documentation to Anthropic), or provide an OpenAPI spec or an endpoint list instead.',
      );
    }
    // Same SSRF rules as spec downloads; the page is about to be sent to the LLM.
    const raw = /^https?:\/\//.test(source)
      ? await (await fetchSpec(source, cfg.allowPrivateNetwork)).text()
      : readFileSync(source, 'utf8');
    const text = /<html|<body|<div/i.test(raw) ? htmlToText(raw) : raw;
    const extracted = await llm.extractEndpoints(text, { name: cfg.name, baseUrl: cfg.baseUrl });
    const def = await importOpenApi(extractedToOpenApi(extracted, cfg.baseUrl), {
      name: cfg.name,
      baseUrl: cfg.baseUrl,
      include: cfg.include,
      exclude: cfg.exclude,
    });
    def.findings.unshift({
      severity: 'warning',
      code: 'from_llm',
      message: `Endpoints were extracted from free-text documentation by ${this.config.llm.model}. Review every tool: extraction can be wrong even when it looks plausible, which is why each read operation is verified with a live call.`,
    });
    return def;
  }

  private llmCache?: LlmStage;
  llmStage(): LlmStage | undefined {
    if (!this.config.llm.enabled) return undefined;
    return (this.llmCache ??= new LlmStage({
      model: this.config.llm.model,
      effort: this.config.llm.effort,
    }));
  }

  /** For tests: inject a stage with a fake client. */
  setLlmStage(stage: LlmStage): void {
    this.llmCache = stage;
  }

  /**
   * Capability analysis, with the LLM fallback when keyword matching finds
   * nothing and the fallback is enabled. Suggested names are checked against
   * the tools this client may call; invented names are dropped.
   */
  async analyzeCapability(request: string, sessionId?: string, principal?: string) {
    const ok = (tool: string) => this.allowed(principal ?? sessionId, tool);
    const analysis = this.discovery.analyze(request, sessionId, ok);
    const llm = this.llmStage();
    if (analysis.verdict !== 'unsupported' || !llm || !this.config.llm.capabilityFallback)
      return analysis;
    const allowed = this.catalog
      .list()
      .filter((t) => t.source !== 'builtin' && this.allowed(principal ?? sessionId, t.name));
    try {
      const s = await llm.suggestTools(
        request,
        allowed.map((t) => ({ name: t.name, description: t.description })),
      );
      const names = new Set(allowed.map((t) => t.name));
      const valid = s.tools.filter((t) => names.has(t.name));
      if (valid.length === 0 || !s.possible)
        return { ...analysis, llm: { explanation: s.explanation, tools: [] } };
      return {
        ...analysis,
        verdict: 'available' as const,
        explanation: `Keyword matching found nothing, but ${this.config.llm.model} suggests: ${valid.map((t) => `${t.name} (${t.why})`).join('; ')}. Check that these fit before relying on them.`,
        llm: { explanation: s.explanation, tools: valid },
      };
    } catch (err) {
      return { ...analysis, llm: { error: (err as Error).message } };
    }
  }

  /** Introspect a GraphQL endpoint (through the guarded client) or read a saved introspection file. */
  private async importGraphql(cfg: IntegrationConfig): Promise<OpenApiIntegrationDef> {
    const isUrl = /^https?:\/\//.test(cfg.spec);
    const endpoint = isUrl ? cfg.spec : cfg.baseUrl;
    if (!endpoint) {
      throw new ToolsmithError(
        'A GraphQL integration needs the endpoint URL',
        'validation',
        'Set "spec" to the endpoint URL, or "baseUrl" when "spec" is a saved introspection file.',
      );
    }
    let intro: unknown;
    if (isUrl) {
      const url = new URL(endpoint);
      const client = new HttpIntegrationClient(cfg, url.origin, this.redactor);
      const r = await client.call(
        {
          name: 'introspect',
          method: 'POST',
          path: url.pathname,
          summary: '',
          description: '',
          params: [],
          inputSchema: { type: 'object' },
          outputWrapped: false,
          access: 'read',
          tags: [],
          graphql: { document: INTROSPECTION_QUERY, field: '__schema' },
        },
        {},
      );
      if (!r.ok)
        throw new ToolsmithError(
          `GraphQL introspection failed: ${r.error}`,
          r.errorCode ?? 'upstream',
          'Introspection may be disabled on this server; save an introspection result to a file and point "spec" at it.',
        );
      intro = { __schema: r.data };
    } else {
      intro = JSON.parse(readFileSync(resolvePath(this.loaded, cfg.spec), 'utf8'));
    }
    if (!isIntrospection(intro))
      throw new ToolsmithError('Not a GraphQL introspection result', 'validation');
    return introspectionToDef(cfg.name, endpoint, intro);
  }

  async runEvaluation(
    artifactId: string,
    version: number,
    actor: string,
    opts: { live?: boolean; inputs?: JsonObject[] } = {},
  ): Promise<VersionRow> {
    let v = this.registry.getVersion(artifactId, version)!;
    const artifact = this.registry.getArtifact(artifactId)!;
    if (v.status === 'proposed' || v.status === 'failed' || v.status === 'awaiting_approval') {
      v = this.registry.transition(artifactId, version, 'generating', actor);
    }
    if (v.status === 'generating')
      v = this.registry.transition(artifactId, version, 'testing', actor);
    if (v.status !== 'testing')
      throw new ToolsmithError(`Cannot evaluate a version in status "${v.status}"`, 'policy');
    let evaluation;
    try {
      if (artifact.kind === 'openapi') {
        evaluation = await evaluateIntegration(
          v.definition as unknown as OpenApiIntegrationDef,
          this.integrationConfig(artifact.name),
          this.redactor,
          { live: opts.live ?? true },
        );
      } else if (artifact.kind === 'composite') {
        const def = v.definition as unknown as CompositeDef;
        const inputs = opts.inputs?.length ? opts.inputs : this.examplesFromTraces(def);
        evaluation = await evaluateComposite(def, inputs, {
          call: (tool, args, ctx) => this.dispatcher.call(tool, args, ctx),
          runComposite: (d, args, ctx) => this.runCompositeDirect(d, args, ctx),
          toolAccess: (tool) => {
            const t = this.catalog.get(tool);
            return t && t.def.source !== 'composite' ? t.def.access : undefined;
          },
          limits: this.config.composites,
        });
      } else {
        throw new ToolsmithError('Upstream servers are not evaluated', 'validation');
      }
    } catch (err) {
      this.registry.transition(artifactId, version, 'failed', actor, (err as Error).message);
      throw err;
    }
    this.registry.setEvaluation(artifactId, version, evaluation);
    return this.registry.transition(
      artifactId,
      version,
      evaluation.passed ? 'awaiting_approval' : 'failed',
      actor,
      evaluation.passed ? 'evaluation passed' : 'evaluation failed',
    );
  }

  /**
   * Example inputs for a mined composite, read from the recorded (redacted)
   * calls it references. Calls that are gone (retention) or whose values
   * were redacted are skipped.
   */
  private examplesFromTraces(def: CompositeDef): JsonObject[] {
    const props = Object.keys((def.inputSchema.properties ?? {}) as object);
    const required = (def.inputSchema.required as string[] | undefined) ?? [];
    const out: JsonObject[] = [];
    for (const id of def.exampleTraceIds ?? []) {
      const args = this.traces.get(id)?.args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const input: JsonObject = {};
      for (const k of props) if (k in args) input[k] = (args as JsonObject)[k]!;
      if (required.every((r) => r in input) && !JSON.stringify(input).includes('[REDACTED'))
        out.push(input);
    }
    return out;
  }

  /** Run a composite definition that is not (yet) published, for evaluation. */
  private async runCompositeDirect(def: CompositeDef, args: JsonObject, ctx: CallContext) {
    const { CompositeExecutor } = await import('./composite/executor.js');
    const exec = new CompositeExecutor(
      (tool, a, c) => this.dispatcher.call(tool, a, c),
      this.config.composites,
    );
    return exec.run(def, args, ctx);
  }

  async evaluateLatest(
    name: string,
    inputs: JsonObject[],
    actor: string,
    live = true,
  ): Promise<VersionRow> {
    const { artifact } = this.registry.resolve(name);
    const latest = this.registry.latestVersion(artifact.id);
    if (!latest) throw new ToolsmithError(`"${name}" has no versions`, 'not_found');
    return this.runEvaluation(artifact.id, latest.version, actor, { inputs, live });
  }

  approve(ref: string, perms: Permissions, actor: string, publish = true): VersionRow {
    const { artifact, version } = this.registry.resolve(ref);
    const v =
      version ??
      this.registry.versionsByStatus('awaiting_approval').find((x) => x.artifactId === artifact.id)
        ?.version;
    if (!v) {
      const latest = this.registry.latestVersion(artifact.id);
      throw new ToolsmithError(
        `"${artifact.name}" has no version awaiting approval${latest ? ` (latest v${latest.version} is ${latest.status})` : ''}`,
        'validation',
        latest?.status === 'failed'
          ? `See why with \`toolsmith-mcp show ${artifact.name}\`.`
          : undefined,
      );
    }
    let out = this.registry.approve(artifact.id, v, perms, actor);
    this.audit.write(actor, 'approve', `${artifact.name}@${v}`, perms as unknown as JsonValue);
    if (publish) {
      out = this.registry.publish(artifact.id, v, actor);
      this.audit.write(actor, 'publish', `${artifact.name}@${v}`);
    }
    return out;
  }

  reject(ref: string, actor: string, reason?: string): VersionRow {
    const { artifact, version } = this.registry.resolve(ref);
    const v = version ?? this.registry.latestVersion(artifact.id)!.version;
    this.audit.write(actor, 'reject', `${artifact.name}@${v}`, reason ?? null);
    return this.registry.transition(artifact.id, v, 'rejected', actor, reason);
  }

  publish(ref: string, actor: string): VersionRow {
    const { artifact, version } = this.registry.resolve(ref);
    const v =
      version ??
      this.registry.listVersions(artifact.id).find((x) => x.status === 'approved')?.version;
    if (!v)
      throw new ToolsmithError(
        `"${artifact.name}" has no approved version to publish`,
        'validation',
      );
    this.audit.write(actor, 'publish', `${artifact.name}@${v}`);
    return this.registry.publish(artifact.id, v, actor);
  }

  disable(ref: string, actor: string, reason?: string): VersionRow {
    const { artifact } = this.registry.resolve(ref);
    this.audit.write(actor, 'disable', artifact.name, reason ?? null);
    return this.registry.disable(artifact.id, actor, reason);
  }

  enable(ref: string, actor: string): VersionRow {
    const { artifact } = this.registry.resolve(ref);
    this.audit.write(actor, 'enable', artifact.name);
    return this.registry.enable(artifact.id, actor);
  }

  rollback(ref: string, actor: string): VersionRow {
    const { artifact, version } = this.registry.resolve(ref);
    const out = this.registry.rollback(artifact.id, actor, version);
    this.audit.write(actor, 'rollback', `${artifact.name}@${out.version}`);
    return out;
  }

  // ---- Composite usage (AWO: measure benefit, not just equivalence) -------

  /**
   * For each published composite: how often agents use it, how many MCP
   * round-trips it saved, and how often agents still run the same workflow
   * by hand since it was published. Unused composites are flagged: extra
   * tools are not free for the agent (AWO saw weaker models regress).
   */
  compositeUsage(unusedAfterDays = 7): Array<{
    name: string;
    tool: string;
    publishedAt: string;
    calls: number;
    sessions: number;
    stepCalls: number;
    roundTripsSaved: number;
    manualRunsSincePublish: number;
    adoption: number | null;
    lastUsed: string | null;
    unused: boolean;
  }> {
    const out = [];
    for (const { artifact, version } of this.registry.publishedVersions()) {
      if (artifact.kind !== 'composite') continue;
      const def = version.definition as unknown as CompositeDef;
      const published = this.registry
        .events(artifact.id)
        .find((e) => e.version === version.version && e.toStatus === 'published');
      const since = published ? Date.parse(published.at) : 0;
      const calls = this.traces.query({
        tool: def.toolName,
        since,
        topLevelOnly: true,
        limit: 100_000,
      });
      const stepCalls = calls.reduce((n, t) => n + this.traces.children(t.id).length, 0);
      const manual =
        def.provenance.type === 'pattern'
          ? (this.mine(since).find((p) => p.id === def.provenance.ref)?.support ?? 0)
          : 0;
      const ageDays = (Date.now() - since) / 86_400_000;
      out.push({
        name: artifact.name,
        tool: def.toolName,
        publishedAt: published?.at ?? '',
        calls: calls.length,
        sessions: new Set(calls.map((c) => c.sessionId)).size,
        stepCalls,
        roundTripsSaved: Math.max(0, stepCalls - calls.length),
        manualRunsSincePublish: manual,
        adoption:
          calls.length + manual > 0
            ? Math.round((calls.length / (calls.length + manual)) * 100) / 100
            : null,
        lastUsed: calls[0] ? new Date(calls[0].startedAt).toISOString() : null,
        unused: calls.length === 0 && ageDays >= unusedAfterDays,
      });
    }
    return out;
  }

  // ---- Workflow discovery ---------------------------------------------------

  mine(sinceMs?: number): Pattern[] {
    const p = this.config.patterns;
    return minePatterns(this.traces.chronological(sinceMs), p);
  }

  /**
   * Mine traces and turn each new pattern into a proposed composite, then
   * evaluate it. Patterns whose composite already exists (same content) are
   * not re-proposed.
   */
  async proposeComposites(
    actor: string,
    opts: { sinceMs?: number; evaluate?: boolean } = {},
  ): Promise<
    Array<{ pattern: Pattern; def?: CompositeDef; version?: VersionRow; error?: string }>
  > {
    const out: Array<{
      pattern: Pattern;
      def?: CompositeDef;
      version?: VersionRow;
      error?: string;
    }> = [];
    for (const pattern of this.mine(opts.sinceMs)) {
      try {
        const def = patternToComposite(pattern, (n) => {
          const e = this.catalog.get(n);
          return e && e.def.source !== 'composite' ? e.def : undefined;
        });
        const artifact = this.registry.ensureArtifact('composite', def.name);
        const { version, created } = this.registry.addVersion(
          artifact.id,
          def as unknown as JsonValue,
          `pattern:${pattern.id}`,
          'proposed',
          actor,
        );
        let v = version;
        if (created) {
          this.audit.write(actor, 'propose', def.name, {
            pattern: pattern.signature,
            support: pattern.support,
          });
          if (opts.evaluate !== false)
            v = await this.runEvaluation(artifact.id, version.version, actor).catch(() =>
              this.registry.getVersion(artifact.id, version.version)!,
            );
        }
        out.push({ pattern, def, version: v });
      } catch (err) {
        out.push({ pattern, error: (err as Error).message });
      }
    }
    return out;
  }
}
