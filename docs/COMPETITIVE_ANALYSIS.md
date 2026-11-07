# Competitive analysis

Landscape as of 2026-11-07. Tags:

- **Verified**: someone read the primary source (repo, `gh api` output,
  registry metadata, or the docs page). Most rows were read by research
  sub-agents working for this document. Rows marked *(spot-checked)* were
  re-read by the author.
- **Unverified**: comes from a search snippet or a secondary source only.

Star counts and versions come from `gh api`, `npm view` and PyPI JSON,
read on 2026-11-07. They will go stale.

## Comparison table

Column key:

- Agg: aggregates upstream MCP servers with namespacing.
- OAPI: converts OpenAPI or REST at runtime.
- Trace: tool-call logs or OTel.
- Redact: redaction, PII or secret filtering.
- Comp: composite or multi-step tools.
- Mine: proposes tools from traces.
- Gap: detects missing capabilities.
- Appr: approval workflow before tools are published.
- 07-28: speaks MCP 2026-07-28.

| Product | Licence | Agg | OAPI | Trace | Redact | Comp | Mine | Gap | Appr | 07-28 |
|---|---|---|---|---|---|---|---|---|---|---|
| Docker MCP Gateway | MIT | yes | no | yes | yes | code-mode | no | no | no | no |
| IBM ContextForge | Apache-2.0 | yes | yes | yes | yes | no | no | no | no | WIP |
| Microsoft MCP Gateway | MIT | yes | no | partial | no | no | no | no | no | only |
| MetaMCP | MIT | yes | no | no | no | no | no | no | no | no |
| Unla | MIT | ? | yes | ? | ? | no | no | no | no | ? |
| Kong AI MCP Proxy | Enterprise | yes | yes | yes | no | no | no | no | no | v2.1+ |
| Cloudflare portals | SaaS | yes | no | yes | DLP | code-mode | no | no | no | ? |
| agentgateway | Apache-2.0 | yes | yes | yes | yes | no | no | no | no | yes |
| Agent Router (Envoy) | Apache-2.0 | yes | ? | yes | ? | no | no | no | no | no |
| Obot | MIT | yes | yes | audit | filters | no | no | no | servers | ? |
| Azure APIM | SaaS | ? | yes | yes | policies | no | no | no | no | ? |
| AgentCore Gateway | SaaS | yes | yes | ? | ? | no | no | no | no | ? |
| FastMCP from_openapi | Apache-2.0 | lib | yes | no | no | no | no | no | no | ? |
| openapi-mcp-generator | MIT | no | codegen | no | no | no | no | no | no | ? |
| mcp-openapi-proxy | MIT | no | yes | raw | no | no | no | no | no | yes |
| PostHog / AgentCat | SaaS | no | no | yes | ? | no | no | yes | no | n/a |
| Trace2MCP | ? | no | no | no | no | 1 trace | partial | no | no | ? |
| **toolsmith-mcp (plan)** | OSS | yes | yes | yes | yes | DAG | yes | yes | yes | target |

"?" means not stated in the sources read. Support for each cell is in
the sections below.

## MCP gateways and proxies

**Docker MCP Gateway**, https://github.com/docker/mcp-gateway
(Go, MIT, v0.44.3, 2026-10-26):

- Aggregates servers into profiles. A `tool-name-prefix` flag adds the
  server name to tool names. `mcp-find`, `mcp-add` and `mcp-remove` add
  tools at runtime.
- `--log-calls` and `--block-secrets` are on by default, and interceptor
  hooks are available.
- `pkg/gateway/codemode.go` creates a `code-mode-<name>` tool: one
  JavaScript execution tool with the chosen servers' tools in scope.
- Built on go-sdk v1.4.1. No claim of 2026-07-28 support was found.

**Verified** *(codemode.go spot-checked)*,
https://github.com/docker/mcp-gateway

**IBM ContextForge**, https://github.com/IBM/mcp-context-forge
(Python, Apache-2.0, v1.1.0, 2026-10-20):

- Federates MCP, A2A and REST/gRPC. A REST-to-MCP adapter is included.
- OTel and Prometheus. More than 40 plugins, including PII guardian,
  regex and deny filters, and `schema_guard`.
- "Virtual servers" are curated tool subsets, not composition.

**Verified**, https://github.com/IBM/mcp-context-forge

- Issue #2246, "Tool chain templates and workflow automation", was
  closed as **not_planned**. **Verified** *(spot-checked)*,
  https://github.com/IBM/mcp-context-forge/issues/2246
