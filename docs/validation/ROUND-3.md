# Final validation report (round 3): toolsmith-mcp

- **Date:** 2026-11-08 (+03)
- **Commit validated:** `6715ecd` (`git rev-parse --short HEAD`), branch
  `main`, clean tree. Round-2 fixes are in `8a4fd8b`. `0223f65` regenerates
  the benchmarks and `6715ecd` archives the round-2 report;
  `git diff 8a4fd8b HEAD -- src` is empty.
- **Validator:** independent QA and security pass. Every result below comes
  from a command I ran. Anything I did not run is marked NOT RUN.

## Environment

| Item | Value |
|---|---|
| OS | macOS 27.2 (Darwin 27.2.0), Apple Silicon |
| Node / npm | v22.13.1 / 10.9.2 |
| Docker | installed, daemon **not running** (`docker info` fails) |
| actionlint / shellcheck | 1.7.7 / 0.10.0, release binaries in a temp dir |
| MCP client | `@modelcontextprotocol/client` 2.4.0, in a scratch project |
| GitHub repo | not created, so publication, release and CI are NOT RUN |
| Network | loopback only. Public DNS was simulated with a test-only `dns` preload; no public host was contacted |

Scratch work was kept outside the repo:

- a `git archive HEAD` copy for the checks;
- the `npm pack` tarball, installed with `npm i -g --prefix <tmp>`;
- my workspaces and client scripts;
- these mock servers: the demo shop (with token, expired token and rate
  limit), an echo API, an "internal" listener and a redirector.

Every server was stopped at the end. The only file I wrote in the repo is
this report.

## Verdict

**Release after fixing listed items.**

- N1, N3 and N4 are fixed.
- N2 is fixed for security: approvals are bound to the token-authenticated
  client, and I could not spoof that by any means I tried. Its
  workflow-discovery half is only partly fixed (N5).
- One new Major: credentials still reach the agent through truncated error
  bodies (N6).
- One new Major of the same class as N1: query API keys leak in URL-encoded
  form (N7).

Neither Major needs a redesign. Each is a few lines in
`src/openapi/http-executor.ts`.

## Requirement areas

| Area | Result | Notes |
|---|---|---|
| lint / format:check / typecheck / build | PASS | clean `git archive` copy, all exit 0 |
| `npm test` | PASS | 7 files, **97/97** |
| `npm audit --omit=dev` | PASS | 0 vulnerabilities. The full tree has 10 moderate, all dev-only |
| actionlint | PASS with note | exit 0 without shellcheck. With shellcheck: one SC2034 warning (`i` unused) in `pages.yml:53`, a file that did not change since round 2. `release.yml` is clean |
| Release workflow (simulated) | PASS | Ran each step locally: `npm ci`, `npm test`, the tag check (`v0.1.0` = package version), `npm pack`, global install into a temp prefix plus `--version`, and the CHANGELOG awk (91 lines extracted). `gh release create` NOT RUN |
| Install from tarball | PASS | `npm i -g --prefix <fresh tmp> toolsmith-mcp-0.1.0.tgz`: `0.1.0`; installed `dist` identical to the clean build. Tarball sha1 `a141c315…` reproducible across two clean builds |
| Documented install URL (`…/releases/download/v0.1.0/toolsmith-mcp-0.1.0.tgz`) | NOT RUN | repo not published. The asset name matches `npm pack` output |
| CLI path (`demo`, `init`, `import`, approve refusing without a TTY, `start`, `client-config`, `doctor`, `discover`, `usage`) | PASS | see the end-user path below |
| MCP 2025-11-25 over HTTP | PASS | list, call, errors and approvals work. No `list_changed` (m3, open) |
| MCP 2026-07-28 over HTTP | PASS | list, call, errors and approvals work. `list_changed`: 2 events |
| MCP both eras over stdio | PASS | negotiated `2025-11-25` / `2026-07-28`; `list_changed` 1 event each, triggered from another process; approval bound per process |
| Client identity (N2) | PASS | spoofing attempts all refused (table below) |
| Workflow discovery over HTTP without a session header | **FAIL** | N5 |
| Spec-download SSRF guard | PASS with accepted limitation | 17 private and redirect shapes blocked, 0 internal hits. DNS rebinding and lookup failure fall through (TOCTOU, n13) |
| Secrets never exposed | **FAIL** | Basic, header-key and Bearer echoes are scrubbed in full. Truncated echoes in error bodies leak (N6), and URL-encoded query keys leak (N7) |
| Read vs write / destructive approval | PASS | write and destructive tools are hidden until granted; per-call approval is bound to the client and to the arguments, and works once |
| No generated code executed | PASS | unchanged since round 2. No `eval`, `Function` or `vm` |
| 14 scenarios | PASS | suite (all scenario tests pass) plus spot checks 3–7, 10, 13 by hand |
| Benchmarks vs docs | PASS | README, REPORT.md and the built site match `benchmarks/results/*.json` (results commit `8a4fd8b`, src identical to HEAD) |
| Benchmark CI gate (n3) | PASS | 3 quick runs; the gate passed all 3, including a run where the chain composite was slower (102 vs 99.5 ms) |
| Docs match behaviour | PARTIAL | N5 (fallback grouping), n12–n15 |
| Docker image | NOT RUN | daemon down |
| Website build / links | PASS | `Built site/dist (30 KB HTML)`; `Link check passed (22 external links not fetched)` |

