import {
  Server,
  acceptedContent,
  inputRequired,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import type { Toolsmith } from '../app.js';
import { INVISIBLE } from '../openapi/schema-utils.js';
import { VERSION } from '../app.js';
import type { JsonObject, JsonValue, ToolCallResult, ToolDefinition } from '../core/types.js';

const MAX_TEXT = 200_000;

// Everything cleanText removes, plus line/paragraph separators, shown as escapes in prompts.
const INVISIBLE_OR_SEPARATOR = new RegExp(`${INVISIBLE.source.slice(0, -1)}\\u2028\\u2029]`, 'gu');

/**
 * JSON with invisible and layout-changing characters shown as \uXXXX
 * escapes. (JSON.stringify already escapes ASCII control characters inside
 * strings; these Unicode ones it leaves alone.)
 */
const visibleJson = (v: unknown): string =>
  JSON.stringify(v, null, 2).replace(
    INVISIBLE_OR_SEPARATOR,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`,
  );

const askKey = (principal: string, tool: string, args: JsonObject): string =>
  `${principal}\n${tool}\n${JSON.stringify(args)}`;

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
      // Without a session header, group by client name; the miner splits
      // back-to-back runs itself (run restarts and data flow).
      const sub = explicit ? explicit.slice(0, 80) : (envelopeClient ?? 'client');
      return { principal, session: `${principal}/${sub}` };
    };

    server.setRequestHandler(
      'tools/list',
      async () =>
        ({
          tools: app
            .listedTools(
              opts.sessionId ??
                `http:${rctx?.requestInfo?.headers?.get('x-toolsmith-client') ?? 'local'}`,
            )
            .map(toMcpTool),
        }) as never,
    );

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const params = (request as { params: { name: string; arguments?: JsonObject } }).params;
      const envelope = ctx.mcpReq.envelope as { clientInfo?: { name?: string } } | undefined;
      const { principal, session } = identify(
        envelope?.clientInfo?.name ?? server.getClientVersion()?.name,
      );
      const entry = app.catalog.get(params.name);
      if (entry?.perCallApproval && app.config.approvals.inClient) {
        const envelope = ctx.mcpReq.envelope as
          { clientCapabilities?: { elicitation?: unknown } } | undefined;
        const canElicit = Boolean(
          envelope?.clientCapabilities?.elicitation ?? server.getClientCapabilities()?.elicitation,
        );
        if (canElicit && app.allowed(principal, params.name)) {
          const answer = acceptedContent(ctx.mcpReq.inputResponses, 'approve') as
            { approve?: unknown } | undefined;
          // Only an answer to a prompt this gateway actually sent counts: a
          // client cannot pre-fill an approval without being asked.
          const key = askKey(principal, params.name, params.arguments ?? {});
          const asked = (app.inClientAsks.get(key) ?? 0) > Date.now();
          const answered = Boolean(
            ctx.mcpReq.inputResponses && 'approve' in ctx.mcpReq.inputResponses,
          );
          // Any answer, accepted or not, uses up the prompt: a declined prompt
          // cannot be accepted later, and an expired one counts for nothing.
          if (answered) app.inClientAsks.delete(key);
          if (answer?.approve === true && asked) {
            // The person confirmed in the client: record it like a dashboard approval.
            const req = app.approvals.request(params.name, params.arguments ?? {}, principal);
            app.approvals.decide(req.id, true, 'human:client-elicitation');
            app.audit.write('human:client-elicitation', 'approve-call', req.id, {
              tool: params.name,
            });
          } else if (!answered && JSON.stringify(params.arguments ?? {}, null, 2).length <= 1500) {
            // Not asked yet. (Declined or cancelled answers fall through to the
            // dashboard flow below.) The prompt shows the complete arguments,
            // never a cut-off prefix: calls too large to show in full go to the
            // dashboard instead, so padding cannot hide the real target.
            // Prompts expire after 5 minutes; the set is bounded.
            app.inClientAsks.set(key, Date.now() + 300_000);
            if (app.inClientAsks.size > 1000)
              app.inClientAsks.delete(app.inClientAsks.keys().next().value!);
            return inputRequired({
              inputRequests: {
                approve: inputRequired.elicit({
                  message: `Allow ONE call to ${params.name}? It is marked destructive. Complete arguments:\n${visibleJson(params.arguments ?? {})}`,
                  requestedSchema: {
                    type: 'object',
                    properties: { approve: { type: 'boolean', title: 'Approve this call' } },
                    required: ['approve'],
                  },
                }),
              },
            }) as never;
          }
        }
      }
      if (!app.allowed(principal, params.name)) {
        return toMcpResult(
          undefined,
          {
            ok: false,
            errorCode: 'forbidden',
            error: `${params.name} is not available to this client.`,
            upstreamRequests: 0,
            retries: 0,
          },
          false,
        ) as never;
      }
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
