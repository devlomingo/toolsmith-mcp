# Benchmark report

Generated 2026-11-09T04:16:12.508Z from the JSON files in `benchmarks/results/`. Nothing in this report is estimated or hand-edited.

**Environment:** toolsmith-mcp 0.1.0 (commit `085fb68`), Node v22.13.1, darwin 27.2.0 arm64, Apple M1 Pro (10 cores, 17 GB), MCP SDK server 2.4.0 / client 2.4.0, developer workstation.

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
| 0 ms | sequential | 8.34 | 10.78 | 15.04 | 8 | 8 | 100% | 100% | 27.17 | 1796 |
| 0 ms | parallel-client | 4.66 | 7.37 | 8.04 | 8 | 8 | 100% | 100% | 17.28 | 1796 |
| 0 ms | composite | 2.06 | 3.34 | 3.5 | 1 | 8 | 100% | 100% | 11.59 | 2157 |
| 10 ms | sequential | 118.14 | 135.18 | 150.24 | 8 | 8 | 100% | 100% | 69.81 | 1796 |
| 10 ms | parallel-client | 35.09 | 40.75 | 44.24 | 8 | 8 | 100% | 100% | 47.48 | 1796 |
| 10 ms | composite | 30.77 | 35.37 | 38.73 | 1 | 8 | 100% | 100% | 40.85 | 2157 |
| 25 ms | sequential | 247.09 | 255.9 | 258.42 | 8 | 8 | 100% | 100% | 83.63 | 1796 |
| 25 ms | parallel-client | 68.46 | 74.78 | 75.17 | 8 | 8 | 100% | 100% | 58.02 | 1796 |
| 25 ms | composite | 62.97 | 68.52 | 70.53 | 1 | 8 | 100% | 100% | 47.93 | 2157 |
| 50 ms | sequential | 451.94 | 464.1 | 467.07 | 8 | 8 | 100% | 100% | 103.03 | 1796 |
| 50 ms | parallel-client | 124.15 | 129.33 | 131.55 | 8 | 8 | 100% | 100% | 94.47 | 1796 |
| 50 ms | composite | 117.24 | 120.27 | 122.32 | 1 | 8 | 100% | 100% | 81.46 | 2157 |

### dependent-chain

Order → its customer → that customer’s orders (strictly sequential, nothing to parallelize)

![dependent-chain latency](../charts/latency-dependent-chain.svg)

| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 ms | sequential | 1.83 | 2.63 | 2.96 | 3 | 3 | 100% | 100% | 5.55 | 735 |
| 0 ms | composite | 1.26 | 2.19 | 26.06 | 1 | 3 | 100% | 100% | 6.33 | 960 |
| 10 ms | sequential | 43.98 | 49.81 | 52.18 | 3 | 3 | 100% | 100% | 23.33 | 735 |
| 10 ms | composite | 40.74 | 46.19 | 46.35 | 1 | 3 | 100% | 100% | 20.15 | 960 |
| 25 ms | sequential | 92.27 | 97.98 | 99.16 | 3 | 3 | 100% | 100% | 29.35 | 735 |
| 25 ms | composite | 87.62 | 93.87 | 97.4 | 1 | 3 | 100% | 100% | 22.9 | 960 |
| 50 ms | sequential | 171.99 | 177.63 | 178.95 | 3 | 3 | 100% | 100% | 45.52 | 735 |
| 50 ms | composite | 166.18 | 170.53 | 171.99 | 1 | 3 | 100% | 100% | 35.49 | 960 |

## High traffic

- Each agent runs the order-details workflow 10 times back to back; all agents start together. The demo API adds 20 ms per request.
- Clients, gateway and demo API share one Node process on one machine, so CPU and memory figures cover all three and throughput is bounded by that single process.
- No LLM is involved; agent reasoning time between calls is excluded.
- Errors in this run are client-side connection resets (`fetch failed` / ECONNRESET), not tool failures: on macOS the TCP accept queue is capped at kern.ipc.somaxconn (128 here), and parallel clients open many new connections at once. Linux defaults are usually 4096; on macOS, raise it with `sudo sysctl kern.ipc.somaxconn=4096`. The composite variant opens one connection per agent run and did not hit the limit.

![Throughput under load](../charts/load-throughput.svg)

![p95 latency under load](../charts/load-p95.svg)

