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
| `rateLimit` | off | Per-client call limit, `{ "requestsPerSecond": 5, "burst": 20 }`, for every client without its own (`clients[].rateLimit`, `oauth.clients[].rateLimit`, `oauth.rateLimit`). Each `tools/call` counts once, so a composite costs one call however many steps it runs. Over the limit, the call fails at once with `rate_limited` and a retry hint; it never reaches the API. The limit applies per principal: for OAuth that is per user of a client app, so an app with many users gets the limit once per user. An in-client approval prompt and its answer count as two calls. |
| `oauth` | none | Accept OAuth 2.1 access tokens (JWTs) from your authorization server, as the MCP authorization spec describes. See below. Static tokens keep working alongside it. |

#### `server.oauth`

```json
"oauth": {
  "issuer": "https://auth.example.com",
  "resource": "https://tools.example.com/mcp",
  "requiredScopes": ["mcp:tools"],
  "exposure": { "tools": ["shop__get*"] },
  "clients": [{ "clientId": "reporting-agent", "exposure": { "tools": ["flow__*"] } }]
}
```

| Field | Default | Meaning |
|---|---|---|
| `issuer` | required | The authorization server's issuer (`iss`). Must be https; plain http is accepted only on loopback, for development. |
| `resource` | required | This gateway's public `/mcp` URL. Tokens must name it as their audience (RFC 8707), so a token issued for another service is refused. |
| `jwksUri` | discovered | Where the signing keys are. By default read from the issuer's `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`, whose `issuer` must match. Keys are cached for 10 minutes. |
| `audiences` | `[]` | Extra accepted audience values. |
| `requiredScopes` | `[]` | Scopes every token must carry (`scope` or `scp` claim). A token without them gets `403 insufficient_scope`. |
| `requireAtJwt` | `false` | Refuse tokens whose header is not `typ: at+jwt` (RFC 9068). Turn on if your issuer sends it, so an ID token can never pass as an access token. |
| `maxLifetimeSeconds` | `86400` | Refuse tokens that stay valid longer than this from now, and tokens issued more than 30 s in the future. |
| `algorithms` | `RS256`, `ES256`, `EdDSA` | Accepted signature algorithms. Only asymmetric ones can be configured; `none` and HMAC are always refused. |
| `exposure` | top-level `exposure` | Tool exposure for OAuth clients. |
| `rateLimit` | `server.rateLimit` | Per-client call limit for OAuth clients. |
| `clients` | `[]` | Per-client `exposure` and `rateLimit`, keyed by the token's client id: the full `client_id` claim, else `azp`. The `sub` claim never selects a client. Issuers that name the client in another claim (Okta `cid`, Azure v1 `appid`) are not matched, so set `oauth.exposure` to the narrowest allow-list and widen it per client, not the other way round. |

The gateway serves RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`, and every 401 carries a
`WWW-Authenticate` header that points to it, so MCP clients can find your
authorization server on their own. Access tokens are never forwarded to
upstream APIs.

**Identity.** A verified token becomes the principal
`oauth:<label>.<client hash>/<user hash>`, where the hashes cover the
complete `client_id` (or `azp`) and `sub` values and the label is a short
readable piece of the client id for logs. Per-call approvals, in-client
prompts, rate limits and traces bind to that principal, so they are never
shared between two users of the same client app, or between two client ids
that look alike.

**Edge cases.** `resource` is used exactly as URL-normalised: a value
without a path (`https://tools.example.com`) becomes
`https://tools.example.com/`, and tokens must carry that audience. After
your issuer rotates its signing key, tokens signed with the new key can be
refused for up to 30 s, the JWKS refetch cooldown that stops forged key ids
from flooding the issuer. If the JWKS cannot be fetched, clients get a
500, not a 401, so they do not re-authenticate in a loop.