## Round-2 findings: status

| # | Status | Evidence |
|---|---|---|
| **N1** Basic echo on success | **fixed** | `eb__echo` → `"auth":"Basic [REDACTED_SECRET]"`, `"decodedB64":"[REDACTED_SECRET]:[REDACTED_SECRET]"`, object key `"Basic [REDACTED_SECRET]"`. The full base64 appears 0 times in the DB, WAL and admin API. But see N6 (truncated echoes) |
| **N2** session binding over HTTP | **partially fixed** | **Security half fixed:** the principal is `http:<client name from token>`, and every spoof attempt failed (below). **Discovery half not fixed** for clients without `X-Toolsmith-Session`: N5 |
| **N3** "agents cannot approve" claims | **fixed** (the `script` bypass is now an **accepted limitation**) | CLI says "…it is not a security boundary against software running as your user". MCP-INTEGRATION, SECURITY.md, ADR 0006 and the site are reworded. The `script` bypass still works (I used it for setup) and is now documented |
| **N4** global git install | **fixed** (switched to tarball) / real URL NOT RUN | The docs no longer give `github:`, and INSTALLATION.md explains why. Tarball install verified locally; release workflow simulated |
| n1 raw stack for unreachable spec | fixed | `Error: Could not reach 127.0.0.1:7999 to download the API spec (ECONNREFUSED)` + hint, exit 1 |
| n2 silent hidden write composite | fixed | prompt: `! It changes data: without --allow-writes it will stay hidden from agents.` After approval: `! Not visible to agents: hidden: …` |
| n3 flaky benchmark gate | fixed | gate passed 3/3 quick runs, including one with an inverted chain result |
| n4 trace paths store keys verbatim | fixed for registered secrets | paths go through `redactString`. A literal (non-`${env:}`) key still lands in a path (`keyed.literal-KEY-99999`, see n14) |
| n5 wrong `ask` binding | not fixed | `ask "get the user's orders and delete the product"` → `getOrders → getProduct`, `id ← getOrders.id`. Human approval still gates it |
| n6 IPv4-translated IPv6 | fixed | `[::ffff:0:127.0.0.1]` → `private address ::ffff:0:7f00:1` |
| n7 Docker image lacks benchmarks | fixed in Dockerfile; build NOT RUN | `COPY benchmarks/results/latest.json`. The `.dockerignore` exclusion was removed |
| n8 TOOL-GENERATION wording | fixed | "A read-only composite is published only after it is shown to return exactly…" |
| n9 evaluator says "write" for destructive | fixed (code review) | `evaluator.ts:246` |
| n10 upstream write tools overclaimed | fixed (docs) | README and site: "Generated write and destructive tools…; connected MCP servers are trusted by configuration, except…" |
| n11 `name@1 v1` | fixed | `✓ flow-update-product-flow v1 is published.` |
| m1 spec URL unguarded | fixed (TOCTOU accepted) | see the SSRF section |
| m3 no `list_changed`, 2025-11-25 HTTP | not fixed | `list_changed events { legacy: 0, auto: 2 }` |
| m5 failed import leaves config | fixed | junk / missing / blocked imports → `integrations: []`, `doctor` "All good" |
| m10 site wording | fixed | "this run measured the composite +5% to +9% faster, but … treat the latency difference as noise" |
| m11 benchmark outside git | fixed | no `fatal:` in 3 runs from a non-git copy; `commit: null` |
| m12 misleading `ask` | fixed | `ask "delete a product"` → `available: shop__deleteProduct already covers this.` |
| m13 `grantNow` unused | fixed | removed |
| m14 demo temp dir kept | fixed | after SIGINT: `ls …/toolsmith-demo-uGLyJB: No such file or directory` |
| m15 RSS unlabeled | fixed | REPORT.md: "RSS MB (whole process)" plus a note |
| m16 unlimited proposals | fixed (code review; not exercised) | `MAX_OPEN_PROPOSALS = 50`, `discovery.ts:73` |
| M7 repo / install path | NOT RUN pending publication | |

