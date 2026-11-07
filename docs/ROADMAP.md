# Roadmap

Items are listed by expected value. Nothing here is implemented yet.

## Next

- **npm registry release**, so that `npx toolsmith-mcp` works without the
  GitHub install.
- **In-band approval through MCP elicitation.** Destructive calls would be
  approved in the client instead of the dashboard, for clients that support
  multi-round-trip input.
- **Baked constants in composites.** When an argument's fingerprint is the
  same in every occurrence, store it as a literal instead of an input (from
  AWO's argument normalization).
- **Session-prefix mining.** A prefix tree over session starts would surface
  "session init" composites, such as login then search (AWO's state graph).
- **Postman collection import.**
- **Tool-list filtering for large catalogs.** Aggregating many servers grows
  the agent's tool list. Per-client tool profiles or a "search for a tool"
  meta tool would load tools on demand.

## Later

- **Optional LLM stage, off by default:**
  - extract endpoints from free-text HTML docs into the same descriptor,
    following ToolFactory's minimal schema;
  - richer capability matching;
  - proposed normalization rules.

  All of it would still have to pass live verification, the equivalence
  test and human approval.
- **A sandboxed transform step for composites** (filter, sort, pick
  latest), using a restricted expression language, not general code.
- **PostgreSQL storage**, for multi-node deployments.
- **OAuth 2.0 client-credentials and authorization-code flows** for APIs,
  and OAuth resource-server mode for the gateway itself.
- **OpenTelemetry export** of traces, following the MCP semantic conventions.
- **GraphQL and gRPC sources.**
