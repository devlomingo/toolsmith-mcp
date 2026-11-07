# 0002: MCP SDK v2, serve both protocol eras

## Context

The current MCP specification, 2026-07-28, is not backward compatible.
It has no `initialize` handshake and no sessions, and every request
carries its version in `_meta`.

`@modelcontextprotocol/sdk` v1 (1.32.2) stops at 2025-11-25. Most deployed
clients are probably still on the 2025 era; we found no survey, so this is
an assumption.

See [RESEARCH.md](../RESEARCH.md).

## Decision

- Build on the v2 split packages (`@modelcontextprotocol/server` and
  `client` 2.4.0, `node` 2.1.2).
- Serve HTTP through `createMcpHandler`. It answers 2026-07-28 requests
  natively and falls back to stateless 2025 serving for legacy clients.
- Serve stdio through `serveStdio`.
- Connect to upstream servers with `versionNegotiation: 'auto'`.

## Consequences

- Clients of either era work without configuration. The e2e test checks
  that both negotiate the expected version.
- **Legacy HTTP clients get no session-scoped notifications.** Stateless
  serving cannot push `tools/list_changed`, so these clients see new tools
  when they next list them.
- **Sessions no longer exist, so tracing needs its own grouping key.** It
  uses the `X-Toolsmith-Session` header, the OAuth client id, or the
  client's self-reported name. Agents that share one key are split apart
  by data flow (see [0005](0005-fingerprint-traces.md)).