## Client identity probes (N2)

The setup:

- `server.mcpToken` (client `default`) plus `server.clients` `agent-a` and
  `agent-b`;
- agent-a requests `shop__deleteProduct {id}`, and a human approves it
  through the admin API;
- then each line below tries to spend agent-a's approval.

Every attempt was run under both 2025-11-25 and 2026-07-28.

| Attempt | 2025-11-25 | 2026-07-28 |
|---|---|---|
| B's token, client name `agent-a` | refused (new pending, principal `http:agent-b`) | refused |
| B + `x-toolsmith-client: agent-a` | refused | refused |
| B + `X-TOOLSMITH-CLIENT: agent-a` | refused | refused |
| B + `x-toolsmith-session` / `mcp-session-id` / `x-toolsmith-conn` | refused | refused |
| default token + `x-toolsmith-client: agent-a` | refused | refused |
| B + `_meta` `io.modelcontextprotocol/clientInfo {name:"agent-a"}` | refused | refused |
| raw request, B token, 3× duplicate `x-toolsmith-client` in mixed case + `X-TOOLSMITH-CONN` | refused (`a49eb5de pending http:agent-b`) | n/a |
| raw request, B token + a second `Authorization: Bearer <A>` | refused (Node keeps the first `Authorization`) | n/a |
| agent-a retry | `{"deleted": 3}` | `{"deleted": 4}` |
| agent-a replay | approval required again | approval required again |

Why spoofing fails:

- `toNodeHandler` builds the Web `Headers` from `req.headers`
  (`@modelcontextprotocol/node` `index.mjs:388`), after `http.ts:90-91` has
  deleted the client-supplied names.
- Node lower-cases and merges header names, so case variants and duplicates
  are dropped together.

Other cases:

- **No token on loopback.** With `mcpToken` removed and `clients: []`,
  every HTTP client is the principal `http:local`. Agent B under 2026-07-28
  spent agent A's 2025-11-25 approval: `{"deleted": 9}`. `init` always
  writes a token, so this needs an operator to delete it. It is still
  undocumented (n12).
- **Stdio.** A second stdio process with the same client name was refused.
  A retry in the same process succeeded: `{"deleted": 18}`.

## New findings

### Major

**N5. Workflow discovery over Streamable HTTP still fails for clients that
send no session header, and the documented fallback is not what happens.**

`src/server/mcp.ts:94-97` groups calls by `<client name>@<remote ip:port>`,
using the connection set in `src/server/http.ts:103-104`. That is
unreliable in two ways.

