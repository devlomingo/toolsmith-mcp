# Final validation report (round 2): toolsmith-mcp

- **Date:** 2026-11-08 (+03)
- **Commit validated:** `04aff6b` (`git rev-parse --short HEAD`), branch
  `main`, clean tree. Fixes for round 1 are in `50a43bc`; `04aff6b`
  regenerates benchmark results.
- **Validator:** independent QA/security pass. Every result below comes from
  a command I ran. Anything I did not run is marked NOT RUN.

## Environment

| Item | Value |
|---|---|
| OS | macOS 27.2 (Darwin 27.2.0), Apple M1 Pro |
| Node / npm | v22.13.1 / 10.9.2 |
| Docker | installed, daemon **not running** ("Cannot connect to the Docker daemon") |
| actionlint | 1.7.7 (release binary downloaded to a temp dir); shellcheck not installed, so `run:` scripts were not shellchecked |
| GitHub repo | `devlomingo/toolsmith-mcp` does not exist ("Could not resolve to a Repository") |
| Network | loopback mock APIs only; no public spec fetched |

Scratch work stayed outside the repo:

- a `git archive HEAD` copy for `npm ci` and the checks;
- an `npm pack` tarball installed with `npm i -g --prefix <tmp>`;
- temp workspaces;
- mock servers: the demo shop with token, expired token, injected 500s and a
  hanging path; an echo API; an "internal" listener;
- an upstream stdio MCP server;
- my own MCP client scripts, written against `@modelcontextprotocol/client`
  2.4.0.

The only file written in the repo is this report.

## Verdict

**Release after fixing listed items.** Both Criticals are fixed. So are
M2, M3, M5, M6 and M8. M7 stays NOT RUN until the repository is published.
Two round-1 Majors are only partly fixed, and testing the fixes turned up
new Major issues:

- **M1 (partly fixed).** A Basic-auth credential echoed in a 200 response
  still reaches the agent (N1).
- **Session binding (partly fixed).** Approvals are bound to "the session",
  but over Streamable HTTP the session key is either the shared constant
  `http:anonymous` (every 2025-11-25 client) or a client-chosen name.
  Binding is ineffective there, and workflow discovery stops working for
  2025-11-25 HTTP clients (N2).
- **M4 (partly fixed).** The interactive-terminal check can be bypassed in
  one line with `script`. The CLI message and the website still say agents
  cannot approve their own requests (N3).
- **Install path.** The documented global install from git fails during the
  git-dependency `prepare` step in a local simulation (N4).

Each item above has a contained fix (see each finding). None is a design
flaw on the scale of C1/C2.

## Requirement areas

