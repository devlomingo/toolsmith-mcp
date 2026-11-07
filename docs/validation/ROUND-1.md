# Final validation report: toolsmith-mcp

- **Date:** 2026-11-07
- **Commit validated:** `cf5e8f6` (`git rev-parse --short HEAD`), branch `main`, clean tree
- **Validator:** independent QA/security pass. Every result below was produced
  by a command I ran. Anything not run is marked NOT RUN.

## Environment

| Item | Value |
|---|---|
| OS | macOS (Darwin 27.2.0), Apple Silicon (M1 Pro) |
| Node / npm | v22.13.1 / 10.9.2 |
| Docker | installed, daemon **not running** (`docker info` failed) |
| actionlint | **not installed** |
| Network | loopback only for tests; no public spec fetched |

Scratch work lived outside the repo: a `git archive HEAD` copy for `npm ci`
and checks, a tarball install into a temp npm prefix, and temp workspaces. The
only file written in the repo is this report.

## Summary verdict

**Do not release.** Most of the system works. The core lifecycle
(import → verify → approve → trace → mine → composite → evaluate → publish →
rollback) behaves as described, both MCP protocol versions work over stdio and
Streamable HTTP, tests pass, and the benchmark numbers come from real runs.

Two Critical issues block a public release:

1. The SSRF guard can be bypassed with an IPv4-mapped IPv6 literal. During
   import, before any human review, the gateway called a loopback service
   that it should have blocked.
2. `toolsmith-mcp discover`, a documented core command, crashes and leaves
   the composite stuck in `testing`.

Eight Major issues also undermine headline security claims or break the
documented install, CI and CLI paths. They include unredacted credentials in
success results, unapproved destructive upstream tools, composite approvals
that ignore grants, agent self-approval through the CLI, a CI job that will
fail, the missing `usage` command, a GitHub install path that does not exist
yet, and the admin token printed to logs.

## Requirement areas

| Area | Result | Notes |
|---|---|---|
| Lint / typecheck / build / tests | PASS | 77/77 tests, lint clean, tsc clean |
| format:check (run by CI) | **FAIL** | 2 files unformatted, so the CI `check` job fails (M5) |
| npm audit --omit=dev | PASS | 0 vulnerabilities (dev tree: moderate `minimatch` via eslint) |
| Install from tarball + `demo` | PASS | |
| Documented install (`npm i -g github:devlomingo/toolsmith-mcp`) | **FAIL** | repo does not exist (M7) |
| init / import / show / approve / start / client-config / doctor / ask / traces | PASS | minor UX issues |
| `discover` CLI | **FAIL** | C2 |
| `usage` CLI | **FAIL** | M6 |
| MCP 2025-11-25 over HTTP | PASS (list/call/errors) | `list_changed` never delivered (minor) |
| MCP 2026-07-28 over HTTP | PASS | `list_changed` delivered |
| MCP both versions over stdio | PASS | `list_changed` delivered in both |
| OpenAPI / Swagger / endpoint-list generation | PASS | |
| Composite generation + execution (parallel, forEach, partial) | PASS (read plans) | write plans: M3 |
| SSRF protection | **FAIL** | C1; spec-URL fetch unguarded (minor) |
| Secrets not exposed to agent / traces / logs | **FAIL** | DB and traces clean; agent gets echoed token (M1); admin token in stdout (M8) |
| Read vs write separation | PARTIAL | OpenAPI tools OK; composites (M3) and upstreams (M2) not |
| Destructive needs explicit approval | PARTIAL | OpenAPI: PASS (bound to args, single use); upstream: FAIL (M2) |
| No generated code executed | PASS | no `eval` / `new Function` / `vm`; plans are data |
| Generated tools cannot exceed step/credential permissions | PASS | composite hidden when a step is hidden; but M3 |
| Approval only by humans | **FAIL** in practice | M4 |
| Rate limit, timeouts, input/output validation, audit | PASS | timeout retried 3× (minor) |
| Admin API auth / CORS / DNS rebinding / dashboard XSS | PASS | |
| Required scenarios 1–14 | PASS (suite + my reproduction of 3, 4, 6, 7, 8, 9, 10, 13, 14) | |
| Benchmarks reproducible, not fabricated | PASS | small-margin claims within noise (minor) |
| Docs match implementation | **FAIL** | see M1–M4, M6, C2 |
| Website builds, links OK, synthetic labelled | PASS with issues | overclaims security (M1–M3) |
| CI workflows | **FAIL** | YAML parses; `check` job fails on format (M5); actionlint NOT RUN |
| Docker image | NOT RUN | daemon not running |

