// Builds benchmarks/reports/REPORT.md, benchmarks/charts/*.svg and
// benchmarks/results/latest.json from the recorded result files only.
// Palette: validated categorical slots 1-3 (light #2a78d6 #eb6834 #1baf7a,
// dark #3987e5 #d95926 #199e70); slot 3 is under 3:1 on light, so every bar
// carries a direct value label and the report repeats the data as tables.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT } from './lib.mjs';

const CHARTS = join(ROOT, 'benchmarks', 'charts');
const REPORTS = join(ROOT, 'benchmarks', 'reports');
mkdirSync(CHARTS, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

const load = (name) => {
  const f = join(RESULTS, `${name}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const perf = load('performance');
const pat = load('patterns');
const scale = load('scalability');
const loadRes = load('load');
if (!perf && !pat && !scale && !loadRes) {
  console.error('No results found. Run `npm run benchmark` first.');
  process.exit(1);
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

/**
 * Horizontal grouped bar chart. groups: [{ label, values: [number|null] }],
 * series: names (max 3, fixed slot order). One axis, zero baseline.
 */
function groupedBars({ title, subtitle, unit, series, groups, fmt = (v) => String(v), max }) {
  const W = 760;
  const left = 280;
  const right = 70;
  const barH = 14;
  const gap = 2;
  const groupGap = 14;
  const top = 60 + series.length * 18;
  const groupH = series.length * (barH + gap) - gap;
  const H = top + groups.length * (groupH + groupGap) + 34;
  const rawMax =
    max ??
    Math.max(...groups.flatMap((g) => g.values.filter((v) => v !== null && v !== undefined)), 1);
  // "Nice" axis: 1/2/2.5/5 x 10^n step, four intervals.
  const step = (() => {
    const raw = rawMax / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= raw) ?? raw;
  })();
  const vmax = max ?? step * 4;
  const x = (v) => left + (v / vmax) * (W - left - right);
  const rows = [];
  groups.forEach((g, gi) => {
    const y0 = top + gi * (groupH + groupGap);
    rows.push(
      `<text class="lbl" x="${left - 10}" y="${y0 + groupH / 2 + 4}" text-anchor="end">${esc(g.label)}</text>`,
    );
    g.values.forEach((v, si) => {
      if (v === null || v === undefined) return;
      const y = y0 + si * (barH + gap);
      const w = Math.max(1, x(v) - left);
      // 4px rounded data-end, square at the baseline
      const r = Math.min(4, w);
      const path = `M${left},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - r} z`;
      rows.push(
        `<path class="s${si + 1}" d="${path}"><title>${esc(`${g.label} — ${series[si]}: ${fmt(v)}${unit ? ` ${unit}` : ''}`)}</title></path>`,
      );
      rows.push(`<text class="val" x="${left + w + 6}" y="${y + barH - 3}">${esc(fmt(v))}</text>`);
    });
  });
  const ticks = [0, 1, 2, 3, 4].map((i) => (i * vmax) / 4);
  const axis = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 30}"/><text class="tick" x="${x(t)}" y="${H - 14}" text-anchor="middle">${esc(fmt(Math.round(t * 100) / 100))}</text>`,
    )
    .join('');
  const legend = series
    .map(
      (s, i) =>
        `<rect class="s${i + 1}" x="20" y="${52 + i * 18}" width="12" height="12" rx="3"/><text class="leg" x="38" y="${62 + i * 18}">${esc(s)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">
<title id="t">${esc(title)}</title><desc id="d">${esc(subtitle)}</desc>
<style>
  .bg{fill:#fcfcfb}.ttl{fill:#1b1b1a;font-size:16px;font-weight:600}.sub,.tick,.leg{fill:#5f5e58;font-size:12px}.lbl{fill:#2f2e2b;font-size:12.5px}.val{fill:#2f2e2b;font-size:11.5px;font-variant-numeric:tabular-nums}
  .grid{stroke:#e6e5e0;stroke-width:1}.s1{fill:#2a78d6}.s2{fill:#eb6834}.s3{fill:#1baf7a}
  @media (prefers-color-scheme: dark){.bg{fill:#1a1a19}.ttl{fill:#f0efec}.sub,.tick,.leg{fill:#a9a89f}.lbl,.val{fill:#d9d8d0}.grid{stroke:#33332f}.s1{fill:#3987e5}.s2{fill:#d95926}.s3{fill:#199e70}}
</style>
<rect class="bg" width="100%" height="100%" rx="8"/>
<text class="ttl" x="20" y="28">${esc(title)}</text>
<text class="sub" x="20" y="44">${esc(subtitle)}</text>
${legend}
${axis}
${rows.join('\n')}
<text class="tick" x="20" y="${H - 14}">${esc(unit)}</text>
</svg>
`;
}

const md = [];
const charts = [];
const fmtMs = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
md.push('# Benchmark report', '');
const env = (perf ?? pat ?? scale ?? loadRes).environment;
md.push(
  `Generated ${new Date().toISOString()} from the JSON files in \`benchmarks/results/\`. Nothing in this report is estimated or hand-edited.`,
  '',
  `**Environment:** toolsmith-mcp ${env.toolsmith} (commit \`${env.commit}\`), Node ${env.node}, ${env.platform}, ${env.cpu} (${env.cores} cores, ${env.memoryGb} GB), MCP SDK server ${env.mcpSdk.server} / client ${env.mcpSdk.client}${env.ci ? ', GitHub Actions runner' : ', developer workstation'}.`,
  '',
);

if (perf) {
  md.push(
    '## Workflow latency: baseline vs composite',
    '',
    `${perf.iterations} measured runs per variant after ${perf.warmup} warm-up runs.`,
    '',
  );
  for (const n of perf.notes) md.push(`- ${n}`);
  md.push('');
  for (const scenario of [...new Set(perf.scenarios.map((s) => s.scenario))]) {
    const rows = perf.scenarios.filter((s) => s.scenario === scenario);
    const variants = rows[0].variants.map((v) => v.name);
    const label = {
      sequential: 'Sequential agent (1 call at a time)',
      'parallel-client': 'Best-case parallel client',
      composite: 'Composite tool (1 call)',
    };
    const svg = groupedBars({
      title: `${scenario}: median end-to-end latency`,
      subtitle: rows[0].description,
      unit: 'ms (p50)',
      series: variants.map((v) => label[v] ?? v),
      groups: rows.map((r) => ({
        label: `API latency ${r.apiLatencyMs} ms`,
        values: r.variants.map((v) => v.latency.p50),
      })),
      fmt: fmtMs,
    });
    const file = `latency-${scenario}.svg`;
    writeFileSync(join(CHARTS, file), svg);
    charts.push(file);
    md.push(
      `### ${scenario}`,
      '',
      rows[0].description,
      '',
      `![${scenario} latency](../charts/${file})`,
      '',
    );
    md.push(
      '| API latency | Variant | p50 ms | p95 ms | p99 ms | MCP calls | API requests | Correct | Success | CPU ms/run | Result bytes |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      for (const v of r.variants) {
        md.push(
          `| ${r.apiLatencyMs} ms | ${v.name} | ${v.latency.p50} | ${v.latency.p95} | ${v.latency.p99} | ${v.mcpCalls} | ${v.apiRequests} | ${Math.round(v.correctness * 100)}% | ${Math.round(v.successRate * 100)}% | ${v.cpuMsPerRun} | ${v.resultBytesPerRun} |`,
        );
      }
    }
    md.push('');
  }
}