1. **The connection changes within one run.** With the official SDK client,
   the first `tools/call` of every run arrives on a different TCP
   connection from the rest. Traces from one run:

   ```
   http:default/client@127.0.0.1:63752 shop__getOrders
   http:default/client@127.0.0.1:63750 shop__getUser … (rest of the run)
   http:default/client@127.0.0.1:63756 shop__getProduct
   http:default/client@127.0.0.1:63754 shop__updateProduct
   ```

   After 8 runs (4 per workflow), `patterns` found only
   `getOrderItems > getPayments`. It missed both planted workflows. The
   same 8 runs with `X-Toolsmith-Session` found both: `getOrders > getUser
   > loop(getOrderItems+getPayments)` support 4, and
   `getProduct > updateProduct` support 4.

2. **The server closes idle connections.** Node's default keep-alive is
   5 s. With a 6 s pause between calls (shorter than a typical LLM turn),
   every call got its own session (ports 63798, 63808, 63812, 63818,
   64307, 64607), so nothing can be mined.

The "reported name" part of the key is the constant `client` under
2025-11-25. `getClientVersion()` is empty on the per-request server.

The docs disagree with this behaviour:

- `docs/MCP-INTEGRATION.md:60-61` says the fallback is "the client's
  reported name plus its TCP connection";
- `client-config` prints an HTTP snippet with no `X-Toolsmith-Session`
  header, so the default HTTP setup never gets workflow discovery.

This is not a security issue, because the principal is unaffected. But it
is the product's headline feature, failing silently in the default HTTP
configuration.

Fix:

- emit `X-Toolsmith-Session` in the `client-config` HTTP snippet (a static
  per-agent value is fine; the miner separates runs by data flow);
- document that grouping without the header is per connection and usually
  per call;
- optionally group header-less calls by principal plus a time window.

**N6. Credentials leak through error bodies cut at 300 characters before
redaction.**

`src/openapi/http-executor.ts:285` runs
`this.redactor.redactString(res.body.slice(0, 300))`. A secret that
straddles the cut is no longer an exact match, so it is not scrubbed.

The `Basic …` value pattern misses it too, because `\b` fails when a word
character precedes `Basic`. An argument the agent controls sets the padding
in front of a reflected header. By choosing it, the agent receives all but
the last character of the credential.

Repro: an echo API whose `GET /echoerr?pad=N` returns 400 with N × `x`
followed by the request's `Authorization` / `X-API-Key`. With the
integrations approved read-only:

```
eb__echoErr {pad:263} → "The API rejected the request (400). Response: x…Basic ZWNob3VzZXI6ZWNoby1QQVNTLTU1NTU"
                         (base64 of "echouser:echo-PASS-5555…"; 31 of 32 chars)
ek__echoErr {pad:282} → "… Response: x…ek-HEADER-KEY-7777"   (18 of 19 chars of EK_KEY)
```

The prefixes are also stored in the trace DB and returned by
`GET /api/traces`: `ZWNob3VzZXI6ZW` and `ek-HEADER-` each found.

This contradicts SECURITY.md:10 ("never reaches … the agent, the traces")
and the site's "redacted everywhere".

Fix: redact the full body, then truncate the redacted text. Also drop the
leading `\b` from the `Basic` / `Bearer` patterns, or replace it with a
look-behind on non-base64 characters.

**N7. Query-string API keys leak in their URL-encoded form.**

For `apiKey` with `in: "query"`, `http-executor.ts:199` registers the raw
value. The request carries `URLSearchParams` encoding. An API that echoes
its request URL returns the encoded key, which is never matched. That
includes pagination `next` links, `self` links and error messages.

This is the same class as N1: the on-the-wire form is not registered.

Repro: `EQ_KEY=eq+QUERY/KEY=88888`:

```
eq__echo     → OK {"url":"/echo?api_key=eq%2BQUERY%2FKEY%3D88888","qkey":"[REDACTED_SECRET]", …}
eq__echoErr  → "… Response: [REDACTED_SECRET] url=/echoerr?api_key=eq%2BQUERY%2FKEY%3D88888"
```

The encoded key is also in `GET /api/traces` (error field) and in
`GET /api/artifacts/eq` (live-verification detail). It affects any key
containing characters that need encoding, such as base64-style keys with
`+ / =`. Purely alphanumeric keys are scrubbed.

