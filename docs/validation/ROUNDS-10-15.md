# Validation rounds 10–15 (release 0.2.0)

Each round was run by a separate agent that had not written the code and
reported findings with reproductions. Every finding below was fixed, with a
regression test, unless marked otherwise.

## Round 10: OAuth 2.1 resource server

Verdict: ship after fixes. Token cryptography held (30 forgery and
malformed-token cases refused).

| Severity | Finding | Resolution |
|---|---|---|
| Major | Client ids cut at 100 characters lost their restricted exposure | Principals use hashes of the full claim values |
| Major | Ids sharing a 100-character prefix shared approvals | Same |
| Major | `client_id`, `azp` and `sub` mixed in one namespace; users of one client app shared approvals | Principal = client hash + user hash; `sub` never selects a client |
| Minor | JWKS outage answered 401 | Now 500 |
| Minor | No `typ: at+jwt` option, no lifetime cap, future `iat` accepted | `requireAtJwt`, `maxLifetimeSeconds`, `iat` check |
| Minor | Path-less `resource`, key-rotation cooldown undocumented | Documented |
| Minor | Lowercase `bearer` refused for static tokens | Accepted |

## Round 11: OAuth fixes, per-client rate limits, workflows with gaps

Verdict: ship after fixes.

| Severity | Finding | Resolution |
|---|---|---|
| Major | Mining memory grew with the square of session length (3.3 GB at 12,000 calls) | Indexed bindings, bounded carriers: 0.14 s and 132 MB |
| Minor | Committed benchmark results were stale | Regenerated |
| Minor | Kept side calls can mix argument shapes | Documented |
| Minor | OAuth rate limits are per user, per-client exposure needs `client_id`/`azp`, prompts cost a rate token | Documented |

## Rounds 12–13: gRPC sources

Round 12 verdict: ship after fixes. Round 13 confirmed every fix and found
five follow-ups.

| Severity | Finding | Resolution |
|---|---|---|
| Critical | A poisoned method comment did not fail evaluation (finding code mismatch) | Code fixed; the evaluator now scans every operation's text directly |
| Major | A `.proto` with an unknown type crashed the process | Synchronous load inside the error handler |
| Major | Side-effecting names (`CheckOut`, `FindOrCreate`, `GetAndDelete`) classified as reads | Word-based classification; delete words always destructive |
| Major | No byte cap on streams; streams cut at the deadline lost everything | 5 MB cap; partial results with `truncated` |
| Major | `include`/`exclude` ignored | Applied |
| Major (13) | `Batch…` names read-classified | Only `BatchGet…` and other read verbs |
| Minor | Wrapper and enum outputs failed schema checks; case-only duplicate names; reflection file cap; transport check; client leaks; oauth auth accepted then failed | Fixed |
| Minor (13) | Swapped clients cut in-flight calls; silent streams reported success; `?` in globs; empty imports passed | Fixed |
| Open | Node DEP0123 warning for TLS to an IP literal | Not changed |

## Rounds 14–15: PostgreSQL storage and async storage

Round 14 verdict: ship after fixes. Approvals were spent exactly once under
180-way contention across six nodes.

| Severity | Finding | Resolution |
|---|---|---|
| Critical | A dropped connection inside a transaction crashed the node | Error listener for the checkout; broken clients destroyed |
| Major | The catalog revision was bumped after commit, so a crash could leave nodes serving a disabled tool | Bumped inside the same transaction; disable window documented |
| Major | A transaction body using the top-level handle hung forever | Refused with an error (AsyncLocalStorage guard) |
| Minor | Placeholder rewriter ignored comments, dollar quotes, `E''` strings, jsonb `?` | Rewritten with tests |
| Minor | Unique violations retried 8 times | Retried once |
| Minor | Proposal cap is per node | Documented |

Round 15 re-checked every fix (verdict: ship): dropped connections are
errors and the pool recovers, disable reaches other nodes within the
documented window, the guard refuses misuse without misfiring on 200
interleaved operations, and approvals stayed single-spend across six nodes.
Its one latent finding (the SQLite guard threw synchronously) was fixed
before release. Transaction bodies must not start work that outlives them.
