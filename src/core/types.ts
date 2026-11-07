/**
 * Core types shared by every component. Kept free of runtime imports so any
 * module can depend on it without cycles.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchema = Record<string, unknown>;

/** How dangerous a tool is. Drives approval and exposure policy. */
export type AccessLevel = 'read' | 'write' | 'destructive';

export type ToolSource = 'openapi' | 'upstream' | 'composite' | 'builtin';

/** A tool as the gateway exposes it over MCP. */
export interface ToolDefinition {
  /** Gateway-wide unique name, matches ^[A-Za-z0-9_-]{1,64}$. */
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  access: AccessLevel;
  source: ToolSource;
  /** Registry artifact this tool came from (integration, composite, upstream). */
  artifactId: string;
  artifactVersion: number;
}

export interface ToolCallResult {
  ok: boolean;
  /** Structured result returned to the agent. */
  data?: JsonValue;
  /** Human-readable error safe to show the agent (no secrets). */
  error?: string;
  /** Machine-readable error category. */
  errorCode?: ErrorCode;
  /** Number of underlying upstream requests (HTTP or MCP) this call made. */
  upstreamRequests: number;
  retries: number;
  /** Original MCP content blocks from an upstream server, passed through unchanged. */
  content?: unknown[];
  /** Pending approval id when errorCode is approval_required. */
  approvalId?: string;
}

export type ErrorCode =
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'network'
  | 'policy'
  | 'approval_required'
  | 'partial'
  | 'internal';

export interface CallContext {
  /** Logical agent session (MCP session id, or a per-connection id for stdio). */
  sessionId: string;
  /** Set when the call is a step inside a composite tool. */
  parentCallId?: string;
  signal?: AbortSignal;
  /** An approval granted for this exact call (destructive operations). */
  approvalId?: string;
}

/** Something that can execute a tool. Each tool source implements one. */
export interface ToolExecutor {
  execute(tool: ToolDefinition, args: JsonObject, ctx: CallContext): Promise<ToolCallResult>;
}

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Separator between integration and operation in tool names. */
export const NAMESPACE_SEP = '__';
