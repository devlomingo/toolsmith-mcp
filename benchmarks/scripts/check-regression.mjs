// Benchmark regression gate for CI. Timing on shared runners is noisy, so
// it asserts structural properties that must always hold, plus accuracy floors.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS } from './lib.mjs';

const failures = [];
const perf = JSON.parse(readFileSync(join(RESULTS, 'performance.json'), 'utf8'));
for (const s of perf.scenarios) {
  const by = Object.fromEntries(s.variants.map((v) => [v.name, v]));
  for (const v of s.variants) {
    if (v.correctness !== 1)
      failures.push(`${s.name}: ${v.name} correctness ${v.correctness} (must be 1)`);
    if (v.successRate !== 1)
      failures.push(`${s.name}: ${v.name} success ${v.successRate} (must be 1)`);
  }
  if (by.composite.mcpCalls !== 1)
    failures.push(`${s.name}: composite made ${by.composite.mcpCalls} MCP calls`);
  if (by.composite.apiRequests !== by.sequential.apiRequests)
    failures.push(
      `${s.name}: composite API requests ${by.composite.apiRequests} != sequential ${by.sequential.apiRequests}`,
    );
  if (s.apiLatencyMs >= 25 && by.composite.latency.p50 > by.sequential.latency.p50)
    failures.push(`${s.name}: composite p50 slower than sequential`);
}
const pat = JSON.parse(readFileSync(join(RESULTS, 'patterns.json'), 'utf8'));
if (pat.overall.f1.mean < 0.9) failures.push(`pattern F1 ${pat.overall.f1.mean} < 0.9`);
if (pat.overall.f1.mean < pat.overallBaseline.f1.mean)
  failures.push('shipped miner worse than v0 baseline');
for (const r of pat.grid.filter((x) => x.variant === 'default' && x.condition === 'clean')) {
  if (r.f1.mean !== 1) failures.push(`clean-condition F1 ${r.f1.mean} (must be 1)`);
}
if (failures.length) {
  console.error(`Benchmark regression:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Benchmark regression checks passed.');