## Commands and key output

### Checks (clean `git archive` copy)

```
$ npm ci                       # ok; full audit: moderate minimatch (dev only)
$ npm run lint                 # no output, exit 0
$ npm run format:check
[warn] .github/workflows/pages.yml
[warn] compose.yaml
[warn] Code style issues found in 2 files.
$ npm run typecheck            # exit 0
$ npm run build                # exit 0
$ npm test
 Test Files  6 passed (6)
      Tests  77 passed (77)
$ npm audit --omit=dev
found 0 vulnerabilities
```

### End-user path

```
$ npm pack && npm i -g --prefix <tmp>/prefix ./toolsmith-mcp-0.1.0.tgz
$ toolsmith-mcp --version        → 0.1.0
$ toolsmith-mcp demo --port 7431
2. Imported its OpenAPI spec: 11 operations → evaluation passed
5. Discovered workflow (4 sessions) → proposed flow__getUserOrdersDetails: awaiting_approval
   evaluator: identical results; 8 MCP calls → 1; 193 ms sequential vs 55.7 ms composite
✓ Gateway running ...
$ toolsmith-mcp init             → config + .env (mode 600) + .gitignore
$ toolsmith-mcp import http://127.0.0.1:7440/openapi.json --name shop --token-env SHOP_TOKEN
  ✗ egress policy — 127.0.0.1 is a private/loopback address. Set "allowPrivateNetwork": true ...
$ ... --allow-private-network    → v2 awaiting_approval, live: 8/8 read operations verified
$ toolsmith-mcp approve shop     → 8 tools; "2 write tool(s) hidden ... 1 destructive hidden"
$ toolsmith-mcp start --port 7450
  Dashboard:     http://127.0.0.1:7450/dashboard/#token=qa-admin-token-2222   ← M8
$ toolsmith-mcp client-config    → correct stdio + HTTP snippets
$ toolsmith-mcp doctor           → "All good." exit 0
$ toolsmith-mcp discover         → 48× "[toolsmith] failed to record trace: database is not open"  ← C2
$ toolsmith-mcp usage            → Unknown command "usage". exit 2  ← M6
$ gh repo view devlomingo/toolsmith-mcp → Could not resolve to a Repository  ← M7
```

### MCP compatibility (my own client scripts, `@modelcontextprotocol/client` 2.4.0)

```
legacy negotiated 2025-11-25 | auto negotiated 2026-07-28
tools 10 (write/destructive hidden), getProduct → structuredContent {id,name,price,stock,category}
missing param → isError "Invalid arguments ...: missing required \"id\""
bad type      → isError "id must be integer"
unknown tool  → isError "Unknown tool ... Call toolsmith__request_capability"
404           → isError "Not found (404). Response: {...}"
unknown arg   → isError "unknown argument \"extra\""
HTTP list_changed after admin disable/enable: legacy 0 events; auto 2 events
stdio (start --stdio), legacy and auto: negotiated correctly; list_changed -> 16, -> 17
  after CLI disable/enable from another process
curl GET /mcp (legacy SSE stream) → 405 Method Not Allowed; no Mcp-Session-Id issued
```

### Security probes

```
SSRF imports (no allowPrivateNetwork):
  127.0.0.1.nip.io  → blocked at connect ("resolves to private address 127.0.0.1")
  2130706433, localhost → egress policy failed (blocked)
  [::ffff:127.0.0.1] / [::ffff:7f00:1] → "✓ egress policy — only ::ffff:7f00:1 reachable",
      "✓ live: meta — verified — HTTP 200"
  internal server log: INTERNAL HIT GET /latest/meta-data [::ffff:7f00:1]:7442   ← C1
Path params: "..", "../x", "%2e%2e", "//host", "@host", "?#", CRLF → all encoded or refused
Redirect → "redirects are not followed"
Error body echoing token → "bad token Bearer [REDACTED_SECRET]"
Success body echoing token → {"token":"evil-secret-TOKEN-987654"} returned to agent  ← M1
DB/WAL files, /api/{overview,traces,audit,tools,events,call-approvals,artifacts/*}: 0 secret matches
Destructive call without grant → hidden; with grant → approval_required + id
approve-call 7e3c36a5 {id:17}; replay with {id:18} → approval_required; reuse {id:17} → approval_required
Upstream mini__wipe_disk (destructiveHint:true) → executed with no grant and no approval  ← M2
Admin API: no token 401, MCP token 401, admin+Origin evil 403, Host evil 403, admin 200
/mcp: no token 401, admin token 401; dashboard CSP default-src 'self'; traversal 404
grep eval/new Function/vm/child_process in src, dashboard, site → none (only db.exec SQL)
```

