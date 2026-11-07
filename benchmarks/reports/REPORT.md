# Benchmark report

Generated 2026-11-07T21:33:10.956Z from the JSON files in `benchmarks/results/`. Nothing in this report is estimated or hand-edited.

**Environment:** toolsmith-mcp 0.1.0 (commit `8a4fd8b`), Node v22.13.1, darwin 27.2.0 arm64, Apple M1 Pro (10 cores, 17 GB), MCP SDK server 2.4.0 / client 2.4.0, developer workstation.

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
| 0 ms | sequential | 7.97 | 10.59 | 12.09 | 8 | 8 | 100% | 100% | 26.03 | 1796 |
| 0 ms | parallel-client | 4.52 | 6.67 | 7.68 | 8 | 8 | 100% | 100% | 18.01 | 1796 |
| 0 ms | composite | 1.96 | 2.91 | 4.07 | 1 | 8 | 100% | 100% | 11.58 | 2157 |
| 10 ms | sequential | 120.46 | 132.7 | 137.56 | 8 | 8 | 100% | 100% | 75.06 | 1796 |
| 10 ms | parallel-client | 36.01 | 41.89 | 42.86 | 8 | 8 | 100% | 100% | 50.55 | 1796 |
| 10 ms | composite | 32.74 | 37.82 | 38.79 | 1 | 8 | 100% | 100% | 43.03 | 2157 |
| 25 ms | sequential | 251.07 | 260.22 | 260.75 | 8 | 8 | 100% | 100% | 86.93 | 1796 |
| 25 ms | parallel-client | 67.48 | 74.11 | 76.98 | 8 | 8 | 100% | 100% | 63.49 | 1796 |
| 25 ms | composite | 63.31 | 67.59 | 69.59 | 1 | 8 | 100% | 100% | 52.94 | 2157 |
| 50 ms | sequential | 458.43 | 467.68 | 479.18 | 8 | 8 | 100% | 100% | 113.44 | 1796 |
| 50 ms | parallel-client | 120.91 | 126.67 | 126.92 | 8 | 8 | 100% | 100% | 82.71 | 1796 |
| 50 ms | composite | 115.34 | 120.64 | 124.25 | 1 | 8 | 100% | 100% | 67.03 | 2157 |

### dependent-chain

Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)