| Area | Result | Notes |
|---|---|---|
| lint / format:check / typecheck / build | PASS | clean copy, all exit 0 |
| `npm test` | PASS | 7 files, 91/91 tests |
| `npm audit --omit=dev` | PASS | 0 vulnerabilities (full tree: moderate `minimatch` via eslint, dev only) |
| Install from `npm pack` into temp prefix | PASS | installed `dist` identical to the clean build (`diff -r`) |
| Documented `npm install -g github:devlomingo/toolsmith-mcp` | NOT RUN | repo not published. Simulation with `git+file://…#04aff6b -g` **failed** (N4) |
| demo / init / import / approve / start / client-config / doctor / discover / usage | PASS with issues | see N3, n1, n2; approve refuses without a TTY |
| MCP 2025-11-25 over Streamable HTTP | PASS (list/call/errors) | `list_changed` still never delivered (m3); session key collapses to `http:anonymous` (N2) |
| MCP 2026-07-28 over Streamable HTTP | PASS | `list_changed` delivered (2 events) |
| MCP both versions over stdio | PASS | negotiated correctly; `list_changed` 2 events each, triggered from another process |
| API integration generation (OpenAPI 3, Swagger 2, `.endpoints`, incomplete docs) | PASS | |
| Composite generation and execution (parallel, forEach, partial, write ordering) | PASS | |
| SSRF | PASS | C1 fixed and verified end to end; spec-URL fetch still unguarded (m1, minor) |
| Secrets never exposed | **FAIL** | Bearer/API-key/upstream env echoes are scrubbed; a Basic credential echo is not (N1) |
| Read vs write | PASS with caveat | API tools and composites PASS; upstream write-annotated tools are exposed without a grant (documented in SECURITY.md, overclaimed in README and site: n10) |
| Destructive needs explicit approval | PARTIAL | the gate works for API, upstream and composite steps; approver identity is weak (N3); session binding is weak over HTTP (N2) |
| No generated code executed | PASS | no `eval` / `new Function` / `vm` / `child_process` in `src`, `dashboard`, `site/build.mjs` |
| No privilege escalation via composites | PASS | write composite hidden without `--allow-writes`; steps go through the dispatcher |
| Rate limits, timeouts, input/output validation | PASS | timeout no longer retried (15.0 s); 429 surfaced after `Retry-After` retries |
| Audit logging | PASS | CLI and admin actions recorded with `human:*` actor |
| Admin API auth / Origin / Host / CSP / traversal | PASS | 401 / 401 / 403 / 403 / CSP set / 404 |
| 14 required scenarios | PASS | 1–14 reproduced by hand (table below) plus the suite |
| Benchmarks reproducible, not fabricated | PASS | my runs reproduce the committed numbers within a few %; README, REPORT.md and site match the JSON |
| No conflation of MCP calls / LLM requests / API requests; no token claims | PASS | reported separately; "LLM tokens and requests were not measured" |
| Docs match behaviour | **FAIL** (minor-to-major wording) | N2, N3, n8, n10 |
| CI workflows | PASS with caveat | actionlint clean (exit 0); format:check passes now; benchmark gate is flaky (n3) |
| Docker image | NOT RUN | daemon not running |
| Website build / links | PASS | `Built site/dist (30 KB HTML)`, `Link check passed (22 external links not fetched)` |

## Round-1 findings: new status

