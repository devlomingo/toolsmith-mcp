# 0001: TypeScript on Node 22, minimal dependencies

## Context

The official MCP SDKs with the newest protocol support are TypeScript and
Python. The gateway is I/O-bound (HTTP and stdio), and it ships as a CLI
that end users install with one command.

## Decision

- TypeScript in `strict` mode, ES modules, Node 22.13 or newer.
- Runtime dependencies are kept to what earns its place:

| Dependency | Why it is needed |
|---|---|
| `@modelcontextprotocol/server`, `client`, `node` | Protocol implementation, both eras |
| `@apidevtools/swagger-parser` | Swagger 2 / OpenAPI 3.x validation and `$ref` dereferencing |
| `js-yaml` | YAML specs |
| `ajv`, `ajv-formats` | JSON Schema validation of tool inputs and outputs |
| `zod` | Config validation (also an SDK peer) |

- Everything else uses the Node standard library: `node:http` for HTTP,
  `node:sqlite` for storage, and `node:crypto` for hashing and tokens.

## Consequences

- `npx` installs fast, and the dependency audit surface stays small.
- Node versions before 22.13 are not supported, because they need a flag
  for `node:sqlite`.
