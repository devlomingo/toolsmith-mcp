# Benchmark report

Generated 2026-11-07T20:25:37.347Z from the JSON files in `benchmarks/results/`. Nothing in this report is estimated or hand-edited.

**Environment:** toolsmith-mcp 0.1.0 (commit `7a16e57`), Node v22.13.1, darwin 27.2.0 arm64, Apple M1 Pro (10 cores, 17 GB), MCP SDK server 2.4.0 / client 2.4.0, developer workstation.

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
| 0 ms | sequential | 8.04 | 11.17 | 12.56 | 8 | 8 | 100% | 100% | 26.25 | 1796 |
| 0 ms | parallel-client | 4.61 | 6.93 | 13.31 | 8 | 8 | 100% | 100% | 18.45 | 1796 |
| 0 ms | composite | 1.91 | 2.57 | 5.4 | 1 | 8 | 100% | 100% | 11.88 | 2157 |
| 10 ms | sequential | 111.15 | 119.89 | 122.1 | 8 | 8 | 100% | 100% | 53.92 | 1796 |
| 10 ms | parallel-client | 31.84 | 37.9 | 39.23 | 8 | 8 | 100% | 100% | 39.12 | 1796 |
| 10 ms | composite | 28.84 | 31.65 | 36.91 | 1 | 8 | 100% | 100% | 34.42 | 2157 |
| 25 ms | sequential | 239.57 | 246.18 | 247 | 8 | 8 | 100% | 100% | 65.94 | 1796 |
| 25 ms | parallel-client | 63.5 | 73.43 | 78.06 | 8 | 8 | 100% | 100% | 47.98 | 1796 |
| 25 ms | composite | 60 | 65.67 | 66.01 | 1 | 8 | 100% | 100% | 33.71 | 2157 |
| 50 ms | sequential | 445.54 | 456.06 | 462.74 | 8 | 8 | 100% | 100% | 87.03 | 1796 |
| 50 ms | parallel-client | 116.97 | 122.09 | 122.96 | 8 | 8 | 100% | 100% | 67.05 | 1796 |
| 50 ms | composite | 111.43 | 114.79 | 115.93 | 1 | 8 | 100% | 100% | 48.62 | 2157 |

### dependent-chain

Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)

