# Research notes

Research for `toolsmith-mcp`, gathered 2026-11-07. Every claim carries a
source URL and a tag:

- **Verified**: the source was read directly (page fetched, package
  unpacked, or registry queried) on 2026-11-07.
- **Unverified**: taken from a search snippet or secondary source, or an
  inference of ours. Check before relying on it.

## Design-relevant summary

1. The current MCP spec is **2026-07-28**, and it is a breaking revision:
   no `initialize` handshake, no sessions, no server-initiated requests,
   and no GET stream. A gateway has to be **dual-era**, serving 2026-07-28
   clients and 2025-era clients, and reaching upstreams of both eras.
2. `@modelcontextprotocol/sdk@1.32.2` (v1) tops out at protocol
   `2025-11-25`. The 2026-07-28 revision is only implemented by the v2
   split packages (`@modelcontextprotocol/server` and `client` 2.4.0).
3. Turning traces into composite tools has prior art. AWO "meta-tools"
   (arXiv 2601.22037) describes nearly the same pipeline as our feature 4,
   so we should cite it and not claim novelty.

## MCP specification

### Version and revision model

- The current protocol version is `2026-07-28`. Versions are `YYYY-MM-DD`
  strings marking the last backwards-incompatible change.
  **Verified**, https://modelcontextprotocol.io/specification/versioning
- Every request carries its version in `_meta`
  (`io.modelcontextprotocol/protocolVersion`). On HTTP the version is also
  sent in the `MCP-Protocol-Version` header. An unsupported version gets
  `UnsupportedProtocolVersionError` (code `-32022`), which lists the
  supported versions. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- Servers MUST implement `server/discover`, which returns supported
  versions, capabilities and identity. **Verified**, same URL.
- Major changes since 2025-11-25: sessions and `Mcp-Session-Id` removed;
  `initialize` handshake removed; `server/discover` added; GET stream and
  `resources/subscribe` replaced by `subscriptions/listen`; `ping` and
  `logging/setLevel` removed; tasks moved to the extension
  `io.modelcontextprotocol/tasks`; Multi Round-Trip Requests (MRTR)
  replace server-initiated requests; every result carries `resultType`;
  SSE resumability (`Last-Event-ID`) removed. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Minor changes we must honor: deterministic `tools/list` ordering
  (SHOULD); required `ttlMs` and `cacheScope` on list results; OTel
  `traceparent`, `tracestate` and `baggage` in `_meta`; `inputSchema` and
  `outputSchema` may use any JSON Schema 2020-12 keyword, with `$ref`
  resolution rules. **Verified**, same changelog URL.
- Deprecated, with earliest removal in the first revision on or after
  2027-07-28: Roots, Sampling, Logging, and Dynamic Client Registration
  (replaced by Client ID Metadata Documents). HTTP+SSE is also deprecated.
  **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/deprecated
- Compatibility: a "dual-era" server MAY serve both eras on one endpoint.
  An `initialize` request selects legacy semantics, and per-request
  `_meta` selects modern semantics. A legacy client talking to a
  modern-only server **fails**, because legacy clients have no
  fall-forward. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- How many deployed clients (Claude Desktop, Cursor, VS Code and others)
  speak 2026-07-28 today is unknown. We assume most still speak 2025-era
  protocol. **Unverified**: no client survey was found.

### Transports

- There are two standard bindings. **stdio** carries newline-delimited
  JSON-RPC over the streams of a client-launched subprocess. **Streamable
  HTTP** sends every message as a POST to a single endpoint, and the reply
  is JSON or a request-scoped SSE stream. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- Streamable HTTP MUST rules:
  - Validate `Origin`, and answer 403 when it is invalid.
  - Bind to 127.0.0.1 when running locally (SHOULD).
  - Every POST carries `MCP-Protocol-Version`, `Mcp-Method`, and, for
    `tools/call`, `resources/read` and `prompts/get`, `Mcp-Name`.
  - A header that does not match the body is rejected with 400 and
    `HeaderMismatch` (`-32020`).
  - A notification POST gets 202.
  - Closing the response stream means cancellation.
  - A modern-only server answers GET and DELETE with 405 and ignores
    `Mcp-Session-Id`.

  **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- `x-mcp-header` on an `inputSchema` property mirrors that argument into
  an `Mcp-Param-{Name}` header. It works only on primitive,
  statically reachable properties, and non-ASCII values are
  Base64-encoded. Clients MUST drop tools whose annotation is invalid.
  Sensitive parameters SHOULD NOT use it. **Verified**, same URL.
  - Implication: OpenAPI header parameters could map to `x-mcp-header`,
    but never secrets. **Unverified** (our inference).
