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

## Authentication

| Type | Flags | Config |
|---|---|---|
| Bearer | `--token-env NAME` | `{ "type": "bearer", "token": "${env:NAME}" }` |
| API key | `--api-key-env NAME [--api-key-header X-API-Key]` | `{ "type": "apiKey", "in": "header", "name": "X-API-Key", "value": "${env:NAME}" }` |
| Basic | (config only) | `{ "type": "basic", "username": "${env:U}", "password": "${env:P}" }` |

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
