# Benchmark report

Generated 2026-11-07T21:04:10.118Z from the JSON files in `benchmarks/results/`. Nothing in this report is estimated or hand-edited.

**Environment:** toolsmith-mcp 0.1.0 (commit `50a43bc`), Node v22.13.1, darwin 27.2.0 arm64, Apple M1 Pro (10 cores, 17 GB), MCP SDK server 2.4.0 / client 2.4.0, developer workstation.

## Workflow latency: baseline vs composite

40 measured runs per variant after 5 warm-up runs.

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
| 0 ms | sequential | 7.47 | 10.08 | 11.16 | 8 | 8 | 100% | 100% | 25.63 | 1796 |
| 0 ms | parallel-client | 4.67 | 6.29 | 8.15 | 8 | 8 | 100% | 100% | 18.4 | 1796 |
| 0 ms | composite | 1.89 | 3.23 | 3.32 | 1 | 8 | 100% | 100% | 12.91 | 2157 |
| 10 ms | sequential | 121.02 | 136.1 | 136.82 | 8 | 8 | 100% | 100% | 71.28 | 1796 |
| 10 ms | parallel-client | 35.21 | 41.97 | 49.72 | 8 | 8 | 100% | 100% | 50.08 | 1796 |
| 10 ms | composite | 30.21 | 35.92 | 41.47 | 1 | 8 | 100% | 100% | 44.2 | 2157 |
| 25 ms | sequential | 249.3 | 257.27 | 263.17 | 8 | 8 | 100% | 100% | 90.13 | 1796 |
| 25 ms | parallel-client | 68.3 | 73.25 | 74.3 | 8 | 8 | 100% | 100% | 61.89 | 1796 |
| 25 ms | composite | 62.74 | 67.73 | 69.95 | 1 | 8 | 100% | 100% | 53.33 | 2157 |
| 50 ms | sequential | 458.74 | 469.26 | 478.16 | 8 | 8 | 100% | 100% | 115.78 | 1796 |
| 50 ms | parallel-client | 120.1 | 126.7 | 130.32 | 8 | 8 | 100% | 100% | 80.61 | 1796 |
| 50 ms | composite | 114.52 | 119.68 | 127.94 | 1 | 8 | 100% | 100% | 64.76 | 2157 |

### dependent-chain

Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)

