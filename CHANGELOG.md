# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [semantic versioning](https://semver.org/).

## [0.1.0] - 2026-11-07

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

[0.1.0]: https://github.com/devlomingo/toolsmith-mcp/releases/tag/v0.1.0
