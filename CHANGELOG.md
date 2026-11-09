# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **The gateway as an OAuth 2.1 resource server** (`server.oauth`), as the
  MCP authorization spec describes:
  - JWT access tokens are verified against the issuer's JWKS, which is
    discovered from its metadata and cached. Checks cover the signature,
    issuer, audience/resource (RFC 8707), expiry and required scopes.
  - RFC 9728 protected-resource metadata, with `resource_metadata` in
    every `WWW-Authenticate` challenge.
  - The identity covers the client app and the user, hashed from the
    complete claims. Approvals, prompts and rate limits are never shared
    between users, or between look-alike client ids. Exposure can be set
    per client. Static client tokens keep working.
  - Optional `typ: at+jwt` enforcement and a maximum token lifetime. A
    JWKS outage answers 500, not 401.
- **Per-client rate limits** (`server.rateLimit`, with overrides per
  static or OAuth client). A composite counts as one call.
- **Workflows with gaps.** Inside a data-flow component, the miner also
  counts non-adjacent steps, as long as each consumes a value from an
  earlier chosen step. An optional linked side call no longer hides the
  workflow around it (benchmark F1 0.72 → 0.92 with side calls in 30% of
  runs). Values are wired from the earliest step in the pattern that holds
  them. `subsequences: false` restores adjacent-only counting.
- **Mining scales linearly with session length.** Bindings are found
  through a value index instead of a scan of every earlier call. One
  12,000-call session now mines in 0.14 s and 132 MB; it took minutes
  before. 88k traces take 418 ms, against 403 ms before gaps were added.
- `npm run verify:cycle`: the whole release cycle as one command (checks,
  tests, quick benchmarks, the demo lifecycle over HTTP, a packed install,
  the site).

## [0.1.0] - 2026-11-08

First public release.

### Added

- **Gateway**
  - Serves MCP 2025-11-25 and 2026-07-28 over stdio and Streamable HTTP,
    through the official v2 TypeScript SDK.
  - Bearer-token protection, loopback default, and DNS-rebinding and
    cross-origin guards.
  - Aggregates upstream MCP servers of either protocol era under name
    prefixes.
- **API integration builder**
  - OpenAPI 3.0/3.1 and Swagger 2.0 (JSON or YAML, from a file or URL), plus
    plain endpoint lists (`{p}`, `:p`, `<p>` path syntax).
  - Typed input and output schemas and read/write/destructive access levels.
  - Bearer, API-key and basic auth from environment variables.
  - Timeouts, a per-integration rate limit, and retries for safe reads that
    honour `Retry-After`.
  - SSRF protection with connect-time address checks.
- **Live verification** of generated read tools, inspired by ToolFactory:
  - parameter values from spec examples or from other endpoints, found by
    schema linking;
  - a typed failure taxonomy;
  - parameter-source hints in tool descriptions.
- **Tracing**
  - Redacted arguments and keyed value fingerprints; tool results are never
    stored.
  - Retention, and per-tool p50/p95.
- **Workflow discovery**
  - Data-flow segmentation and loop detection.
  - AWO-inspired majority step rule and commutative reads.
  - Closed-pattern pruning.
  - Argument-source voting.
- **Composite tools**
  - Declarative DAG plans with parallel stages, bounded `forEach` fan-out,
    partial results and limits.
  - Equivalence-checked evaluation against the original tools.
  - Usage tracking after publication.
- **Missing-capability analysis** through the `toolsmith__request_capability`
  meta tool.
- **Lifecycle**
  - A state machine with human-only approval.
  - Explicit write and destructive grants, and per-call approval of
    destructive operations.
  - Versioning, disable/enable and rollback, plus an audit log.
- **CLI:** `demo`, `init`, `import`, `list`, `show`, `evaluate`, `approve`,
  `reject`, `publish`, `disable`, `enable`, `rollback`, `approve-call`,
  `reject-call`, `patterns`, `discover`, `usage`, `ask`, `traces`, `doctor`,
  `client-config`.
- **Dashboard** with no build step, in English and Arabic (RTL).
- **Benchmarks:**
  - baseline versus composite latency and call counts;
  - pattern-discovery precision, recall and F1 under 12 conditions, with an
    ablation;
  - scalability.

  Each produces a generated report and charts.
