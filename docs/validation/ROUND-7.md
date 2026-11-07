# Final validation report (round 7): toolsmith-mcp

- **Date:** 2026-11-08 (+03)
- **Commit validated:** `c5e6da9` (`c5e6da90d08ac611023bc5391001714d5fdf66fa`),
  branch `main`, clean tree. The builder says this commit fixes round 6's
  N1–N4, N7 and N13.
- **Validator:** independent release-gate pass. Every result below comes from
  a command I ran in this round. Anything I did not run is marked NOT RUN.

## Environment

| Item | Value |
|---|---|
| OS | macOS (Darwin 27.2.0), Apple Silicon |
| Node / npm | v22.13.1 / 10.9.2 |
| MCP client | `@modelcontextprotocol/client` from the installed tarball's own dependencies |
| Not run | Docker build, GitHub CI and Pages, real MCP client UI or browser rendering, any Anthropic API call, Node 24 matrix leg |

All scratch work was outside the repo: a `git archive c5e6da9` extraction
(`w/`), probe scripts (`qa/*.mjs`), the five real specs downloaded in round 6,
an `npm pack` tarball installed with `npm i -g --prefix <tmp>`, and a CLI
workspace. The `w/` directory was reused from an earlier round. I overwrote it
with the archive and ran `npm ci`. Comparing it with `git ls-tree c5e6da9`
showed no extra files apart from generated `site/dist/` output, which the
site build regenerates. I stopped every server I started:
`lsof -iTCP -sTCP:LISTEN` showed no node listeners, and
`pgrep -fl 'toolsmith|shopsrv'` returned nothing. The only file I wrote in
the repo is this report.

## Verdict

**Release after fixing listed items.** There are no Critical findings and
five Major findings: V1 to V3 are residuals of N2 and N3, V4 is new and
pre-existing, and V5 is a new regression.

| Round-6 item | Status |
|---|---|
| N1 title / path / 20,000-string scan | **fixed** for the reported repros; **partial** for variants (V1, Minor V7) |
| N2 Unicode TAG characters | **partial**: stripped from descriptions, titles and summaries only. **Not fixed** for enum, default, const, pattern, property and parameter names, and paths (V1, Major) |
| N3 baked constants | **partial**: free text is no longer baked, and no literal disagrees with a same-named input. Numbers (including an integer phone number) are still baked, and recorded phone numbers are stored in definitions (V2, V3, Major) |
| N4 `format:check` | **fixed** |
| N7 `patternProperties` / `prefixItems` | **partial**: `patternProperties` is fixed. Valid `prefixItems` calls are still refused (V8, Minor) |
| N13 discover orphan loop | **fixed**: no crash in 6 loop-pattern variants |

## Findings

