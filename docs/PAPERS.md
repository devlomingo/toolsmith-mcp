# Research this project builds on

Two papers shaped specific parts of toolsmith-mcp. This page says what each
paper does, what was adopted, what was deliberately done differently, and how
the effect was measured. Claims about the papers come from reading them in
full; anything that goes beyond what a paper says is marked as our own design.

## ToolFactory

Ni, Wang, Zhang, Hong. *ToolFactory: Automating Tool Generation by Leveraging
LLM to Understand REST API Documentations.* arXiv:2501.16945, 2025.
<https://arxiv.org/abs/2501.16945>

**What the paper does.** It extracts a minimal JSON description of each
endpoint from unstructured HTML docs with a soft-prompt-tuned Llama-3-8B
(APILlama), turns that JSON into tools with deterministic scripts, and then
validates each tool by calling it: a tool is kept only if it returns HTTP 200
and a GPT-4o judge says the body is information rather than an error. Its
main finding is that wrong or missing **parameter values** are the dominant
failure (30–55% of APILlama's tools). Even tools generated from the
ground-truth JSON passed only 50 of 117. To fix values it builds a knowledge
base of (key, description, value) triples from verified responses and
retrieves candidates by embedding similarity.

**What we adopted**

| Paper mechanism | In toolsmith-mcp | Where |
|---|---|---|
| Validate generated tools by calling them | Every read operation is probed during evaluation, not only parameter-free ones | `src/openapi/verify.ts` |
| Six-way failure taxonomy | `verified`, `no_parameter_value`, `wrong_parameter_value`, `auth_failed`, `http_error`, `error_shaped_response`, `schema_mismatch`, `network_error`, `not_probed_write` | `verify.ts` |
| LLM judge for "is this body an error?" | Deterministic heuristic: empty body, only error-like keys, `success: false` | `looksLikeError` |
| Parameter values from a knowledge base of verified responses | Values from the spec's own examples / defaults / enums, else **live** from another endpoint that returns them (`orderId ← listOrders[*].id`), found by linking response and parameter schemas | `linkParamSources`, `verifyOperations` |
| Parameter knowledge as documentation | Tool descriptions carry hints such as *get "orderId" from shop__listOrders (each item's id)* | `describeParamSources` |
| Path syntaxes `:p`, `<p>`, `{p}` | Accepted in plain endpoint lists | `src/openapi/endpoints.ts` |
| Client-side required-parameter check | Already present: every call is validated against the input schema before any request | `src/gateway/validation.ts` |

**Deliberately different**

- **No LLM in the default path.** ToolFactory's extraction and judging need
  an LLM. Here, input must be a structured spec or an explicit endpoint list.
  Free-text documentation is out of scope; that is listed on the roadmap as an
  optional, off-by-default extractor whose output would still have to pass
  this same verification.
- **Values are never stored.** The paper's knowledge base keeps raw values.
  Toolsmith keeps only keyed fingerprints in traces, so verification fetches
  values live, uses them for the probe and discards them.
- **Writes are never probed.** The paper's APIs were auth-free and mostly
  read-only. Here, POST/PUT/PATCH/DELETE operations are reported as
  `not_probed_write` and need human review.

## AWO: Optimizing Agentic Workflows using Meta-tools

Abuzakuk, Kermarrec, Sharma, Veski, de Vos. *Optimizing Agentic Workflows
using Meta-tools.* arXiv:2601.22037, 2026. <https://arxiv.org/abs/2601.22037>

**What the paper does.** It builds a state graph from agent traces, where a
node is the history of calls so far and an edge weight counts how many
executions take that step. It merges equivalent states "horizontally" with
domain rules. Two examples: reads form a *set* (order does not matter) while
other actions form a *list*, and arguments are normalized with regexes. It
then extracts "meta-tools" with a greedy "vertical" merge: a chain is
extended only if the next step carries a strict majority of the traffic
leaving the current node. Meta-tools are added alongside the original tools.
On AppWorld with GPT-5.1 it reports 11.9% fewer LLM calls and 15% lower cost.
Its meta-tools were few (2–5 per benchmark) and hand-checked, and one weaker
model got more expensive.

**What we adopted**

| Paper mechanism | In toolsmith-mcp | Where |
|---|---|---|
| Vertical merging majority rule (`SELECT_CHILD`: > ½ of outgoing weight) | `minStepShare` (default 0.5): every step of a mined pattern must be taken by more than half of the sessions that continue past its prefix; per-step shares are reported | `src/patterns/miner.ts` |
| Reads as a commutative set (Φ_GET) | `commutativeReads`: adjacent reads that do not consume each other's output are counted in a canonical order; loops are barriers | `canonicalizeReads` |
| Meta-tools added next to, not instead of, originals | Composite tools never hide their step tools | `src/gateway/gateway.ts` |
| Measure utilization and steps saved | `toolsmith-mcp usage` and the dashboard show per-composite calls, sessions, MCP round-trips saved, how often agents still do the workflow by hand, adoption, and an "unused" flag | `Toolsmith.compositeUsage` |

**Where toolsmith-mcp goes further (our design, not in the paper)**

- **Parameters and data flow are derived automatically** from value
  fingerprints. AWO leaves this unspecified, and its meta-tools were built by
  hand.
- **Workflow boundaries come from data flow.** Sessions are split into
  connected components of the "argument equals an earlier result" graph,
  which handles unrelated calls in between and two agents sharing a session.
- **Independent steps run in parallel.** AWO calls this complementary
  (LLMCompiler-style) and does not do it.
- **Every composite is checked for equivalence.** It is run against the
  original tools one by one and must return identical results, and then it
  needs human approval. AWO's own preliminary automated merger produced rules
  it could not verify.

**Not adopted, and why**

- **Domain-expert horizontal merging rules and regex argument normalization.**
  These are application-specific by the paper's own account. Fingerprint-based
  linking covers the cases they handle without hand-written rules.
- **LLM-proposed merge rules** (AWO Appendix C). Off-by-default future work.
  Any such rule would have to pass the existing equivalence evaluator.

## How the effect was measured

`npm run benchmark:patterns` runs an ablation on synthetic traces with planted
workflows, under eleven difficulty conditions:

- noise between steps
- abandoned runs
- colliding small ids
- two agents sharing a session key
- independent reads in random order
- and others

It compares three miners:

- the shipped defaults
- the defaults with the AWO rules turned off (`no AWO rules`)
- the first contiguous-sequence version (`contiguous (v0 baseline)`)

Results, including where the AWO rules do not help, are in
[benchmarks/reports/REPORT.md](../benchmarks/reports/REPORT.md). These are
synthetic traces. They show what the algorithm does under controlled
conditions, not how real agents behave.