- List-change notifications now arrive only on a `subscriptions/listen`
  POST stream that the client opted into (`toolsListChanged: true`), and
  each carries `io.modelcontextprotocol/subscriptionId`. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/changelog

### Authorization

- Authorization is optional. HTTP transports SHOULD follow the spec, and
  stdio SHOULD NOT; stdio takes credentials from the environment instead.
  The MCP server is an OAuth 2.1 resource server. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- Servers MUST implement Protected Resource Metadata (RFC 9728). Clients
  MUST send `resource` (RFC 8707). Clients MUST validate `iss`
  (RFC 9207) when it is present. Client ID Metadata Documents are
  preferred, and DCR is deprecated. **Verified**, same URL.
- Servers MUST validate the token audience. They "MUST NOT accept or
  transit any other tokens", so token passthrough is forbidden.
  Insufficient scope gets 403 with
  `WWW-Authenticate: Bearer error="insufficient_scope"` for step-up.
  **Verified**, same URL.
- `tools/list` MAY vary by the caller's authorization (granted scopes) but
  MUST NOT vary per connection. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Implication for the gateway: upstream API credentials have to be the
  gateway's own credentials, or the user's credentials obtained via URL
  elicitation. The client's MCP token is never forwarded. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation

### Tools: names, annotations, output

- Names SHOULD be 1–128 characters, case-sensitive, and limited to
  `[A-Za-z0-9_.-]` with no spaces or commas, and SHOULD be unique per
  server. Aggregating proxies SHOULD disambiguate, for example with a
  server prefix, and SHOULD NOT rely on `serverInfo.name`, which is not
  unique. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
  - Design consequence: prefix every name, as in `ns.op` (dot allowed),
    and enforce the 128-character cap with hash-suffix truncation.
    OpenAPI `operationId` can contain characters outside the allowed set
    and must be sanitized. **Unverified** (our inference).
- The `Tool` fields are `name`, `title`, `description`, `icons`,
  `inputSchema` (root `type: "object"`), `outputSchema`, `annotations`
  and `_meta`. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/schema
- `ToolAnnotations` fields and defaults: `title`; `readOnlyHint` (default
  false); `destructiveHint` (default true, and meaningful only when not
  read-only); `idempotentHint` (default false); `openWorldHint` (default
  true). All of them are **hints**, and clients MUST treat them as
  untrusted unless the server is trusted. **Verified**, same URL.
  - Mapping: GET/HEAD become `readOnlyHint: true`. PUT and DELETE become
    `idempotentHint: true`. DELETE becomes `destructiveHint: true`. Every
    upstream HTTP call gets `openWorldHint: true`. **Unverified** (our
    inference from HTTP semantics, RFC 9110).
- When `outputSchema` is present, servers MUST return conforming
  `structuredContent`, and clients SHOULD validate it. `structuredContent`
  may be any JSON value. For compatibility, servers SHOULD also return the
  serialized JSON as a text block. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Errors: an unknown tool is a JSON-RPC error (`-32602`). Upstream API
  failures should be `isError: true` results so the model can correct
  itself. **Verified**, same URL.
- Stateful flows use explicit opaque handles passed as arguments. Servers
  MUST NOT treat possession of a handle as authentication. **Verified**,
  same URL and
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

### Elicitation and MRTR

