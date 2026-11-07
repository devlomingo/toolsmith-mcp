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
  can never exceed the permissions of its steps. A composite that writes
  also needs its own write grant.
- Destructive tools of upstream MCP servers need per-call approval too,
  unless the operator opts out per server or tool. An unannotated tool counts
  as destructive, following the MCP default.
- Approvals are bound to the requesting client, which is authenticated by its MCP token (or, over stdio, its process). Self-reported session headers only group traces.
- CLI commands that grant access require an interactive terminal and a
  typed confirmation, which stops an agent approving by accident. This
  raises the bar, but it is not a boundary: a process can fake a terminal or
  read the token.

## Consequences

- Destructive operations are slower for agents: they ask the user, and the
  user approves in the dashboard or CLI. That is the intent.
- In-band approval through MCP elicitation exists, but is opt-in
  (`approvals.inClient`). The client app shows the prompt, so the trust
  moves to that app. The prompt always shows the complete arguments, and
  calls too large to show in full go to the dashboard. An answer only counts
  if the gateway actually sent the prompt.
