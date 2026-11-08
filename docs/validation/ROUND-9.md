# Validation round 9

Independent agent, commit `862ac94`. **Verdict: release.** No Critical or
Major findings. All round-8 fixes (W1–W5) were confirmed end to end; build,
lint, typecheck, format and 146 tests passed.

## Minor findings

| Id | Finding | Resolution |
|---|---|---|
| M1 | A run of escapes mixing valid UTF-8 with one invalid byte was decoded as Latin-1, garbling the valid part; decoding stopped after 5 layers | Runs decode as UTF-8 with invalid bytes replaced; decoding loops until the text stops changing |
| M2 | U+FE0F was stripped from enum values, breaking emoji such as `❤️`; docs overstated exact spelling | U+FE0E/U+FE0F are kept right after an emoji (a lone one is still removed); docs say bidi marks are still removed |
| M3 | A recorded "clear this field" argument becomes an optional input | By design: matches the tool's own schema; nothing is dropped |

## Not verified in this round

Clean-checkout `npm ci` + global install, `npm audit`, dashboard and admin
API views, GraphQL over HTTP, Postman, real-world specs, Docker, CI, Node 24.
Release CI and the post-publish install check cover the install path.