- Elicitation is delivered through MRTR. The server returns
  `resultType: "input_required"` with `inputRequests`, and the client
  retries with `inputResponses` and the opaque `requestState` under a new
  JSON-RPC id. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Form mode is flat primitives only (string, number, boolean, enum). It
  MUST NOT ask for passwords, API keys or tokens; those require URL mode.
  The actions are `accept`, `decline` and `cancel`.
  `notifications/elicitation/complete` was removed. **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Fit for toolsmith: a destructive tool can return a form-mode
  confirmation as a runtime human-in-the-loop gate. That is separate from
  the publish-approval lifecycle, which belongs to an admin and not the
  agent's user. **Unverified** (design inference).

## TypeScript SDK

- `@modelcontextprotocol/sdk` latest is `1.32.2`, modified
  2026-10-23. Its constants are `LATEST_PROTOCOL_VERSION = '2025-11-25'`
  and `SUPPORTED_PROTOCOL_VERSIONS` from 2025-11-25 back to 2024-10-07,
  with no 2026-07-28. **Verified**: `npm view` plus an unpacked tarball,
  `dist/esm/types.js`; https://www.npmjs.com/package/@modelcontextprotocol/sdk
- v1 server transports: `StdioServerTransport`,
  `StreamableHTTPServerTransport` (Node) and
  `WebStandardStreamableHTTPServerTransport`. v1 client transports:
  `StdioClientTransport`, `StreamableHTTPClientTransport`,
  `SSEClientTransport` and `WebSocketClientTransport`. On a
  `RegisteredTool`, `enable()`, `disable()` and `update()` exist, and
  `sendToolListChanged()` is on `McpServer`. **Verified**: tarball
  `dist/esm/server/*.d.ts`.
- v2 split packages: `@modelcontextprotocol/server` 2.4.0,
  `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/core`
  2.4.0, `@modelcontextprotocol/node` 2.1.2 (Hono-based) and
  `@modelcontextprotocol/express` 2.0.2. They need Node ≥20 and zod ^4.2.
  The server README says v2 is "the stable release line, implementing the
  2026-07-28 MCP spec". **Verified**: `npm view` and the tarball README,
  https://www.npmjs.com/package/@modelcontextprotocol/server
- v2 serving API: `createMcpHandler(factory, opts)` takes a per-request
  `McpServer` factory and returns `{ fetch, close, notify, bus }`.
  `serveStdio(factory)` comes from `@modelcontextprotocol/server/stdio`.
  `toNodeHandler()` and `NodeStreamableHTTPServerTransport` come from
  `@modelcontextprotocol/node`. `WebStandardStreamableHTTPServerTransport`
  remains. Legacy clients are served with `isLegacyRequest` and
  `legacyStatelessFallback`. Host and Origin guards are
  `localhostHostValidation` and `localhostOriginValidation`.
  **Verified**: tarball exports;
  https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- The handler from `createMcpHandler` does **not** validate Host or
  Origin on its own; mount the guards. **Verified**, same URL.
- `fromJsonSchema(schema)` turns raw JSON Schema into a Standard Schema
  for `registerTool`. That is what runtime OpenAPI tools need, and v1's
  `McpServer` has no equivalent; there you would drop to the low-level
  `Server`. **Verified**: v2 `index.d.mts`; the v1 tarball has no
  `fromJsonSchema`.
- The v2 `Client` takes `versionNegotiation: 'legacy' | 'auto' | {pin}`.
  `'auto'` probes `server/discover` and falls back to `initialize`. That
  suits a gateway connecting to upstreams of unknown era. **Verified**:
  `client-*.d.mts` doc comment.
- Migration renames: `.tool()` became `registerTool`, `McpError` became
  `ProtocolError`, and `extra` became `ctx`. `SSEServerTransport` was
  removed. A codemod is available:
  `npx @modelcontextprotocol/codemod@latest v1-to-v2`. Using
  `server.connect()` with the old transports serves only 2025-era
  clients. **Verified**,
  https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
- **Recommendation:** build on v2 (`@modelcontextprotocol/server` and
  `client`), not `@modelcontextprotocol/sdk` 1.32.2. **Unverified**: this
  is a judgment, but it follows from the facts above.

