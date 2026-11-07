# 0006: Human approval gates publication; destructive calls approved per call

## Context

Generated tools must not become trusted automatically. Read and write
operations need different treatment, and destructive operations need
explicit approval.

## Decision

- The lifecycle is enforced in code as a state machine (`Registry`).
- Only an actor of the form `human:*` can move a version to `approved`, and
  a version that failed evaluation cannot be approved.
- At approval, write and destructive operations stay hidden unless they are
  explicitly granted.
- A destructive call also needs a per-call approval. It is bound to the
  exact tool and arguments by hash and is single-use.
- A composite is only exposed while every tool it calls is exposed, so it
  can never exceed the permissions of its steps.

## Consequences

- Destructive operations are slower for agents: they ask the user, and the
  user approves in the dashboard or CLI. That is the intent.
- MCP elicitation could make per-call approval in-band. It is not used
  yet, because its 2026-07-28 form needs multi-round-trip support in
  clients. It is on the roadmap.