- Docker image, CI (lint, types, tests on Node 22 and 24, audit, CodeQL,
  Docker, benchmark regression), and the GitHub Pages site.
- **Sources:** Postman collections (v2.0/v2.1); GraphQL via introspection;
  free-text documentation through the optional LLM stage.
- **OAuth 2.0 client-credentials** auth for APIs.
- **Per-client tool exposure:** allow-lists enforced on calls, a search
  listing mode, and the `toolsmith__search_tools` meta tool.
- **Declarative transform steps** in composites (filter, sort, pick, limit,
  first, last, count). "Latest" and "oldest" requests select the item
  themselves.
- **Baked constants** in mined composites, and session-prefix statistics.
- **Opt-in in-client approval** of destructive calls through MCP
  elicitation (both protocol eras).
- **OpenTelemetry OTLP/HTTP export** of tool-call spans.
- **Optional LLM stage** (Anthropic SDK, off by default): endpoint extraction
  from docs, and a capability-matching fallback.
- **High-traffic load benchmark** with charts.
- Composite descriptions start with a "use this instead of …" line, and
  reviewers can replace a description at approval (`--description`, or the
  dashboard).

### Security

Fixed before release, after independent validation (see
`docs/validation/ROUND-1.md`):

- SSRF: IPv4-embedding IPv6 spellings such as `::ffff:7f00:1`, NAT64, 6to4
  and Teredo are now blocked.
- Known credentials are scrubbed from successful responses, not only from
  errors, for both APIs and upstream MCP servers.
- Destructive tools of upstream MCP servers now need per-call approval.
  Opt-outs: `approval: "none"`, `trustedTools`.
- Composites that write need their own write grant, and run in recorded
  order.
- Per-call approvals are bound to the calling client, identified by its MCP
  token (`server.clients` gives each agent its own).
- CLI granting commands need an interactive terminal and confirmation. This
  guards against accidents and is not a boundary.
- Basic-auth credentials, including the encoded header, are scrubbed from
  responses. Trace paths are redacted.
- Spec and documentation downloads refuse private addresses on every
  redirect hop and fail closed when a host can't be resolved. They are
  checked before connecting, so unlike tool calls they are not protected
  against DNS rebinding; these URLs come from the operator. IPv4-translated
  IPv6 is blocked.
- Tool poisoning:
  - Agent-visible schemas keep only standard JSON Schema keywords.
  - Invisible characters (every Unicode format character, which includes
    tag characters, plus control, private-use and filler characters) are
    removed from every string and key an agent can read. Visible text is
    never rewritten; the joiners and emoji selectors Persian, Indic
    scripts and emoji need are kept (bidi marks are still removed), and only the scanner's private copy is NFKC-folded.
  - The title, paths and all schema strings are scanned (a best-effort
    tripwire). A tool with more than 5,000 schema strings fails evaluation
    as unreviewable.
  - `show` lists every description and top-level parameter; `show --json`
    and the dashboard show full schemas.
- Mined composites:
  - Only booleans and API-declared enum values are baked in. Numbers, ids
    and free text stay inputs, and a name that is also an input always uses
    the input.
  - Every argument is kept, empty values (`""`, `null`, `[]`, `{}`)
    included, so none is silently dropped.
  - Recorded values never go into the definition: example inputs are read
    from traces at evaluation time.
- OAuth tokens stay scrubbed until they really expire.
- In-client approval prompts expire, can't be accepted after a decline,
  and show invisible and line-separator characters as `\u{…}` escapes.
- In-client approval prompts show the complete arguments, and only answers
  to prompts the gateway sent count.
- Capability answers only offer tools the calling client may use. Postman
  path variables stay parameters instead of baking values into tools.
  OAuth tokens are fetched once
  for parallel calls and rotated out of the redactor.
- Install from the release tarball: a global install from git cannot build
  the package.
- The admin token is no longer printed to non-interactive output.
- Timeouts are no longer retried.

[0.1.0]: https://github.com/devlomingo/toolsmith-mcp/releases/tag/v0.1.0
