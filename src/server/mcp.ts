import { Server, type McpRequestContext } from '@modelcontextprotocol/server';
import type { Toolsmith } from '../app.js';
import { VERSION } from '../app.js';
import type { JsonObject, JsonValue, ToolCallResult, ToolDefinition } from '../core/types.js';

const MAX_TEXT = 200_000;

const INSTRUCTIONS =
  'Toolsmith is a gateway: its tools come from imported APIs (prefixed by integration name), connected MCP servers, and approved composite workflows (prefixed "flow__"). If no tool fits the task, call toolsmith__request_capability instead of guessing. Destructive tools need a human to approve each call; if a call returns an approval id, ask the user to approve it and then retry the same call.';

export function toMcpTool(def: ToolDefinition): Record<string, unknown> {
  return {
    name: def.name,
    ...(def.title ? { title: def.title } : {}),
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    annotations: {
      readOnlyHint: def.access === 'read',
      destructiveHint: def.access === 'destructive',
      idempotentHint: def.access === 'read',
      openWorldHint: def.source !== 'builtin',
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function toMcpResult(
  def: ToolDefinition | undefined,
  r: ToolCallResult,
  wrapped: boolean,
): Record<string, unknown> {
  if (!r.ok) {
    const extra = r.data !== undefined ? `\n${truncate(JSON.stringify(r.data))}` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `${r.error ?? 'Tool failed'}${extra}` }],
      ...(r.approvalId ? { _meta: { 'toolsmith/approvalId': r.approvalId } } : {}),
    };
  }
  const data = r.data ?? null;
  const content =
    r.content && r.content.length > 0
      ? r.content
      : [
          {
            type: 'text',
            text: truncate(typeof data === 'string' ? data : JSON.stringify(data, null, 1)),
          },
        ];
  const out: Record<string, unknown> = { content };
  if (def?.outputSchema)
    out.structuredContent = !wrapped && isPlainObject(data) ? data : { result: data };
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} characters]`
    : text;
}

export interface ServerFactoryOptions {
  /** Fixed session key (stdio: one process = one agent). */
  sessionId?: string;
  /** Called with each server instance (stdio keeps it to push list_changed). */
  onServer?: (server: Server) => void;
}

/**
 * Factory for the MCP server instance. The v2 SDK builds one instance per
 * HTTP request (both protocol eras) or per stdio connection; all of them
 * share the one Toolsmith core, so the tool list is always current.
 */
export function createServerFactory(app: Toolsmith, opts: ServerFactoryOptions = {}) {
  return (rctx?: McpRequestContext): Server => {
    const server = new Server(
      { name: 'toolsmith-mcp', version: VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
    );
    /**
     * principal: who is calling, authenticated by token (HTTP) or by being
     * this process (stdio). Per-call approvals bind to it.
     * session: a finer grouping of calls for workflow discovery, from the
     * session header, the client's name and connection. It is self-reported,
     * so it never widens what a principal may do.
     */
    const identify = (envelopeClient?: string): { principal: string; session: string } => {
      if (opts.sessionId) return { principal: opts.sessionId, session: opts.sessionId };
      const headers = rctx?.requestInfo?.headers;
      const principal = `http:${headers?.get('x-toolsmith-client') ?? 'local'}`;
      const explicit = headers?.get('x-toolsmith-session') ?? headers?.get('mcp-session-id');
      const conn = headers?.get('x-toolsmith-conn') ?? '';
      const sub = explicit ? explicit.slice(0, 80) : `${envelopeClient ?? 'client'}@${conn}`;
      return { principal, session: `${principal}/${sub}` };
    };

    server.setRequestHandler(
      'tools/list',
      async () =>
        ({
          tools: app.catalog.list().map(toMcpTool),
        }) as never,
    );

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const params = (request as { params: { name: string; arguments?: JsonObject } }).params;
      const envelope = ctx.mcpReq.envelope as { clientInfo?: { name?: string } } | undefined;
      const { principal, session } = identify(
        envelope?.clientInfo?.name ?? server.getClientVersion()?.name,
      );
      const entry = app.catalog.get(params.name);
      const result = await app.call(params.name, params.arguments ?? {}, {
        sessionId: session,
        principal,
        signal: ctx.mcpReq.signal,
      });
      const wrapped = entry?.exec.type === 'openapi' ? entry.exec.op.outputWrapped : false;
      return toMcpResult(entry?.def, result, wrapped) as never;
    });

    opts.onServer?.(server);
    return server;
  };
}
