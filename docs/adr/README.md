# Architecture decision records

Each record states the context, the decision, and its consequences,
including the costs we accepted.

| # | Decision | Status |
|---|---|---|
| [0001](0001-typescript-node.md) | TypeScript on Node 22, minimal dependencies | Accepted |
| [0002](0002-mcp-sdk-v2-dual-era.md) | MCP SDK v2, serve both protocol eras | Accepted |
| [0003](0003-sqlite-storage.md) | Embedded SQLite (`node:sqlite`), no PostgreSQL or Redis | Accepted |
| [0004](0004-no-generated-code.md) | Generated tools are data, never code | Accepted |
| [0005](0005-fingerprint-traces.md) | Traces store keyed fingerprints, not payloads | Accepted |
| [0006](0006-human-approval.md) | Human approval gates publication; destructive calls approved per call | Accepted |
| [0007](0007-no-llm-by-default.md) | No LLM in the default pipeline | Accepted |
| [0008](0008-dashboard-without-build.md) | Dashboard without a build step or framework | Accepted |
