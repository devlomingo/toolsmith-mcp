# Benchmark report

Generated 2026-11-07T20:21:37.969Z from the JSON files in `benchmarks/results/`. Nothing in this report is estimated or hand-edited.

**Environment:** toolsmith-mcp 0.1.0 (commit `5683c62`), Node v22.13.1, darwin 27.2.0 arm64, Apple M1 Pro (10 cores, 17 GB), MCP SDK server 2.4.0 / client 2.4.0, developer workstation.

## Workflow latency: baseline vs composite

8 measured runs per variant after 2 warm-up runs.

- Latency is measured at the MCP client: one workflow run, end to end, over Streamable HTTP on loopback (protocol 2026-07-28).
- No LLM is involved. Agent reasoning time between tool calls is NOT included, so real agents see larger absolute savings per avoided round-trip; this benchmark does not measure that and makes no claim about it.
- LLM requests and tokens are not measured. resultBytesPerRun is the size of tool results returned to the client, not a token count.
- apiRequests is counted by the demo API server itself.
- correctness = fraction of runs whose result deep-equals a sequential reference run for the same input.

### order-details

Customer + orders + items and payments of every order (fan-out, parallelizable)

![order-details latency](../charts/latency-order-details.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 9.57 | 13.11 | 13.11 | 8 | 8 | 100% | 100% | 36.54 | 1828 |
| 0 ms | parallel-client | 5.78 | 8.13 | 8.13 | 8 | 8 | 100% | 100% | 22.5 | 1828 |
| 0 ms | composite | 2.66 | 3.44 | 3.44 | 1 | 8 | 100% | 100% | 17.38 | 2196 |
| 25 ms | sequential | 241.6 | 253.82 | 253.82 | 8 | 8 | 100% | 100% | 95.83 | 1828 |
| 25 ms | parallel-client | 67.76 | 77.47 | 77.47 | 8 | 8 | 100% | 100% | 61.18 | 1828 |
| 25 ms | composite | 59.7 | 68.64 | 68.64 | 1 | 8 | 100% | 100% | 53.96 | 2196 |

### dependent-chain

Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)

![dependent-chain latency](../charts/latency-dependent-chain.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 2.51 | 2.97 | 2.97 | 3 | 3 | 100% | 100% | 9.54 | 730 |
| 0 ms | composite | 1.4 | 3.24 | 3.24 | 1 | 3 | 100% | 100% | 6.23 | 955 |
| 25 ms | sequential | 92.97 | 97.76 | 97.76 | 3 | 3 | 100% | 100% | 32.29 | 730 |
| 25 ms | composite | 87.24 | 90.98 | 90.98 | 1 | 3 | 100% | 100% | 32.52 | 955 |

## Workflow discovery accuracy

- Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.
- Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.
- Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.

![Pattern discovery F1](../charts/patterns-f1.svg)

| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |
|---|---|---|---|---|---|
| clean | default | 1 | 1 | 1 ± 0 | 2.63 |
| clean | no AWO rules | 1 | 1 | 1 ± 0 | 1.54 |
| clean | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.54 |
| boundary noise 80% | default | 1 | 1 | 1 ± 0 | 1.49 |
| boundary noise 80% | no AWO rules | 1 | 1 | 1 ± 0 | 1.35 |
| boundary noise 80% | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 2.02 |
| rare workflows (10% of sessions) | default | 1 | 0.83 | 0.9 ± 0.1 | 0.56 |
| rare workflows (10% of sessions) | no AWO rules | 1 | 0.83 | 0.9 ± 0.1 | 0.49 |
| rare workflows (10% of sessions) | contiguous (v0 baseline) | 1 | 0.83 | 0.9 ± 0.1 | 0.97 |
| block-style loops | default | 1 | 1 | 1 ± 0 | 1.47 |
| block-style loops | no AWO rules | 1 | 1 | 1 ± 0 | 1.19 |
| block-style loops | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.3 |
| noise between steps 10% | default | 1 | 1 | 1 ± 0 | 1.44 |
| noise between steps 10% | no AWO rules | 1 | 1 | 1 ± 0 | 1.1 |
| noise between steps 10% | contiguous (v0 baseline) | 0.71 | 1 | 0.81 ± 0.14 | 1.63 |
| noise between steps 30% | default | 1 | 1 | 1 ± 0 | 1.42 |
| noise between steps 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.14 |
| noise between steps 30% | contiguous (v0 baseline) | 0.35 | 1 | 0.51 ± 0.02 | 1.85 |
| abandoned runs 30% | default | 1 | 1 | 1 ± 0 | 1.21 |
| abandoned runs 30% | no AWO rules | 1 | 1 | 1 ± 0 | 0.93 |
| abandoned runs 30% | contiguous (v0 baseline) | 0.73 | 1 | 0.83 ± 0.1 | 1.14 |
| colliding small ids (1..50) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.44 |
| colliding small ids (1..50) | no AWO rules | 0.95 | 1 | 0.97 ± 0.06 | 1.17 |
| colliding small ids (1..50) | contiguous (v0 baseline) | 0.98 | 1 | 0.99 ± 0.04 | 1.18 |
| colliding small ids (1..10) | default | 0.69 | 1 | 0.81 ± 0.08 | 1.58 |
| colliding small ids (1..10) | no AWO rules | 0.66 | 1 | 0.78 ± 0.13 | 1.27 |
| colliding small ids (1..10) | contiguous (v0 baseline) | 0.69 | 1 | 0.8 ± 0.11 | 1.41 |
| two agents share a session key 30% | default | 1 | 1 | 1 ± 0 | 1.8 |
| two agents share a session key 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.03 |
| two agents share a session key 30% | contiguous (v0 baseline) | 0.59 | 1 | 0.73 ± 0.12 | 1.53 |
| independent reads in random order 50% | default | 1 | 1 | 1 ± 0 | 1.18 |
| independent reads in random order 50% | no AWO rules | 0.75 | 1 | 0.86 ± 0 | 1.03 |
| independent reads in random order 50% | contiguous (v0 baseline) | 0.75 | 1 | 0.86 ± 0 | 1.19 |
| all of the above (moderate) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.3 |
| all of the above (moderate) | no AWO rules | 0.98 | 1 | 0.99 ± 0.04 | 1.06 |
| all of the above (moderate) | contiguous (v0 baseline) | 0.49 | 1 | 0.65 ± 0.07 | 1.53 |

Overall mean across conditions (shipped miner): precision 0.97, recall 0.99, F1 0.97. v0 baseline: F1 0.84.

## Scalability

- Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.

![Throughput](../charts/throughput.svg)

| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB |
|---|---|---|---|---|---|---|---|
| 1 | 20 | 0 | 105 | 8.47 | 10.16 | 25.17 | 164 |
| 10 | 200 | 0 | 875 | 10.87 | 16.16 | 18.86 | 187 |

| Traces mined | Sessions | Mining ms (p50) |
|---|---|---|
| 872 | 200 | 8.81 |
| 4390 | 1000 | 20.87 |

| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |
|---|---|---|---|---|
| 50 | 51 | 50 | 0.8 | 3.99 |
| 500 | 501 | 54 | 5.8 | 5.8 |

## What these numbers do not show

- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.
- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.
- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.
- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.