![dependent-chain latency](../charts/latency-dependent-chain.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 1.83 | 2.99 | 3.46 | 3 | 3 | 100% | 100% | 5.18 | 735 |
| 0 ms | composite | 1.04 | 1.81 | 2.75 | 1 | 3 | 100% | 100% | 3.85 | 960 |
| 10 ms | sequential | 45.27 | 48.1 | 48.29 | 3 | 3 | 100% | 100% | 25.56 | 735 |
| 10 ms | composite | 42.07 | 46.37 | 48.6 | 1 | 3 | 100% | 100% | 21.47 | 960 |
| 25 ms | sequential | 93.34 | 100.93 | 103.65 | 3 | 3 | 100% | 100% | 31.32 | 735 |
| 25 ms | composite | 89.22 | 93.11 | 99.25 | 1 | 3 | 100% | 100% | 27.54 | 960 |
| 50 ms | sequential | 171.25 | 177.65 | 178.12 | 3 | 3 | 100% | 100% | 44.62 | 735 |
| 50 ms | composite | 166.14 | 175.33 | 180.45 | 1 | 3 | 100% | 100% | 32.66 | 960 |

## Workflow discovery accuracy

- Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.
- Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.
- Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.

![Pattern discovery F1](../charts/patterns-f1.svg)

| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |
|---|---|---|---|---|---|
| clean | default | 1 | 1 | 1 ± 0 | 2.64 |
| clean | no AWO rules | 1 | 1 | 1 ± 0 | 1.51 |
| clean | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.45 |
| boundary noise 80% | default | 1 | 1 | 1 ± 0 | 1.63 |
| boundary noise 80% | no AWO rules | 1 | 1 | 1 ± 0 | 1.39 |
| boundary noise 80% | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.98 |
| rare workflows (10% of sessions) | default | 1 | 0.83 | 0.9 ± 0.1 | 0.65 |
| rare workflows (10% of sessions) | no AWO rules | 1 | 0.83 | 0.9 ± 0.1 | 0.5 |
| rare workflows (10% of sessions) | contiguous (v0 baseline) | 1 | 0.83 | 0.9 ± 0.1 | 1 |
| block-style loops | default | 1 | 1 | 1 ± 0 | 1.36 |
| block-style loops | no AWO rules | 1 | 1 | 1 ± 0 | 1.05 |
| block-style loops | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.33 |
| noise between steps 10% | default | 1 | 1 | 1 ± 0 | 1.47 |
| noise between steps 10% | no AWO rules | 1 | 1 | 1 ± 0 | 1.15 |
| noise between steps 10% | contiguous (v0 baseline) | 0.71 | 1 | 0.81 ± 0.14 | 1.57 |
| noise between steps 30% | default | 1 | 1 | 1 ± 0 | 1.44 |
| noise between steps 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.25 |
| noise between steps 30% | contiguous (v0 baseline) | 0.35 | 1 | 0.51 ± 0.02 | 1.81 |
| abandoned runs 30% | default | 1 | 1 | 1 ± 0 | 1.14 |
| abandoned runs 30% | no AWO rules | 1 | 1 | 1 ± 0 | 0.94 |
| abandoned runs 30% | contiguous (v0 baseline) | 0.73 | 1 | 0.83 ± 0.1 | 1.1 |
| colliding small ids (1..50) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.1 |
| colliding small ids (1..50) | no AWO rules | 0.95 | 1 | 0.97 ± 0.06 | 1.22 |
| colliding small ids (1..50) | contiguous (v0 baseline) | 0.98 | 1 | 0.99 ± 0.04 | 1.27 |
| colliding small ids (1..10) | default | 0.69 | 1 | 0.81 ± 0.08 | 1.55 |
| colliding small ids (1..10) | no AWO rules | 0.66 | 1 | 0.78 ± 0.13 | 1.16 |
| colliding small ids (1..10) | contiguous (v0 baseline) | 0.69 | 1 | 0.8 ± 0.11 | 1.31 |
| two agents share a session key 30% | default | 1 | 1 | 1 ± 0 | 1.44 |
| two agents share a session key 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.12 |
| two agents share a session key 30% | contiguous (v0 baseline) | 0.59 | 1 | 0.73 ± 0.12 | 1.58 |
| independent reads in random order 50% | default | 1 | 1 | 1 ± 0 | 1.17 |
| independent reads in random order 50% | no AWO rules | 0.75 | 1 | 0.86 ± 0 | 0.96 |
| independent reads in random order 50% | contiguous (v0 baseline) | 0.75 | 1 | 0.86 ± 0 | 1.1 |
| all of the above (moderate) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.16 |
| all of the above (moderate) | no AWO rules | 0.98 | 1 | 0.99 ± 0.04 | 1.01 |
| all of the above (moderate) | contiguous (v0 baseline) | 0.49 | 1 | 0.65 ± 0.07 | 1.53 |

Overall mean across conditions (shipped miner): precision 0.97, recall 0.99, F1 0.97. v0 baseline: F1 0.84.

## Scalability

- Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.

![Throughput](../charts/throughput.svg)

| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB |
|---|---|---|---|---|---|---|---|
| 1 | 100 | 0 | 113 | 8.54 | 10.27 | 12.13 | 416 |
| 10 | 1000 | 0 | 839 | 11.66 | 15.46 | 19.07 | 516 |
| 50 | 5000 | 0 | 1725 | 29.11 | 36.91 | 47.15 | 824 |
| 100 | 10000 | 0 | 2061 | 46.54 | 53.34 | 87.35 | 1007 |

| Traces mined | Sessions | Mining ms (p50) |
|---|---|---|
| 872 | 200 | 5.43 |
| 4390 | 1000 | 14.04 |
| 21908 | 5000 | 73.46 |
| 87862 | 20000 | 301.57 |

| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |
|---|---|---|---|---|
| 50 | 51 | 59 | 0.9 | 1.27 |
| 200 | 201 | 54 | 1.8 | 3.47 |
| 1000 | 1001 | 145 | 8.5 | 11.86 |
| 2000 | 2001 | 217 | 19.3 | 37.01 |

## What these numbers do not show

- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.
- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.
- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.
- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.

