# Roadmap

Released items moved to the [changelog](../CHANGELOG.md).

## Not built yet

| Item | Why it is not in this release |
|---|---|
| **PostgreSQL storage** for multi-node deployments | The storage classes (`Registry`, `TraceStore`, `CallApprovals`, `AuditLog`) use synchronous SQLite calls throughout. A networked store means making them, and every caller, async. That is a careful refactor of the security-critical paths, not an add-on. |
| **gRPC client and bidirectional streaming** | A tool call is one request; streaming uploads need a different interaction model. Unary and server-streaming methods are supported. |
| **Sandboxed general-purpose transforms** (arbitrary expressions) | The declarative transform vocabulary covers filter, sort and pick by design. General expressions would need a real sandbox. |
| **Optional calls inside loop bodies** | A loop's per-item calls fold into one element, so a run that sometimes adds a call per item (`getOrder` next to `getOrderItems`) counts as a different loop shape. Gaps between top-level steps are handled. |

## Ideas

- Ranking composites by measured benefit (`usage`) and suggesting to
  disable unused ones automatically.
- Importing AsyncAPI and gRPC-gateway annotations.