- Code-mode (#2952), a tool recommendation engine (#2244) and a virtual
  meta-server (#2230) were also closed as not planned. **Verified**, same
  repo.
- Dual-era 2026-07-28 support is an open epic, #6218. **Verified**
  *(spot-checked)*, https://github.com/IBM/mcp-context-forge/issues/6218

**Microsoft MCP Gateway**, https://github.com/microsoft/mcp-gateway
(C#, MIT):

- A Kubernetes control plane with adapters and a tool router. It uses
  Entra ID OAuth with app roles.
- It **requires** 2026-07-28 for both clients and adapters: "A stateless
  gateway cannot translate requests for a legacy-only adapter."

**Verified** *(spot-checked)*,
https://github.com/microsoft/mcp-gateway/blob/main/docs/mcp-2026-07-28.md

**Azure API Management** turns a "REST API as MCP server" (operations
become tools). It supports tools only and Entra or OAuth auth.
**Verified**,
https://learn.microsoft.com/en-us/azure/api-management/mcp-server-overview

**MetaMCP**, https://github.com/metatool-ai/metamcp (TypeScript, MIT,
v2.4.22, 2025-12-19, slowing):

- Namespaces aggregate servers into endpoints, with per-namespace
  overrides for tool names and descriptions.
- Middleware exists, but the only built-in one filters inactive tools.
  Observability middleware is marked "coming soon".
- It exposes MCP *as* OpenAPI, not the reverse.

**Verified**, same URL.

**Unla**, https://github.com/AmoyLab/Unla (MIT, v0.10.0, 2026-08-04):
REST-to-MCP conversion and OAuth pre-auth. **Verified** (README only).

**Kong AI Gateway.** The AI MCP Proxy plugin is Enterprise only, from
3.12. It converts OpenAPI or REST operations to tools, and listener mode
aggregates them. The plugin page says AI Guardrails are not supported for
MCP. **Verified**, https://developer.konghq.com/plugins/ai-mcp-proxy/

- The version-support page lists 2026-07-28 for v2.1 and later.
  **Verified**, https://developer.konghq.com/ai-gateway/mcp-version-support/
- AI Gateway 2.2 adds "MCP Server Bundling", which gives per-caller tool
  visibility. **Verified** (secondary press),
  https://unite.ai/kong-ships-ai-gateway-2-2-with-mcp-tool-governance-identity-policies

**Cloudflare MCP server portals**:

- Up to 120 servers per portal. Tools are auto-namespaced as
  `{server_id}_{name}`.
- Access logs and Logpush. Gateway DLP can block tool calls.
- **Code Mode** "collapses all upstream tools into two tools for search
  and code execution" in a Dynamic Worker, and admins can enforce it.

**Verified**,
https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
The Agents SDK v0.20.0 added 2026-07-28 support. **Unverified**,
https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/

**agentgateway**, https://github.com/agentgateway/agentgateway (Rust,
Apache-2.0, v1.7.0, 2026-10-27):

- Multiplexes servers with `{target}_{name}` prefixes.
- Has an OpenAPI upstream and OTel.
- Guardrails: regex, moderation, Bedrock and Model Armor.

**Verified**, same URL. It supports the sessionless 2026-07-28 protocol
by default and negotiates older versions automatically. **Verified**
*(spot-checked)*,
https://agentgateway.dev/docs/standalone/latest/mcp/spec-compatibility/

**Agent Router** (formerly Envoy AI Gateway),
https://github.com/theagentrouter/agent-router:

- `backend__tool` prefixes and a `toolSelector` filter.
- OTel tracing.
- OAuth with upstream credential injection.
- Its docs cite the 2025-06-18 spec.

**Verified**, https://theagentrouter.ai/docs/capabilities/mcp/

**Obot**, https://github.com/obot-platform/obot (Go, MIT, v0.27.0):

- vMCP aggregation with tool search.
- "Turn any HTTP API with an OpenAPI schema into a hosted MCP server".
- Audit logs and traffic filters.
- A catalog of *approved servers*, with snapshot pinning and explicit
  upgrade.

**Verified**, same URL. That approval covers servers, not generated
tools.

**Others.** Lasso MCP Gateway is MIT and has Presidio PII masking, but
looks stale (last push 2026-01). Pomerium logs every tool call and
enforces an `mcp_tool` policy. TBXark mcp-proxy, sparfenyuk mcp-proxy and
1MCP do aggregation or transport bridging. Composio's Tool Router uses
search plus execute. All **Verified** except Composio's "Workbench /
CodeAct" (**Unverified**):

- https://github.com/lasso-security/mcp-gateway
- https://www.pomerium.com/docs/capabilities/mcp
- https://github.com/TBXark/mcp-proxy
- https://github.com/sparfenyuk/mcp-proxy
- https://github.com/1mcp-app/agent
- https://github.com/ComposioHQ/composio

## OpenAPI-to-MCP generators

| Tool | Mode | Tool naming | Filtering and safety defaults |
|---|---|---|---|
| openapi-mcp-generator v5.0.1 | codegen (TS) | operationId; max 64, hash-suffix truncation | tags and ops include/exclude; `x-mcp`; external `$ref` off (SSRF) |
| FastMCP v4.1.6 `from_openapi` | runtime | operationId to first `__`, slug, **56-char cap**, numeric dedupe | ordered `RouteMap`, `EXCLUDE`; everything is a Tool by default |
| mcp-openapi-proxy v0.4.0 | runtime | path+method (`chat_completions`); prefix, max length | path whitelist; logs not redacted |
| awslabs openapi-mcp-server 1.1.6 | runtime (FastMCP) | not stated | tags; external `$ref` refused; DNS pinning; private-IP block |
| Bedrock AgentCore Gateway | managed | operationId, required; no cap | no `oneOf`/`anyOf`/`allOf`; no Swagger 2 |
| Speakeasy MCP | codegen (TS) | operationId, tags, overrides | `--scope read`; `--mode dynamic` meta-tools |
| Higress openapi-to-mcpserver | codegen to YAML, runtime | operationId; `--tool-prefix` | no filters documented |
| @ivotoby/openapi-mcp-server 1.17.0 | runtime | abbreviated to 64 | `all`/`dynamic`/`explicit` tool modes |
| Apigee MCP Discovery Proxy | managed | not stated | OAS 3.0.x only; 1000 tools per org |
| Stainless | **wound down** | — | — |

Sources, all **Verified**:

- https://github.com/harsha-iiiv/openapi-mcp-generator
- https://gofastmcp.com/integrations/openapi
- https://github.com/matthewhand/mcp-openapi-proxy
- https://github.com/awslabs/mcp/tree/main/src/openapi-mcp-server
- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-schema-openapi.html
- https://www.speakeasy.com/docs/standalone-mcp/build-server
- https://github.com/higress-group/openapi-to-mcpserver
- https://github.com/ivo-toby/mcp-openapi-server
- https://docs.cloud.google.com/apigee/docs/api-platform/apigee-mcp/apigee-mcp-overview

Stainless joined Anthropic and is "winding down all hosted Stainless
products". **Verified**,
https://www.stainless.com/blog/stainless-is-joining-anthropic/

Tyk, Gravitee, Zuplo and Postman also ship OpenAPI-to-MCP. **Unverified**
(snippets only):

- https://tyk.io/tyk-mcp-vs-gravitee-mcp/
- https://documentation.gravitee.io/apim/4.9/agent-mesh/convert-your-apis-to-mcp-servers
- https://zuplo.com/docs/handlers/mcp-server.md
- https://learning.postman.com/docs/postman-ai/mcp-servers/generate/

FastMCP's own docs say "LLMs achieve significantly better performance
with well-designed and curated MCP servers" than auto-converted ones, and
recommend conversion for bootstrapping. **Verified**,
https://gofastmcp.com/integrations/openapi
That supports our design of "import everything, publish a curated
subset".

## MCP observability

**OpenTelemetry MCP semantic conventions** now live in
`semantic-conventions-genai` and have status **Development**:

- Span name is `{mcp.method.name} {target}`.
- `gen_ai.tool.name` and `mcp.protocol.version` are attributes.
- Metrics are `mcp.{client,server}.operation.duration`.
- Tool arguments and results are **opt-in** because they "may contain
  sensitive information". The spec only gates content; it does not
  redact it.

**Verified**,
https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md

**Sentry MCP monitoring.** Inputs and outputs are recorded only when the
`recordInputs`/`recordOutputs` or `sendDefaultPii` options are set.
**Verified**, https://docs.sentry.io/ai/monitoring/mcp/getting-started

**Langfuse.** Links client and server traces through W3C trace context
in `_meta`. **Verified**,
https://langfuse.com/docs/observability/features/mcp-tracing

**Grafana Cloud.** Per-tool latency, success and "usage patterns", with
no call-chain analysis. **Verified**,
https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/ai-observability/mcp-observability.md

**Datadog.** MCP client spans and tool-change security monitoring.
**Unverified**, https://www.datadoghq.com/blog/mcp-client-monitoring/

**Snyk Agent Scan** (formerly Invariant mcp-scan, v0.6.11):

- Statically scans for tool poisoning, shadowing and "Toxic Flows",
  which are dangerous tool *combinations* found by static analysis rather
  than from runtime traces.
- Invariant's policy language matches tool-call sequences.

**Verified**, https://github.com/snyk/agent-scan and
https://github.com/invariantlabs-ai/invariant

**MCP Inspector v2.14.0** is a debugging client, not telemetry.
**Verified**, https://github.com/modelcontextprotocol/inspector

## Prior art for trace mining and gap detection

- **AWO meta-tools (arXiv 2601.22037, 2026-01).** Mines workflow traces
  for recurring tool-call sequences and compiles them into deterministic
  composite meta-tools. It reports up to 11.9% fewer LLM calls.
  **Verified**, https://arxiv.org/abs/2601.22037
  This is essentially our feature 4, as research code rather than a
  product.
- **Trace2MCP (PyPI 0.2.2, 2026-08).** Compiles *one* successful trace
  into a DAG workflow plus an MCP server skeleton. Side effects are
  blocked by default and the output is marked "unreviewed". It does not
  mine across many traces. **Verified**,
  https://pypi.org/pypi/trace2mcp/json
- **arXiv 2607.08010.** "Compiles repeated SOP steps into validated,
  versioned tools" from execution traces. **Verified** (abstract, via
  sub-agent), https://arxiv.org/abs/2607.08010