### Scenarios reproduced by hand (beyond the suite)

```
3 invalid auth   → "The API rejected the credentials (401) ... check SHOP_TOKEN." (27 ms)
4 expired token  → same 401 message
8 timeout        → [45393 ms] "The API did not respond within 15000 ms" (3 attempts)
6 404, 7 missing param, 13 unauthorized write → as above
9 partial        → flow__getUserOrdersDetails {userId:2}: partial true,
                   errors [getPayments iteration 1: 500], other results present
10 repeated      → patterns: "getOrders > getUser > loop(getOrderItems+getPayments) 4 sessions"
14 rollback      → "✓ v1 is now published." (v2 superseded)
```

### Benchmarks

```
$ npm run benchmark -- --quick           (17.8 s) → Benchmark regression checks passed.
  order-details @25ms: seq 253.22 | parallel 66.34 | composite 61.14 ms; 8 MCP → 1; 8 API = 8 API
$ node benchmarks/scripts/performance.mjs  (full, my run vs committed results/REPORT.md)
  @0ms   seq 7.30 / par 4.41 / comp 1.78    (committed 8.04 / 4.61 / 1.91)
  @10ms  seq 124.93 / par 35.04 / comp 30.29 (committed 111.15 / 31.84 / 28.84)
  @25ms  seq 249.59 / par 62.60 / comp 64.00 (committed 239.57 / 63.50 / 60.00)
  @50ms  seq 454.26 / par 121.04 / comp 115.24 (committed 445.54 / 116.97 / 111.43)
  chain @10ms seq 41.74 / comp 41.94; @50ms 169.64 / 163.96
```

README and REPORT.md numbers match `benchmarks/results/*.json` exactly. The
F1 values match too: 0.97 shipped, 0.84 baseline, 0.69 precision for ids
1..10. The results come from commit `7a16e57`. Since then the only change is
the `client-config` snippet and the regression checker, so the results still
apply. MCP calls, API requests and result bytes are reported separately. No
token claim is made. Pattern results are labelled synthetic.

### Website

```
$ node site/build.mjs && node site/check-links.mjs
Built site/dist (30 KB HTML).
Link check passed (22 external links not fetched).
```

The site says "Synthetic setup, not production measurements." Its numbers
match the committed results. It renders "gains 3%–3%". Its security bullets
overclaim: "redacted everywhere" (M1), "Write and destructive tools hidden
until granted" (M2, M3), and "Per-call approval for destructive actions" (M2).

## Findings

### Critical

**C1. SSRF guard bypass with an IPv4-mapped IPv6 address.**
`src/security/ssrf.ts:37`. `isPrivateAddress` only recognises the dotted form
`::ffff:a.b.c.d`. The WHATWG URL parser normalises `http://[::ffff:127.0.0.1]`
to `[::ffff:7f00:1]`, which is classified as public. Node skips `lookup` for IP
literals, so `guardedLookup` never runs. The same applies to
`[::ffff:a9fe:a9fe]`, which is cloud metadata at 169.254.169.254.

Because the spec's `servers` URL becomes the base URL, an untrusted spec can
reach loopback or metadata during import, before review. Live verification
calls every read operation. Agent calls after approval can reach the same
addresses. `docs/SECURITY.md` claims that "mapped" addresses are blocked.

Repro:

1. Write a spec with `"servers":[{"url":"http://[::ffff:127.0.0.1]:7442"}]`
   and a GET operation.
2. Run a listener on 127.0.0.1:7442.
3. Run `toolsmith-mcp import ./spec.json --name x`, without
   `--allow-private-network`.

Result: `✓ egress policy — only ::ffff:7f00:1 reachable`,
`✓ live: meta — verified — HTTP 200`, and the listener logs the request.

Fix: parse with `net.BlockList`, or normalise hex-mapped, IPv4-compatible
(`::a.b.c.d`) and 6to4 forms. Add a test that goes through `new URL()`.

**C2. `toolsmith-mcp discover` closes the DB mid-run.**
`src/cli/index.ts:194` has `return discover(app);` without `await`. The
`finally` block at `:227` closes the DB while composite evaluation is still
running.

