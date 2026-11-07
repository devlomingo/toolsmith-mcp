import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { UpstreamConfig } from '../config/config.js';
import { errorMessage } from '../core/errors.js';
import type { AccessLevel, JsonObject, JsonValue, ToolCallResult } from '../core/types.js';
import { resolveEnvRefs } from '../security/secrets.js';

export interface UpstreamTool {
  upstream: string;
  tool: Tool;
  access: AccessLevel;
}

export interface UpstreamStatus {
  name: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Classify by MCP tool annotations. Per the spec, destructiveHint defaults to
 * true when readOnlyHint is false, so an unannotated tool counts as
 * destructive for composites and traces. Annotations are hints from the
 * server, not guarantees.
 */
export function accessFromAnnotations(tool: Tool): AccessLevel {
  const a = tool.annotations;
  if (a?.readOnlyHint) return 'read';
  if (a?.destructiveHint === false) return 'write';
  return 'destructive';
}

class UpstreamConnection {
  client?: Client;
  tools: Tool[] = [];
  error?: string;

  constructor(
    readonly cfg: UpstreamConfig,
    private readonly onToolsChanged: () => void,
  ) {}

  get transportKind(): 'stdio' | 'http' {
    return 'command' in this.cfg ? 'stdio' : 'http';
  }

  async connect(): Promise<void> {
    // 'auto' probes for the 2026-07-28 protocol and falls back to the 2025
    // initialize handshake, so upstreams of either era work.
    const client = new Client(
      { name: 'toolsmith-mcp-gateway', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            onChanged: (_err: unknown, items: Tool[] | null) => {
              if (items) this.tools = items;
              this.onToolsChanged();
            },
          },
        },
      },
    );
    const transport =
      'command' in this.cfg
        ? new StdioClientTransport({
            command: this.cfg.command,
            args: this.cfg.args,
            cwd: this.cfg.cwd,
            env: {
              ...(process.env as Record<string, string>),
              ...Object.fromEntries(Object.entries(this.cfg.env).map(([k, v]) => [k, resolveEnvRefs(v)])),
            },
            stderr: 'pipe',
          })
        : new StreamableHTTPClientTransport(new URL(this.cfg.url), {
            requestInit: {
              headers: Object.fromEntries(Object.entries(this.cfg.headers).map(([k, v]) => [k, resolveEnvRefs(v)])),
            },
          });
    try {
      await client.connect(transport);
      this.client = client;
      this.error = undefined;
      await this.refresh();
    } catch (err) {
      this.error = errorMessage(err);
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  async refresh(): Promise<void> {
    if (!this.client) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 2000);
    this.tools = tools;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}

/** Connects to configured upstream MCP servers and proxies their tools. */
export class UpstreamManager {
  private readonly conns = new Map<string, UpstreamConnection>();

  constructor(private readonly onToolsChanged: () => void = () => undefined) {}

  async connectAll(configs: UpstreamConfig[]): Promise<UpstreamStatus[]> {
    await Promise.all(
      configs.map(async (cfg) => {
        const conn = new UpstreamConnection(cfg, this.onToolsChanged);
        this.conns.set(cfg.name, conn);
        try {
          await conn.connect();
        } catch (err) {
          process.stderr.write(`[toolsmith] upstream "${cfg.name}" failed to connect: ${errorMessage(err)}\n`);
        }
      }),
    );
    return this.status();
  }

  status(): UpstreamStatus[] {
    return [...this.conns.values()].map((c) => ({
      name: c.cfg.name,
      transport: c.transportKind,
      connected: Boolean(c.client),
      toolCount: c.tools.length,
      error: c.error,
    }));
  }

  tools(): UpstreamTool[] {
    return [...this.conns.values()].flatMap((c) =>
      c.tools.map((tool) => ({ upstream: c.cfg.name, tool, access: accessFromAnnotations(tool) })),
    );
  }

  async call(upstream: string, toolName: string, args: JsonObject, signal?: AbortSignal): Promise<ToolCallResult> {
    const conn = this.conns.get(upstream);
    if (!conn?.client) {
      return {
        ok: false,
        errorCode: 'upstream',
        error: `Upstream MCP server "${upstream}" is not connected${conn?.error ? `: ${conn.error}` : ''}`,
        upstreamRequests: 0,
        retries: 0,
      };
    }
    try {
      const res = await conn.client.callTool({ name: toolName, arguments: args }, { signal });
      const content = (res.content as unknown[]) ?? [];
      const data = (res.structuredContent as JsonValue | undefined) ?? contentToData(content);
      if (res.isError) {
        return { ok: false, errorCode: 'upstream', error: textOf(content) || 'Upstream tool reported an error', content, upstreamRequests: 1, retries: 0 };
      }
      return { ok: true, data, content, upstreamRequests: 1, retries: 0 };
    } catch (err) {
      return { ok: false, errorCode: 'upstream', error: `Upstream call failed: ${errorMessage(err)}`, upstreamRequests: 1, retries: 0 };
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
  }
}

function textOf(content: unknown[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string })?.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Use JSON text content as data when the upstream has no structuredContent. */
function contentToData(content: unknown[]): JsonValue {
  const text = textOf(content);
  if (text) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return null;
}