| # | Sev | Finding | Location | Repro / evidence |
|---|---|---|---|---|
| V1 | **Major** | TAG ("ASCII smuggling") payloads still reach the agent, with evaluation passing and the payload invisible to the reviewer, through every agent-visible string except descriptions, titles and summaries. `cleanText` runs only on `description`/`title` keys and on operation text. `detectInjection` *strips* TAG characters before matching, so the tripwire cannot see a TAG payload anywhere. `show`, `show --json` and the dashboard `<pre>` print the characters raw | `src/openapi/schema-utils.ts:100`, `src/openapi/import.ts:591`, `dashboard/app.js:311`, `src/cli/index.ts` (`show`) | `qa/poison.mjs`: TAG in enum, default, const, pattern, body property name, query parameter name, path key, output-schema enum, and `patternProperties` key → `awaiting_approval failed=[] agentSeesPayload=YES` (9 channels). `show` / `show --json` on a TAG path and parameter: `TAG chars present: 225 / 675, escaped-form present: False` |
| V2 | **Major** | Recorded argument values, including phone numbers, are stored in composite definitions. `examples` copies the first call's raw recorded args for every input (default `captureArguments: "redacted"` redacts sensitive keys only). These are also replayed live as evaluation inputs. This was not addressed by c5e6da9 | `src/patterns/miner.ts:626`, `src/composite/generator.ts:217` | `qa/baked2.mjs` (5 real sessions through `app.call`): `examples [{"repo":"secret-repo","channel":"C0PRIVATE","phone":"+15551234567","customer":"cus_123"}, …]`; `stored version row contains phone=+15551234567` |
| V3 | **Major** | Numbers are always baked, even when they are a target or personal data. On a POST first step, `number: 42`, `amount: 500` and an integer phone `mobile: 15551234567` become literals and are not exposed as inputs. The composite then always acts on issue 42 / amount 500 / that phone number | `src/composite/generator.ts:142-153` | `qa/baked.mjs` (`SPLIT=1`): step `sendA {…"mobile":15551234567,"number":42,"amount":500,…}`; called with other values → `upstream saw POST /a?…&mobile=15551234567&number=42&amount=500…` |
| V4 | **Major** (new, pre-existing since `32453b6`) | Boolean arguments, sensitive-key arguments and strings over 256 characters are silently **dropped** from mined composites, because fingerprints skip them. `dry_run: true`, sent in 5 of 5 recorded POSTs, is not sent by the composite, so it performs the real write. CHANGELOG, README and TOOL-GENERATION say booleans are *baked*. They never are | `src/security/redact.ts:175-186` (no boolean branch, `isSensitiveKey` skip) | `qa/baked.mjs`: pattern args have no `dry_run` key; `upstream saw POST /a?repo=…&limit=50` (no `dry_run`); eval `awaiting_approval` |
| V5 | **Major** (regression) | The new 20,000-string limit is **per integration** (the sum over every operation), not per schema. Twilio and both OpenAI specs, which passed in round 6 (R5-9 was the OpenAI fix), now fail evaluation by default | `src/evaluator/evaluator.ts:110-121` | `qa/real7.mjs`: petstore 916 strings → awaiting; slack 12,819 → awaiting; **twilio 26,045 → failed; openai `manual_spec` 45,675 → failed; openai `master` 123,026 → failed**; stripe 97,050 → failed (it also failed before, for other reasons) |
| V6 | Minor | Other invisible format characters survive `cleanText` and split tripwire keywords: U+2800, U+061C, U+034F, U+1D173, U+FFF9, U+13430 and U+1BCA0. U+FFA0 is caught (NFKC maps it to U+3164). The approval prompt (`visibleJson`) leaves U+061C, U+034F, U+2800, U+115F, U+1160, U+FFA0, U+1D173, U+FFF9, U+13430 and U+1BCA0 raw. The TAG block and U+FE0F, U+3164 and U+180E are now escaped | `src/openapi/schema-utils.ts:63-69`, `src/server/mcp.ts:18-23` | `qa/poison.mjs split`: `<IMP{ch}ORTANT>` → `awaiting_approval … agentSeesPayload=YES` for the 7 listed; `qa/vis.mjs`: `U+061C RAW`, `U+034F RAW`, `U+2800 RAW`, … |
| V7 | Minor | A percent-encoded payload in a path key passes the scan and reaches the tool description verbatim | `src/evaluator/evaluator.ts:93` (raw `op.path`) | `path key url-encoded … status=awaiting_approval failed=[] agentSeesPayload=YES(id_rsa,IMPORTANT)` |
| V8 | Minor (N7 residual) | Ajv runs in draft-07 mode, so `prefixItems`, `minContains` and `dependentRequired` are kept in the schema but not understood. A valid `["a",1]` for `prefixItems` + `items:false` is refused, as is `[1,"x"]` for `prefixItems` + `items:{type:string}` and `[]` for `contains` + `minContains:0`. `maxContains`, `dependentRequired` and `unevaluatedProperties:false` only loosen validation | `src/gateway/validation.ts:12` | `qa/pp.mjs`: `BAD prefixItems + items:false … got=invalid: 0 boolean schema is false` (5 BAD, 10 OK) |
| V9 | Minor | The miner folds unrelated calls into a loop element. These composites fail equivalence, so the error fails closed | `src/patterns/miner.ts` | `qa/disc7.mjs`: `shop__listOrders > loop(shop__getUser+shop__getOrders)` → `failed` (equivalence) |

## Docs accuracy

| Doc | Status |
|---|---|
| `docs/SECURITY.md:34` | **Mostly accurate.** It now scopes stripping to "the API title, operation text and schema descriptions", which is correct. Two gaps remain. "Every string anywhere in the input and output schemas [is] scanned" is literally true, but the scan cannot see TAG payloads (V1). The text also implies that `show --json` and the dashboard let a reviewer see the full text, yet TAG text in those strings is invisible. The 20,000 limit is described accurately ("an integration with more than…"), but not its effect on real specs (V5) |
| `CHANGELOG.md:112-113` | **Overclaims.** "Agent-visible schemas … invisible characters (including Unicode tags) are stripped" is false for enum, default, const, pattern, property names and paths (V1) |
| `CHANGELOG.md:117-118` | **Overclaims.** "`show` … give[s] reviewers the full text and schemas": `show` lists top-level parameters only, and TAG text is invisible everywhere |
| `CHANGELOG.md:119-121` | **Inaccurate.** Booleans are never baked; they are dropped (V4). "Never ids or free-text strings" is true for strings. Numeric targets are baked (V3) |
| `CHANGELOG.md:124` | **Partial.** "Show invisible characters as escapes" is true for the listed set, not for V6 |
| `README.md:39`, `docs/TOOL-GENERATION.md:72-76` | **Inaccurate** on booleans (V4) |

## Commands and key output

### CI-equivalent checks (`git archive c5e6da9` extraction, `npm ci`)

```
ci=0 lint=0 fmt=0 tc=0 build=0 test=0 testsec=0 audit=0
Checking formatting... All matched files use Prettier code style!
 Test Files  15 passed (15)
      Tests  137 passed (137)
test:security  Tests  15 passed (15)
npm audit --omit=dev --audit-level=high → found 0 vulnerabilities
CI smoke: --version 0.1.0; init → files-ok; doctor → "All good." exit 0
node benchmarks/scripts/performance.mjs --quick → 0; patterns.mjs --quick → 0
npm run benchmark:check → Benchmark regression checks passed.
```

