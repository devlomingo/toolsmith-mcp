# 0004: Generated tools are data, never code

## Context

The brief requires that AI-generated code never runs in the main process.
It also requires sandboxing or similarly strong isolation wherever
generated code does run.

## Decision

Nothing generated is ever executed as code. Both kinds of generated tool
are declarative definitions, interpreted by fixed code that ships with the
package:

- **OpenAPI tools** are stored operation descriptors: method, path,
  parameters and schemas. A single HTTP executor runs them, with an egress
  allow-list, a connect-time private-address check, no redirects, rate
  limits, timeouts and size limits.
- **Composite tools** are a small JSON DAG: steps, `$ref` paths and
  `forEach`. The executor resolves references with a path walker, not
  `eval`. It enforces limits on steps, fan-out, concurrency and total time.
  Every step goes back through the gateway's normal validation, policy and
  tracing.

## Consequences

- No sandbox is needed, because there is nothing to sandbox. This is
  stronger isolation than a sandbox, not weaker.
- Composites cannot transform data (filter, sort, compute). That is
  deliberate: an agent request such as "latest order" returns all orders
  and the agent filters. A data-transformation step would need a sandboxed
  expression language. It is on the roadmap, not built.
