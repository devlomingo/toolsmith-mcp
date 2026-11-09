# Turning an API into tools

## From an OpenAPI or Swagger spec

```sh
toolsmith-mcp import ./openapi.yaml --name shop --token-env SHOP_TOKEN
toolsmith-mcp import https://api.example.com/openapi.json --name example
toolsmith-mcp import ./spec.json --name local --base-url http://localhost:8080 --allow-private-network
```

`import` adds the integration to `toolsmith.config.json` and then, in order:

1. **Parses and validates** the document: OpenAPI 3.0/3.1 or Swagger 2.0,
   JSON or YAML. Local `$ref`s are resolved. External `$ref`s are **not**
   followed, so bundle the spec first if it needs them.
2. **Generates one tool per operation**:
   - **Name:** from the `operationId`, camelCased. If there is none, it is
     built from the method and path: `GET /users/{id}/orders` →
     `getUserOrders`.
   - **Description:** from the summary and description, plus the method and
     path, plus hints on where to get required parameter values.
   - **Input schema:** path, query, header and cookie parameters, plus
     `body` for JSON request bodies. It is strict: unknown arguments are
     rejected.
   - **Output schema:** from the first 2xx JSON response. Non-object
     responses are wrapped as `{ "result": … }`.
   - **Access level:** GET/HEAD/OPTIONS are `read`, POST/PUT/PATCH are
     `write`, DELETE is `destructive`.
3. **Records findings** for anything missing or suspicious:
   - no `operationId`, no description, no response schema;
   - unsupported body types;
   - instruction-like text in descriptions (an *error*: see
     [SECURITY.md](SECURITY.md)).
4. **Evaluates the result**:
   - tool names and schemas;
   - egress policy and credentials;
   - **live verification** of every read operation. Required parameter
     values come from spec examples, or live from another endpoint that
     returns them (`orderId` ← `listOrders[*].id`). Each operation is
     classified as `verified`, `no_parameter_value`,
     `wrong_parameter_value`, `auth_failed`, `http_error`,
     `error_shaped_response`, `schema_mismatch` or `network_error`.

     **Write operations are never called.** Pass `--no-live` to skip
     verification.
5. Leaves the version **awaiting approval**.

Review with `toolsmith-mcp show shop`, then approve:

```sh
toolsmith-mcp approve shop                                       # read-only tools
toolsmith-mcp approve shop --allow-writes                        # also POST/PUT/PATCH
toolsmith-mcp approve shop --allow-writes --allow-destructive    # also DELETE (each call still needs approval)
```

### What Toolsmith will not do

- **Invent endpoints.** A spec without paths, or without any server URL
  and no `--base-url`, is rejected with a message asking for the missing
  information.
- **Guess an API from a bare URL.** You need a spec or an endpoint list.
- **Read free-text HTML documentation.** That needs an LLM extraction step,
  which is on the [roadmap](ROADMAP.md).

## From a list of endpoints

When there is no spec, write one line per endpoint:

```text
# shop.endpoints
GET    /products               List products
GET    /products/{id}          Get one product
GET    /users/:userId/orders   A customer's orders
POST   /products               Create a product
```

```sh
toolsmith-mcp import ./shop.endpoints --name shop --base-url https://api.shop.example.com
```

- `{p}`, `:p` and `<p>` path parameters are all accepted.
- Query parameters can be listed as `GET /search?q&limit`.
- Bodies are untyped objects.
- These tools are weaker than spec-based ones: no types, no output schema.

## From a Postman collection

Export the collection (v2.0 or v2.1) and import the JSON file like a spec:

```sh
toolsmith-mcp import ./shop.postman_collection.json --name shop
```

- Folders are flattened.
- `{{variables}}` are resolved from the collection's variables.
- `:param` and `{{param}}` path segments become path parameters.
- Request bodies and response shapes are inferred from the collection's
  raw JSON bodies and saved example responses. A finding reminds you to
  review them.

## From a GraphQL API

```json
{ "name": "gql", "type": "graphql", "spec": "https://api.example.com/graphql", "auth": { "type": "bearer", "token": "${env:GQL_TOKEN}" } }
```

Toolsmith introspects the endpoint through the same guarded HTTP client as
everything else, or reads a saved introspection JSON, then:

- every **query** field becomes a read tool;
- every **mutation** field becomes a write tool, or a destructive one when
  its name starts with delete, remove, destroy, purge or drop;
- arguments become a typed input schema, with enums and input objects;
- a selection set is generated: scalars plus one nested level;
- arguments are sent as GraphQL **variables**, never spliced into the
  document;
- GraphQL `errors` come back as readable tool errors.

## From a gRPC service

