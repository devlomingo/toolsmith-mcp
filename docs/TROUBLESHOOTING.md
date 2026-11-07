# Troubleshooting

Run `toolsmith-mcp doctor` first. It checks the Node version, config,
tokens, imported integrations and upstream connections, and says what to
fix.

| Symptom | Cause and fix |
|---|---|
| `Environment variable X is not set` | A `${env:X}` reference has no value. Add `X=...` to `.env` next to the config, or export it. |
| `The spec does not say where the API is hosted` | No `servers` (OpenAPI 3) or `host` (Swagger 2). Pass `--base-url https://…`. |
| `Blocked request: … private address` | The API is on localhost or a private network. If that is intended, set `"allowPrivateNetwork": true` for that integration only. |
| `The API rejected the credentials (401)…` | Token missing, wrong or expired. Update the named environment variable and restart. |
| `… does not match its documented schema` | The API returns something its spec doesn't describe. Fix the spec, or set `"validateOutput": false` for that integration. |
| Evaluation `failed` | `toolsmith-mcp show <name>` lists the failing checks. A failed version cannot be approved. Fix the cause and run `toolsmith-mcp evaluate <name>`. |
| Composite fails with "no example input" | Run `toolsmith-mcp evaluate <name> --input '{"userId": 1}'` with a real value. |
| A tool isn't visible to the agent | It is not published, or it is a write/destructive operation that wasn't granted (`approve --allow-writes`). `toolsmith-mcp list` shows the status; the dashboard **Overview** lists catalog problems. |
| A composite disappeared | One of its step tools was disabled or lost its grant. Or it writes data and was approved without `--allow-writes`. `toolsmith-mcp list` shows the reason under catalog problems. |
| Every call to an upstream tool needs approval | The server doesn't annotate its tools, so they count as destructive. Add read-only tools to `trustedTools`, or set `"approval": "none"` for a server you fully trust. |
| `This action grants access and needs a person at an interactive terminal` | `approve`, `approve-call`, `publish`, `enable` and `rollback` ask you to type `yes`. They don't run from scripts or agents. Use the dashboard for remote or scripted approval. |
| `approval_required` on every call | The tool is destructive. Approve each call with `toolsmith-mcp approve-call <id>`; approvals are single-use and bound to the exact arguments. |
| No workflows found | Fewer than `minSupport` (3) sessions ran it, or calls aren't linked by data flow. Over HTTP, send `X-Toolsmith-Session` so one agent's calls group together. |
| `Refusing to serve MCP over HTTP … without a client token` | HTTP serving always needs a token, even on loopback, because the token is the client's identity for approvals. Run `toolsmith-mcp init` or set `server.mcpToken`. |
| Dashboard says the token was not accepted | Use `TOOLSMITH_ADMIN_TOKEN`, not the MCP token. `start` prints a sign-in link. |
| HTTP 403 from `/mcp` in a browser | Cross-origin requests are refused on purpose. Use an MCP client. |
| Upstream server `not connected` | Check its command or URL; `doctor` prints the error. Toolsmith keeps serving everything else. |
