# Final validation report (round 8): toolsmith-mcp

- **Date:** 2026-11-08 (+03)
- **Commit validated:** `e476a48` (`e476a48516b69771a534951724328edb42fc3d9c`),
  branch `main`, clean tree. The builder says it fixes round 7's V1 to V5.
- **Validator:** independent release-gate pass. Every result below comes
  from a command I ran in this round. Anything not run is marked NOT RUN.

## Environment

| Item | Value |
|---|---|
| OS | macOS (Darwin 27.2.0), Apple Silicon |
| Node / npm | v22.13.1 / 10.9.2 |
| Clean copy | fresh `git archive e476a48` into an empty directory, `npm ci` |
| Not run | Docker build, GitHub CI and Pages, Node 24, browser rendering of the dashboard, any Anthropic API call |

Probe scripts, the clean copy, the tarball prefix and the CLI workspace all
lived in the session scratchpad, outside the repo. Real specs were
downloaded fresh this round. Every server I started was stopped: no node
listeners and no `toolsmith`/shop processes at the end. The only file
written in the repo is this report.

## Verdict

**Release after fixing listed items.** No Critical findings. One Major
finding (W1, a V4 residual, with a false doc claim). V1, V2, V3 and V5 are
fixed. The rest are Minor.

| Round-7 item | Status |
|---|---|
| V1 invisible characters | **Fixed** for every agent-visible channel tested (OpenAPI 3.0/3.1, Swagger 2, GraphQL, Postman). Reviewer-only residue: W5 (Minor) |
| V2 recorded values | **Fixed.** `examples: []`, only `exampleTraceIds` stored. No recorded value in any table except `traces`. Read composites still pass equivalence from traces |
| V3 constants | **Fixed.** Numbers (`mobile`, `number`, `amount`, `limit`) are inputs. Only booleans and spec enums are baked. No literal disagrees with a same-named input |
| V4 dropped arguments | **Partial.** Booleans, sensitive-named args and strings over 256 characters are kept. `""`, `null`, `[]` and `{}` are still dropped (W1, Major) |
| V5 size limit | **Fixed.** Twilio, OpenAI `manual_spec` and OpenAI `master` all reach `awaiting_approval`. The largest single tool is 3,854 strings, under the 5,000 limit |
| V6 other invisible classes | **Mostly fixed.** The round-7 list is now stripped and escaped. U+16FE4 and U+1D159 survive (W3, Minor) |
| V7 percent-encoded path | **Partial.** The round-7 repro now fails evaluation. A malformed escape or double encoding still bypasses the check (W4, Minor) |

## Findings

| # | Sev | Finding | Location | Repro / evidence |
|---|---|---|---|---|
| W1 | **Major** | Mined composites still silently drop arguments whose value is `""`, `null`, `[]` or `{}`, or a body made only of such values. The fingerprinter emits no leaf for them, so they never reach the pattern or plan. A recorded "clear the field" PATCH becomes a no-op. Write plans skip the equivalence test, so evaluation passes. `CHANGELOG.md:125` and `docs/TOOL-GENERATION.md:78` say "none is silently dropped", which is false | `src/security/redact.ts:182` (`v.length > 0`), `:187-193` (empty array/object/null produce no leaf) | `qa8/empty8.mjs`: direct call `PATCH /a?issue=I-0&desc=` × 5 → composite `PATCH /a?issue=I-9` (no `desc`). `qa8/empty9.mjs`: direct `body={"assignee":null,"labels":[]}` × 5 → composite step `{"issue":…}`, upstream `PATCH /a?issue=I-9` with **no body**; status `awaiting_approval` |
| W2 | Minor (new in e476a48) | `cleanText` (NFKC plus Cf removal) now runs on value-bearing schema parts: enum, const, default, pattern, parameter names and the path. Spec values with compatibility characters or ZWNJ are rewritten, and the original value is refused by validation, so it can never be sent. `docs/SECURITY.md:34` says text "Arabic included, is unchanged", but Arabic presentation forms are normalised and U+061C and ZWNJ are removed | `src/openapi/schema-utils.ts:60`, `src/openapi/import.ts:592-599` | `qa8/nfkc8.mjs`: enum `["m²","نیم‌فاصله","ﻻ","ﬁle"]` is shown as `["m2","نیمفاصله","لا","file"]`. Upstream gets `unit=m2`; the original value gets `REFUSED … must be equal to one of`. Ordinary Arabic (`مرحبا بالعالم`) is unchanged |
| W3 | Minor | Two invisible combining marks survive `INVISIBLE`: U+16FE4 (Khitan filler) and U+1D159 (null notehead). They split tripwire keywords and appear raw in in-client prompts | `src/openapi/schema-utils.ts:73-75` | `qa8/poison3.mjs`: `<IMP{U+16FE4}ORTANT>` in summary → `awaiting_approval … invisibleChar=KEPT`. `qa8/vis8.mjs`: `in-client prompt: RAW = U+16FE4,U+1D159` (21 others escaped) |
| W4 | Minor (V7 residual) | `safeDecode` falls back to the raw path when any escape is malformed, and decodes only once. A `%ZZ` segment or double encoding hides a percent-encoded payload, which reaches the tool description | `src/evaluator/evaluator.ts:276` | `qa8/pct.mjs`: single-encoded → `failed`. `%ZZ/` + encoded → `awaiting_approval agentSees=YES`. `%E0%A4/` + encoded → YES. Double-encoded → YES |
| W5 | Minor | TAG text is stripped from everything agents see, but the stored definition shown by `show --json`, `/api/artifacts/<name>` and the dashboard still has it raw in `operationId`, `tags[]`, finding messages (raw path) and the GraphQL `document`. The text is invisible to a reviewer but never reaches the agent | `src/openapi/import.ts:592` (`sanitizeOperation` skips these), findings built from the raw path | `qa8/poison2.mjs`: `agentTools=clean` in all 19 cases. `storedDefInvisible` is >0 for path param name, operationId, tags, GraphQL and Postman. `show` prints 0 TAG chars; `show --json` has `"operationId": "get<TAG>"`. Admin `/api/artifacts/p` has 15 occurrences; `/api/tools` and `/api/overview` have 0 |
| W6 | Minor | Now that sensitive-named arguments are kept as inputs (V4 fix), any mined read composite with such an input can never auto-evaluate: every trace example contains `[REDACTED]` and is skipped. It fails closed with "no example input" | `src/app.ts:602` | `qa8/comp8.mjs read` (with `api_token`): `equivalence test=FAIL(no example input…)`. The same flow without `api_token` (`comp8b.mjs`): `equivalence #1..#3=ok` |
| W7 | Minor (doc) | `docs/PAPERS.md:94-95` still says an argument with the same fingerprint in every occurrence is baked as a literal. Only booleans and enums are | `docs/PAPERS.md:95` | Read |