```json
{
  "name": "orders",
  "type": "grpc",
  "spec": "protos/orders.proto",
  "grpc": { "address": "orders.internal.example.com:443", "includeDirs": ["protos"] },
  "auth": { "type": "bearer", "token": "${env:ORDERS_TOKEN}" }
}
```

`spec` is one or more `.proto` files (comma-separated; imports resolve
against `includeDirs` and each file's folder, like `protoc -I`), or
`"reflection"` to read the service definitions from the server's
reflection API (v1, with a v1alpha fallback). Then:

- every **unary** and **server-streaming** method becomes a tool, filtered
  by `include` / `exclude` (globs on the tool name, the method name or
  `/package.Service/Method`). A streamed reply comes back as
  `{ "items": [...], "truncated": bool }`, with at most
  `grpc.maxStreamMessages` items (default 100) and 5 MB in total. A stream
  still open at the timeout (a `Watch…` method) returns what arrived so far,
  with `truncated: true`; one that sent nothing by then is a timeout error. Client and bidirectional streaming are skipped and
  listed as findings;
- arguments and results use the **ProtoJSON** mapping: lowerCamelCase field
  names, 64-bit integers as strings (numbers are accepted), enums by name
  (or number, for values newer than the descriptor),
  `bytes` as base64, `Timestamp` as RFC 3339, `Duration` as `"1.5s"`, maps
  as objects; wrapper results such as `StringValue` come back as the bare
  value. The tool schemas say exactly this;
- **access level** errs towards caution. A name containing a delete-type
  word (`Delete`, `Remove`, `Purge`, `Cancel`, …) is destructive, even if the
  proto says `NO_SIDE_EFFECTS`. A read needs `option idempotency_level =
  NO_SIDE_EFFECTS`, or a read verb first (`Get`, `List`, `Search`, `Watch`,
  `BatchGet`, …; `Batch…` and `Stream…` alone are not enough) and no mutating word anywhere (`CheckAndMutateRow`, `FindOrCreate` and
  `GetAndDelete` are not reads). Everything else is a write. Reads are
  visible without a grant and are probed during import, so check the list
  before approving;
- status codes map to the same tool errors as HTTP (`NOT_FOUND` → not
  found, `UNAUTHENTICATED` → auth, `UNAVAILABLE` → network, …). Only reads
  are retried, and only on `UNAVAILABLE`;
- **TLS is on** by default; `"tls": false` is allowed, but never with
  credentials to a host other than loopback. Auth is sent as metadata
  (`bearer`, `basic`, or a header `apiKey`). The address goes through the
  same egress rules as HTTP: it is resolved once, private addresses need
  `allowPrivateNetwork`, and the channel connects to the checked address
  while TLS still verifies the certificate for the host name;
- live verification probes read methods with an empty request. Proto3 has
  no required fields, so methods that need an id usually report
  `http_error` there. That is a warning, not a failure.

## From free-text documentation (optional LLM stage)

With `"llm": { "enabled": true }` and an integration of `"type": "docs"`,
Toolsmith sends the documentation (HTML, Markdown or text) to the model.
The model extracts endpoints into a fixed schema, as ToolFactory does. The
result is then imported like any spec:
- every read operation is verified with a live call;
- nothing is published until you approve it;
- a finding marks the integration as LLM-extracted.

Documentation larger than 400,000 characters is refused, not truncated.

## Authentication

| Type | Flags | Config |
|---|---|---|
| Bearer | `--token-env NAME` | `{ "type": "bearer", "token": "${env:NAME}" }` |
| API key | `--api-key-env NAME [--api-key-header X-API-Key]` | `{ "type": "apiKey", "in": "header", "name": "X-API-Key", "value": "${env:NAME}" }` |
| Basic | (config only) | `{ "type": "basic", "username": "${env:U}", "password": "${env:P}" }` |
| OAuth 2.0 client credentials | (config only) | `{ "type": "oauth2ClientCredentials", "tokenUrl": "https://auth.example.com/token", "clientId": "${env:ID}", "clientSecret": "${env:SECRET}", "scope": "read" }` |

For OAuth:
- The token is fetched through the same guarded client and cached until a
  minute before it expires.
- After a 401 it is refreshed once and the request retried; that's safe,
  because the API rejected the request.
- The client secret and the access tokens are scrubbed like any other
  secret.

Credentials are read from the environment when a request is sent, never
stored, and redacted wherever they could appear. A 401 is reported as "the
API rejected the credentials, check `NAME`". The same applies to expired
tokens.

## Updating and rolling back

Re-running `import` with the same `--name` on a changed spec creates a new
version. If the content is identical, nothing changes. The
published version stays live until you approve the new one.

```sh
toolsmith-mcp rollback shop        # republish the previous approved version
toolsmith-mcp rollback shop@1      # a specific one
toolsmith-mcp disable shop         # hide all of its tools now
toolsmith-mcp enable shop
```