| # | Status | Evidence |
|---|---|---|
| C1 SSRF via IPv4-mapped IPv6 | **fixed** | `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::127.0.0.1]`, `[0:0:0:0:0:ffff:7f00:1]` import → `✗ egress policy — ::ffff:7f00:1 is a private/loopback address`; internal listener got 0 hits. Fuzz of 40 spellings through `new URL()`: all private ones are classified private (one informational gap: n6) |
| C2 `discover` closes DB mid-run | **fixed** | `discover` completed: `flow__updateProductFlow awaiting_approval`; the read composite was evaluated (it failed correctly on an injected 500, then passed with `--input`). No "database is not open" |
| M1 echoed credential on success | **partially fixed** | Bearer echo → `"Bearer [REDACTED_SECRET]"`, key-position echo scrubbed, upstream env secret → `secret=[REDACTED_SECRET]`. **Basic** auth echo → `"Basic ZWNob3VzZXI6ZWNoby1QQVNTLTU1NTU1"` returned to the agent (N1). Encoded and transformed echoes (base64, upper-case, split) pass, as the exact-match design implies |
| M2 upstream tools bypass approval | **fixed** | stdio upstream: `wipe_disk` (destructive) and `mystery` (unannotated) → `approval_required`. After a human `approve-call`, it ran once; the replay asked again. `trustedTools` and `approval:"none"` opt-outs work. Write-annotated upstream tools run without a grant (n10) |
| M3 composite grant ignored | **fixed** | `approve flow-update-product-flow` (no flag) → overview problem `hidden: it performs write operations but was approved without --allow-writes`. With `--allow-writes` it was exposed. Plan has `after:["getProduct"]`. Execution returned pre-update `stock 13` from getProduct and `99` from updateProduct. Named `flow__updateProductFlow` |
| M4 agent self-approval via CLI | **partially fixed** | Without a TTY, `approve`, `approve --yes`, `publish`, `enable`, `rollback` and `approve-call` all refuse. But `(sleep 2; printf 'yes\n') \| script -q /dev/null toolsmith-mcp approve shop --allow-writes --allow-destructive` (run by me, a non-interactive agent) → `shop v2 is published` with WRITE + DESTRUCTIVE (N3) |
| M5 CI `format:check` fails | **fixed** | `All matched files use Prettier code style!`; actionlint exit 0 |
| M6 `usage` unknown | **fixed** | `usage` prints the table (2 composites, round-trips saved 14 / 1) |
| M7 install path / repo missing | **not fixed (NOT RUN, pending publication)** | `gh repo view` → not found. Global git install simulation fails (N4) |
| M8 admin token printed | **fixed** | non-TTY `start` → `Dashboard: http://127.0.0.1:7450/dashboard/  (sign in with TOOLSMITH_ADMIN_TOKEN)`; `grep -c qa-admin` on the log = 0 |
| m1 spec URL fetch unguarded | not fixed | `import http://127.0.0.1:7442/latest/meta-data/iam` (no flag) → `INTERNAL HIT GET /latest/meta-data/iam` |
| m2 timeouts retried 3× | fixed | `[15017 ms] The API did not respond within 15000 ms` |
| m3 no `list_changed` on HTTP 2025-11-25 | not fixed | legacy HTTP client: `list_changed events 0`; 2026: 2 |
| m4 approval not session-bound | partially fixed | bound in code, but see N2 |
| m5 failed import leaves config | fixed (throw path) | non-spec / missing file → config restored (`grep -c '"bad"'` = 0). An egress-failed evaluation keeps the entry, but `doctor` now says "All good" |
| m6 `--endpoints` hint | fixed | hint now describes `.endpoints` files |
| m7 `files` lists missing `examples` | fixed | `files`: dist, dashboard, benchmarks/results/latest.json, README, LICENSE |
| m8 dashboard benchmarks empty | fixed | `GET /api/benchmarks` on demo returns the shipped results (not in Docker image: n7) |
| m9 evaluator perf skewed by rate limiter | fixed (not reproduced) | `server-side 12.1 ms vs 52 ms sequential` |
| m10 noise-level margins | partially fixed | README now says "same within run-to-run noise", and "gains 3–7%" is correct. Site says "same within noise (this run: +5% to +14%…)", which is self-contradictory at 14% |
| m11 benchmark outside git | not fixed | `fatal: Needed a single revision` on stderr, commit null |
| m12 misleading `ask` | not fixed | `ask "delete a product"` → `needs_approval … Closest available tool: shop__getProducts`, though `shop__deleteProduct` was published |
| m13 `grantNow` unused | not fixed | `src/gateway/approvals.ts:91`, no callers |
| m14 demo temp dir kept | not fixed | `toolsmith-demo-n2o7Sc` still exists after SIGINT |
| m15 RSS unlabeled | not fixed | REPORT.md scalability "RSS MB" column, no note |
| m16 unlimited proposals | not fixed | no cap in `src/discovery/discovery.ts` / `request_capability` |

## New findings

### Major

**N1. A Basic-auth credential echoed in a successful response reaches the
agent.**

The success path uses `Redactor.scrubSecrets`
(`src/openapi/http-executor.ts:99`), which matches registered secrets
exactly. For Basic auth, only the username and password are registered
(`http-executor.ts:175-195`). The header value the API sees, and may echo,
is their base64 form, which is never registered.

The error path catches it through the `Basic …` pattern
(`src/security/redact.ts:9`); the success path does not. The value also
lands in the trace DB when it appears as an object key in the response: a
`result_fingerprints` path is stored verbatim (n4).

