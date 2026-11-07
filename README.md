# toolsmith-mcp

**Give any AI agent the tools it needs.**

Toolsmith is an MCP gateway with three jobs:

- It turns OpenAPI/Swagger specs into MCP tools at runtime.
- It aggregates other MCP servers behind one endpoint.
- It watches how agents use those tools, finds workflows they repeat, and
  proposes **composite tools** that do the whole workflow in one call.
  Independent steps run in parallel, and the composite is checked against
  the original calls.

Nothing Toolsmith generates (API tools, composite tools) reaches an agent
until a human approves it. Destructive calls, including those of connected
MCP servers, need a human per call.

[![CI](https://github.com/devlomingo/toolsmith-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/devlomingo/toolsmith-mcp/actions/workflows/ci.yml)
· Website: <https://devlomingo.github.io/toolsmith-mcp/> · MIT licensed

```sh
npm install -g https://github.com/devlomingo/toolsmith-mcp/releases/download/v0.1.0/toolsmith-mcp-0.1.0.tgz
toolsmith-mcp demo
```

The demo runs the whole lifecycle against a bundled demo shop API, then
leaves the gateway and dashboard running for you to explore.

![Dashboard: an evaluated composite tool](docs/images/dashboard-composite.png)

## What it does

| | |
|---|---|
| **API → tools** | Import OpenAPI 3.x / Swagger 2.0 (file or URL, JSON or YAML), or a plain `METHOD /path` list. Each operation becomes a typed MCP tool with input and output schemas, auth, timeouts, rate limits and retries for safe reads. Missing information is reported, never invented. |
| **Live verification** | Every read operation is called before review. Parameter values come from spec examples, or from another endpoint that returns them (`orderId ← listOrders[*].id`). Results are classified (`verified`, `wrong_parameter_value`, `schema_mismatch`, …). Writes are never called. Inspired by [ToolFactory](docs/PAPERS.md#toolfactory). |
| **One endpoint for every MCP server** | Upstream MCP servers (stdio or HTTP, either protocol era) are re-exposed under a prefix, with the same tracing. |
| **Workflow discovery** | Traces store keyed hashes of values, not payloads. Repeated sequences are linked by data flow and loops are detected. The AWO majority rule and commutative reads are applied ([AWO](docs/PAPERS.md#awo-optimizing-agentic-workflows-using-meta-tools)). |
| **Composite tools** | Mined workflows become declarative DAG plans: parallel stages, `forEach` fan-out, partial results. They are executed by fixed code; nothing generated runs as code. Each one tells the agent what it replaces ("Use this instead of calling … one by one"), and the reviewer can rewrite that description at approval. |
| **Evaluation** | Composites are run against the original tools one by one and must return identical results. Plans that write data are never executed automatically. |
| **Missing capabilities** | Agents call `toolsmith__request_capability`. The answer is `available`, `composable` (and a composite is proposed), `needs_approval`, or `unsupported`. |
| **Human approval** | A lifecycle state machine. Generated write and destructive tools stay hidden until granted, including composites that write. Connected MCP servers are trusted by configuration, except that their destructive tools need per-call approval. Every destructive call is approved individually, in the dashboard or an interactive terminal (never through MCP), bound to its exact arguments and to the calling client's token. Versions can be rolled back. |
| **Dashboard** | Approvals, integrations, tools, workflows and usage, capability requests, traces (p50/p95), benchmarks, audit log. English and Arabic, with right-to-left layout. |
| **Protocol** | MCP 2025-11-25 and 2026-07-28 over stdio and Streamable HTTP, through the official v2 TypeScript SDK. Not tied to any client. |

## Quick start

```sh
mkdir my-tools && cd my-tools
toolsmith-mcp init                                   # config + .env with fresh tokens
toolsmith-mcp import ./openapi.yaml --name shop --token-env SHOP_TOKEN
toolsmith-mcp show shop                              # review tools, findings, verification
toolsmith-mcp approve shop                           # read-only; add --allow-writes to expose writes
toolsmith-mcp start                                  # MCP endpoint + dashboard
toolsmith-mcp client-config                          # snippets for your MCP client
```

Later, after agents have used the tools for a while:

```sh
toolsmith-mcp patterns      # repeated workflows
toolsmith-mcp discover      # propose and evaluate composites
toolsmith-mcp approve flow-get-user-orders-details
toolsmith-mcp usage         # are they used, and what do they save?
```

## Benchmarks

All numbers come from `npm run benchmark` on a developer workstation:
Apple Silicon, Node 22.13, with client, gateway and demo API on loopback.
The full methodology, the tables and the limitations are in
[benchmarks/reports/REPORT.md](benchmarks/reports/REPORT.md).

**"Customer, orders, and items plus payments for each order", median
end-to-end latency at the MCP client:**

| Demo API latency | Sequential agent (8 MCP calls) | Best-case parallel client (8 MCP calls) | Composite (1 MCP call) |
|---|---|---|---|
| 0 ms | 7.5 ms | 4.7 ms | 1.9 ms |
| 25 ms | 249.3 ms | 68.3 ms | 62.7 ms |
| 50 ms | 458.7 ms | 120.1 ms | 114.5 ms |

How to read this table:

- **The comparison that matters is the parallel client.** Against a client
  that already parallelizes perfectly, the composite's latency is the same
  within run-to-run noise (an independent re-run measured it 2% slower at
  25 ms). The real saving is **7 fewer MCP round-trips**: in a real agent
  those are model turns, which this benchmark does not include.
- **A strictly sequential chain gains little.** A 3-step dependent chain
  gains 3–7% at 10–50 ms API latency.
- **No correctness was lost:** every composite run matched the sequential
  reference, with the same 8 underlying API requests.

**Workflow discovery** (synthetic traces, 3 planted workflows, 12
conditions, 10 seeds each):

- Mean F1 is **0.97**, against 0.84 for the first version of the miner.
- The miner is perfect on clean data, on noise between steps, on abandoned
  runs and on agents sharing a session.
- It is weakest when unrelated calls reuse small integer ids (ids 1..10:
  precision 0.69).

LLM tokens and requests were **not** measured; no claim is made about them.

## Documentation

**Setting up**
- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Turning APIs into tools](docs/API-INTEGRATION.md)
- [Connecting MCP clients](docs/MCP-INTEGRATION.md)

**Using it**
- [Workflows and composite tools](docs/TOOL-GENERATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

**Under the hood**
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Decision records](docs/adr/README.md)

**Background**
- [Research](docs/RESEARCH.md)
- [Competitive analysis](docs/COMPETITIVE_ANALYSIS.md)
- [Papers we build on](docs/PAPERS.md)

**Project**
- [Roadmap](docs/ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Prior art

Mining agent traces into composite tools is not new. **AWO** (2026) does it
with hand-built meta-tools, and **ToolFactory** (2025) generates and
validates tools from API docs. [COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md)
covers both, along with gateways and OpenAPI-to-MCP generators.

What Toolsmith adds is putting the pieces together behind one standard MCP
endpoint:

- arguments wired automatically from value fingerprints;
- parallel execution;
- equivalence-checked evaluation;
- a human-approval lifecycle.

## Status

Version 0.1. It is tested (unit, integration, end-to-end over MCP, and
security suites) and benchmarked. It is **not** yet hardened by production
use. Single host, SQLite storage. See the [roadmap](docs/ROADMAP.md) for
what's missing, including npm registry publication and an optional LLM
stage.