## Academic and industry work

### Parallel planning and tool-use optimization

- **LLMCompiler** (2023): a planner emits a DAG of function calls, and a
  task-fetching unit and executor run them in parallel. It reports up to
  3.7× lower latency, 6.7× lower cost and about 9% higher accuracy than
  ReAct. **Verified**, https://arxiv.org/abs/2312.04511
  This is the model for our parallel composite-step executor.
- **ReWOO** (2023) plans the full tool chain up front, separate from
  observations, to cut tokens. **Verified**,
  https://arxiv.org/abs/2305.18323
- **ToolLLM / ToolBench** (2023): 16,464 RapidAPI REST APIs, DFS-based
  decision-tree search, and a neural API retriever. **Verified**,
  https://arxiv.org/abs/2307.16789
- **Gorilla** (2023): an LLM tuned for accurate API calls, with retrieval
  over docs. **Verified**, https://arxiv.org/abs/2305.15334
- **RAG-MCP** (2025) uses semantic retrieval to pick relevant MCP tools
  and avoid prompt bloat. **MCP-Zero** (2025) lets the agent actively
  request tools. Both bear on our capability-gap matching. **Verified**,
  https://arxiv.org/abs/2505.03275 and https://arxiv.org/abs/2506.01056
- **CodeAct** (2024): executable code as the action space beats JSON tool
  calls. **Verified**, https://arxiv.org/abs/2402.01030
- **Anthropic, "Code execution with MCP"** (2025-11-04): presents MCP
  servers as code APIs. In its example, tokens drop from 150,000 to
  2,000. Saved functions become "skills", and PII can be tokenized before
  it reaches the model. It requires sandboxing. **Verified**,
  https://www.anthropic.com/engineering/code-execution-with-mcp
- **Anthropic, "Advanced tool use"** (2025-11-24): the Tool Search Tool
  cut context about 85%, from about 77K to about 8.7K tokens.
  Programmatic Tool Calling cut tokens 37%. **Verified**,
  https://www.anthropic.com/engineering/advanced-tool-use
  These are client-side alternatives to gateway-side composite tools, and
  the gateway should not assume composites are the only way to save
  tokens.

### Mining traces and tools that make tools

- **AWO, "Optimizing Agentic Workflows using Meta-tools"** (2026-01):
  analyzes workflow traces for recurring tool-call sequences and compiles
  them into deterministic composite "meta-tools". It reports up to 11.9%
  fewer LLM calls and +4.2 points in success rate. **Verified**,
  https://arxiv.org/abs/2601.22037
  **This is the closest prior art to our feature 4.**
- **MACRO** (2026-03): mines recurring multi-step sequences from verified
  trajectories and registers them as composite tools, in a medical imaging
  setting. **Verified**, https://arxiv.org/abs/2603.05860
- **SkillCraft** (2026-02): a benchmark for composing atomic tools into
  cached, reusable "Skills", reporting up to 80% fewer tokens.
  **Verified**, https://arxiv.org/abs/2603.00718
- **AgentTrails** (2026-07): turns trajectories into provenance graphs and
  aligns recurring tool patterns across runs. Its dataflow approach is
  relevant to inferring argument wiring between steps. **Verified**,
  https://arxiv.org/abs/2607.18816
- **ToolLIFT** (2026-08): lifts trajectories into function-level workflow
  graphs. **Verified**, https://arxiv.org/abs/2608.03468
- **Agent Workflow Memory** (2024): induces reusable workflows from past
  trajectories, with +24.6% and +51.1% relative success on Mind2Web and
  WebArena. **Verified**, https://arxiv.org/abs/2409.07429
