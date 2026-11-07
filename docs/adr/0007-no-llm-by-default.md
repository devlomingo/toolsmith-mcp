# 0007: No LLM in the default pipeline

## Context

Free-text API docs and natural-language capability requests invite an LLM.
But an LLM adds cost, nondeterminism, a vendor dependency, and another place
where data leaves the machine. ToolFactory's own results show that
LLM-extracted tools mostly fail validation without a live check.

## Decision

Every default stage is deterministic:

- spec parsing;
- schema linking for parameter sources;
- live verification;
- data-flow pattern mining;
- keyword and synonym capability matching;
- equivalence evaluation.

## Consequences

- Results are reproducible and testable, and nothing leaves the machine.
- Unstructured documentation is not supported, and capability matching
  only understands vocabulary it has synonyms for. Both are stated in
  the docs and the tool output.
- The optional LLM stage now exists (`llm.enabled`, off by default): it
  extracts endpoints from free-text documentation and provides a
  capability-matching fallback. Its output passes the same verification and
  human approval as everything else, and tool names it suggests are
  checked against the real catalog.
