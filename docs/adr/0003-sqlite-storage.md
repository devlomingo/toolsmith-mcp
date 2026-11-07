# 0003: Embedded SQLite, no PostgreSQL or Redis

## Context

The data is small:

- the registry of artifacts and versions;
- an audit log;
- approvals;
- traces under a retention window.

Ease of setup is a stated priority ([CLAUDE.md](../../CLAUDE.md)).
Several processes can share the data: a stdio server per client plus a
dashboard.

## Decision

- One SQLite file through `node:sqlite`, in WAL mode with a busy timeout.
- Schema migrations are versioned in code.
- Other processes notice catalog changes through a revision counter that
  each gateway polls.
- No Redis: nothing needs a shared cache or a queue.

## Consequences

- Zero infrastructure. `npx toolsmith-mcp start` works on a fresh machine.
- Single-host only. A multi-node deployment would need the storage classes
  (`Registry`, `TraceStore`, `CallApprovals`, `AuditLog`) backed by
  PostgreSQL. They are small and isolated for that reason, but no PostgreSQL
  adapter ships today.
- `node:sqlite` is still flagged experimental in Node 22. The CLI hides
  that one warning.