### Tarball

```
npm pack → toolsmith-mcp-0.1.0.tgz (142 files); npm i -g --prefix <tmp> → --version 0.1.0
toolsmith-mcp demo --port 7631 (SIGINT after 45 s):
  2. Imported its OpenAPI spec: 11 operations → evaluation passed
  5. Discovered workflow (4 sessions) → proposed flow__getUserOrdersDetails: awaiting_approval
     evaluator: identical results; 8 MCP calls → 1; 194.9 ms sequential vs 61.7 ms composite
  7. Capability check "…latest order and show its payment status": composable
import (no flag) → Refusing … private address 127.0.0.1
import --allow-private-network → live verification 8/8 verified
approve shop --allow-writes --allow-destructive (TTY via script, typed yes) → shop v1 is published
doctor → ✓ integration shop: published v1 … All good. (exit 0)
start --port 7633 → "Streamable HTTP, protocol 2025-11-25 and 2026-07-28", "Tools: 13 exposed"
patterns / discover (CLI) → "No repeated workflows found yet." (exit 0; the MCP traffic did not form a pattern; N13 was verified through the API, below)
```

### MCP (`qa/mcp7.mjs`, installed CLI)

```
[http legacy]  negotiated 2025-11-25 | tools 13 | getProduct ok=true structured=true | missing: … missing required "userId" | unknown: Unknown tool "shop__nope" … | destructive: … needs a human to approve this e
[http auto]    negotiated 2026-07-28 | (same)
[stdio legacy] negotiated 2025-11-25 | (same)
[stdio auto]   negotiated 2026-07-28 | (same)
```

### Site

```
node site/build.mjs → Built site/dist (31 KB HTML).
node site/check-links.mjs → Link check passed (22 external links not fetched).
```

### Poisoning (`qa/poison.mjs`, abbreviated)

```
info.title canonical / path key canonical            status=failed  (N1 repro fixed)
enum 20001 then poison                               status=failed failed=[schema text reviewable]
spread over 30 ops x 1000 strings                    status=failed
info.title TAG / TAG op summary / TAG param desc     awaiting_approval agentSeesPayload=no   (stripped)
operationId canonical / tags[] / server description  awaiting_approval agentSeesPayload=no
path key TAG                                         awaiting_approval failed=[] agentSeesPayload=YES
TAG enum / default / const / pattern                 awaiting_approval failed=[] agentSeesPayload=YES
TAG property name (body) / param name                awaiting_approval failed=[] agentSeesPayload=YES
TAG output schema enum / patternProperties key       awaiting_approval failed=[] agentSeesPayload=YES
path key url-encoded                                 awaiting_approval failed=[] agentSeesPayload=YES
canonical in patternProperties / if-then / prefixItems  status=failed  (newly allowed keywords are scanned)
```

### Composites (`qa/baked.mjs`, `qa/baked2.mjs`)

```
shared case: every step uses input.repo/channel/phone/…; called with OTHER values → upstream saw OTHER values (fixed)
SPLIT=1:  step sendA {"repo":{"$ref":"input.repo"},…,"mobile":15551234567,"number":42,"amount":500,…,"sort":"desc","limit":50}
          upstream saw POST /a?repo=OTHER-repo&…&mobile=15551234567&number=42&amount=500&…   (no dry_run)
baked2:   examples [{"repo":"secret-repo","channel":"C0PRIVATE","phone":"+15551234567","customer":"cus_123"},…]
          stored version row contains phone=+15551234567
```

### Discover (`qa/disc7.mjs`, 5 sessions each)

```
listOrders > loop getUser > getOrders     errors=[]  (was: Cannot read properties of undefined)
unrelated call between source and loop    errors=[]
two loops over one source                 errors=[]
nested: loop over loop results            errors=[]  flow__getOrdersOrderDetails: awaiting_approval
loop then call then loop (2nd source)     errors=[]
```

## Release recommendation

Must fix:

1. **V1.** Apply `cleanText` (or reject) to every string kept in an
   agent-visible schema (enum, const, default, pattern, property and
   parameter names) and to paths. Make `detectInjection` *flag* TAG and
   other `\p{Cf}` characters instead of silently stripping them before
   matching.
2. **V2, V3.** Do not store recorded argument values in `examples`; at
   minimum drop free-text values. Bake numbers only when the schema bounds
   them (enum, or small `minimum`/`maximum`), never on a write step's target.
3. **V4.** Fingerprint booleans (and keep sensitive-key args as inputs) so
   recorded arguments are never silently dropped. Fix the "booleans are
   baked" docs.
4. **V5.** Apply the limit per schema, not per integration, or let the
   operator approve past it. Otherwise OpenAI and Twilio do not import.
5. Correct `CHANGELOG.md:112-124` as listed above.

Should fix: V6, V7, V8 (use Ajv 2020 for 2020-12 keywords), V9.
