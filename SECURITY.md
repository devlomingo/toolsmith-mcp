# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on
<https://github.com/devlomingo/toolsmith-mcp/security/advisories/new>.

Include:

- the affected version or commit;
- what an attacker can do;
- steps or a proof of concept.

You will get an acknowledgement within 7 days. Fixes for confirmed issues
are released as soon as they are ready and credited unless you prefer
otherwise.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Scope

These are especially in scope:

- SSRF or other ways to reach hosts outside an integration's allow-list;
- credentials or tool results leaking into traces, logs, the dashboard, or
  the agent;
- an agent or automated actor getting a tool approved, published, or
  granted write or destructive access without a human;
- destructive calls running without their per-call approval;
- execution of generated content as code;
- dashboard XSS through spec content.

The threat model is in [docs/SECURITY.md](docs/SECURITY.md).
