# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Setup

```sh
git clone https://github.com/devlomingo/toolsmith-mcp && cd toolsmith-mcp
npm ci            # also builds dist/
npm test          # unit, integration, e2e and security suites
node dist/cli/index.js demo
```

Requirements: Node 22.13 or newer. Nothing else.

## Before you open a pull request

```sh
npm run lint && npm run format:check && npm run typecheck && npm test
```

If you touch the miner, the composite executor, or the gateway hot path,
also run:

```sh
npm run benchmark && npm run benchmark:check
```

Include the relevant lines of `benchmarks/reports/REPORT.md` in the PR
description. **Do not commit benchmark results produced on a different
machine without saying so.**

## Rules of the codebase

- **Security comes first.** Don't add a code path that executes generated
  code, follows redirects, or stores raw tool results. Don't add any path
  that lets an automated actor approve or publish. The relevant invariants
  are listed in [docs/SECURITY.md](docs/SECURITY.md); a change that weakens
  one needs an ADR.
- **Tests ship with the change.** Every bug fix gets a regression test, and
  every new failure mode gets a scenario test.
- **No new runtime dependency without a reason.** Add the justification to
  [ADR 0001](docs/adr/0001-typescript-node.md).
- **User-facing errors say what to do next.** Throw `ToolsmithError` with a
  `hint`.
- **The dashboard works in English and Arabic.** New strings go in both
  dictionaries, and new layouts must work right-to-left.
- **Docs stay in sync.** A behaviour change updates the matching page under
  `docs/`.

## Commit messages

Conventional style: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `perf:`.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