| Agents | Variant | Workflows/s | p50 ms | p95 ms | p99 ms | MCP calls/run | MCP requests/s | API requests/run | Errors | CPU s/run (whole process) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | sequential | 4.6 | 215.1 | 229.87 | 229.87 | 8 | 37 | 8 | 0 | 0.0539 |
| 1 | parallel-client | 18.2 | 54.42 | 57.78 | 57.78 | 8 | 145 | 8 | 0 | 0.0184 |
| 1 | composite | 18.6 | 54.29 | 62.34 | 62.34 | 1 | 19 | 8 | 0 | 0.0148 |
| 10 | sequential | 40.7 | 242.9 | 259.72 | 259.99 | 8 | 325 | 8 | 0 | 0.0129 |
| 10 | parallel-client | 159.8 | 57.94 | 83.06 | 89.85 | 8 | 1278 | 8 | 0 | 0.008 |
| 10 | composite | 154 | 65.12 | 68.11 | 68.23 | 1 | 154 | 8 | 0 | 0.0027 |
| 50 | sequential | 173.6 | 260.01 | 357.37 | 367.96 | 8 | 1389 | 8 | 0 | 0.0057 |
| 50 | parallel-client | 242.7 | 109.37 | 336.7 | 1227.46 | 7.9 | 1992 | 7.8 | 17 | 0.0053 |
| 50 | composite | 454.3 | 104.1 | 128.81 | 142.52 | 1 | 454 | 8 | 0 | 0.0023 |
| 100 | sequential | 252.8 | 372.38 | 511.51 | 516.09 | 8 | 2022 | 8 | 0 | 0.005 |
| 100 | parallel-client | 236.6 | 152.27 | 1155.07 | 2039.41 | 7.2 | 2358 | 6.1 | 275 | 0.004 |
| 100 | composite | 476.1 | 172.6 | 339.9 | 372.17 | 1 | 476 | 8 | 0 | 0.0026 |

## Workflow discovery accuracy

- Synthetic data: 3 planted workflows (fan-out loop, 3-step dependent chain, list+loop) plus 7 noise tools. This measures the algorithm, not real agent behaviour.
- Recall is computed over all 3 planted workflows; with rare workflows a workflow can run fewer than minSupport (3) times, which caps recall by design.
- Ablation: "contiguous (v0 baseline)" mines raw call order with a 0.9 closed-pattern ratio (the first implementation). "default" splits sessions into data-flow components and uses a 0.6 ratio.

![Pattern discovery F1](../charts/patterns-f1.svg)

| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |
|---|---|---|---|---|---|
| clean | default | 1 | 1 | 1 ± 0 | 4.97 |
| clean | no AWO rules | 1 | 1 | 1 ± 0 | 2.39 |
| clean | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 2.19 |
| clean | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 2.18 |
| boundary noise 80% | default | 1 | 1 | 1 ± 0 | 2.72 |
| boundary noise 80% | no AWO rules | 1 | 1 | 1 ± 0 | 2.05 |
| boundary noise 80% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 2.31 |
| boundary noise 80% | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 2.7 |
| rare workflows (10% of sessions) | default | 1 | 0.83 | 0.9 ± 0.1 | 1.01 |
| rare workflows (10% of sessions) | no AWO rules | 1 | 0.83 | 0.9 ± 0.1 | 1.03 |
| rare workflows (10% of sessions) | no gaps (contiguous within components) | 1 | 0.83 | 0.9 ± 0.1 | 0.88 |
| rare workflows (10% of sessions) | contiguous (v0 baseline) | 1 | 0.83 | 0.9 ± 0.1 | 1.35 |
| block-style loops | default | 1 | 1 | 1 ± 0 | 2.22 |
| block-style loops | no AWO rules | 1 | 1 | 1 ± 0 | 1.73 |
| block-style loops | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 1.78 |
| block-style loops | contiguous (v0 baseline) | 1 | 1 | 1 ± 0 | 1.87 |
| noise between steps 10% | default | 1 | 1 | 1 ± 0 | 2.01 |
| noise between steps 10% | no AWO rules | 1 | 1 | 1 ± 0 | 1.72 |
| noise between steps 10% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 1.8 |
| noise between steps 10% | contiguous (v0 baseline) | 0.71 | 1 | 0.81 ± 0.14 | 2.12 |
| noise between steps 30% | default | 1 | 1 | 1 ± 0 | 2.1 |
| noise between steps 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.86 |
| noise between steps 30% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 1.91 |
| noise between steps 30% | contiguous (v0 baseline) | 0.35 | 1 | 0.51 ± 0.02 | 2.51 |
| abandoned runs 30% | default | 1 | 1 | 1 ± 0 | 2.05 |
| abandoned runs 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.48 |
| abandoned runs 30% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 1.52 |
| abandoned runs 30% | contiguous (v0 baseline) | 0.73 | 1 | 0.83 ± 0.1 | 1.64 |
| colliding small ids (1..50) | default | 0.98 | 1 | 0.99 ± 0.04 | 3.03 |
| colliding small ids (1..50) | no AWO rules | 0.95 | 1 | 0.97 ± 0.06 | 2.37 |
| colliding small ids (1..50) | no gaps (contiguous within components) | 0.95 | 1 | 0.97 ± 0.06 | 2.01 |
| colliding small ids (1..50) | contiguous (v0 baseline) | 0.98 | 1 | 0.99 ± 0.04 | 1.84 |
| colliding small ids (1..10) | default | 1 | 1 | 1 ± 0 | 2.37 |
| colliding small ids (1..10) | no AWO rules | 0.59 | 1 | 0.73 ± 0.13 | 1.97 |
| colliding small ids (1..10) | no gaps (contiguous within components) | 0.69 | 1 | 0.81 ± 0.08 | 2.31 |
| colliding small ids (1..10) | contiguous (v0 baseline) | 0.67 | 1 | 0.79 ± 0.11 | 2.15 |
| two agents share a session key 30% | default | 1 | 1 | 1 ± 0 | 2.63 |
| two agents share a session key 30% | no AWO rules | 1 | 1 | 1 ± 0 | 1.67 |
| two agents share a session key 30% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 2.19 |
| two agents share a session key 30% | contiguous (v0 baseline) | 0.59 | 1 | 0.73 ± 0.12 | 2.06 |
| independent reads in random order 50% | default | 1 | 1 | 1 ± 0 | 2.03 |
| independent reads in random order 50% | no AWO rules | 0.65 | 1 | 0.78 ± 0.05 | 1.64 |
| independent reads in random order 50% | no gaps (contiguous within components) | 1 | 1 | 1 ± 0 | 1.96 |
| independent reads in random order 50% | contiguous (v0 baseline) | 0.75 | 1 | 0.86 ± 0 | 2 |
| optional linked side calls 30% | default | 0.86 | 1 | 0.92 ± 0.09 | 2.7 |
| optional linked side calls 30% | no AWO rules | 0.31 | 1 | 0.48 ± 0.06 | 3.09 |
| optional linked side calls 30% | no gaps (contiguous within components) | 0.53 | 0.7 | 0.59 ± 0.12 | 2.23 |
| optional linked side calls 30% | contiguous (v0 baseline) | 0.22 | 1 | 0.36 ± 0.04 | 2.29 |
| optional linked side calls 60% | default | 0.83 | 0.97 | 0.89 ± 0.12 | 4.16 |
| optional linked side calls 60% | no AWO rules | 0.17 | 1 | 0.29 ± 0.02 | 4.17 |
| optional linked side calls 60% | no gaps (contiguous within components) | 0.65 | 0.63 | 0.61 ± 0.09 | 3.33 |
| optional linked side calls 60% | contiguous (v0 baseline) | 0.12 | 0.9 | 0.21 ± 0.04 | 2.91 |
| all of the above (moderate) | default | 0.85 | 1 | 0.91 ± 0.1 | 2.59 |
| all of the above (moderate) | no AWO rules | 0.5 | 1 | 0.66 ± 0.12 | 2.19 |
| all of the above (moderate) | no gaps (contiguous within components) | 0.62 | 0.87 | 0.71 ± 0.14 | 2.03 |
| all of the above (moderate) | contiguous (v0 baseline) | 0.34 | 1 | 0.5 ± 0.07 | 2.38 |

Overall mean across conditions (shipped miner): precision 0.97, recall 0.99, F1 0.97. v0 baseline: F1 0.75.

## Scalability

- Single process on one machine; the demo API adds 5 ms latency per request in the throughput test. Loopback networking only.

![Throughput](../charts/throughput.svg)

RSS is the resident memory of the single benchmark process, which hosts the MCP clients, the gateway and the demo API together. It is an upper bound for the gateway alone.

| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB (whole process) |
|---|---|---|---|---|---|---|---|
| 1 | 100 | 0 | 112 | 8.52 | 10.4 | 12.49 | 495 |
| 10 | 1000 | 0 | 723 | 13.69 | 17.45 | 19.34 | 599 |
| 50 | 5000 | 0 | 1546 | 31.09 | 41.9 | 48.59 | 885 |
| 100 | 10000 | 0 | 1755 | 54.18 | 69.77 | 112.18 | 1123 |

| Traces mined | Sessions | Mining ms (p50) |
|---|---|---|
| 872 | 200 | 8.62 |
| 4390 | 1000 | 21.53 |
| 21908 | 5000 | 104.89 |
| 87862 | 20000 | 418.17 |

| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |
|---|---|---|---|---|
| 50 | 52 | 57 | 1 | 1.62 |
| 200 | 202 | 55 | 2 | 3.93 |
| 1000 | 1002 | 160 | 11 | 13.29 |
| 2000 | 2002 | 245 | 17.3 | 23.12 |

## What these numbers do not show

- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.
- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.
- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.
- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.