if (loadRes) {
  const label = { sequential: 'Sequential agents', 'parallel-client': 'Best-case parallel clients', composite: 'Composite tool' };
  const variants = [...new Set(loadRes.rows.map((r) => r.variant))];
  const conc = [...new Set(loadRes.rows.map((r) => r.concurrency))];
  const get = (c, v) => loadRes.rows.find((r) => r.concurrency === c && r.variant === v);
  const thr = groupedBars({
    title: 'High traffic: workflows completed per second',
    subtitle: `Concurrent agents running order-details; demo API ${loadRes.apiLatencyMs} ms per request`,
    unit: 'workflows/s (higher is better)',
    series: variants.map((v) => label[v] ?? v),
    groups: conc.map((c) => ({ label: `${c} agent${c > 1 ? 's' : ''}`, values: variants.map((v) => get(c, v)?.workflowsPerSec ?? null) })),
    fmt: (v) => String(Math.round(v * 10) / 10),
  });
  writeFileSync(join(CHARTS, 'load-throughput.svg'), thr);
  const p95 = groupedBars({
    title: 'High traffic: p95 workflow latency',
    subtitle: 'Per-run latency at the MCP client while all agents run at once',
    unit: 'ms, p95 (lower is better)',
    series: variants.map((v) => label[v] ?? v),
    groups: conc.map((c) => ({ label: `${c} agent${c > 1 ? 's' : ''}`, values: variants.map((v) => get(c, v)?.latency.p95 ?? null) })),
    fmt: fmtMs,
  });
  writeFileSync(join(CHARTS, 'load-p95.svg'), p95);
  charts.push('load-throughput.svg', 'load-p95.svg');
  md.push('## High traffic', '');
  for (const n of loadRes.notes) md.push(`- ${n}`);
  md.push('', '![Throughput under load](../charts/load-throughput.svg)', '', '![p95 latency under load](../charts/load-p95.svg)', '');
  md.push('| Agents | Variant | Workflows/s | p50 ms | p95 ms | p99 ms | MCP calls/run | MCP requests/s | API requests/run | Errors | CPU s/run (whole process) |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of loadRes.rows) md.push(`| ${r.concurrency} | ${r.variant} | ${r.workflowsPerSec} | ${r.latency.p50} | ${r.latency.p95} | ${r.latency.p99} | ${r.mcpCallsPerRun} | ${r.mcpRequestsPerSec} | ${r.apiRequestsPerRun} | ${r.errors} | ${r.cpuSecondsPerRun} |`);
  md.push('');
}

if (pat) {
  const variants = [...new Set(pat.grid.map((r) => r.variant))];
  const conditions = [...new Set(pat.grid.map((r) => r.condition))];
  const label = {
    default: 'Shipped miner',
    'no AWO rules': 'Without AWO rules',
    'contiguous (v0 baseline)': 'v0: contiguous order',
  };
  const svg = groupedBars({
    title: 'Workflow discovery F1 by condition',
    subtitle: `Synthetic traces, 3 planted workflows, mean of ${pat.seeds} seeds`,
    unit: 'F1',
    series: variants.map((v) => label[v] ?? v),
    groups: conditions.map((c) => ({
      label: c,
      values: variants.map(
        (v) => pat.grid.find((r) => r.condition === c && r.variant === v)?.f1.mean ?? null,
      ),
    })),
    fmt: (v) => v.toFixed(2),
    max: 1,
  });
  writeFileSync(join(CHARTS, 'patterns-f1.svg'), svg);
  charts.push('patterns-f1.svg');
  md.push('## Workflow discovery accuracy', '');
  for (const n of pat.notes) md.push(`- ${n}`);
  md.push('', '![Pattern discovery F1](../charts/patterns-f1.svg)', '');
  md.push(
    '| Condition | Miner | Precision | Recall | F1 (mean ± sd) | Mining ms (p50) |',
    '|---|---|---|---|---|---|',
  );
  for (const r of pat.grid)
    md.push(
      `| ${r.condition} | ${r.variant} | ${r.precision.mean} | ${r.recall.mean} | ${r.f1.mean} ± ${r.f1.sd} | ${r.mineMs.p50} |`,
    );
  md.push(
    '',
    `Overall mean across conditions (shipped miner): precision ${pat.overall.precision.mean}, recall ${pat.overall.recall.mean}, F1 ${pat.overall.f1.mean}. v0 baseline: F1 ${pat.overallBaseline.f1.mean}.`,
    '',
  );
}

if (scale) {
  const svg = groupedBars({
    title: 'Gateway throughput by concurrent clients',
    subtitle: 'shop__getProduct over Streamable HTTP; demo API adds 5 ms per request',
    unit: 'calls/s',
    series: ['Throughput'],
    groups: scale.throughput.map((t) => ({
      label: `${t.concurrency} client${t.concurrency > 1 ? 's' : ''}`,
      values: [t.callsPerSec],
    })),
    fmt: (v) => String(Math.round(v)),
  });
  writeFileSync(join(CHARTS, 'throughput.svg'), svg);
  charts.push('throughput.svg');
  md.push('## Scalability', '');
  for (const n of scale.notes) md.push(`- ${n}`);
  md.push(
    '',
    '![Throughput](../charts/throughput.svg)',
    '',
    'RSS is the resident memory of the single benchmark process, which hosts the MCP clients, the gateway and the demo API together. It is an upper bound for the gateway alone.',
    '',
  );
  md.push(
    '| Concurrent clients | Calls | Errors | Calls/s | p50 ms | p95 ms | p99 ms | RSS MB (whole process) |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const t of scale.throughput)
    md.push(
      `| ${t.concurrency} | ${t.calls} | ${t.errors} | ${t.callsPerSec} | ${t.latency.p50} | ${t.latency.p95} | ${t.latency.p99} | ${t.rssMb} |`,
    );
  md.push('', '| Traces mined | Sessions | Mining ms (p50) |', '|---|---|---|');
  for (const m of scale.mining) md.push(`| ${m.traces} | ${m.sessions} | ${m.ms.p50} |`);
  md.push(
    '',
    '| Operations in spec | Tools listed | Import ms | Catalog rebuild ms | tools/list p50 ms |',
    '|---|---|---|---|---|',
  );
  for (const c of scale.catalog)
    md.push(
      `| ${c.operations} | ${c.tools} | ${c.importMs} | ${c.catalogRebuildMs} | ${c.listToolsMs.p50} |`,
    );
  md.push('');
}

md.push(
  '## What these numbers do not show',
  '',
  '- **LLM requests and tokens were not measured.** No LLM runs in these benchmarks. Fewer MCP calls usually means fewer agent turns, but this report makes no token or cost claim.',
  '- **Agent reasoning time is excluded.** In a real agent, each avoided round-trip also saves a model turn, which is typically far slower than the API calls measured here.',
  '- **Loopback only.** Client, gateway and API run on one machine; real networks add latency to every call, which favours composites.',
  '- **Synthetic data for pattern discovery.** The planted workflows and noise model are ours; real traces will differ.',
  '',
);
writeFileSync(join(REPORTS, 'REPORT.md'), `${md.join('\n')}\n`);
writeFileSync(
  join(RESULTS, 'latest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), environment: env, performance: perf, patterns: pat, scalability: scale, load: loadRes, charts }, null, 2)}\n`,
);
console.log(`Wrote benchmarks/reports/REPORT.md and ${charts.length} charts.`);
