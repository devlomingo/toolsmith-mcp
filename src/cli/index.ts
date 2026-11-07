#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Toolsmith, VERSION } from '../app.js';
import { CONFIG_FILE, loadConfig, findConfig, loadDotEnv, type LoadedConfig } from '../config/config.js';
import { ToolsmithError } from '../core/errors.js';
import type { JsonObject } from '../core/types.js';
import { ShopApi } from '../demo/shop.js';
import type { CapabilityAnalysis } from '../discovery/discovery.js';
import type { OpenApiIntegrationDef } from '../openapi/types.js';
import type { VersionRow } from '../registry/registry.js';
import { startHttpServer } from '../server/http.js';
import { startStdio } from '../server/stdio.js';
import { c, say, statusColor, table, useStderr } from './output.js';

const ACTOR = `human:cli:${process.env.USER ?? 'user'}`;

const HELP = `${c.bold('toolsmith-mcp')} ${VERSION} — give any AI agent the tools it needs

${c.bold('Get started')}
  toolsmith-mcp demo                      try everything against a bundled demo API
  toolsmith-mcp init                      create toolsmith.config.json and .env here
  toolsmith-mcp import <spec> --name <n>  turn an OpenAPI/Swagger spec (file or URL) into tools
  toolsmith-mcp start                     run the gateway (HTTP + dashboard)
  toolsmith-mcp start --stdio             run as a stdio MCP server (for desktop clients)
  toolsmith-mcp client-config             print config snippets for MCP clients

${c.bold('Review and approve')}
  list | show <name> | evaluate <name> [--input JSON] [--no-live]
  approve <name>[@v] [--allow-writes] [--allow-destructive]
  reject | publish | disable | enable | rollback <name>[@v]
  approve-call <id> | reject-call <id>    decide a pending destructive call

${c.bold('Discover')}
  patterns                                repeated workflows found in traces
  discover                                propose composite tools from those patterns
  ask "<what you need>"                   check whether the connected APIs can do it
  traces [--tool <name>] [--limit N]      recent tool calls

${c.bold('Other')}
  doctor                                  check configuration, credentials and connectivity
  --config <path>                         use a config file other than ./${CONFIG_FILE}
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      name: { type: 'string' },
      'base-url': { type: 'string' },
      'token-env': { type: 'string' },
      'api-key-env': { type: 'string' },
      'api-key-header': { type: 'string' },
      'allow-private-network': { type: 'boolean' },
      'allow-writes': { type: 'boolean' },
      'allow-destructive': { type: 'boolean' },
      'no-publish': { type: 'boolean' },
      'no-live': { type: 'boolean' },
      input: { type: 'string' },
      stdio: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      tool: { type: 'string' },
      limit: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) return say(VERSION), 0;
  if (!cmd || values.help || cmd === 'help') return say(HELP), 0;

  switch (cmd) {
    case 'init':
      return init(values.yes === true);
    case 'demo':
      return demo(values.port ? Number(values.port) : undefined);
    case 'import':
      return importCmd(rest[0], values);
  }

  const KNOWN = ['start', 'client-config', 'list', 'show', 'evaluate', 'approve', 'reject', 'publish', 'disable', 'enable', 'rollback', 'approve-call', 'reject-call', 'patterns', 'discover', 'ask', 'traces', 'doctor'];
  if (!KNOWN.includes(cmd)) {
    say(`${c.red('Unknown command')} "${cmd}". Run ${c.cyan('toolsmith-mcp --help')} for the list.`);
    return 2;
  }
  if (values.stdio) useStderr();
  const loaded = loadConfig(values.config);
  const app = new Toolsmith(loaded);
  try {
    switch (cmd) {
      case 'start':
        return await start(app, values);
      case 'client-config':
        return clientConfig(loaded);
      case 'list':
        return list(app);
      case 'show':
        return show(app, need(rest[0], 'show <name>'), values.json === true);
      case 'evaluate': {
        const inputs = values.input ? [parseJson(values.input) as JsonObject] : [];
        const v = await app.evaluateLatest(need(rest[0], 'evaluate <name>'), inputs, ACTOR, !values['no-live']);
        return printEvaluation(app, v), v.status === 'failed' ? 1 : 0;
      }
      case 'approve': {
        const v = app.approve(need(rest[0], 'approve <name>'), { allowWrite: values['allow-writes'] === true, allowDestructive: values['allow-destructive'] === true }, ACTOR, !values['no-publish']);
        app.refresh();
        say(`${c.green('✓')} ${rest[0]} v${v.version} is ${statusColor(v.status)}.`);
        const name = app.registry.getArtifact(v.artifactId)!.name;
        const exposed = app.catalog.list().filter((t) => t.artifactId === v.artifactId);
        if (exposed.length) say(`  Agents now see ${exposed.length} tool(s): ${exposed.slice(0, 6).map((t) => t.name).join(', ')}${exposed.length > 6 ? ', …' : ''}`);
        const hidden = hiddenWrites(app, name, v);
        if (hidden) say(c.dim(`  ${hidden}`));
        return 0;
      }
      case 'reject':
        return report(app.reject(need(rest[0], 'reject <name>'), ACTOR, values.reason));
      case 'publish':
        return report(app.publish(need(rest[0], 'publish <name>'), ACTOR));
      case 'disable':
        return report(app.disable(need(rest[0], 'disable <name>'), ACTOR, values.reason));
      case 'enable':
        return report(app.enable(need(rest[0], 'enable <name>'), ACTOR));
      case 'rollback':
        return report(app.rollback(need(rest[0], 'rollback <name>'), ACTOR));
      case 'approve-call':
      case 'reject-call': {
        const a = app.approvals.decide(need(rest[0], `${cmd} <id>`), cmd === 'approve-call', ACTOR);
        app.audit.write(ACTOR, cmd, a.id);
        say(`${cmd === 'approve-call' ? c.green('✓ approved') : c.red('✗ rejected')} call ${a.id} to ${a.tool} ${c.dim(JSON.stringify(a.args))}`);
        if (cmd === 'approve-call') say(c.dim('  The agent can now retry the same call once.'));
        return 0;
      }
      case 'patterns':
        return patterns(app);
      case 'discover':
        return discover(app);
      case 'ask':
        return ask(app, need(rest.join(' ') || undefined, 'ask "<what you need>"'));
      case 'traces':
        return traces(app, values.tool, values.limit ? Number(values.limit) : 30);
      case 'doctor':
        return await doctor(app);
      default:
        return 2;
    }
  } finally {
    if (cmd !== 'start') await app.close();
  }
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new ToolsmithError(`Missing argument. Usage: toolsmith-mcp ${usage}`, 'validation');
  return v;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolsmithError(`--input is not valid JSON: ${text}`, 'validation', `Example: --input '{"userId": 42}'`);
  }
}

function report(v: VersionRow): number {
  say(`${c.green('✓')} v${v.version} is now ${statusColor(v.status)}.`);
  return 0;
}

function hiddenWrites(app: Toolsmith, name: string, v: VersionRow): string | undefined {
  const def = v.definition as unknown as OpenApiIntegrationDef;
  if (def.kind !== 'openapi') return undefined;
  const w = def.operations.filter((o) => o.access === 'write').length;
  const d = def.operations.filter((o) => o.access === 'destructive').length;
  const parts: string[] = [];
  if (w && !v.permissions.allowWrite) parts.push(`${w} write tool(s) hidden (re-approve with --allow-writes)`);
  if (d && !v.permissions.allowDestructive) parts.push(`${d} destructive tool(s) hidden (--allow-destructive; each call still needs approval)`);
  void app;
  void name;
  return parts.length ? parts.join('; ') : undefined;
}

// ---- init / import -----------------------------------------------------------

function init(yes: boolean): number {
  const dir = process.cwd();
  const cfgPath = join(dir, CONFIG_FILE);
  if (existsSync(cfgPath) && !yes) {
    say(`${CONFIG_FILE} already exists here. Nothing changed. ${c.dim('(use --yes to overwrite)')}`);
    return 0;
  }
  writeFileSync(
    cfgPath,
    `${JSON.stringify(
      {
        $comment: 'See https://github.com/devlomingo/toolsmith-mcp/blob/main/docs/CONFIGURATION.md',
        server: { host: '127.0.0.1', port: 7420, mcpToken: '${env:TOOLSMITH_MCP_TOKEN}', adminToken: '${env:TOOLSMITH_ADMIN_TOKEN}' },
        dataDir: '.toolsmith',
        integrations: [],
        upstreams: [],
      },
      null,
      2,
    )}\n`,
  );
  const envPath = join(dir, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const add: string[] = [];
  if (!/^TOOLSMITH_MCP_TOKEN=/m.test(env)) add.push(`TOOLSMITH_MCP_TOKEN=${randomBytes(24).toString('base64url')}`);
  if (!/^TOOLSMITH_ADMIN_TOKEN=/m.test(env)) add.push(`TOOLSMITH_ADMIN_TOKEN=${randomBytes(24).toString('base64url')}`);
  if (add.length) appendFileSync(envPath, `${env && !env.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, { mode: 0o600 });
  const gi = join(dir, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const giAdd = ['.env', '.toolsmith/'].filter((l) => !giText.split(/\r?\n/).includes(l));
  if (giAdd.length) appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}${giAdd.join('\n')}\n`);
  say(
    `${c.green('✓')} Created ${CONFIG_FILE} and .env (with fresh tokens; .env is git-ignored).`,
    '',
    'Next:',
    `  1. Import an API:   ${c.cyan('toolsmith-mcp import ./openapi.yaml --name myapi --token-env MYAPI_TOKEN')}`,
    `  2. Approve it:      ${c.cyan('toolsmith-mcp approve myapi')}`,
    `  3. Start:           ${c.cyan('toolsmith-mcp start')}`,
  );
  return 0;
}

async function importCmd(spec: string | undefined, values: Record<string, string | boolean | undefined>): Promise<number> {
  const source = need(spec, 'import <spec-file-or-url> --name <name>');
  const name = (values.name as string | undefined) ?? deriveName(source);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
    throw new ToolsmithError(`"${name}" is not a valid name`, 'validation', 'Use --name with lowercase letters, digits and dashes, e.g. --name shop');
  }
  const cfgPath = values.config ? resolve(String(values.config)) : (findConfig() ?? join(process.cwd(), CONFIG_FILE));
  if (!existsSync(cfgPath)) {
    say(c.dim(`No ${CONFIG_FILE} here yet; creating one.`));
    init(false);
  }
  loadDotEnv(resolve(cfgPath, '..'));
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: Array<Record<string, unknown>> };
  raw.integrations ??= [];
  const existing = raw.integrations.find((i) => i.name === name);
  const entry: Record<string, unknown> = existing ?? { name };
  entry.spec = /^https?:\/\//.test(source) ? source : relativeTo(cfgPath, source);
  if (values['base-url']) entry.baseUrl = values['base-url'];
  if (values['token-env']) entry.auth = { type: 'bearer', token: `\${env:${String(values['token-env'])}}` };
  if (values['api-key-env']) {
    entry.auth = { type: 'apiKey', in: 'header', name: (values['api-key-header'] as string | undefined) ?? 'X-API-Key', value: `\${env:${String(values['api-key-env'])}}` };
  }
  if (values['allow-private-network']) entry.allowPrivateNetwork = true;
  if (!existing) raw.integrations.push(entry);
  writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`);

  const app = new Toolsmith(loadConfig(cfgPath));
  try {
    say(`Importing ${c.bold(source)} as ${c.bold(name)}…`);
    const v = await app.importIntegration(name, ACTOR, { live: !values['no-live'] });
    const def = v.definition as unknown as OpenApiIntegrationDef;
    const counts = { read: 0, write: 0, destructive: 0 };
    for (const op of def.operations) counts[op.access]++;
    say(`${c.green('✓')} ${def.title}: ${def.operations.length} operations (${counts.read} read, ${counts.write} write, ${counts.destructive} destructive) → v${v.version} ${statusColor(v.status)}`);
    printEvaluation(app, v);
    if (v.status === 'awaiting_approval') {
      say('', `Review, then approve: ${c.cyan(`toolsmith-mcp approve ${name}`)}${counts.write + counts.destructive ? c.dim('   (read-only by default; add --allow-writes to expose write tools)') : ''}`);
    }
    return v.status === 'failed' ? 1 : 0;
  } finally {
    await app.close();
  }
}