### `integrations[]`

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Namespace: lowercase letters, digits and `-`. Tools are named `<name>__<operation>`. |
| `type` | `openapi` | `openapi` (OpenAPI, Swagger, Postman collection or endpoint list, detected automatically), `graphql` (`spec` is the endpoint URL, or a saved introspection JSON with `baseUrl` set), `docs` (free-text documentation; needs the optional LLM stage), or `grpc` (`spec` is `.proto` file(s) or `reflection`; set `grpc.address`, see [gRPC](API-INTEGRATION.md#from-a-grpc-service)). |
| `grpc` | none | For `type: grpc`: `{ "address": "host:port", "tls": true, "includeDirs": [], "services": [], "maxStreamMessages": 100 }`. `services` limits the import to these fully-qualified services. |
| `spec` | required | Path or URL of an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML), or a `.txt` / `.endpoints` endpoint list. |
| `baseUrl` | the spec's first server | Required when the spec has none. Toolsmith never guesses it. |
| `auth` | `{ "type": "none" }` | `bearer` (`token`), `apiKey` (`in`: `header`/`query`, `name`, `value`), `basic` (`username`, `password`), or `oauth2ClientCredentials` (`tokenUrl`, `clientId`, `clientSecret`, optional `scope`, `audience`). |
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

### `database` (several gateway nodes)

```json
"database": { "url": "${env:DATABASE_URL}", "poolSize": 10 }
```

| Field | Default | Meaning |
|---|---|---|
| `url` | none | A `postgres://` URL. When set, PostgreSQL replaces the SQLite file in `dataDir`. Put it in the environment, and add `?sslmode=require` (or stricter) for a remote server. |
| `poolSize` | `10` | Connections per gateway node. |

With PostgreSQL, every node shares the registry, traces, approvals and audit
log: a tool published or **disabled** through one node's dashboard reaches
all of them within about 1.5 s (each node polls a revision counter that
commits together with the change, so it is never missed), traffic through every node feeds workflow discovery, and
a per-call approval is spent exactly once, whichever nodes the retries land
on. The schema is created on first start (nodes starting together take
turns). Some state stays in each node's memory:

- **Rate limits** (`server.rateLimit` and the per-client limits) count per
  node, so N nodes allow up to N times the configured rate.
- **In-client approval prompts.** An answer that reaches a different node
  than the one that asked falls back to the dashboard approval flow. Use
  sticky sessions if you rely on in-client approvals.
- The cap on open composite proposals, enforced by each node for itself.
- The OAuth key cache and gRPC channels, which need no coordination.

If a disabled tool must stop everywhere at once, also stop the nodes' traffic
to it upstream (revoke its credentials), since a node may serve it for up to
the poll interval.

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

When `true`, agents also see two meta tools:
- `toolsmith__request_capability`, to describe a need no tool covers;
- `toolsmith__search_tools`, to find tools by description.

### `exposure` (and `server.clients[].exposure`)

Which tools a client sees and may call. Set it at the top level, or per
client to override.

| Field | Default | Meaning |
|---|---|---|
| `tools` | `[]` | Allow-list of glob patterns, for example `["shop__get*", "flow__*"]`. Empty means every published tool. **Enforced on calls, not just on listing.** A composite is allowed only if every tool it calls is allowed. |
| `list` | `all` | `search` keeps `tools/list` short for large catalogs: only meta tools and `pinned` patterns are listed, and the agent finds the rest with `toolsmith__search_tools` and calls them directly. |
| `pinned` | `[]` | Patterns always listed in `search` mode. |

### `approvals`

| Field | Default | Meaning |
|---|---|---|
| `inClient` | `false` | Ask for per-call approval of destructive operations inside the MCP client (elicitation), when the client supports it. The client app shows the prompt, so you trust it to put the prompt in front of a person. A declined prompt falls back to the dashboard flow. |

### `telemetry`

| Field | Default | Meaning |
|---|---|---|
| `otlpEndpoint` | none | OTLP/HTTP collector base URL, for example `http://localhost:4318`. Spans go to `/v1/traces`. Export is off when this is unset. |
| `headers` | `{}` | Headers for the collector, for example an API key. `${env:...}` is allowed. |
| `serviceName` | `toolsmith-mcp` | The `service.name` resource attribute. |
| `exportArguments` | `false` | Also export redacted tool arguments. Results are never exported. |

### `llm`

The optional LLM stage, **off by default**. Enabling it sends documentation
text (for `docs` integrations), or tool names and descriptions plus the
request (for the capability fallback), to Anthropic. Credentials come from
`ANTHROPIC_API_KEY` or an `ant auth login` profile, never from this file.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn the stage on. |
| `model` | `claude-opus-5-5` | Model id. |
| `effort` | `medium` | `low`, `medium` or `high`. |
| `capabilityFallback` | `true` | When keyword matching finds nothing for a capability request, ask the model which existing tools fit. Names it invents are dropped. |

## Environment variables

| Variable | Used by |
|---|---|
| `TOOLSMITH_MCP_TOKEN`, `TOOLSMITH_ADMIN_TOKEN` | Generated by `init` and referenced from `server` |
| Anything you reference with `${env:NAME}` | Credentials and headers |
| `NO_COLOR` | Disables colored CLI output |