Fix: also register `url.searchParams`-encoded and `encodeURIComponent`
forms of query keys (and of Basic parts, if they can appear in URLs).

### Minor

| # | Finding | Repro / location |
|---|---|---|
| n12 | With no `mcpToken` and no `clients` on loopback, all HTTP clients share the principal `http:local`, so any client can spend any approval. Neither the docs nor the `start` banner say so | `notok.mjs`: agent B (2026) consumed agent A's (2025) approval → `{"deleted": 9}`; `src/server/http.ts:95`, `mcp.ts:93` |
| n13 | The spec-download guard checks DNS, then fetches separately. **Accepted for operator-supplied URLs.** Two undocumented fall-throughs: DNS rebinding, and a guard lookup error (`.catch(() => [])`, `import.ts:52`), which fails open. The limitation is only in a code comment, and CHANGELOG:91 says "the same SSRF rules as tool calls", which are connect-time | test DNS preload: `public.test` (guard sees 93.184.216.34, connect → 127.0.0.1) → `INTERNAL HIT GET /rebind`; `fail.test` (guard lookup throws) → `INTERNAL HIT GET /failopen`. Fix: one connect-time `lookup` in an undici `Agent`, and treat a lookup error as a block |
| n14 | A literal credential in config (no `${env:}`) is accepted, never registered for scrubbing (`http-executor.ts:177`), echoed in full, and stored in trace paths. The evaluator reports `credentials configured — no authentication configured` and `doctor` says "All good" | integration `el` with `value: "literal-KEY-99999"` → `el__echo` returns it. Fix: reject or warn on literals, and register every resolved credential |
| n15 | Per-call approval args are stored and shown to the approver *redacted* (`approvals.ts:78`), so a person may approve `deleteUser {"email":"[REDACTED_EMAIL]"}` without seeing the target. The hash still binds the exact call, so this is a usability and safety gap, not a bypass | code review |
| n16 | `usage` lists a hidden write composite (approved without `--allow-writes`) as status `in use` | ws3: `flow__updateProductFlow 0 … in use` while `doctor` reports it hidden |
| n17 | `tokenMatches` requires the exact scheme `Bearer `. A client sending `bearer x` gets 401, though RFC 7235 schemes are case-insensitive | `http.ts:31` |
| n18 | Commands run in a directory with no config silently create `.toolsmith/` there (e.g. `enable shop` → "No integration or tool named shop") | running `enable` in a scratch dir |
| m3 | (round 1, still open) no `list_changed` for 2025-11-25 HTTP clients | `{ legacy: 0, auto: 2 }` |
| n5 | (round 2, still open) wrong `ask` binding | above |

## Spec-download SSRF probes

Each of these was a `toolsmith-mcp import <url>` with no
`--allow-private-network`, run against an internal listener on `[::]:7442`.

| Shape | Result |
|---|---|
| `127.0.0.1`, `localhost`, `[::1]`, `0.0.0.0`, `[::]` | blocked |
| `[::ffff:127.0.0.1]`, `[0:0:0:0:0:ffff:7f00:1]`, `[::ffff:0:127.0.0.1]`, `[::127.0.0.1]` | blocked |
| `2130706433`, `0x7f.1` | blocked (normalised to `127.0.0.1`) |
| name resolving to `::1` | blocked: `six.test … resolves to private address ::1` |
| public name → 302 to `127.0.0.1`, `[::ffff:7f00:1]`, `localhost`, double redirect | blocked at the private hop |
| public name → 302 to `file:///etc/passwd` | `Refusing to fetch the spec over file:` |
| DNS rebinding (guard sees public, connect gets loopback) | **reached the internal listener** (accepted TOCTOU, n13) |
| guard lookup error, connect resolves | **reached the internal listener** (n13) |

Result: 17 of 17 static shapes blocked. The internal listener received only
the 2 TOCTOU probes.

I judge the TOCTOU **acceptable for release**:

- spec URLs come only from the operator (CLI, config, or the
  admin-token-protected API), never from an agent;
- tool calls, which agents drive, keep the connect-time guard.

