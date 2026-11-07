# Discovering workflows and generating composite tools

## The idea

Agents often repeat the same sequence: fetch a customer, fetch their orders,
then fetch items and payments for each order. Each step is a model turn and
an MCP round-trip.

Toolsmith watches these sequences in its traces. When one repeats, it
proposes a single **composite tool** that does the same work in one call,
with independent steps running in parallel. A composite is published only
after it is shown to return exactly what the individual calls return, and
after a human approves it.

## Workflow

```sh
toolsmith-mcp patterns     # repeated workflows found so far
toolsmith-mcp discover     # turn them into proposed composites and evaluate them
toolsmith-mcp show flow-get-user-orders-details
toolsmith-mcp approve flow-get-user-orders-details
toolsmith-mcp usage        # after a while: is it used? how many round-trips saved?
```

The dashboard's **Workflows** page shows the same information, with a
button to propose.

## What gets discovered

A workflow needs to:

- appear in at least `minSupport` sessions (default 3);
- have its steps connected by data flow: an argument equals a value an
  earlier step returned, or the same input is passed to several steps;
- have each step taken by more than half of the sessions that continue past
  its prefix (the AWO majority rule).

Repeated calls over the items of an earlier result (`for each order…`)
become one `forEach` step. Independent reads count the same in either
order. Unrelated calls in between, and other agents sharing the session
key, are separated out by data flow.

See [ARCHITECTURE.md](ARCHITECTURE.md#workflow-discovery-step-by-step) for
the algorithm and [the benchmark report](../benchmarks/reports/REPORT.md)
for how accurate it is, including where it fails.

## What a composite looks like

It is a declarative plan. Nothing generated is ever run as code:

```json
{
  "toolName": "flow__getUserOrdersDetails",
  "inputSchema": { "type": "object", "properties": { "userId": { "type": "integer", "minimum": 1 } }, "required": ["userId"] },
  "steps": [
    { "id": "getUser",       "tool": "shop__getUser",       "args": { "userId": { "$ref": "input.userId" } } },
    { "id": "getOrders",     "tool": "shop__getOrders",     "args": { "userId": { "$ref": "input.userId" } } },
    { "id": "getOrderItems", "tool": "shop__getOrderItems", "forEach": "steps.getOrders.result[*]", "args": { "orderId": { "$ref": "item.id" } } },
    { "id": "getPayments",   "tool": "shop__getPayments",   "forEach": "steps.getOrders.result[*]", "args": { "orderId": { "$ref": "item.id" } } }
  ]
}
```

- `getUser` and `getOrders` run together; then both fan-outs run together.
- The result is `{ results: { <stepId>: … }, partial, errors, skippedSteps, stats }`.
- If a step fails, the steps that depend on it are skipped, the rest still
  run, and `partial` is `true`.

## Evaluation

Before anyone is asked to approve, the evaluator checks four things:

1. **The plan is valid.** Tools exist, there are no cycles, every input is
   declared, and limits are respected.
2. **Authorization is preserved.** Every step calls a tool that is already
   exposed. The composite's access level is the highest of its steps'.
3. **Equivalence.** For read-only plans with example inputs, it runs the
   original tools one by one, the way an agent would, using a separate
   sequential interpreter, then runs the composite. The per-step results
   must be identical.
   - Plans that **write** are never executed by the evaluator; they are
     flagged for manual review.
   - If no example input was observed, supply one:
     `toolsmith-mcp evaluate <name> --input '{"userId": 42}'`.
4. **Performance.** It records sequential versus composite latency and the
   MCP call count, and says so when there is no latency gain. Fewer
   round-trips alone is not counted as a win.

## After publication

`toolsmith-mcp usage` shows, per composite:

- calls and sessions;
- MCP round-trips saved;
- how often agents still did the workflow by hand since it was published;
- adoption.

A composite unused for 7 days is flagged. Extra tools cost agent context,
and AWO observed weaker models getting worse with more meta-tools, so
disable composites that are not earning their place.

## Limits

- Composites call tools and pass values between them. They do not filter,
  sort or compute: "the latest order" returns all orders, and the agent
  picks.
- Discovery needs at least a few repetitions. Rare workflows are not found.
- Values that collide by coincidence (small integer ids across unrelated
  calls) can produce spurious patterns. Name evidence and voting reduce
  this, and evaluation and review catch the rest.