This contradicts `docs/SECURITY.md:32` ("Credentials … are scrubbed … from
every tool result") and the site's "redacted everywhere".

Repro:

1. Integration with `auth: {type:"basic", username:"${env:ECHO_USER}", password:"${env:ECHO_PASS}"}` and an API
   whose `GET /echo` returns `{"token": <Authorization header>}`.
2. Approve it and call `echob__echo` over MCP.
3. The result is `{"token":"Basic ZWNob3VzZXI6ZWNoby1QQVNTLTU1NTU1"}`, which
   is `echouser:echo-PASS-55555`.

Fix: register the full computed header value, and the bare base64 value,
as secrets in `applyAuth`. Consider applying the value patterns to success
bodies for `Authorization`-shaped strings.

**N2. Session-bound approvals, and workflow discovery, do not work over
Streamable HTTP as documented.**

`src/server/mcp.ts:84-92` derives the session key in this order:

1. `X-Toolsmith-Session` / `Mcp-Session-Id` header;
2. OAuth client id;
3. `clientInfo.name`;
4. otherwise `'anonymous'`.

Under 2025-11-25 the server is stateless: it issues no `Mcp-Session-Id`,
and `getClientVersion()` is empty on the per-request server. So every HTTP
client without the custom header gets `http:anonymous`. Under 2026-07-28
the key is the client's self-reported name: identical for two instances of
the same client, and choosable by any client.

Consequences, all reproduced:

- An approval granted to agent A was **consumed by agent B** under
  2025-11-25. `/api/call-approvals` shows `5afa9980 … used http:anonymous`,
  and agent-b's call returned `{"deleted": 5}`.
- Under 2026-07-28, a *new* connection reporting `clientInfo.name =
  "agent-a"` consumed agent-a's approval (`{"deleted": 6}`).
- 8 default (2025-11-25) HTTP agent sessions of two workflows produced
  **no patterns**: `patterns` → "No repeated workflows yet". The same
  sessions under 2026-07-28 produced both patterns (support 4).

Docs affected:

- `README.md:42` and `docs/SECURITY.md:36` say approvals are "bound to …
  [the] session".
- `docs/MCP-INTEGRATION.md:50-58` says grouping falls back to the client's
  name, which never happens under 2025-11-25.
- README says the miner is "perfect … on agents sharing a session"; true
  synthetically, but not for back-to-back sessions under one key.

Stdio is unaffected (a random per-process key).

Fix:

- Issue real `Mcp-Session-Id`s for 2025-11-25 HTTP, or derive the key from
  the authenticated principal (per-agent MCP tokens).
- Document that HTTP binding is advisory.
- Have `client-config` emit an `X-Toolsmith-Session` header.

**N3. The interactive-terminal gate for granting commands is bypassed by a
non-interactive process in one line, while the product tells users and
agents it cannot be.**

`confirmHuman` (`src/cli/index.ts:259-275`) only checks `isTTY`. As a
non-interactive agent, I ran:

```
(sleep 2; printf 'yes\n') | script -q /dev/null toolsmith-mcp approve shop --allow-writes --allow-destructive
→ ✓ shop v2 is published.  Agents now see 11 tool(s): … shop__deleteProduct …
(sleep 2; printf 'yes\n') | script -q /dev/null toolsmith-mcp approve-call ad1778a6
→ ✓ approved call ad1778a6 to up__wipe_disk
```

`docs/SECURITY.md` ("What is not protected") does say the check "stops it
from casually approving itself". These say otherwise:

- the refusal message: "Agents cannot approve their own requests";
- `docs/MCP-INTEGRATION.md:86-89`: "so an agent cannot approve its own
  request";
- `docs/SECURITY.md:39`: "so an agent running shell commands cannot
  approve its own requests";
- the site: "Approvals only by a person".

Fix: correct those claims to match the limitation already stated in
SECURITY.md. Optionally require the admin token, or an OS-level prompt, for
CLI grants. The real boundary is running agents without access to the
toolsmith directory, which SECURITY.md already recommends.

**N4. The documented global install from git fails during git-dependency
preparation (simulated).**

The run:

```
npm_config_prefix=<tmp> npm i -g "git+file://$HOME/toolsmith-mcp#04aff6b"
→ npm error git dep preparation failed … > tsc -p tsconfig.build.json … sh: tsc: command not found   (exit 127)
```

The same happens with `--prefix <tmp>`. The child `npm install` ran
`prepare` without installing any dependencies; it appears to inherit the
global flag. A non-global `npm i git+file://…` and `npm pack git+file://…`
both succeed and build `dist`.

This simulates `npm install -g github:devlomingo/toolsmith-mcp`
(`README.md:22`, `docs/INSTALLATION.md:11`, site) through the same pacote
git path. I could not run the real `github:` URL, because the repo does not
exist. It must be re-verified at publication. If it reproduces:

- publish to the npm registry; or
- install from a release tarball URL; or
- ship a prebuilt `dist` on a release tag.

### Minor

| # | Finding | Repro / location |
|---|---|---|
| n1 | Unreachable spec URL prints a raw stack trace and "Please report this" | `import http://127.0.0.1:7999/openapi.json --name down` → `Unexpected error: TypeError: fetch failed …` (`src/openapi/import.ts:34`) |
| n2 | Approving a write composite without `--allow-writes` prompts "(composite, read-only access)" and reports "published", but the tool stays hidden; the CLI prints no warning | `src/cli/index.ts:149`, `describeGrant` at `:277` |
| n3 | CI benchmark gate is flaky: `dependent-chain @25ms` composite vs sequential differ by only ~5%; my first `--quick` run failed `benchmark:check` (`composite p50 slower than sequential`, 90 vs 88.22 ms), and the next 5 runs passed | `benchmarks/scripts/check-regression.mjs:22` |
| n4 | Trace `result_fingerprints` store response object keys verbatim (e.g. maps keyed by email, or the Basic credential in N1) | trace row: `"keyed.Basic ZWNob3VzZXI6…"`; contradicts "results are never stored" in spirit |
| n5 | `ask` proposes a semantically wrong composite: "get the user's orders and delete the product" → `getOrders → getProduct` with `id ← getOrders.id` (order id as product id). Human approval still gates it | `src/discovery/discovery.ts` chain binding |
| n6 | `::ffff:0:a.b.c.d` (IPv4-translated, `::ffff:0:0/96`) is classified public. Not routable on this macOS: a fetch to `[::ffff:0:7f00:1]` timed out | `src/security/ssrf.ts:66-76` |
| n7 | The Docker image does not copy `benchmarks/results/latest.json`, so the dashboard Benchmarks page is empty in Docker (from Dockerfile review; Docker NOT RUN) | `Dockerfile:14-17` |
| n8 | `docs/TOOL-GENERATION.md:12` says composites publish only after being shown equivalent; write plans are never executed by the evaluator (same file, `:111`) | docs |
| n9 | The evaluator reports "composite access = write" for plans with destructive steps | `src/evaluator/evaluator.ts:241-246` |
| n10 | Upstream tools annotated as non-destructive writes (`destructiveHint:false`) run with no grant. SECURITY.md documents this; `README.md:42` and the site say "Write and destructive tools stay hidden until granted" | stdio upstream: `up__write_note` executed with no grant |
| n11 | `approve name@1` output reads "flow-update-product-flow@1 v1 is published" | cosmetic |

## Required scenarios (by hand, installed CLI, MCP client)

| # | Scenario | Result |
|---|---|---|
| 1 | Valid OpenAPI | shop: 11 ops, `live verification — 8/8 read operations verified` |
| 2 | Incomplete docs | Swagger 2 without responses or summaries → imported with `spec_invalid` and `no_description` warnings; `.endpoints` file → 2 tools; non-spec → clear error, config restored |
| 3 | Invalid auth | `[28 ms] The API rejected the credentials (401) … check SHOP_TOKEN.` |
| 4 | Expired credentials | same 401 message (`expired-TOKEN-0000`) |
| 5 | Rate-limited API | `[2026 ms] The API rate limit was hit (429). Wait before retrying.` (3 requests logged; `Retry-After: 1`) |
| 6 | Invalid endpoint | `Not found (404). Response: {"error":"order not found"}` |
| 7 | Missing parameters | `Invalid arguments for shop__getOrders: missing required "userId"` |
| 8 | API timeout | `[15017 ms] The API did not respond within 15000 ms` |
| 9 | Partial failure | `flow__getOrdersUserDetails {userId:1}` → `partial:true`, error `getPayments iteration 1 … 500`, all 4 step keys present, 8 API requests |
| 10 | Repeated workflows | `getOrders > getUser > loop(getOrderItems+getPayments)` support 4; `getProduct > updateProduct` support 4 (2026-07-28 clients; see N2 for 2025-11-25) |
| 11 | Parallelizable | "2 stages for 4 steps"; server-side 12.1 ms vs 52 ms sequential |
| 12 | Sequential dependent | write plan forced serial (`after`); composite saw pre-update state |
| 13 | Unauthorized write | demo (read-only grant): `shop__createProduct` / `shop__deleteProduct` → `Unknown tool …` |
| 14 | Rollback | echo v2 published → `rollback echo` → `✓ v1 is now published`, v2 `approved` (superseded) |

## Commands and key output

### Checks (clean `git archive HEAD` copy)

```
$ npm ci && npm run lint                 # exit 0, no output
$ npm run format:check                   # All matched files use Prettier code style!
$ npm run typecheck && npm run build     # exit 0
$ npm test
 Test Files  7 passed (7)
      Tests  91 passed (91)
$ npm audit --omit=dev                   # found 0 vulnerabilities
$ actionlint .github/workflows/*.yml     # exit 0, no findings
```

### End-user path

```
$ npm pack && npm i -g --prefix <tmp>/prefix ./toolsmith-mcp-0.1.0.tgz
$ diff -r clean/dist prefix/lib/node_modules/toolsmith-mcp/dist   → identical
$ toolsmith-mcp --version → 0.1.0
$ toolsmith-mcp init → "Created toolsmith.config.json and .env"; .env mode -rw-------
$ toolsmith-mcp import http://127.0.0.1:7440/openapi.json --name shop --token-env SHOP_TOKEN
  ✗ egress policy — 127.0.0.1 is a private/loopback address …
$ … --allow-private-network → live verification 8/8
$ echo yes | toolsmith-mcp approve shop   (also --yes, publish, enable, rollback)
  Error: This action grants access and needs a person at an interactive terminal.
$ (sleep 2; printf 'yes\n') | script -q /dev/null toolsmith-mcp approve shop --allow-writes --allow-destructive
  ✓ shop v2 is published.                                                    ← N3
$ toolsmith-mcp start --port 7450 > log   (non-TTY)
  Dashboard: http://127.0.0.1:7450/dashboard/  (sign in with TOOLSMITH_ADMIN_TOKEN)
$ toolsmith-mcp discover → flow__updateProductFlow awaiting_approval; read flow evaluated
$ toolsmith-mcp usage → flow__getOrdersUserDetails 2 calls, 14 round-trips saved
$ toolsmith-mcp client-config → stdio + HTTP snippets
$ toolsmith-mcp doctor → All good.
$ toolsmith-mcp demo --port 7431 → steps 1–7 as documented; 8 MCP calls → 1; 198.7 ms vs 58.2 ms
$ gh repo view devlomingo/toolsmith-mcp → Could not resolve to a Repository
```

### MCP compatibility (own scripts, `@modelcontextprotocol/client` 2.4.0)

```
[legacy] negotiated 2025-11-25 | [auto] negotiated 2026-07-28
tools 12, write (W) and destructive (D) annotated; getProduct → structuredContent {id,name,price,stock,category}
missing param / bad type / extra arg / unknown tool / 404 → isError with clear messages (both versions)
delete#1 → "needs a human to approve this exact call. Approval id: …; you cannot approve it."
admin approve: no token 401, MCP token 401, admin token 200
[legacy] other client (agent-b) consumed agent-a's approval → {"deleted": 5}        ← N2
[auto]   agent-b refused; new connection named "agent-a" consumed it → {"deleted": 6} ← N2
list_changed: legacy HTTP 0, auto HTTP 2, stdio legacy 2, stdio auto 2
```

### Security probes

```
SSRF import (no flag): [::ffff:127.0.0.1], [::ffff:7f00:1], [::127.0.0.1], localhost, 2130706433 → ✗ egress policy
  127.0.0.1.nip.io → "Blocked request: 127.0.0.1.nip.io resolves to private address 127.0.0.1"
  internal listener hits from these imports: 0
isPrivateAddress via new URL(): 64:ff9b::7f00:1, 2002:7f00:1::, 2001::1, fc00::1, fe80::, fec0::1, ff02::1,
  ::ffff:a9fe:a9fe, 0x7f.1, 0177.0.0.1, 127.1, 100.64.0.1 → private; 8.8.8.8, ::ffff:808:808, 2606:4700::1 → public
Bearer echo → {"token":"Bearer [REDACTED_SECRET]", "keyed":{"[REDACTED_SECRET]":1}, "b64":"ZWNo…" }
Basic echo  → {"token":"Basic ZWNob3VzZXI6ZWNoby1QQVNTLTU1NTU1"}                                     ← N1
Upstream env secret → "secret=[REDACTED_SECRET]"
DB + WAL + gateway logs: shop/echo/upstream tokens and admin/MCP tokens 0 matches; Basic base64 found in traces (n4)
Admin API: /api/* no token 401; MCP token 401; Origin evil 403; Host evil 403; /mcp admin token 401; traversal 404
CSP: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'
Upstream stdio: wipe_disk / mystery → approval_required; approve-call (TTY) → ran once; replay → approval_required
```

### Benchmarks

```
$ npm run benchmark -- --quick   (17.8 s)
  order-details @25ms: seq 244.93 | parallel 70.41 | composite 63.04 ms; 8 MCP → 1; 8 API = 8 API
  dependent-chain @25ms: seq 88.22 | composite 90 ms    → benchmark:check FAILED once (n3); 5 later runs passed
$ node benchmarks/scripts/performance.mjs   (full, 3m28s)            committed (results/performance.json)
  @0ms   seq 7.63 / par 4.56 / comp 1.76                               7.47 / 4.67 / 1.89
  @10ms  seq 118.04 / par 33.73 / comp 31.39                           121.02 / 35.21 / 30.21
  @25ms  seq 245.91 / par 68.36 / comp 61.65                           249.3 / 68.3 / 62.74
  @50ms  seq 445.31 / par 120.46 / comp 113.42                         458.74 / 120.1 / 114.52
  chain @10/25/50: 46.06→42.48, 92.19→84.25, 169.64→165.1               45.27→42.07, 93.34→89.22, 171.25→166.14
```

The README table (7.5/4.7/1.9, 249.3/68.3/62.7, 458.7/120.1/114.5),
REPORT.md and the site table match `benchmarks/results/performance.json`.

Patterns:

- F1 0.97 matches `patterns.json` `overall.f1.mean`.
- The baseline 0.84 matches `overallBaseline`.
- The README's "precision 0.69" for ids 1..10 matches REPORT.md.

Throughput "2061 calls/s, p95 53.34 ms" matches `scalability.json`.

The results JSON records commit `50a43bc`. `04aff6b` changes only results
and docs, so the numbers apply to the validated code.

MCP calls, API requests and result bytes are reported separately. The site
says "LLM tokens were not measured, and no token claim is made". Pattern
results are labelled synthetic.

## Known limitations of this validation

- **NOT RUN:**
  - the Docker build and run (daemon down);
  - the real `npm install -g github:…` (repo not published; simulated, N4);
  - real GitHub Actions runs;
  - shellcheck of workflow `run:` blocks;
  - a public spec over the internet, and a real cloud metadata endpoint
    (loopback stood in);
  - browser rendering of the dashboard and site (HTML inspected as text
    only);
  - Streamable HTTP *upstream* servers (only stdio upstreams were
    hand-tested);
  - full `patterns.mjs` and `scalability.mjs` runs (quick mode only).
- Path-parameter injection and redirect handling were not re-probed by hand
  this round. They are covered by the passing security suite and were
  verified by hand in round 1.
- Timings come from one machine of the same model as the committed results.
- The installed scratch prefix pre-existed from round 1. I reinstalled over
  it and verified the installed `dist` is byte-identical to this commit's
  clean build.

## Release recommendation

**Release after fixing listed items.**

Must fix before a public release:

1. **N1.** Scrub Basic credentials on success.
2. **N2.** Make HTTP session binding real, or document it as advisory and
   stop claiming it.
3. **N3.** Correct the "agents cannot approve" claims in the CLI message,
   MCP-INTEGRATION.md, SECURITY.md:39 and the site.
4. **N4.** Verify the documented install path at publication, or switch to
   a registry or tarball install.
5. **Docker.** Run the image build and run once the daemon is available.

The Minor list (n1–n11 and the open round-1 minors m1, m3, m11–m16) can
follow as normal issues. Fix n3 soon, because it will produce red CI runs.