It should be documented, and the fail-open closed.

## Commands and key output

### Checks (fresh `git archive HEAD` copy)

```
ci=0 lint=0 fmt=0 tc=0 build=0 test=0 audit=0 pack=0 inst=0
All matched files use Prettier code style!
 Test Files  7 passed (7)
      Tests  97 passed (97)
found 0 vulnerabilities
0.1.0
DIST-IDENTICAL
a141c315b631c6996271714fc0f63dffe7e7fb3b  toolsmith-mcp-0.1.0.tgz   (identical in two clean builds)
$ actionlint .github/workflows/*.yml                     → exit 0
$ PATH=<shellcheck>:$PATH actionlint …                    → pages.yml:53 SC2034 warning (unchanged file)
$ awk … CHANGELOG.md (release notes for 0.1.0)            → 91 lines
$ test "v$(node -p 'require("./package.json").version')" = v0.1.0 → ok
```

### End-user path (installed tarball)

```
$ toolsmith-mcp init                → .env -rw------- with fresh tokens; config has mcpToken + adminToken
$ toolsmith-mcp import http://127.0.0.1:7440/openapi.json --name shop --token-env SHOP_TOKEN
  Error: Refusing to download the spec from 127.0.0.1:7440: it resolves to private address 127.0.0.1
$ … --allow-private-network         → 11 operations, live verification 8/8
$ echo yes | toolsmith-mcp approve shop | approve --yes | approve-call <id> | publish | enable | rollback
  Error: This action grants access and needs a person at an interactive terminal.
  → … it is not a security boundary against software running as your user (docs/SECURITY.md).
$ toolsmith-mcp start > log         → "Dashboard: … (sign in with TOOLSMITH_ADMIN_TOKEN)"; admin token in log: 0
$ toolsmith-mcp client-config       → stdio + HTTP snippets (HTTP has no X-Toolsmith-Session: N5)
$ toolsmith-mcp discover            → 3 composites awaiting_approval (read flows evaluated; write flow ordered)
$ toolsmith-mcp usage               → flow__getOrdersUserDetails 2 calls, 14 round-trips saved
$ toolsmith-mcp doctor              → All good. (fresh workspace)
$ toolsmith-mcp demo --port 7431    → steps 1–7; "8 MCP calls → 1; 194 ms sequential vs 60.1 ms composite"
  MCP clients (both eras) list 10 tools, call the flow, shop__deleteProduct → Unknown tool
  SIGINT → temp dir removed
```

### MCP compatibility

```
[legacy] negotiated 2025-11-25 | [auto] negotiated 2026-07-28 (HTTP)
[stdio legacy] negotiated 2025-11-25 | [stdio auto] negotiated 2026-07-28
tools 12, destructive annotated; getProduct → structuredContent; missing param / bad type → clear errors
list_changed: HTTP { legacy: 0, auto: 2 }; stdio legacy 1, stdio auto 1 (one disable from another process)
```

### Scenarios (by hand, on top of the suite)

```
S3/4 auth (wrong / expired token): [25–29 ms] The API rejected the credentials (401) … check SHOP_TOKEN.
S5 rate limit (1 rps API, 5 parallel calls): OK | OK | OK | 429 "Wait before retrying." ×2
S6 404: Not found (404). Response: {"error":"order not found"}
S7 missing: Invalid arguments for shop__getOrders: missing required "userId"; bad type: id must be integer
S10 repeated workflows: found with X-Toolsmith-Session (support 4 each); not found without it (N5)
S13 unauthorized write: shop__deleteProduct → Unknown tool (read-only grant)
Suite: scenarios 1–14 all pass (verbose run; S8 timeout, S9 partial, S11/12, S14 rollback via suite)
```

### Credential scrubbing

