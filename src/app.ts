import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IntegrationConfig, LoadedConfig } from './config/config.js';
import { resolvePath } from './config/config.js';
import { patternToComposite } from './composite/generator.js';
import type { CompositeDef } from './composite/plan.js';
import { ToolsmithError } from './core/errors.js';
import type { CallContext, JsonObject, JsonValue } from './core/types.js';
import { DiscoveryEngine } from './discovery/discovery.js';
import { evaluateComposite, evaluateIntegration } from './evaluator/evaluator.js';
import { CallApprovals } from './gateway/approvals.js';
import { Catalog, Dispatcher, type BuiltinTool } from './gateway/gateway.js';
import { UsageObserver } from './observer/observer.js';
import { TraceStore } from './observer/trace-store.js';
import { endpointsToOpenApi, parseEndpointText } from './openapi/endpoints.js';
import { importOpenApi } from './openapi/import.js';
import type { OpenApiIntegrationDef } from './openapi/types.js';
import { minePatterns, type Pattern } from './patterns/miner.js';
import { Registry, type Permissions, type VersionRow } from './registry/registry.js';
import { Fingerprinter, Redactor } from './security/redact.js';
import { AuditLog } from './store/audit.js';
import { openDb, type Db } from './store/db.js';
import { UpstreamManager } from './upstream/upstream-manager.js';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
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
    this.observer = new UsageObserver(this.traces, this.redactor, new Fingerprinter(this.fingerprintKey()), {
      captureArguments: cfg.traces.captureArguments,
    });
    this.upstreams = new UpstreamManager(() => this.refresh());
    this.discovery = new DiscoveryEngine(this.db, this.registry, () => new Set(this.catalog.list().map((t) => t.name)));
    this.catalog = new Catalog(cfg, this.registry, this.upstreams, this.redactor, cfg.metaTools ? this.builtinTools() : []);
    this.dispatcher = new Dispatcher(this.catalog, this.observer, this.approvals, this.upstreams, { limits: cfg.composites });
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
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'fingerprint_key'").get() as { value: string } | undefined;
    if (row) return row.value;
    const key = randomBytes(32).toString('hex');
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('fingerprint_key', ?)").run(key);
    return key;
  }

  private registerUpstream(name: string): void {
    const artifact = this.registry.ensureArtifact('upstream', name);
    const status = this.upstreams.status().find((s) => s.name === name);
    const def = { kind: 'upstream', name, transport: status?.transport ?? 'stdio' } as JsonValue;
    const { version, created } = this.registry.addVersion(artifact.id, def, 'config', 'approved', 'human:config');
    if (created || artifact.publishedVersion !== version.version) {
      if (version.status === 'approved') this.registry.publish(artifact.id, version.version, 'human:config');
    }
  }

  private builtinTools(): BuiltinTool[] {
    return [
      {
        name: 'toolsmith__request_capability',
        description:
          'Call this when none of the available tools can do what the user asked. Describe the task in plain words. Toolsmith checks the connected APIs and answers whether it is already possible, can be built from existing operations (and proposes a tool for human approval), needs approval of an existing operation, or is not supported.',
        inputSchema: {
          type: 'object',
          properties: { request: { type: 'string', minLength: 3, maxLength: 2000, description: 'What the user wants to do' } },
          required: ['request'],
          additionalProperties: false,
        },
        handler: async (args, ctx) => {
          const analysis = this.discovery.analyze(String(args.request), ctx.sessionId);
          if (analysis.proposal) await this.evaluateLatest(analysis.proposal.artifact, [], 'discovery').catch(() => undefined);
          return { ok: true, data: analysis as unknown as JsonValue, upstreamRequests: 0, retries: 0 };
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
  async importIntegration(name: string, actor: string, opts: { live?: boolean; endpointsText?: string } = {}): Promise<VersionRow> {
    const cfg = this.integrationConfig(name);
    let source: string | Record<string, unknown> = resolvePath(this.loaded, cfg.spec);
    if (cfg.spec.endsWith('.endpoints') || cfg.spec.endsWith('.txt') || opts.endpointsText) {
      const text = opts.endpointsText ?? readFileSync(source as string, 'utf8');
      if (!cfg.baseUrl) throw new ToolsmithError('Endpoint lists need "baseUrl" in the integration config', 'validation');
      source = endpointsToOpenApi(parseEndpointText(text, cfg.baseUrl, name));
    }
    const def = await importOpenApi(source, { name, baseUrl: cfg.baseUrl, include: cfg.include, exclude: cfg.exclude });
    def.specSource = cfg.spec;
    const artifact = this.registry.ensureArtifact('openapi', name);
    const { version, created } = this.registry.addVersion(artifact.id, def as unknown as JsonValue, `import:${cfg.spec}`, 'generating', actor);
    this.audit.write(actor, 'import', name, { version: version.version, operations: def.operations.length, created });
    if (!created) return version;
    return this.runEvaluation(artifact.id, version.version, actor, { live: opts.live ?? true });
  }

  async runEvaluation(artifactId: string, version: number, actor: string, opts: { live?: boolean; inputs?: JsonObject[] } = {}): Promise<VersionRow> {
    let v = this.registry.getVersion(artifactId, version)!;
    const artifact = this.registry.getArtifact(artifactId)!;
    if (v.status === 'proposed' || v.status === 'failed' || v.status === 'awaiting_approval') {
      v = this.registry.transition(artifactId, version, 'generating', actor);
    }
    if (v.status === 'generating') v = this.registry.transition(artifactId, version, 'testing', actor);
    if (v.status !== 'testing') throw new ToolsmithError(`Cannot evaluate a version in status "${v.status}"`, 'policy');
    let evaluation;
    try {
      if (artifact.kind === 'openapi') {
        evaluation = await evaluateIntegration(v.definition as unknown as OpenApiIntegrationDef, this.integrationConfig(artifact.name), this.redactor, { live: opts.live ?? true });
      } else if (artifact.kind === 'composite') {
        const def = v.definition as unknown as CompositeDef;
        evaluation = await evaluateComposite(def, opts.inputs ?? [], {
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
    return this.registry.transition(artifactId, version, evaluation.passed ? 'awaiting_approval' : 'failed', actor, evaluation.passed ? 'evaluation passed' : 'evaluation failed');
  }

  /** Run a composite definition that is not (yet) published, for evaluation. */
  private async runCompositeDirect(def: CompositeDef, args: JsonObject, ctx: CallContext) {
    const { CompositeExecutor } = await import('./composite/executor.js');
    const exec = new CompositeExecutor((tool, a, c) => this.dispatcher.call(tool, a, c), this.config.composites);
    return exec.run(def, args, ctx);
  }

  async evaluateLatest(name: string, inputs: JsonObject[], actor: string, live = true): Promise<VersionRow> {
    const { artifact } = this.registry.resolve(name);
    const latest = this.registry.latestVersion(artifact.id);
    if (!latest) throw new ToolsmithError(`"${name}" has no versions`, 'not_found');
    return this.runEvaluation(artifact.id, latest.version, actor, { inputs, live });
  }

  approve(ref: string, perms: Permissions, actor: string, publish = true): VersionRow {
    const { artifact, version } = this.registry.resolve(ref);
    const v = version ?? this.registry.versionsByStatus('awaiting_approval').find((x) => x.artifactId === artifact.id)?.version;
    if (!v) {
      const latest = this.registry.latestVersion(artifact.id);
      throw new ToolsmithError(
        `"${artifact.name}" has no version awaiting approval${latest ? ` (latest v${latest.version} is ${latest.status})` : ''}`,
        'validation',
        latest?.status === 'failed' ? `See why with \`toolsmith-mcp show ${artifact.name}\`.` : undefined,
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
    const v = version ?? this.registry.listVersions(artifact.id).find((x) => x.status === 'approved')?.version;
    if (!v) throw new ToolsmithError(`"${artifact.name}" has no approved version to publish`, 'validation');
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
  async proposeComposites(actor: string, opts: { sinceMs?: number; evaluate?: boolean } = {}): Promise<Array<{ pattern: Pattern; def?: CompositeDef; version?: VersionRow; error?: string }>> {
    const out: Array<{ pattern: Pattern; def?: CompositeDef; version?: VersionRow; error?: string }> = [];
    for (const pattern of this.mine(opts.sinceMs)) {
      try {
        const def = patternToComposite(pattern, (n) => {
          const e = this.catalog.get(n);
          return e && e.def.source !== 'composite' ? e.def : undefined;
        });
        const artifact = this.registry.ensureArtifact('composite', def.name);
        const { version, created } = this.registry.addVersion(artifact.id, def as unknown as JsonValue, `pattern:${pattern.id}`, 'proposed', actor);
        let v = version;
        if (created) {
          this.audit.write(actor, 'propose', def.name, { pattern: pattern.signature, support: pattern.support });
          if (opts.evaluate !== false) v = await this.runEvaluation(artifact.id, version.version, actor).catch(() => this.registry.getVersion(artifact.id, version.version)!);
        }
        out.push({ pattern, def, version: v });
      } catch (err) {
        out.push({ pattern, error: (err as Error).message });
      }
    }
    return out;
  }
}