![dependent-chain latency](../charts/latency-dependent-chain.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 1.8 | 3.16 | 3.35 | 3 | 3 | 100% | 100% | 5.17 | 735 |
| 0 ms | composite | 1.04 | 1.35 | 2.45 | 1 | 3 | 100% | 100% | 3.79 | 960 |
| 10 ms | sequential | 40.63 | 45.56 | 49.61 | 3 | 3 | 100% | 100% | 16.48 | 735 |
| 10 ms | composite | 39.58 | 45.67 | 48.7 | 1 | 3 | 100% | 100% | 16.58 | 960 |
| 25 ms | sequential | 88.5 | 93.99 | 95.25 | 3 | 3 | 100% | 100% | 22.97 | 735 |
| 25 ms | composite | 85.84 | 92.28 | 94.37 | 1 | 3 | 100% | 100% | 18.02 | 960 |
| 50 ms | sequential | 167.49 | 173.66 | 174.38 | 3 | 3 | 100% | 100% | 36.2 | 735 |
| 50 ms | composite | 163.25 | 168.41 | 170.5 | 1 | 3 | 100% | 100% | 29.79 | 960 |

## Workflow discovery accuracy

- Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.
- Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.
- Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.

![Pattern discovery F1](../charts/patterns-f1.svg)

| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |
|---|---|---|---|---|---|
| clean | default | 1 | 1 | 1 ± 0 | 2.4 |
| clean | no AWO rules | 1 | 1 | 1 ± 0 | 1.44 |
| clean | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.46 |
| boundary noise 80% | default | 1 | 1 | 1 ± 0 | 1.8 |
| boundary noise 80% | no AWO rules | 1 | 1 | 1 ± 0 | 1.39 |
| boundary noise 80% | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.81 |
| rare workflows (10% of sessions) | default | 1 | 0.83 | 0.9 ± 0.1 | 0.6 |
| rare workflows (10% of sessions) | no AWO rules | 1 | 0.83 | 0.9 ± 0.1 | 0.57 |
| rare workflows (10% of sessions) | contiguous (v0 baseline) | 1 | 0.83 | 0.9 ± 0.1 | 1.03 |
| block-style loops | default | 1 | 1 | 1 ± 0 | 1.23 |
| block-style loops | no AWO rules | 1 | 1 | 1 ± 0 | 1.09 |
| block-style loops | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.26 |
| noise between steps 10% | default | 1 | 1 | 1 ± 0 | 1.42 |
| noise between steps 10% | no AWO rules | 1 | 1 | 1 ± 0 | 1.23 |
| noise between steps 10% | contiguous (v0 baseline) | 0.71 | 1 | 0.81 ± 0.14 | 1.57 |
| noise between steps 30% | default | 1 | 1 | 1 ± 0 | 1.81 |
| noise between steps 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.18 |
| noise between steps 30% | contiguous (v0 baseline) | 0.35 | 1 | 0.51 ± 0.02 | 1.94 |
| abandoned runs 30% | default | 1 | 1 | 1 ± 0 | 1.15 |
| abandoned runs 30% | no AWO rules | 1 | 1 | 1 ± 0 | 0.93 |
| abandoned runs 30% | contiguous (v0 baseline) | 0.73 | 1 | 0.83 ± 0.1 | 1.05 |
| colliding small ids (1..50) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.27 |
| colliding small ids (1..50) | no AWO rules | 0.95 | 1 | 0.97 ± 0.06 | 1.25 |
| colliding small ids (1..50) | contiguous (v0 baseline) | 0.98 | 1 | 0.99 ± 0.04 | 1.42 |
| colliding small ids (1..10) | default | 0.69 | 1 | 0.81 ± 0.08 | 1.56 |
| colliding small ids (1..10) | no AWO rules | 0.66 | 1 | 0.78 ± 0.13 | 1.16 |
| colliding small ids (1..10) | contiguous (v0 baseline) | 0.69 | 1 | 0.8 ± 0.11 | 1.34 |
| two agents share a session key 30% | default | 1 | 1 | 1 ± 0 | 2.04 |
| two agents share a session key 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.25 |
| two agents share a session key 30% | contiguous (v0 baseline) | 0.59 | 1 | 0.73 ± 0.12 | 1.52 |
| independent reads in random order 50% | default | 1 | 1 | 1 ± 0 | 1.13 |
| independent reads in random order 50% | no AWO rules | 0.75 | 1 | 0.86 ± 0 | 1.02 |
| independent reads in random order 50% | contiguous (v0 baseline) | 0.75 | 1 | 0.86 ± 0 | 1.11 |
| all of the above (moderate) | default | 0.95 | 1 | 0.97 ± 0.06 | 1.19 |
| all of the above (moderate) | no AWO rules | 0.98 | 1 | 0.99 ± 0.04 | 1.12 |
| all of the above (moderate) | contiguous (v0 baseline) | 0.49 | 1 | 0.65 ± 0.07 | 1.58 |

Overall mean across conditions (shipped miner): precision 0.97, recall 0.99, F1 0.97. v0 baseline: F1 0.84.

## Scalability

- Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.

![Throughput](../charts/throughput.svg)

| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB |
|---|---|---|---|---|---|---|---|
| 1 | 100 | 0 | 114 | 8.48 | 9.79 | 13.43 | 413 |
| 10 | 1000 | 0 | 774 | 13.03 | 15.91 | 19.61 | 510 |
| 50 | 5000 | 0 | 1717 | 28.52 | 38.87 | 54.79 | 807 |
| 100 | 10000 | 0 | 2056 | 46.61 | 54.09 | 89.86 | 992 |

| Traces mined | Sessions | Mining ms (p50) |
|---|---|---|
| 872 | 200 | 5.31 |
| 4390 | 1000 | 13.95 |
| 21908 | 5000 | 73.15 |
| 87862 | 20000 | 299.34 |

| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |
|---|---|---|---|---|
| 50 | 51 | 56 | 1.1 | 1.7 |
| 200 | 201 | 55 | 2 | 3.31 |
| 1000 | 1001 | 140 | 8.6 | 12.4 |
| 2000 | 2001 | 232 | 40.2 | 23.04 |

## What these numbers do not show

- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.
- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.
- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.
- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.