```
eb__echo     OK {"auth":"Basic [REDACTED_SECRET]","decodedB64":"[REDACTED_SECRET]:[REDACTED_SECRET]","keyed":{"Basic [REDACTED_SECRET]":1,…}}
ek__echo     OK {"key":"[REDACTED_SECRET]", "keyed":{"[REDACTED_SECRET]":2,…}}
eb__echoErr  ERR … Response: Basic [REDACTED_SECRET] url=/echoerr
eb__echoErr {pad:263} → … Basic ZWNob3VzZXI6ZWNoby1QQVNTLTU1NTU      ← N6
ek__echoErr {pad:282} → … ek-HEADER-KEY-7777                          ← N6
eq__echo     OK {"url":"/echo?api_key=eq%2BQUERY%2FKEY%3D88888", "qkey":"[REDACTED_SECRET]"}  ← N7
DB/WAL: full Basic base64 0, password 0, header key 0, MCP/admin tokens 0;
        prefix "ZWNob3VzZXI6ZW" 8, "ek-HEADER-" 4, "eq%2BQUERY%2FKEY%3D88888" 9
```

### Benchmarks

The committed `performance.json` (results commit `8a4fd8b`) has these
order-details medians:

| API latency | Sequential | Parallel client | Composite |
|---|---|---|---|
| 0 ms | 7.97 ms | 4.52 ms | 1.96 ms |
| 25 ms | 251.07 ms | 67.48 ms | 63.31 ms |
| 50 ms | 458.43 ms | 120.91 ms | 115.34 ms |

They match all three published copies:

- **README:** 8.0/4.5/2.0, 251.1/67.5/63.3, 458.4/120.9/115.3, and
  "chain gains 3–6%" (5.5 / 4.6 / 2.5%).
- **REPORT.md:** same values.
- **Built site:** rounded to 3 significant figures; "+5% to +9% faster
  … treat as noise".

The other published numbers also match the JSON:

- Patterns: F1 0.97 and baseline 0.84 match the JSON, and
  "ids 1..10 precision 0.69" matches REPORT.md.
- Scalability: 1994 calls/s, p95 58.61 ms at 100 clients.

My own runs:

- **3 × `npm run benchmark -- --quick`** (clean copy, with my mock servers
  running). At order-details @25 ms, sequential was 280–291 ms and the
  composite 69 ms. The dependent chain @25 ms ran 99–109 ms sequential and
  91–102 ms composite, so the chain was inverted once.
- **`benchmark:check`:** passed 3/3.

The quick numbers are 10–15% higher than the committed full run, but the
shape is the same. The full `performance.mjs` run is NOT RUN this round;
round 2 reproduced it within a few %.

## Known limitations of this validation

- **NOT RUN:**
  - the Docker build and run;
  - the real release tarball URL;
  - `gh release create`, and real GitHub Actions and Pages runs;
  - a full (non-quick) benchmark run;
  - a public spec over the internet. Public DNS was simulated with a
    test-only `dns` preload;
  - browser rendering of the dashboard and site;
  - HTTP upstream MCP servers;
  - an exercised m16 cap (code review only).
- **Scratch overlap.** My scratch directory also held files from an earlier
  session. I therefore re-ran the clean checks, pack and install in a new,
  empty directory; the results above come from that run. One workspace's
  config contained four stale integrations from that earlier session. They
  did not affect the pattern test, and the m5 check was repeated in a fresh
  workspace.
- **Setup used the documented bypass.** To grant tools for setup, I ran
  granting commands through `script` to supply a TTY: the N3 bypass, which
  is now documented.

## Release recommendation

**Release after fixing listed items.**

Must fix before a public release:

1. **N6.** Redact the whole error body, then truncate. Fix the `\b` in the
   `Basic` / `Bearer` patterns.
2. **N7.** Register the URL-encoded forms of query API keys.
3. **N5.** Put `X-Toolsmith-Session` in the `client-config` HTTP snippet,
   and correct `docs/MCP-INTEGRATION.md:60-61`.
4. **Publication checks.** Verify the release tarball URL once v0.1.0 is
   tagged, and run the Docker build once the daemon is available.

Should fix soon:

- n12: document, or warn at `start`, that with no token all clients share
  one identity;
- n13: document the spec-download TOCTOU and make lookup errors block;
- n14: reject or warn on literal credentials.

The rest (n15–n18, m3, n5) can be normal issues.
