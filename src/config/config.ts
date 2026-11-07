import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';

const namespace = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, 'use lowercase letters, digits and dashes (max 31 chars)');

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query']).default('header'),
    name: z.string(),
    value: z.string(),
  }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
]);
export type AuthConfig = z.infer<typeof AuthSchema>;

export const IntegrationSchema = z.object({
  name: namespace,
  /** Path or http(s) URL of an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML). */
  spec: z.string(),
  /** Overrides the spec's servers[0].url. Required when the spec has none. */
  baseUrl: z.string().url().optional(),
  auth: AuthSchema.default({ type: 'none' }),
  /** Extra hosts besides the base URL's host. Rarely needed. */
  allowedHosts: z.array(z.string()).default([]),
  allowPrivateNetwork: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  rateLimit: z
    .object({
      requestsPerSecond: z.number().positive().default(10),
      burst: z.number().int().positive().default(20),
    })
    .default({ requestsPerSecond: 10, burst: 20 }),
  maxRetries: z.number().int().min(0).max(5).default(2),
  /** Only expose operations whose operationId/path matches. Empty = all. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  /** Check responses against the spec's response schema. Turn off for specs known to be inaccurate. */
  validateOutput: z.boolean().default(true),
});
export type IntegrationConfig = z.infer<typeof IntegrationSchema>;

/**
 * Tool exposure for a client. `tools` is an allow-list of glob patterns
 * (empty = every published tool) and is enforced on calls, not just on
 * listing. `list: "search"` keeps the tool list short for large catalogs:
 * only meta tools and `pinned` patterns are listed, and the agent finds the
 * rest with toolsmith__search_tools.
 */
export const ExposureSchema = z.object({
  tools: z.array(z.string()).default([]),
  list: z.enum(['all', 'search']).default('all'),
  pinned: z.array(z.string()).default([]),
});
export type Exposure = z.infer<typeof ExposureSchema>;

export const UpstreamSchema = z.union([
  z.object({
    name: namespace,
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    /**
     * 'destructive' (default): tools that are destructive per their MCP
     * annotations (an unannotated tool counts as destructive, as the spec
     * says) need a per-call human approval. 'none' trusts the server fully.
     */
    approval: z.enum(['destructive', 'none']).default('destructive'),
    /** Tool names exempt from per-call approval. */
    trustedTools: z.array(z.string()).default([]),
  }),
  z.object({
    name: namespace,
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    /**
     * 'destructive' (default): tools that are destructive per their MCP
     * annotations (an unannotated tool counts as destructive, as the spec
     * says) need a per-call human approval. 'none' trusts the server fully.
     */
    approval: z.enum(['destructive', 'none']).default('destructive'),
    /** Tool names exempt from per-call approval. */
    trustedTools: z.array(z.string()).default([]),
  }),
]);
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;

export const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65535).default(7420),
      /** Token MCP clients send as `Authorization: Bearer`. `${env:...}` allowed. */
      mcpToken: z.string().optional(),
      /** Token for the dashboard and admin API. `${env:...}` allowed. */
      adminToken: z.string().optional(),
      /**
       * Separate tokens per agent. The token identifies the client, and
       * per-call approvals are bound to that identity. `mcpToken` is the
       * client named "default".
       */
      clients: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
            token: z.string(),
            /** Overrides the top-level `exposure` for this client. */
            exposure: z.lazy(() => ExposureSchema).optional(),
          }),
        )
        .default([]),
    })
    .default({ host: '127.0.0.1', port: 7420, clients: [] }),
  dataDir: z.string().default('.toolsmith'),
  integrations: z.array(IntegrationSchema).default([]),
  upstreams: z.array(UpstreamSchema).default([]),
  traces: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).default(14),
      /** "redacted" stores arguments after redaction; "none" stores only fingerprints. */
      captureArguments: z.enum(['redacted', 'none']).default('redacted'),
    })
    .default({ retentionDays: 14, captureArguments: 'redacted' }),
  patterns: z
    .object({
      minSupport: z.number().int().min(2).default(3),
      minConfidence: z.number().min(0).max(1).default(0.6),
      maxLength: z.number().int().min(2).max(12).default(6),
      /** Idle gap (ms) that splits a session into separate episodes. */
      episodeGapMs: z.number().int().positive().default(120_000),
    })
    .default({ minSupport: 3, minConfidence: 0.6, maxLength: 6, episodeGapMs: 120_000 }),
  composites: z
    .object({
      maxSteps: z.number().int().min(1).max(50).default(20),
      maxFanOut: z.number().int().min(1).max(500).default(50),
      concurrency: z.number().int().min(1).max(64).default(8),
      timeoutMs: z.number().int().min(100).default(60_000),
    })
    .default({ maxSteps: 20, maxFanOut: 50, concurrency: 8, timeoutMs: 60_000 }),
  /** Expose toolsmith's own meta tools (capability requests) to agents. */
  metaTools: z.boolean().default(true),
  /** Which tools clients see and may call (per client in server.clients). */
  exposure: z.lazy(() => ExposureSchema).default({ tools: [], list: 'all', pinned: [] }),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  /** Directory relative paths in the config resolve against. */
  baseDir: string;
  path?: string;
}

export const CONFIG_FILE = 'toolsmith.config.json';

export function findConfig(start: string = process.cwd()): string | undefined {
  const candidate = resolve(start, CONFIG_FILE);
  return existsSync(candidate) ? candidate : undefined;
}

export function parseConfig(raw: unknown, baseDir: string, path?: string): LoadedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(
      `Invalid configuration${path ? ` in ${path}` : ''}:\n${issues}`,
      'Fix the fields above. `toolsmith-mcp init` writes a working example.',
    );
  }
  const names = new Set<string>();
  for (const n of [
    ...parsed.data.integrations.map((i) => i.name),
    ...parsed.data.upstreams.map((u) => u.name),
  ]) {
    if (names.has(n)) throw new ConfigError(`Duplicate integration/upstream name "${n}"`);
    names.add(n);
  }
  return { config: parsed.data, baseDir, path };
}

export function loadConfig(path?: string): LoadedConfig {
  const file = path ? resolve(path) : findConfig();
  if (!file) return parseConfig({}, process.cwd());
  if (!existsSync(file)) {
    throw new ConfigError(
      `Config file not found: ${file}`,
      'Run `toolsmith-mcp init` to create one.',
    );
  }
  loadDotEnv(dirname(file));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `Could not parse ${file}: ${(err as Error).message}`,
      'The config file must be valid JSON.',
    );
  }
  return parseConfig(raw, dirname(file), file);
}

export function resolvePath(loaded: LoadedConfig, p: string): string {
  if (/^https?:\/\//.test(p) || isAbsolute(p)) return p;
  return resolve(loaded.baseDir, p);
}

/** Minimal .env loader: KEY=VALUE lines, existing env wins. */
export function loadDotEnv(dir: string): void {
  const file = resolve(dir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
