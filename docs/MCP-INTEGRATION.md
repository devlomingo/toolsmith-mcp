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
  WAL, or PostgreSQL with `database.url`, which also lets several HTTP
  gateway nodes share one state). A tool approved in the dashboard or CLI appears in running
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

### OAuth clients

If your organisation runs an authorization server, set `server.oauth`
([configuration](CONFIGURATION.md#serveroauth)). MCP clients that support
the MCP authorization spec then discover it from the gateway's 401
response and sign the user in themselves. No static token is needed in
their config:

```json
{ "mcpServers": { "toolsmith": { "type": "http", "url": "https://tools.example.com/mcp" } } }
```

### Client identity and session grouping

**Who is calling** is decided by the bearer token. `server.mcpToken` is the
client named `default`. Give each agent its own token in `server.clients`
([CONFIGURATION.md](CONFIGURATION.md#server)) and approvals are bound to that
agent: one agent cannot spend an approval granted to another. Over stdio,
each process is its own client.

**Which calls belong together** matters for workflow discovery. The
2026-07-28 protocol has no sessions, so within a client, calls are grouped
in this order of preference:

1. the `X-Toolsmith-Session` header (`Mcp-Session-Id` also works);
2. otherwise, the client's reported name. The miner then splits back-to-back
   runs itself: a run restarts when its first tool is called again with
   arguments no earlier step produced. Data flow separates interleaved
   workflows.

Send the header with something stable per agent run:

```text
X-Toolsmith-Session: <anything stable per agent run>
```

The header is self-reported, so it only groups traces and never changes
what a client is allowed to do. When several agents still end up in one
group, the miner separates them by data flow.

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
2. The agent should ask its user to approve it. The user does that in the
   dashboard under **Approvals**, or in their own terminal with
   `toolsmith-mcp approve-call 3f2a9c1e`. The command asks for a typed
   confirmation and refuses to run without an interactive terminal. That
   stops an agent approving by accident, but it is not a security boundary
   (see [SECURITY.md](SECURITY.md)).
3. The agent then retries the same call with the same arguments and the
   same token.

An approval works once, for those exact arguments and that client. This
applies to destructive tools of connected MCP servers too (see
[CONFIGURATION.md](CONFIGURATION.md#upstreams)).

**Which tools are destructive:**
- **API tools:** DELETE operations.
- **Upstream tools:** ones annotated `destructiveHint`, or with no
  annotations at all.

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

### In-client approval (opt-in)

With `"approvals": { "inClient": true }`, a destructive call from a client
that supports elicitation asks for confirmation in that client. The prompt
reads *"Allow ONE call to shop__deleteProduct? … Complete arguments:"*,
followed by every argument, with invisible characters escaped.
- Calls with arguments too long to show in full go to the dashboard
  instead.
- A prompt expires after 5 minutes.
- An answer only counts once, and only if this gateway asked for it.
- A declined prompt cannot be accepted later.
- On the 2026-07-28 protocol, this uses the `input_required` round trip.
- On 2025-era connections such as stdio, it uses `elicitation/create`.
- Accepting runs that one call. The approval is recorded in the audit log
  as `human:client-elicitation`.
- Declining falls back to the dashboard flow.

It is off by default because you then trust the client app to show the
prompt to a person.

### Large catalogs

When many servers are aggregated, give agents `"list": "search"` in
`exposure`. They then see only the meta tools plus pinned tools, and find
the rest on demand:

```json
{ "name": "toolsmith__search_tools", "arguments": { "query": "payments for an order" } }
```

The result lists matching tools with their descriptions and input schemas,
and the agent calls them directly. Allow-lists still apply: a client can
neither find nor call a tool outside its `exposure.tools`, and
`toolsmith__request_capability` answers only in terms of tools the client
may use.

## Aggregating other MCP servers

Add them under `upstreams` in the config (see
[CONFIGURATION.md](CONFIGURATION.md#upstreams)). Their tools are re-exposed
with a prefix, traced like any other tool, and usable as composite steps.
Upstream servers of either protocol era work. Their destructive tools need
per-call approval unless you opt out per server or per tool.