- **PostHog MCP Analytics.** A virtual `get_more_tools` tool emits
  `$mcp_missing_capability` events for humans to review. **Verified**,
  https://posthog.com/docs/mcp-analytics/missing-capability
- **AgentCat** (formerly MCPcat) does the same and turns it on by
  default. **Verified**, https://docs.agentcat.com/sdk/report-missing-tools
- **Braintrust.** A `send_feedback` tool plus "Patterns" that surface
  repeated behaviours. It is not stated to propose tools. **Verified**,
  https://www.braintrust.dev/blog/mcp-tracing
- **Gravitee "Composite MCP Workflow Mining" pages** look auto-generated
  and one returned 404. They are not evidence of a shipped feature.
  **Unverified**,
  https://www.gravitee.io/corpus/gen-1991/process-mining/composite-mcp-workflow-mining.html

The sub-agents found **no gateway** that mines traces across sessions,
proposes named composite tools, or runs generated tools through a human
approval lifecycle. That is absence of evidence from the queries listed
in their reports, not proof. **Verified** as a search result only.

## Differentiation (honest version)

**Not new; reuse or match these:**

- **Aggregation with prefixing is table stakes.** Docker, agentgateway,
  Cloudflare, Agent Router, MetaMCP and Obot all do it. Copy the
  conventions (`server_tool` or `server.tool`) rather than inventing one.