Every step fails with "database is not open", and the composite is left in
`testing`. Re-running `discover` does not re-evaluate it, because of dedup.
The user has to know to run `toolsmith-mcp evaluate <name>`.

`discover` is in the README quick start and in `docs/TOOL-GENERATION.md`. The
tests never exercise the CLI path. The dashboard's Propose button, at
`POST /api/patterns/propose`, works.

Repro: generate 3 or more agent sessions of a workflow, then run
`toolsmith-mcp discover`. Then `toolsmith-mcp list` shows `testing`.

### Major

**M1. Credentials echoed in a successful response reach the agent.**
`src/openapi/http-executor.ts:92`: `parseBody` output is returned unredacted.
Only error bodies are redacted (`:268`). `docs/SECURITY.md` lists "the agent"
as someone who must not get credentials, and says this is tested "including an
API that echoes the token back". The test (`test/security/security.test.ts:160`)
only covers a 500.

Repro: an API whose GET returns `{"token": <Authorization header>}`. Import it
with `--token-env`, approve it, and call it over MCP. The text content
contains the raw token. A base64-encoded token also passes through unchanged.

**M2. Upstream MCP tools bypass approval entirely.**
`src/gateway/gateway.ts:148` adds every upstream tool, including destructive
ones, with no grant check. `:280` exempts `source === 'upstream'` from
per-call approval.

Repro: configure a stdio upstream whose tool is annotated
`destructiveHint: true`. Connect over stdio. `mini__wipe_disk` is listed and
runs immediately.

`CONFIGURATION.md` and `SECURITY.md` state the exception. The README ("Nothing
becomes available to an agent until a human approves it", "Every destructive
call is approved individually") and the website do not. This fails the
requirement that destructive operations need explicit approval.

**M3. Composite approval ignores the grant.**
Composite `version.permissions` are never consulted in `Catalog.rebuild`
(`src/gateway/gateway.ts:170-200`). A write composite approved with plain
`toolsmith-mcp approve flow-get-product`, without `--allow-writes`, is
published with `access: write`.

The generator also put `getProduct` and `updateProduct` in one parallel stage
("1 stages for 2 steps"), so the observed read-before-write order is lost. The
evaluator does not execute write plans, yet the plan is still approvable.
`docs/TOOL-GENERATION.md` says "a composite is published only after it is
shown to return exactly what the individual calls return". The tool is named
`flow__getProduct` even though it updates.

Repro:

1. Approve shop with `--allow-writes`.
2. Run 4 sessions of `getProduct{id}` → `updateProduct{id,body}`.
3. `POST /api/patterns/propose`, then `toolsmith-mcp approve flow-get-product`.
4. `/api/tools` shows `flow__getProduct write`.

**M4. Any local process can approve, including the agent itself.**
`approve`, `approve-call` and `approve --allow-destructive` are
unauthenticated CLI commands, and the actor string is hard-coded as `human:cli:$USER`
(`src/cli/index.ts:25`). The `approval_required` message tells the agent the
exact command to run (`src/gateway/gateway.ts:285`).

Coding-agent MCP clients have a shell. During this validation I, an
automated agent, ran `toolsmith-mcp approve-call 7e3c36a5` non-interactively,
and the destructive DELETE executed.

The "Only humans approve" claim depends on the agent having no shell.
`SECURITY.md` "not protected: the local machine" only partly covers this.
Suggested fixes: require a TTY confirmation or the admin token for the CLI,
and do not put the CLI command in the agent-facing message.

**M5. The CI `check` job will fail on its first run.**
`npm run format:check` exits 1 on `.github/workflows/pages.yml` and
`compose.yaml`, and `ci.yml` runs it before typecheck, build, tests and the
CLI smoke test.

Repro: `npm ci && npm run format:check`.

**M6. `toolsmith-mcp usage` is an unknown command.**
`'usage'` is missing from `KNOWN` (`src/cli/index.ts:97`) even though the
switch handles it at `:201`. It is documented in the README, `--help` and
`TOOL-GENERATION.md`.

Repro: `toolsmith-mcp usage` prints `Unknown command "usage"` and exits 2.

**M7. The documented install path, website and CI badge point to a repo that
does not exist.**
`gh repo view devlomingo/toolsmith-mcp` reports "Could not resolve to a
Repository". `npm install -g github:devlomingo/toolsmith-mcp` (README,
`INSTALLATION.md`, site) cannot work until that public repo exists with this
code at that name. This has to be done as part of the release, then
re-verified.

