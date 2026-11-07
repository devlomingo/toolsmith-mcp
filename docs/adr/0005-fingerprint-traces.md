# 0005: Traces store keyed fingerprints, not payloads

## Context

Workflow discovery needs to know that an output of one call fed an argument
of the next. Storing tool results would put customer data and secrets in the
trace store.

## Decision

- For each call, store `path → HMAC-SHA256(value)` for argument leaves and
  `HMAC(value) → paths` for result leaves.
- Sensitive keys are skipped entirely.
- The HMAC key is random per installation and kept in the database.
- Arguments are additionally stored redacted (configurable to off).
- Results are never stored, only their size.

## Consequences

- Data-flow linking works on hash equality, with no raw values stored.
- The miner can confuse coincidentally equal values, such as small
  integers. Two mitigations apply: links need name evidence (for example
  `orderId ← orders[*].id`), and votes are taken across sessions. The
  benchmark measures the residual effect (see "colliding small ids").
- Evaluation needs real example inputs. These come from redacted arguments
  when available, or the reviewer supplies them.