![dependent-chain latency](../charts/latency-dependent-chain.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 1.94 | 4.63 | 5.74 | 3 | 3 | 100% | 100% | 5.48 | 735 |
| 0 ms | composite | 1.18 | 1.39 | 2.36 | 1 | 3 | 100% | 100% | 4.05 | 960 |
| 10 ms | sequential | 44.73 | 49.68 | 55.41 | 3 | 3 | 100% | 100% | 24.72 | 735 |
| 10 ms | composite | 42.25 | 47.25 | 48.73 | 1 | 3 | 100% | 100% | 21.4 | 960 |
| 25 ms | sequential | 92.83 | 98.55 | 99.72 | 3 | 3 | 100% | 100% | 30.64 | 735 |
| 25 ms | composite | 88.54 | 92.87 | 94.49 | 1 | 3 | 100% | 100% | 27.13 | 960 |
| 50 ms | sequential | 171.46 | 176.16 | 178.32 | 3 | 3 | 100% | 100% | 36.8 | 735 |
| 50 ms | composite | 167.09 | 172.19 | 177.39 | 1 | 3 | 100% | 100% | 30.75 | 960 |

## Workflow discovery accuracy

- Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.
- Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.
- Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.

![Pattern discovery F1](../charts/patterns-f1.svg)

| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |
|---|---|---|---|---|---|
| clean | default | 1 | 1 | 1 ± 0 | 2.72 |
| clean | no AWO rules | 1 | 1 | 1 ± 0 | 1.4 |
| clean | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.57 |
| boundary noise 80% | default | 1 | 1 | 1 ± 0 | 2.11 |
| boundary noise 80% | no AWO rules | 1 | 1 | 1 ± 0 | 1.35 |
| boundary noise 80% | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 2.07 |
| rare workflows (10% of sessions) | default | 1 | 0.83 | 0.9 ± 0.1 | 0.6 |
| rare workflows (10% of sessions) | no AWO rules | 1 | 0.83 | 0.9 ± 0.1 | 0.52 |
| rare workflows (10% of sessions) | contiguous (v0 baseline) | 1 | 0.83 | 0.9 ± 0.1 | 1.08 |
| block-style loops | default | 1 | 1 | 1 ± 0 | 1.3 |
| block-style loops | no AWO rules | 1 | 1 | 1 ± 0 | 1.16 |
| block-style loops | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.19 |
| noise between steps 10% | default | 1 | 1 | 1 ± 0 | 1.5 |
| noise between steps 10% | no AWO rules | 1 | 1 | 1 ± 0 | 1.07 |
| noise between steps 10% | contiguous (v0 baseline) | 0.71 | 1 | 0.81 ± 0.14 | 1.54 |
| noise between steps 30% | default | 1 | 1 | 1 ± 0 | 1.61 |
| noise between steps 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.16 |
| noise between steps 30% | contiguous (v0 baseline) | 0.35 | 1 | 0.51 ± 0.02 | 1.85 |
| abandoned runs 30% | default | 1 | 1 | 1 ± 0 | 1.15 |
| abandoned runs 30% | no AWO rules | 1 | 1 | 1 ± 0 | 0.96 |
| abandoned runs 30% | contiguous (v0 baseline) | 0.73 | 1 | 0.83 ± 0.1 | 1.14 |
| colliding small ids (1..50) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.2 |
| colliding small ids (1..50) | no AWO rules | 0.95 | 1 | 0.97 ± 0.06 | 1.28 |
| colliding small ids (1..50) | contiguous (v0 baseline) | 0.98 | 1 | 0.99 ± 0.04 | 1.41 |
| colliding small ids (1..10) | default | 0.69 | 1 | 0.81 ± 0.08 | 1.54 |
| colliding small ids (1..10) | no AWO rules | 0.66 | 1 | 0.78 ± 0.13 | 1.08 |
| colliding small ids (1..10) | contiguous (v0 baseline) | 0.69 | 1 | 0.8 ± 0.11 | 1.39 |
| two agents share a session key 30% | default | 1 | 1 | 1 ± 0 | 1.77 |
| two agents share a session key 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.14 |
| two agents share a session key 30% | contiguous (v0 baseline) | 0.59 | 1 | 0.73 ± 0.12 | 1.46 |
| independent reads in random order 50% | default | 1 | 1 | 1 ± 0 | 1.18 |
| independent reads in random order 50% | no AWO rules | 0.75 | 1 | 0.86 ± 0 | 0.99 |
| independent reads in random order 50% | contiguous (v0 baseline) | 0.75 | 1 | 0.86 ± 0 | 1.17 |
| all of the above (moderate) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.21 |
| all of the above (moderate) | no AWO rules | 0.98 | 1 | 0.99 ± 0.04 | 1.03 |
| all of the above (moderate) | contiguous (v0 baseline) | 0.49 | 1 | 0.65 ± 0.07 | 1.46 |

Overall mean across conditions (shipped miner): precision 0.97, recall 0.99, F1 0.97. v0 baseline: F1 0.84.

## Scalability

- Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.

![Throughput](../charts/throughput.svg)

RSS is the resident memory of the single benchmark process, which hosts the MCP clients, the gateway and the demo API together. It is an upper bound for the gateway alone.

| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB (whole process) |
|---|---|---|---|---|---|---|---|
| 1 | 100 | 0 | 112 | 8.63 | 10.17 | 13.59 | 450 |
| 10 | 1000 | 0 | 731 | 13.66 | 17.31 | 21.95 | 553 |
| 50 | 5000 | 0 | 1642 | 30 | 39.4 | 50.98 | 896 |
| 100 | 10000 | 0 | 1994 | 48 | 58.61 | 95.05 | 1018 |

| Traces mined | Sessions | Mining ms (p50) |
|---|---|---|
| 872 | 200 | 5.78 |
| 4390 | 1000 | 13.72 |
| 21908 | 5000 | 71.95 |
| 87862 | 20000 | 300.01 |

| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |
|---|---|---|---|---|
| 50 | 51 | 59 | 1 | 1.16 |
| 200 | 201 | 54 | 1.9 | 2.96 |
| 1000 | 1001 | 145 | 8.7 | 11.84 |
| 2000 | 2001 | 217 | 18.8 | 37.62 |

## What these numbers do not show

- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.
- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.
- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.
- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.