function deriveName(source: string): string {
  const base = /^https?:\/\//.test(source) ? new URL(source).hostname.split('.').slice(-2, -1)[0] ?? 'api' : basename(source).replace(/\.(ya?ml|json|txt|endpoints)$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 31) || 'api';
}

function relativeTo(cfgPath: string, p: string): string {
  const abs = resolve(p);
  const dir = resolve(cfgPath, '..');
  return abs.startsWith(`${dir}/`) ? `./${abs.slice(dir.length + 1)}` : abs;
}

// ---- start / client config ----------------------------------------------------

async function start(app: Toolsmith, values: Record<string, string | boolean | undefined>): Promise<number> {
  await app.start();
  if (values.stdio) {
    const s = startStdio(app);
    const stop = async () => {
      await s.close();
      await app.close();
      process.exit(0);
    };
    process.stdin.on('end', () => void stop());
    process.on('SIGTERM', () => void stop());
    process.stderr.write(`[toolsmith] stdio server ready (${app.catalog.list().length} tools)\n`);
    return new Promise(() => undefined);
  }
  const http = await startHttpServer(app, {
    host: values.host as string | undefined,
    port: values.port ? Number(values.port) : undefined,
  });
  const admin = process.env.TOOLSMITH_ADMIN_TOKEN;
  say(
    `${c.green('✓')} toolsmith-mcp ${VERSION} running`,
    `  MCP endpoint:  ${c.cyan(`${http.url}/mcp`)}  ${c.dim('(Streamable HTTP, protocol 2025-11-25 and 2026-07-28)')}`,
    `  Dashboard:     ${c.cyan(`${http.url}/dashboard/${admin ? `#token=${admin}` : ''}`)}`,
    `  Tools:         ${app.catalog.list().length} exposed`,
  );
  for (const u of app.upstreams.status()) say(`  Upstream ${u.name}: ${u.connected ? c.green(`connected, ${u.toolCount} tools`) : c.red(`not connected (${u.error})`)}`);
  for (const p of app.catalog.problems) say(c.yellow(`  ! ${p.artifact}: ${p.problem}`));
  say(c.dim('  Ctrl+C to stop.'));
  const stop = async () => {
    await http.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  return new Promise(() => undefined);
}

function clientConfig(loaded: LoadedConfig): number {
  const { host, port } = loaded.config.server;
  const cfgPath = loaded.path ?? join(process.cwd(), CONFIG_FILE);
  say(
    c.bold('Stdio (Claude Desktop, Cursor, VS Code, any client that launches servers):'),
    JSON.stringify({ mcpServers: { toolsmith: { command: 'npx', args: ['-y', 'toolsmith-mcp', 'start', '--stdio', '--config', cfgPath] } } }, null, 2),
    '',
    c.bold('HTTP (run `toolsmith-mcp start` first):'),
    JSON.stringify({ mcpServers: { toolsmith: { type: 'http', url: `http://${host}:${port}/mcp`, headers: { Authorization: 'Bearer <TOOLSMITH_MCP_TOKEN from .env>' } } } }, null, 2),
  );
  return 0;
}

// ---- inspection -------------------------------------------------------------------

function list(app: Toolsmith): number {
  const rows = app.registry.listArtifacts().map((a) => {
    const latest = app.registry.latestVersion(a.id);
    const tools = app.catalog.list().filter((t) => t.artifactId === a.id || t.artifactId === `upstream:${a.name}`).length;
    return { name: a.name, kind: a.kind, latest: latest ? `v${latest.version}` : '-', status: latest ? statusColor(latest.status) : '-', published: a.publishedVersion ? `v${a.publishedVersion}` : '-', tools };
  });
  say(c.bold('Integrations and tools'));
  table(rows);
  const pending = app.approvals.list('pending');
  if (pending.length) {
    say('', c.bold('Destructive calls waiting for approval'));
    table(pending.map((p) => ({ id: p.id, tool: p.tool, args: JSON.stringify(p.args).slice(0, 60), since: p.createdAt })));
  }
  for (const p of app.catalog.problems) say(c.yellow(`! ${p.artifact}: ${p.problem}`));
  return 0;
}

function show(app: Toolsmith, ref: string, asJson: boolean): number {
  const { artifact, version } = app.registry.resolve(ref);
  const v = version ? app.registry.getVersion(artifact.id, version) : app.registry.latestVersion(artifact.id);
  if (!v) throw new ToolsmithError('No such version', 'not_found');
  if (asJson) return say(JSON.stringify(v, null, 2)), 0;
  say(`${c.bold(artifact.name)} (${artifact.kind}) v${v.version} ${statusColor(v.status)}  ${c.dim(`origin: ${v.origin}`)}`);
  const def = v.definition as Record<string, unknown>;
  if (def.kind === 'openapi') {
    const d = def as unknown as OpenApiIntegrationDef;
    say(`  ${d.title} → ${d.baseUrl}`);
    table(d.operations.map((o) => ({ tool: `${artifact.name}__${o.name}`, method: o.method, path: o.path, access: o.access === 'read' ? o.access : c.yellow(o.access) })));
    if (d.findings.length) {
      say('', c.bold('Findings'));
      for (const f of d.findings) say(`  ${f.severity === 'error' ? c.red('error') : f.severity === 'warning' ? c.yellow('warn ') : c.dim('info ')} ${f.message}`);
    }
  } else if (def.kind === 'composite') {
    say(`  tool: ${def.toolName as string}`, `  ${def.description as string}`, '', c.bold('Plan'));
    say(JSON.stringify(def.steps, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
    say(c.bold('Input schema'), JSON.stringify(def.inputSchema, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  say('', `Permissions: ${v.permissions.allowWrite ? 'write ' : ''}${v.permissions.allowDestructive ? 'destructive ' : ''}${!v.permissions.allowWrite && !v.permissions.allowDestructive ? 'read-only' : ''}`);
  printEvaluation(app, v);
  const history = app.registry.events(artifact.id, 10);
  say('', c.bold('History'));
  for (const e of history) say(`  ${c.dim(e.at)} v${e.version} ${e.fromStatus ?? '∅'} → ${statusColor(e.toStatus)} ${c.dim(`by ${e.actor}${e.reason ? ` — ${e.reason}` : ''}`)}`);
  return 0;
}

function printEvaluation(_app: Toolsmith, v: VersionRow): void {
  if (!v.evaluation) return;
  say('', c.bold(`Evaluation: ${v.evaluation.passed ? c.green('passed') : c.red('failed')}`));
  for (const ch of v.evaluation.checks) {
    const mark = ch.passed ? (ch.severity === 'warning' ? c.yellow('!') : c.green('✓')) : ch.severity === 'error' ? c.red('✗') : c.yellow('!');
    say(`  ${mark} ${ch.name}${ch.detail ? c.dim(` — ${ch.detail}`) : ''}`);
  }
}

function patterns(app: Toolsmith): number {
  const ps = app.mine();
  if (ps.length === 0) {
    say('No repeated workflows yet. They appear after agents run the same sequence of calls in several sessions.');
    return 0;
  }
  table(ps.map((p) => ({ id: p.id, workflow: p.signature.replace(/\w+__/g, ''), sessions: p.support, confidence: p.confidence, 'calls/run': p.stats.medianMcpCalls, 'agent span ms': Math.round(p.stats.medianSpanMs) })));
  say('', `Turn them into proposed tools: ${c.cyan('toolsmith-mcp discover')}`);
  return 0;
}

async function discover(app: Toolsmith): Promise<number> {
  const out = await app.proposeComposites(ACTOR);
  if (out.length === 0) return say('No repeated workflows found yet.'), 0;
  for (const o of out) {
    if (o.error) {
      say(`${c.yellow('!')} ${o.pattern.signature}: ${o.error}`);
      continue;
    }
    say(`${o.version!.status === 'awaiting_approval' ? c.green('✓') : c.yellow('!')} ${c.bold(o.def!.toolName)}  ${statusColor(o.version!.status)}  ${c.dim(o.def!.name)}`);
    say(c.dim(`    ${o.def!.description}`));
    const failed = o.version!.evaluation?.checks.filter((ch) => !ch.passed) ?? [];
    for (const f of failed) say(c.yellow(`    ${f.name}: ${f.detail}`));
  }
  say('', `Inspect with ${c.cyan('toolsmith-mcp show <name>')}, approve with ${c.cyan('toolsmith-mcp approve <name>')}.`);
  return 0;
}

function ask(app: Toolsmith, request: string): number {
  const a: CapabilityAnalysis = app.discovery.analyze(request, 'cli');
  const color = a.verdict === 'available' ? c.green : a.verdict === 'unsupported' ? c.red : c.yellow;
  say(`${color(a.verdict)}: ${a.explanation}`);
  if (a.chain?.length) {
    say('', c.bold('Chain'));
    for (const s of a.chain) say(`  ${s.published ? c.green('●') : c.yellow('○')} ${s.tool}${s.feeds ? c.dim(`   ${s.feeds}`) : ''}`);
  }
  if (a.matches.length) {
    say('', c.bold('Closest operations'));
    table(a.matches.slice(0, 5).map((m) => ({ tool: m.tool, score: m.score, status: m.status, access: m.access })));
  }
  return 0;
}

function traces(app: Toolsmith, tool: string | undefined, limit: number): number {
  const rows = app.traces.query({ tool, limit, topLevelOnly: true });
  table(rows.map((t) => ({ when: new Date(t.startedAt).toISOString().slice(11, 23), session: t.sessionId.slice(0, 18), tool: t.tool, ms: Math.round(t.durationMs), ok: t.ok ? c.green('ok') : c.red(t.errorCode ?? 'error'), api: t.upstreamRequests })));
  return 0;
}

async function doctor(app: Toolsmith): Promise<number> {
  let problems = 0;
  const ok = (m: string) => say(`${c.green('✓')} ${m}`);
  const bad = (m: string, hint?: string) => {
    problems++;
    say(`${c.red('✗')} ${m}${hint ? `\n    ${c.dim(hint)}` : ''}`);
  };
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (major > 22 || (major === 22 && minor >= 13)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} is too old`, 'toolsmith-mcp needs Node 22.13 or newer.');
  ok(`config: ${app.loaded.path ?? '(defaults, no config file)'}`);
  for (const key of ['mcpToken', 'adminToken'] as const) {
    const v = app.config.server[key];
    if (!v) bad(`server.${key} is not set`, 'Run `toolsmith-mcp init` to generate tokens.');
    else {
      try {
        (await import('../security/secrets.js')).resolveEnvRefs(v);
        ok(`server.${key} resolves`);
      } catch (e) {
        bad(`server.${key}: ${(e as Error).message}`, (e as ToolsmithError).hint);
      }
    }
  }
  for (const i of app.config.integrations) {
    const r = app.registry.getArtifactByName(i.name);
    if (!r) bad(`integration ${i.name} is configured but never imported`, `Run: toolsmith-mcp import ${i.spec} --name ${i.name}`);
    else ok(`integration ${i.name}: ${r.publishedVersion ? `published v${r.publishedVersion}` : c.yellow('not published')}`);
  }
  if (app.config.upstreams.length) {
    await app.upstreams.connectAll(app.config.upstreams);
    for (const u of app.upstreams.status()) (u.connected ? ok : bad)(`upstream ${u.name}: ${u.connected ? `${u.toolCount} tools` : u.error}`);
  }
  for (const p of app.catalog.problems) bad(`${p.artifact}: ${p.problem}`);
  say(problems ? c.red(`\n${problems} problem(s) found.`) : c.green('\nAll good.'));
  return problems ? 1 : 0;
}

// ---- demo -------------------------------------------------------------------------

async function demo(port?: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'toolsmith-demo-'));
  const shop = new ShopApi({ token: 'demo-token', latencyMs: 20 });
  await shop.start();
  process.env.DEMO_SHOP_TOKEN = 'demo-token';
  process.env.TOOLSMITH_MCP_TOKEN = 'demo-mcp-token';
  process.env.TOOLSMITH_ADMIN_TOKEN = 'demo-admin-token';
  const cfgPath = join(dir, CONFIG_FILE);
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        server: { host: '127.0.0.1', port: port ?? 7420, mcpToken: '${env:TOOLSMITH_MCP_TOKEN}', adminToken: '${env:TOOLSMITH_ADMIN_TOKEN}' },
        integrations: [{ name: 'shop', spec: `${shop.baseUrl}/openapi.json`, auth: { type: 'bearer', token: '${env:DEMO_SHOP_TOKEN}' }, allowPrivateNetwork: true, rateLimit: { requestsPerSecond: 200, burst: 400 } }],
        patterns: { minSupport: 3 },
      },
      null,
      2,
    ),
  );
  const app = new Toolsmith(loadConfig(cfgPath));
  say(c.bold('toolsmith-mcp demo'), c.dim(`  working directory: ${dir}`), '');
  say(`1. A demo shop API is running at ${shop.baseUrl}`);
  const v = await app.importIntegration('shop', 'human:demo');
  const def = v.definition as unknown as OpenApiIntegrationDef;
  say(`2. Imported its OpenAPI spec: ${def.operations.length} operations → evaluation ${v.evaluation?.passed ? c.green('passed') : c.red('failed')}`);
  app.approve('shop', { allowWrite: false, allowDestructive: false }, 'human:demo');
  say(`3. Approved read-only: ${app.catalog.list().filter((t) => t.source === 'openapi').map((t) => t.name).join(', ')}`);
  say('4. Simulating an agent that fetches a customer, their orders, and each order’s items and payments…');
  for (const userId of [3, 7, 11, 19]) {
    const ctx = { sessionId: `demo-agent-${userId}` };
    await app.call('shop__getUser', { userId }, ctx);
    const orders = await app.call('shop__getOrders', { userId }, ctx);
    for (const o of (orders.data as Array<{ id: number }>) ?? []) {
      await app.call('shop__getOrderItems', { orderId: o.id }, ctx);
      await app.call('shop__getPayments', { orderId: o.id }, ctx);
    }
  }
  const out = await app.proposeComposites('discovery');
  for (const o of out.filter((x) => x.def)) {
    const m = o.version?.evaluation?.metrics ?? {};
    say(`5. Discovered workflow (${o.pattern.support} sessions) → proposed ${c.bold(o.def!.toolName)}: ${statusColor(o.version!.status)}`);
    say(c.dim(`   evaluator: identical results; ${m.baselineMcpCalls} MCP calls → 1; ${m.baselineMedianMs} ms sequential vs ${m.compositeMedianMs} ms composite (server-side)`));
    app.approve(o.def!.name, { allowWrite: false, allowDestructive: false }, 'human:demo');
    say(`6. Approved and published ${o.def!.toolName}.`);
  }
  const a = app.discovery.analyze("Find a customer's latest order and show its payment status", 'demo');
  say(`7. Capability check "Find a customer's latest order and show its payment status": ${c.yellow(a.verdict)}`, c.dim(`   ${a.explanation}`));
  await app.start();
  const http = await startHttpServer(app);
  say(
    '',
    `${c.green('✓')} Gateway running. Connect any MCP client:`,
    `  URL:    ${c.cyan(`${http.url}/mcp`)}`,
    `  Header: Authorization: Bearer demo-mcp-token`,
    `  Dashboard: ${c.cyan(`${http.url}/dashboard/#token=demo-admin-token`)}`,
    c.dim('  Ctrl+C to stop. The demo data is discarded on exit.'),
  );
  const stop = async () => {
    await http.close();
    await app.close();
    await shop.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  return new Promise(() => undefined);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ToolsmithError) {
      process.stderr.write(`${c.red('Error:')} ${err.message}\n${err.hint ? `${c.dim(`→ ${err.hint}`)}\n` : ''}`);
      process.exit(1);
    }
    if ((err as { code?: string })?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      process.stderr.write(`${c.red('Error:')} ${(err as Error).message}\nRun toolsmith-mcp --help for usage.\n`);
      process.exit(2);
    }
    process.stderr.write(`${c.red('Unexpected error:')} ${(err as Error)?.stack ?? String(err)}\n${c.dim('Please report this at https://github.com/devlomingo/toolsmith-mcp/issues')}\n`);
    process.exit(1);
  },
);
