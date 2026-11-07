# Roadmap

Released items moved to the [changelog](../CHANGELOG.md).

## Not built yet

| Item | Why it is not in this release |
|---|---|
| **PostgreSQL storage** for multi-node deployments | The storage classes (`Registry`, `TraceStore`, `CallApprovals`, `AuditLog`) use synchronous SQLite calls throughout. A networked store means making them, and every caller, async. That is a careful refactor of the security-critical paths, not an add-on. |
| **The gateway as an OAuth 2.1 resource server** (MCP authorization spec: protected-resource metadata, JWT validation, audience checks) | Needs JWKS-based token validation and testing against real authorization servers. Today, clients authenticate with per-client bearer tokens (`server.clients`). |
| **gRPC sources** | Needs protobuf descriptor parsing (reflection or `.proto` files) and a gRPC client. That's a dependency and a test surface on the scale of the OpenAPI importer. |
| **Sandboxed general-purpose transforms** (arbitrary expressions) | The declarative transform vocabulary covers filter, sort and pick by design. General expressions would need a real sandbox. |
| **Mining across non-contiguous calls** inside one data-flow component | The miner already splits sessions by data flow. Patterns inside a component are still contiguous n-grams. |

## Ideas

- Ranking composites by measured benefit (`usage`) and suggesting to
  disable unused ones automatically.
- Per-client rate limits.
- Importing AsyncAPI and gRPC-gateway annotations.
