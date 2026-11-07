# 0008: Dashboard without a build step or framework

## Context

The dashboard is an admin console of tables, forms and approvals. Bundling
React would add a build step and hundreds of transitive packages to a CLI
that should install in seconds.

## Decision

- Plain HTML, CSS and an ES-module script, served by the gateway.
- All data goes in through a small DOM builder that uses `textContent`,
  because tool descriptions come from third-party specs.
- A strict Content-Security-Policy.
- English and Arabic, with full right-to-left layout.

## Consequences

- No frontend toolchain to maintain.
- Fewer niceties than a component framework would give. Acceptable for
  this scope.