Carried over and not re-tested this round: V8 (draft-07 Ajv and
`prefixItems`) and V9 (miner folds unrelated calls into a loop; fails
closed).

## Docs accuracy

| Doc | Status |
|---|---|
| `CHANGELOG.md:117-119` (invisible characters removed from every agent-readable string and key) | **Accurate** for every channel tested. Two filler marks are missed (W3) |
| `CHANGELOG.md:120-121` (5,000 strings per tool) | **Accurate** |
| `CHANGELOG.md:122-124`, `README.md:39`, `docs/TOOL-GENERATION.md:72-76` (booleans and enums only) | **Accurate** |
| `CHANGELOG.md:125`, `docs/TOOL-GENERATION.md:77-78` ("none is silently dropped") | **False** (W1) |
| `CHANGELOG.md:126-127`, `docs/TOOL-GENERATION.md:79-82` (recorded values out of definitions) | **Accurate** |
| `docs/SECURITY.md:34` | **Mostly accurate.** "Text in any script, Arabic included, is unchanged" is not true for presentation forms, ALM and ZWNJ, and value-bearing keywords are rewritten (W2) |
| `CHANGELOG.md` in-client prompt escapes | **Mostly accurate** (W3) |
| `docs/PAPERS.md:95` | **Stale** (W7) |

## Commands and key output

### CI-equivalent checks (fresh `git archive e476a48`, `npm ci`)

```
ci=0 lint=0 format:check=0 typecheck=0 build=0 test=0 audit=0 site=0 sitecheck=0
All matched files use Prettier code style!
 Test Files  15 passed (15)
      Tests  141 passed (141)
npm audit --omit=dev → found 0 vulnerabilities
node site/build.mjs → Built site/dist (31 KB HTML).
node site/check-links.mjs → Link check passed (22 external links not fetched).
```

### Tarball, demo, doctor

```
npm pack → toolsmith-mcp-0.1.0.tgz, total files: 142
npm i -g --prefix <tmp> ./toolsmith-mcp-0.1.0.tgz → install=0; --version 0.1.0
toolsmith-mcp demo --port 7641 (stopped with SIGINT):
  2. Imported its OpenAPI spec: 11 operations → evaluation passed
  5. Discovered workflow (4 sessions) → proposed flow__getUserOrdersDetails: awaiting_approval
     evaluator: identical results; 8 MCP calls → 1; 196.1 ms sequential vs 48.2 ms composite
  7. Capability check "…latest order and show its payment status": composable
workspace: init=0; import <shop>/openapi.json --allow-private-network=0 (live verified)
approve (CLI, no TTY) → refused: "needs a person at an interactive terminal" (expected); approved via admin API POST /api/artifacts/shop/approve → "status":"published"
doctor → ✓ integration shop: published v1 … All good. (exit 0)
```

### MCP

