# Connecting MCP clients

Toolsmith is a standard MCP server. Any client that speaks MCP over stdio
or Streamable HTTP works without client-specific code. The client may use
protocol **2025-11-25** or **2026-07-28**; both are served and negotiated
automatically.

`toolsmith-mcp client-config` prints both snippets below with your real
config path.

## Stdio (desktop clients, IDEs, CLIs)

The client launches the gateway as a child process. Add this to the
client's MCP server list (`mcpServers` or the client's equivalent):

```json
{
  "mcpServers": {
    "toolsmith": {
      "command": "toolsmith-mcp",
      "args": ["start", "--stdio", "--config", "/absolute/path/to/toolsmith.config.json"]
    }
  }
}
```

- Each stdio process is one session for tracing.
- Several stdio processes can share the same config and database (SQLite
  WAL). A tool approved in the dashboard or CLI appears in running
  sessions within about 2 seconds, through `notifications/tools/list_changed`.

## Streamable HTTP

Run `toolsmith-mcp start` and point the client at the endpoint:

```json
{
  "mcpServers": {
    "toolsmith": {
      "type": "http",
      "url": "http://127.0.0.1:7420/mcp",
      "headers": { "Authorization": "Bearer <TOOLSMITH_MCP_TOKEN from .env>" }
    }
  }
}
```

### Session grouping

The 2026-07-28 protocol has no sessions. To keep one agent's calls
together for workflow discovery, send a stable header:

```text
X-Toolsmith-Session: <anything stable per agent run>
```

Without the header, calls are grouped by the OAuth client id or the
client's reported name. When several agents end up behind one key, the
miner separates them by data flow; the benchmark measures how well. Legacy
`Mcp-Session-Id` headers are also accepted.

## What the agent sees

| Tool | Where it comes from |
|---|---|
| `<integration>__<operation>` | Approved operations of an imported API |
| `<upstream>__<tool>` | Tools of a configured upstream MCP server, unchanged |
| `flow__<name>` | Approved composite tools |
| `toolsmith__request_capability` | Ask whether something not covered is possible (`metaTools`) |

Every tool carries:

- **annotations:** `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`;
- an **input schema**;
- an **output schema** where known.

Results come back as `structuredContent` plus a JSON text block.

### Approval round-trip for destructive tools

1. A destructive call returns `isError: true` with a message such as *"needs
   a human to approve this exact call. Approval id: 3f2a9c1e…"*.
2. The agent should ask its user to approve it, either with
   `toolsmith-mcp approve-call 3f2a9c1e` or in the dashboard under
   **Approvals**.
3. The agent then retries the same call with the same arguments.

An approval works once, for those exact arguments.

### Asking for a missing capability

```json
{ "name": "toolsmith__request_capability", "arguments": { "request": "Find a customer's latest order and show its payment status" } }
```

The answer is one of four verdicts:

| Verdict | Meaning |
|---|---|
| `available` | An existing tool already does it |
| `composable` | A chain of published tools can do it. A composite is proposed and the agent is told the chain to use meanwhile |
| `needs_approval` | The operations exist but are not published or not granted |
| `unsupported` | No imported API documents it. Toolsmith does not invent endpoints |

Analysis is keyword- and synonym-based, with no LLM, so unusual vocabulary
can miss.

## Aggregating other MCP servers

Add them under `upstreams` in the config (see
[CONFIGURATION.md](CONFIGURATION.md#upstreams)). Their tools are re-exposed
with a prefix, traced like any other tool, and usable as composite steps.
Upstream servers of either protocol era work.