- **Tool making**: LATM (an LLM makes tools that a cheaper LLM uses)
  https://arxiv.org/abs/2305.17126; CREATOR
  https://arxiv.org/abs/2305.14318; CRAFT
  https://arxiv.org/abs/2309.17428; TroVE, which grows and trims a
  verified toolbox and reports 79–98% smaller toolboxes
  https://arxiv.org/abs/2401.12869; Voyager's skill library
  https://arxiv.org/abs/2305.16291; SkillWeaver's synthesized web APIs
  https://arxiv.org/abs/2504.07079; and Alita, which generates MCPs on
  the fly https://arxiv.org/abs/2505.20286. All **Verified** (abstracts).
- Takeaways for the design:
  - TroVE's "trim" step suggests composites need usage-based retirement,
    not only creation. **Unverified** (inference).
  - These papers measure success on benchmarks, but our miner sees
    production traces without success labels. Use `isError` and retries
    as proxy labels. **Unverified** (inference).

## Security of OpenAPI-to-tool gateways

- **SSRF.** The spec's best-practices page covers SSRF for OAuth discovery
  URLs:
  - block 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (cloud
    metadata), fc00::/7 and fe80::/10;
  - validate every redirect hop;
  - pin DNS between check and use;
  - prefer an egress proxy such as Smokescreen;
  - don't hand-roll IP parsing (octal, hex and IPv4-mapped tricks).

  **Verified**,
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
  The same rules apply to our upstream calls. An imported spec's
  `servers[].url`, server variables and path parameters are all
  attacker-influenced. **Unverified** (inference).
- **Confused deputy and token passthrough.** A proxy with a static
  third-party client ID MUST keep a per-client consent registry, match
  `redirect_uri` exactly, and use single-use `state`. Passthrough is
  forbidden. **Verified**, same URL.
- **stdio in proxy scenarios.** A proxy that spawns stdio servers turns a
  client-side XSS into remote code execution. Sandbox the spawned
  processes and log every spawn. **Verified**, same URL. This applies
  directly to aggregating stdio upstreams.
- **Over-broad write access.** OWASP LLM06:2025 "Excessive Agency" names
  excessive functionality, excessive permissions and excessive autonomy.
  Its mitigations are minimal tools, least privilege, human approval for
  high-impact actions, and authorization enforced downstream.
  **Verified**, https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
  The spec's "Scope minimization" section adds progressive,
  least-privilege scopes. **Verified**,
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
  - Consequence: import every operation as **unpublished** by default,
    auto-publish only safe methods if anything, and gate writes through
    approval. **Unverified** (design inference).
- **Tool poisoning, rug pulls and shadowing** (Invariant Labs,
  2025-04-01):
  - Hidden instructions in tool descriptions are visible to the model and
    not to the user.
  - A server can change a description after approval (a rug pull).
  - One server's description can hijack how another server's tools are
    used (shadowing).

  The mitigations are to show full descriptions, pin and hash tool
  definitions, and enforce cross-server boundaries. **Verified**,
  https://invariantlabs.ai/blog/mcp-security-notification
  For us, OpenAPI `description` and `summary` fields are untrusted input
  that flows into the model. Approval should hash the *rendered* tool
  definition, and any upstream change should demote the tool to
  `awaiting_approval`. **Unverified** (design inference).
- **OWASP MCP Top 10 (2025, beta):** MCP02 Privilege Escalation via Scope
  Creep, MCP03 Tool Poisoning, MCP06 Prompt Injection via Contextual
  Payloads, MCP08 Lack of Audit and Telemetry, MCP10 Context Injection &
  Over-Sharing, among others. **Verified**,
  https://owasp.org/www-project-mcp-top-10/
- **MCP Safety Audit** (2025): shows LLMs using MCP tools can be coerced
  into credential theft and remote access. **Verified** (abstract only),
  https://arxiv.org/abs/2504.03767
- The spec's own tool security list says servers MUST validate inputs,
  enforce access control, rate-limit and sanitize outputs. Clients SHOULD
  confirm sensitive operations and log tool usage for audit.
  **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Tracing and redaction: the spec deprecates protocol Logging in favor of
  OpenTelemetry. Put trace context in `_meta` (`traceparent`). **Verified**,
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
  Redact before persisting, because traces will hold upstream response
  bodies. **Unverified** (inference).