- **Runtime OpenAPI-to-MCP is common.** ContextForge, Kong, agentgateway,
  Obot, Azure APIM, AgentCore, FastMCP and mcp-openapi-proxy all do it.
  - Borrow openapi-mcp-generator's hash-suffix truncation, its
    "external `$ref` off for SSRF" default, and its `x-mcp` opt-in
    extension.
  - Borrow awslabs' DNS pinning and private-IP blocking.
- **Tracing and redaction are commodity.** Emit OTel spans that follow
  the MCP semconv (Development status) so traces land in Langfuse, Sentry
  or Grafana. Don't build an analytics UI that competes with theirs.
- **Code-mode is the competing answer to the same token problem.**
  Docker, Cloudflare, Anthropic's programmatic tool calling, and
  Speakeasy and ivotoby's dynamic meta-tools all attack the cost of
  multi-step tool use from a different angle. Our composites have to
  justify themselves against code-mode, through determinism,
  reviewability and no sandbox.
- **Gap detection through a `get_more_tools` virtual tool exists**
  (PostHog, AgentCat). Matching gaps against *imported but unpublished*
  OpenAPI operations is the part we have not seen elsewhere.
- **The composite-tool idea is published.** AWO, MACRO and Trace2MCP
  cover it. Cite them, and don't claim to have invented it.

**Where toolsmith appears different** (unverified beyond the searches
above):

1. **The combination in one open-source gateway:** import, aggregate,
   trace, mine, propose, test, approve, publish, roll back.
2. **A human approval lifecycle for generated tools.** Nobody found ships
   this. Obot approves servers, and Trace2MCP only labels its output
   "unreviewed".
3. **Declarative, reviewable composites** (a DAG in config) rather than
   agent-written code. Run them LLMCompiler-style in parallel where the
   DAG allows.
4. **Gap matching against the unpublished operation catalog,** which
   turns "missing capability" into "approve operation X".
5. **Being dual-era from day one.** Microsoft's gateway is modern-only and
   ContextForge's 2026-07-28 support is still open. agentgateway and Kong
   v2.1+ already do both, so this is parity, not a moat.

**Risks to the positioning:**

- ContextForge closed its tool-chain and code-mode work as not planned,
  which hints that maintainers saw weak demand. **Unverified** (that is
  our inference; the issues don't give a reason).
- Big gateways (Kong, Cloudflare, agentgateway) could add mining quickly
  on top of the traces they already hold.
- Without success labels, mined composites may encode bad habits.
  Approval and testing are what mitigate that.