**M8. The admin token is printed to stdout.**
`start` prints `Dashboard: http://…/dashboard/#token=<adminToken>`
(`src/cli/index.ts:439`). Under Docker (`docker logs`), systemd or any log
shipper, this puts the admin secret in logs. This fails "secrets never in
logs".

Repro: `toolsmith-mcp start`, then read stdout.

### Minor

| # | Finding | Where / repro |
|---|---|---|
| m1 | Spec URL fetch has no SSRF guard and follows redirects. `import http://127.0.0.1:7442/...` without the flag hit the loopback listener | `src/openapi/import.ts:34` |
| m2 | Timeouts are retried for reads. A hung API took 45.4 s for one call, but the message says "within 15000 ms". Many MCP clients time out at 60 s | `http-executor.ts:79-87`; call `shop__getProduct {id:13}` with `hangPaths` |
| m3 | Streamable HTTP with 2025-11-25 never receives `tools/list_changed`: GET /mcp returns 405 and no session is issued, while `listChanged: true` is advertised | client script, legacy mode |
| m4 | A per-call approval is not bound to the requesting session. Another agent consumed it | `src/gateway/approvals.ts:38-46` |
| m5 | A failed `import` still writes the integration into config; `doctor` then fails and suggests re-running the same failing command | `src/cli/index.ts:367` (write before import) |
| m6 | An error hint suggests `toolsmith-mcp import --endpoints`, a flag that does not exist | `src/openapi/import.ts:85` |
| m7 | `package.json` `files` lists `examples`, which does not exist | `package.json` |
| m8 | The dashboard Benchmarks page always shows nothing for users: it reads `<configDir>/benchmarks/results/latest.json` | `src/server/admin-api.ts` (benchmarks); `GET /api/benchmarks` returns `null`, demo included |
| m9 | The evaluator "performance" metric is skewed by the integration rate limiter (default 10/s): it reported "797.9 ms composite vs 381.7 ms" | `toolsmith-mcp evaluate flow-get-user-orders-details` |
| m10 | The composite vs parallel-client margin (README "5–10%") and the chain margin ("2–3%") are within run-to-run noise. My full run at 25 ms had the composite 2% *slower* than the parallel client, and the chain at 10 ms 0.5% slower. Report variance or several runs. The site renders "gains 3%–3%" | `README.md`, `site/build.mjs` |
| m11 | Outside a git checkout, benchmarks print `fatal: not a git repository` and record `commit null` | `benchmarks/scripts/lib.mjs` |
| m12 | `ask "delete a product"` returns `needs_approval` with "data exists ... closest tool: shop__getProducts", which misleads | `src/discovery/discovery.ts` |
| m13 | `CallApprovals.grantNow` is unused (elicitation is not wired) | `src/gateway/approvals.ts:86` |
| m14 | The demo says "demo data is discarded on exit" but its temp dir remains | `src/cli/index.ts:734` |
| m15 | Report "RSS MB" is the whole benchmark process (clients + gateway + API), which is not stated | `benchmarks/scripts/scalability.mjs:110` |
| m16 | Agents can create unlimited composite proposals through `toolsmith__request_capability` (approval-queue spam) | `src/app.ts` builtinTools |

## Known limitations of this validation

- **NOT RUN:** Docker build and run (daemon down), actionlint (not
  installed), real CI on GitHub (no repo), import of a public spec over the
  internet, a real cloud metadata endpoint (loopback stood in for it), a
  browser rendering of the dashboard (XSS judged from code, which uses
  `textContent` and a DOM builder, plus the served CSP header).
- Only the quick benchmark suite and the full `performance.mjs` were re-run.
  The full `patterns.mjs` and `scalability.mjs` were run only with `--quick`.
- Timing comparisons are from one machine, the same model as the committed
  results.
- Scenarios 5 (rate limit), 11 and 12 (parallel and sequential stages) were
  verified through the test suite and the benchmark (stage behaviour), not by
  a separate hand-made rate-limited API.

## Release recommendation

**Do not release.** Fix C1 and C2. Then fix M1–M8, or for M2 and M4 at least
correct the README, website and SECURITY.md so they stop claiming universal
human approval. Then re-run this validation, including Docker, actionlint and
the GitHub install path. After that it would qualify as "release after fixing
listed items" for the Minor list.
