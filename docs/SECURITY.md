# Security model

This page describes what toolsmith-mcp protects, from whom, and how. To
report a vulnerability, see [../SECURITY.md](../SECURITY.md).

## Assets and trust boundaries

| Asset | Where it lives | Who must not get it |
|---|---|---|
| API credentials | Environment variables (or `.env`), referenced in config as `${env:NAME}` | The agent, the traces, the logs, the dashboard, the database |
| Data returned by APIs | Passed through to the agent, never stored | The trace store, other agents |
| The right to call write/destructive operations | Grants recorded at human approval | Agents, the miner, the evaluator, any automated actor |
| Gateway and admin access | `server.mcpToken`, `server.adminToken` | Other local processes, websites in the user's browser, the network |

Trust boundaries:

- **Agent → gateway.** The agent is trusted only to call tools it can see.
  It may be manipulated through prompt injection.
- **Third-party spec → gateway.** Descriptions and schemas are untrusted
  input.
- **Gateway → API.** The gateway decides where requests go. Arguments never
  do.
- **Human admin → registry.** Only humans approve.

## Threats and controls

| Threat | Control | Verified by |
|---|---|---|
| SSRF through a base URL or arguments | Per-integration host allow-list. Path parameters are percent-encoded (`..` refused) and checked against the base origin. DNS is resolved inside the socket's own lookup and private, loopback, link-local and metadata ranges (v4, v6, mapped, NAT64) are refused unless `allowPrivateNetwork` is set. Redirects are never followed. Credentials in URLs and non-http(s) schemes are refused | `test/security/security.test.ts` (SSRF block) |
| DNS rebinding against the gateway | On a loopback bind, requests are accepted only for localhost `Host` headers; cross-origin browser requests to `/mcp` and `/api` are refused | security tests: admin and MCP endpoints |
| Header injection | CR/LF in header parameters is refused | security tests |
| Credential leakage to the agent, traces or logs | Credentials are resolved only when a request is sent. Resolved secrets are registered with the redactor and removed by exact match from every stored string and error. Sensitive keys and secret-shaped values (Bearer, JWT, AWS, GitHub, Slack, Stripe, private keys, Luhn-valid card numbers, emails) are redacted. Descriptions never contain credentials | security tests: "secrets never reach…" (including an API that echoes the token back) |
| Personal data in traces | Results are never stored, only keyed fingerprints. Arguments are stored redacted, or not at all (`captureArguments: "none"`). Retention is applied at startup (`retentionDays`) | security tests: redaction and fingerprints |
| Tool poisoning through spec descriptions | Instruction-like text (ignore previous instructions, `<IMPORTANT>`, exfiltration phrasing) is flagged as an error finding, and evaluation then fails, so it cannot be approved. Approval is a human reviewing the descriptions anyway | security tests: tool poisoning |
| Unauthorized writes | Write and destructive operations stay hidden until a human grants them at approval | `scenarios.test.ts` scenario 13 |
| Destructive actions by a manipulated agent | Each destructive call needs a per-call human approval, bound to the exact arguments by hash and usable once | scenario 13 |
| Privilege escalation through composites | A composite is exposed only while every step tool is exposed, and each step runs through the same policy path. Composite access is the maximum of its steps' access | scenario 13 |
| Running generated code | Nothing generated is executed as code. OpenAPI tools and composites are data interpreted by fixed code ([ADR 0004](adr/0004-no-generated-code.md)) | design; `src/composite/refs.ts` has no `eval` |
| Resource exhaustion | Token-bucket rate limit per integration, request timeout, 5 MB response cap, 10 MB spec cap, 1 MB admin body cap, 4 MiB MCP body cap (SDK), composite limits on steps, fan-out, concurrency and total time | unit tests (fan-out cap, concurrency) and scenario 5 |
| An automated actor approving its own proposals | Approval requires a `human:*` actor; the registry refuses others. Evaluation failure blocks approval | unit tests: registry lifecycle |
| An exposed gateway | Binds to 127.0.0.1 by default. Binding elsewhere refuses to start without an MCP token. Tokens are compared in constant time. The admin API uses a separate token | security tests |
| XSS in the dashboard from third-party descriptions | All values are rendered as text nodes. Strict CSP (`default-src 'self'`). No inline scripts | `dashboard/app.js` (DOM builder) |
| Token passthrough | The gateway never forwards the client's bearer token upstream. Upstream credentials are the gateway's own | `src/upstream/upstream-manager.ts` |
| Vulnerable dependencies | Small runtime dependency set. CI runs `npm audit --omit=dev --audit-level=high` and CodeQL | `.github/workflows/` |

## What is not protected

- **The local machine.** Anyone with shell access as the same user can read
  `.env` and the database. Use OS file permissions; `init` creates `.env`
  with mode 600.
- **The agent's judgment within granted permissions.** If a human grants
  write access, the agent can write anything the API's credentials allow.
  Toolsmith cannot narrow an API's own authorization model. Use credentials
  with the least privilege the task needs.
- **Upstream MCP servers.** They are trusted by configuration. Their tools
  pass through, their annotations are hints, and they are not
  sandboxed by toolsmith.
- **Prompt injection in API responses.** Data returned to the agent may
  contain instructions. Toolsmith does not rewrite response content.
- **Multi-tenant isolation.** One gateway serves one trust domain. Several
  agents behind one gateway share its published tools.