```
[http auto]    negotiated 2026-07-28 | tools 11 | shop__getProduct isError=false structured=true | missing-arg: Invalid arguments … missing required "use…   (demo gateway)
[http legacy]  negotiated 2025-11-25 | tools 11 | (same)                                                                                        (demo gateway)
[http auto]    negotiated 2026-07-28 | tools 10 | shop__getProduct isError=false structured=true                                                   (installed `start --port 7643`)
[stdio legacy] negotiated 2025-11-25 | tools 10 | shop__getProduct isError=false structured=true | missing-arg: Invalid arguments …
[stdio auto]   negotiated 2026-07-28 | tools 10 | (same)
```

### V1: invisible characters (`qa8/poison.mjs`, `qa8/poison2.mjs`)

```
TAG enum / default / const / pattern / property name (body) / param name /
output schema enum / patternProperties key / path key / info.title / op summary / param desc
                                             awaiting_approval failed=[] agentSeesPayload=no
header param name, path param name, items.enum nested, anyOf const, examples, example,
required entry, format, output property key, output nested default, propertyNames pattern,
dependentRequired, component title via $ref, operationId, tag name, info.description,
swagger2 body/formData, graphql (field/arg/enum/input field/defaultValue/description),
postman (name/description/header/path var/path segment/query key/raw body keys)
                                             agentTools=clean (all 19)
invisible U+2800/FFA0/061C/034F/1D173/FFF9/13430/1BCA0/E0001/E0100/FE0F/115F/200C
  split IMPORTANT in summary → failed (tripwire);  in enum → invisibleChar=stripped
invisible U+16FE4 / U+1D159 split IMPORTANT → awaiting_approval invisibleChar=KEPT   (W3)
show: TAG chars 0;  show --json: 66 TAG chars, one line: "operationId": "get<TAG>"    (W5)
in-client prompt: RAW = U+16FE4,U+1D159 ; Arabic note intact
```

### V2 to V4: composites (`qa8/baked.mjs`, `qa8/comp8.mjs`, `qa8/empty8.mjs`, `qa8/empty9.mjs`)

```
baked SPLIT=1: inputs= repo,channel,phone,mobile,number,amount,customer,limit,ssn
  step sendA {…"mobile":{"$ref":"input.mobile"},"number":{"$ref":"input.number"},"amount":{"$ref":"input.amount"},
              "sort":"desc","dry_run":true,"limit":{"$ref":"input.limit"},…}          (sort/ssn are spec enums)
  upstream saw POST /a?…mobile=19990000000&number=7&amount=1&…&sort=desc&dry_run=true&limit=5…
comp8 write: step stepA {…"dry_run":true,"api_token":{"$ref":"input.api_token"},"note":{"$ref":"input.note"} (300 chars),…}
  examples [] exampleTraceIds [3 ids]; definition contains recorded: none
  DB tables other than traces: no recorded value
comp8b read: equivalence #1=ok #2=ok #3=ok (examples read from traces)
empty8: direct PATCH /a?issue=I-0&desc=   → composite PATCH /a?issue=I-9         (W1)
empty9: direct body={"assignee":null,"labels":[]} → composite sends no body      (W1)
```

### V5: real specs (`qa8/real8.mjs`, freshly downloaded)

```
twilio_api_v2010.json: ops=197 total=26045  maxPerTool=393  status=awaiting_approval
openai manual_spec:    ops=148 total=45675  maxPerTool=2852 status=awaiting_approval
openai master:         ops=388 total=123026 maxPerTool=3854 status=awaiting_approval
petstore 916 / slack 12819 → awaiting_approval
stripe: failed — tool names unique (truncated duplicate names), injection tripwire ("you should use ") — not the size limit
```

### V7: percent-encoding (`qa8/pct.mjs`)

```
single-encoded (round-7 repro)  status=failed
encoded in two segments         status=failed
double-encoded                  awaiting_approval agentSees=YES
malformed %ZZ prefix + encoded  awaiting_approval agentSees=YES
lone %E0%A4 + encoded           awaiting_approval agentSees=YES
```

## Release recommendation

Must fix:

1. **W1.** Fingerprint empty strings, `null`, empty arrays and empty
   objects as argument leaves, so they become literals or inputs. Or
   correct `CHANGELOG.md:125` and `docs/TOOL-GENERATION.md:78`. Fixing the
   code is preferred: a dropped "clear" argument silently changes a write.

Should fix: W2 (apply only invisible-character removal, not NFKC, to
value-bearing keywords, names and paths, and correct the Arabic sentence),
W3, W4 (decode per segment, repeat until stable), W5, W6, W7, plus V8 and
V9 from round 7.

## Resolution

All items fixed in the commit after `e476a48`: W1 (empty values fingerprinted with fixed markers that never link calls; they become inputs), W2 (no normalization of visible text; ZWNJ/ZWJ kept; NFKC only on the scanner copy), W3 (U+16FE4, U+1D159 removed), W4 (iterative, per-escape path decoding), W5 (operationId, tags, findings, GraphQL document cleaned), W6 (documented in docs/TOOL-GENERATION.md), W7 (docs/PAPERS.md updated). Regression tests: `test/integration/regressions.test.ts` "R8".
