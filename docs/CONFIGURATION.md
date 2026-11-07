# Configuration

Configuration lives in `toolsmith.config.json`, in the directory you run
from or wherever `--config <path>` points.

- **Secrets are never written in it.** Reference them as `${env:NAME}`. They
  are read from the environment, or from a `.env` file next to the config.
- **Relative paths** resolve against the config file's directory.
- **Every field has a default**, and `{}` is a valid config.

## Full example

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7420,
    "mcpToken": "${env:TOOLSMITH_MCP_TOKEN}",
    "adminToken": "${env:TOOLSMITH_ADMIN_TOKEN}"
  },
  "dataDir": ".toolsmith",
  "integrations": [
    {
      "name": "shop",
      "spec": "./specs/shop.yaml",
      "baseUrl": "https://api.shop.example.com/v2",
      "auth": { "type": "bearer", "token": "${env:SHOP_TOKEN}" },
      "allowedHosts": [],
      "allowPrivateNetwork": false,
      "timeoutMs": 15000,
      "rateLimit": { "requestsPerSecond": 10, "burst": 20 },
      "maxRetries": 2,
      "include": [],
      "exclude": ["/admin/*"],
      "headers": { "X-Client": "toolsmith" },
      "validateOutput": true
    }
  ],
  "upstreams": [
    { "name": "files", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "trustedTools": ["write_file"] },
    { "name": "remote", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${env:REMOTE_TOKEN}" } }
  ],
  "traces": { "retentionDays": 14, "captureArguments": "redacted" },
  "patterns": { "minSupport": 3, "minConfidence": 0.6, "maxLength": 6, "episodeGapMs": 120000 },
  "composites": { "maxSteps": 20, "maxFanOut": 50, "concurrency": 8, "timeoutMs": 60000 },
  "metaTools": true
}
```

## Reference

### `server`

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address. Anything other than loopback requires `mcpToken`. |
| `port` | `7420` | HTTP port for `/mcp`, `/api` and `/dashboard`. |
| `mcpToken` | none | Bearer token that MCP clients must send. It identifies the client named `default`. Serving MCP over HTTP requires at least one client token, even on loopback. |
| `adminToken` | none | Bearer token for the dashboard and admin API. Required to run `start`. |
| `clients` | `[]` | Extra MCP clients, each `{ "name": "agent-a", "token": "${env:AGENT_A_TOKEN}" }`. The token identifies the client, and per-call approvals are bound to it. Give each agent its own. |

### `integrations[]`

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Namespace: lowercase letters, digits and `-`. Tools are named `<name>__<operation>`. |
| `spec` | required | Path or URL of an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML), or a `.txt` / `.endpoints` endpoint list. |
| `baseUrl` | the spec's first server | Required when the spec has none. Toolsmith never guesses it. |
| `auth` | `{ "type": "none" }` | `bearer` (`token`), `apiKey` (`in`: `header`/`query`, `name`, `value`), or `basic` (`username`, `password`). |
| `allowedHosts` | `[]` | Extra hosts besides the base URL's. Rarely needed. |
| `allowPrivateNetwork` | `false` | Allow loopback and private addresses, for local APIs only. |
| `timeoutMs` | `15000` | Per-request timeout. |
| `rateLimit` | `10/s`, burst `20` | Local token bucket, shared by all of the integration's tools. |
| `maxRetries` | `2` | Retries for **read** operations on 429/502/503/504 and network errors. Writes are never retried. |
| `include` / `exclude` | `[]` | Glob filters (`*`) on operationId or path. |
| `headers` | `{}` | Extra headers. `${env:...}` is allowed. |
| `validateOutput` | `true` | Check responses against the documented schema. Turn off only for specs known to be wrong. |

### `upstreams[]`

Other MCP servers whose tools are re-exposed as `<name>__<tool>`. Either
`command` / `args` / `env` / `cwd` (stdio) or `url` / `headers`
(Streamable HTTP). Both protocol eras are negotiated automatically.

Adding a server to the config is the approval: its tools appear without a
review step. Destructive calls are still checked:

| Field | Default | Meaning |
|---|---|---|
| `approval` | `destructive` | Tools whose MCP annotations mark them destructive need a human per call. Under the MCP spec a tool **without annotations counts as destructive**. `none` trusts the server completely. |
| `trustedTools` | `[]` | Tool names (as the server names them) exempt from per-call approval. |

### `traces`

| Field | Default | Meaning |
|---|---|---|
| `retentionDays` | `14` | Traces older than this are deleted at startup. |
| `captureArguments` | `redacted` | `redacted` stores arguments after redaction; `none` stores only fingerprints. Results are never stored. |

### `patterns`

| Field | Default | Meaning |
|---|---|---|
| `minSupport` | `3` | Sessions a workflow must appear in. |
| `minConfidence` | `0.6` | Share of occurrences that must agree on an argument's source. |
| `maxLength` | `6` | Longest workflow, in steps. |
| `episodeGapMs` | `120000` | Idle time that ends an episode. |

### `composites`

| Field | Default | Meaning |
|---|---|---|
| `maxSteps` | `20` | Upper bound on steps per plan. |
| `maxFanOut` | `50` | Upper bound on `forEach` iterations. Beyond it the result is truncated and marked `partial`. |
| `concurrency` | `8` | Maximum concurrent step calls per composite run. |
| `timeoutMs` | `60000` | Upper bound on a whole composite run. |

### `metaTools`

When `true`, agents also see `toolsmith__request_capability`, which they
call to describe a need no tool covers.

## Environment variables

| Variable | Used by |
|---|---|
| `TOOLSMITH_MCP_TOKEN`, `TOOLSMITH_ADMIN_TOKEN` | Generated by `init` and referenced from `server` |
| Anything you reference with `${env:NAME}` | Credentials and headers |
| `NO_COLOR` | Disables colored CLI output |
