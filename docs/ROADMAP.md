# Roadmap

Released items moved to the [changelog](../CHANGELOG.md).

## Not built yet

| Item | Why it is not in this release |
|---|---|
| **Shared rate limits and in-client prompts across nodes** | With PostgreSQL, these two stay per node (see `database` in the configuration docs). Sharing them needs a coordination store on the hot path. |
| **gRPC client and bidirectional streaming** | A tool call is one request; streaming uploads need a different interaction model. Unary and server-streaming methods are supported. |
| **Sandboxed general-purpose transforms** (arbitrary expressions) | The declarative transform vocabulary covers filter, sort and pick by design. General expressions would need a real sandbox. |
| **Optional calls inside loop bodies** | A loop's per-item calls fold into one element, so a run that sometimes adds a call per item (`getOrder` next to `getOrderItems`) counts as a different loop shape. Gaps between top-level steps are handled. |

## Ideas

- Ranking composites by measured benefit (`usage`) and suggesting to
  disable unused ones automatically.
- Importing AsyncAPI and gRPC-gateway annotations.
