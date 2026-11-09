// Builds the GitHub Pages site into site/dist from committed sources only:
// package.json, benchmarks/results/latest.json, benchmarks/charts/*.svg and
// docs/images/*.png. Every number on the page is read from the results file.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const REPO = 'https://github.com/devlomingo/toolsmith-mcp';
const SITE = 'https://devlomingo.github.io/toolsmith-mcp/';
const latestPath = join(ROOT, 'benchmarks', 'results', 'latest.json');
if (!existsSync(latestPath)) {
  console.error(
    'benchmarks/results/latest.json is missing. Run `npm run benchmark` and commit the results.',
  );
  process.exit(1);
}
const bench = JSON.parse(readFileSync(latestPath, 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'benchmarks', 'charts')))
  copyFileSync(join(ROOT, 'benchmarks', 'charts', f), join(OUT, 'assets', f));
for (const f of readdirSync(join(ROOT, 'docs', 'images')))
  copyFileSync(join(ROOT, 'docs', 'images', f), join(OUT, 'assets', f));

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const doc = (p) => `${REPO}/blob/main/${p}`;
const r1 = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);

// ---- numbers from the results file ------------------------------------------
const perf = bench.performance;
const od = (lat) =>
  perf.scenarios.find((s) => s.scenario === 'order-details' && s.apiLatencyMs === lat);
const v = (s, name) => s?.variants.find((x) => x.name === name);
const lats = [...new Set(perf.scenarios.map((s) => s.apiLatencyMs))];
const headline = od(25) ?? od(lats[lats.length - 1]);
const seq = v(headline, 'sequential');
const par = v(headline, 'parallel-client');
const comp = v(headline, 'composite');
const perfRows = lats
  .map((l) => {
    const s = od(l);
    return `<tr><td>${l} ms</td><td>${r1(v(s, 'sequential').latency.p50)} ms</td><td>${r1(v(s, 'parallel-client').latency.p50)} ms</td><td><strong>${r1(v(s, 'composite').latency.p50)} ms</strong></td></tr>`;
  })
  .join('');
const chain = perf.scenarios.filter(
  (s) => s.scenario === 'dependent-chain' && s.apiLatencyMs >= 10,
);
const chainGain = chain.map(
  (s) => 1 - v(s, 'composite').latency.p50 / v(s, 'sequential').latency.p50,
);
const pct = (x) => `${Math.round(x * 100)}%`;
const pctRange = (xs) =>
  pct(Math.min(...xs)) === pct(Math.max(...xs))
    ? `about ${pct(xs[0])}`
    : `${pct(Math.min(...xs))}–${pct(Math.max(...xs))}`;
// Positive = composite faster.
const signed = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
const parGain = lats
  .filter((l) => l >= 10)
  .map((l) => 1 - v(od(l), 'composite').latency.p50 / v(od(l), 'parallel-client').latency.p50);
const pat = bench.patterns;
const weakest = pat.grid
  .filter((r) => r.variant === 'default')
  .sort((a, b) => a.f1.mean - b.f1.mean)[0];
const thr = bench.scalability.throughput;
const maxThr = thr[thr.length - 1];
const env = bench.environment;
const ld = bench.load;
const loadNote = (() => {
  if (!ld) return '';
  const top = Math.max(...ld.rows.map((r) => r.concurrency));
  const at = (v) => ld.rows.find((r) => r.concurrency === top && r.variant === v);
  const c = at('composite');
  const p = at('parallel-client');
  const s = at('sequential');
  if (!c || !p || !s) return '';
  return `<h3 style="margin-top:36px">Under high traffic (${top} concurrent agents)</h3><p class="sub">The composite completed ${c.workflowsPerSec} workflows/s vs ${p.workflowsPerSec} for best-case parallel clients and ${s.workflowsPerSec} for sequential agents, at p95 ${r1(c.latency.p95)} ms vs ${r1(p.latency.p95)} ms and ${r1(s.latency.p95)} ms, while the gateway handled ${c.mcpRequestsPerSec} MCP requests/s instead of ${p.mcpRequestsPerSec}. ${p.errors ? ` ${p.errors} of ${p.runs} parallel-client runs failed with connection resets (the macOS accept queue is ${ld.somaxconn ?? 128}); the composite had ${c.errors}.` : ''} Successful runs only; one process on one machine.</p>`;
})();
const envLine = `${esc(env.cpu)}, ${env.cores} cores · Node ${esc(env.node)} · MCP SDK ${esc(env.mcpSdk.server)} · commit ${esc(env.commit)}`;

const archSvg = `<svg viewBox="0 0 960 430" role="img" aria-labelledby="arch-t arch-d" class="arch">
<title id="arch-t">Architecture</title><desc id="arch-d">Agents connect to the toolsmith gateway over MCP. Every call passes the dispatcher (validate, policy, observe, execute) and reaches the composite executor, upstream MCP servers, or REST APIs. The observer records traces in SQLite or PostgreSQL; the pattern miner proposes composites to the registry; the evaluator tests them and a human approves before the catalog exposes them.</desc>
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>
<g class="lane"><rect x="10" y="40" width="170" height="350" rx="14"/><text x="95" y="68" text-anchor="middle" class="lane-t">Any MCP client</text></g>
<g class="node"><rect x="28" y="96" width="134" height="58" rx="10"/><text x="95" y="122" text-anchor="middle">Agent</text><text x="95" y="140" text-anchor="middle" class="sm">stdio</text></g>
<g class="node"><rect x="28" y="176" width="134" height="58" rx="10"/><text x="95" y="202" text-anchor="middle">Agent</text><text x="95" y="220" text-anchor="middle" class="sm">HTTP</text></g>
<g class="node"><rect x="28" y="256" width="134" height="58" rx="10"/><text x="95" y="282" text-anchor="middle">You</text><text x="95" y="300" text-anchor="middle" class="sm">CLI · dashboard</text></g>
<g class="lane forge"><rect x="215" y="20" width="520" height="395" rx="16"/><text x="475" y="48" text-anchor="middle" class="lane-t">toolsmith-mcp</text></g>
<g class="node hot"><rect x="240" y="70" width="210" height="64" rx="10"/><text x="345" y="98" text-anchor="middle">Dispatcher</text><text x="345" y="117" text-anchor="middle" class="sm">validate · policy · run</text></g>
<g class="node"><rect x="490" y="70" width="220" height="64" rx="10"/><text x="600" y="98" text-anchor="middle">Catalog</text><text x="600" y="117" text-anchor="middle" class="sm">approved tools only</text></g>
<g class="node"><rect x="240" y="160" width="140" height="58" rx="10"/><text x="310" y="186" text-anchor="middle">Composites</text><text x="310" y="204" text-anchor="middle" class="sm">parallel DAG</text></g>
<g class="node"><rect x="395" y="160" width="140" height="58" rx="10"/><text x="465" y="186" text-anchor="middle">Upstreams</text><text x="465" y="204" text-anchor="middle" class="sm">both MCP eras</text></g>
<g class="node"><rect x="550" y="160" width="160" height="58" rx="10"/><text x="630" y="186" text-anchor="middle">HTTP executor</text><text x="630" y="204" text-anchor="middle" class="sm">SSRF guard</text></g>
<g class="node"><rect x="240" y="250" width="140" height="58" rx="10"/><text x="310" y="276" text-anchor="middle">Observer</text><text x="310" y="294" text-anchor="middle" class="sm">redact · hash</text></g>
<g class="node"><rect x="395" y="250" width="140" height="58" rx="10"/><text x="465" y="276" text-anchor="middle">Miner</text><text x="465" y="294" text-anchor="middle" class="sm">data flow</text></g>
<g class="node"><rect x="550" y="250" width="160" height="58" rx="10"/><text x="630" y="276" text-anchor="middle">Evaluator</text><text x="630" y="294" text-anchor="middle" class="sm">verify · compare</text></g>
<g class="node"><rect x="240" y="335" width="140" height="58" rx="10"/><text x="310" y="361" text-anchor="middle">SQLite / Postgres</text><text x="310" y="379" text-anchor="middle" class="sm">traces</text></g>
<g class="node hot"><rect x="395" y="335" width="315" height="58" rx="10"/><text x="552" y="361" text-anchor="middle">Registry · human approval</text><text x="552" y="379" text-anchor="middle" class="sm">versions · grants · rollback</text></g>
<g class="lane"><rect x="770" y="40" width="180" height="350" rx="14"/><text x="860" y="68" text-anchor="middle" class="lane-t">Outside</text></g>
<g class="node"><rect x="790" y="160" width="140" height="58" rx="10"/><text x="860" y="186" text-anchor="middle">REST APIs</text><text x="860" y="204" text-anchor="middle" class="sm">from OpenAPI</text></g>
<g class="node"><rect x="790" y="250" width="140" height="58" rx="10"/><text x="860" y="276" text-anchor="middle">MCP servers</text><text x="860" y="294" text-anchor="middle" class="sm">aggregated</text></g>
<g class="edges" fill="none">
<path d="M162,125 C200,125 205,96 240,96" marker-end="url(#ah)"/>
<path d="M162,205 C210,205 205,118 240,116" marker-end="url(#ah)"/>
<path d="M490,102 L452,102" marker-end="url(#ah)"/>
<path d="M300,134 L300,158" marker-end="url(#ah)"/>
<path d="M400,134 L455,158" marker-end="url(#ah)"/>
<path d="M440,128 C560,138 610,140 625,158" marker-end="url(#ah)"/>
<path d="M340,160 C350,150 360,145 365,136" class="loop" marker-end="url(#ah)"/>
<path d="M710,189 L788,189" marker-end="url(#ah)"/>
<path d="M465,218 L465,234 L760,234 L788,268" marker-end="url(#ah)"/>
<path d="M240,124 C222,150 222,250 238,272" marker-end="url(#ah)"/>
<path d="M310,308 L310,333" marker-end="url(#ah)"/>
<path d="M380,352 C430,352 455,330 462,310" marker-end="url(#ah)"/>
<path d="M500,308 L500,333" marker-end="url(#ah)"/>
<path d="M630,333 L630,310" marker-start="url(#ah)" marker-end="url(#ah)"/>
<path d="M710,360 C740,360 740,150 700,136" marker-end="url(#ah)"/>
<path d="M150,314 C190,420 360,415 400,388" marker-end="url(#ah)"/>
</g></svg>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolsmith-mcp: give any AI agent the tools it needs</title>
<meta name="description" content="Open-source MCP gateway: turn OpenAPI specs into verified MCP tools, aggregate MCP servers, discover repeated agent workflows and publish equivalence-checked composite tools behind human approval.">
<link rel="canonical" href="${SITE}">
<meta property="og:type" content="website">
<meta property="og:title" content="toolsmith-mcp: give any AI agent the tools it needs">
<meta property="og:description" content="Discover APIs, generate MCP integrations, identify repeated workflows, and create optimized tools for AI agents.">
<meta property="og:url" content="${SITE}">
<meta property="og:image" content="${SITE}assets/dashboard-composite.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#14110f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2314110f'/%3E%3Cpath d='M7 20h18l-3 5H10z' fill='%23ff7a1a'/%3E%3Crect x='14' y='7' width='4' height='13' rx='1' fill='%23f3ece2'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: 'toolsmith-mcp', codeRepository: REPO, programmingLanguage: 'TypeScript', license: 'https://opensource.org/licenses/MIT', version: pkg.version, description: pkg.description })}</script>
<style>
:root{--bg:#14110f;--bg2:#1c1815;--panel:#221d19;--line:#3a322b;--ink:#f3ece2;--ink2:#c9bfb2;--mute:#9a8f82;--ember:#ff7a1a;--ember2:#ffb36b;--steel:#8fb3d9;--ok:#7fd1a3;--display:'Bricolage Grotesque',Georgia,serif;--body:'IBM Plex Sans',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 var(--body);-webkit-font-smoothing:antialiased;
background-image:linear-gradient(rgba(143,179,217,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(143,179,217,.045) 1px,transparent 1px);background-size:32px 32px}
a{color:var(--ember2);text-underline-offset:3px}a:hover{color:var(--ember)}
:focus-visible{outline:2px solid var(--ember);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--ember);color:#14110f;padding:8px 14px;z-index:9}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
nav.top{position:sticky;top:0;z-index:5;background:rgba(20,17,15,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
nav.top .wrap{display:flex;align-items:center;gap:22px;height:60px}
.brand{font:700 19px var(--display);color:var(--ink);text-decoration:none;display:flex;gap:10px;align-items:center;letter-spacing:-.01em}
.brand i{display:inline-block;width:22px;height:22px;border-radius:5px;background:linear-gradient(180deg,var(--ink) 0 45%,transparent 45%),var(--ember);clip-path:polygon(35% 0,65% 0,65% 55%,100% 55%,85% 100%,15% 100%,0 55%,35% 55%)}
nav.top ul{display:flex;gap:18px;list-style:none;margin:0 0 0 auto;padding:0}nav.top ul a{color:var(--ink2);text-decoration:none;font-size:15px}nav.top ul a:hover{color:var(--ink)}
.gh{border:1px solid var(--line);padding:6px 12px;border-radius:8px}
header.hero{padding:96px 0 64px;position:relative;overflow:hidden}
.hero::after{content:"";position:absolute;right:-180px;top:-120px;width:620px;height:620px;background:radial-gradient(circle,rgba(255,122,26,.20),transparent 62%);pointer-events:none}
.eyebrow{font:600 13px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ember2)}
h1{font:800 clamp(44px,7.4vw,92px)/.96 var(--display);letter-spacing:-.035em;margin:18px 0 22px;max-width:14ch}
h1 em{font-style:normal;color:var(--ember);position:relative}
.lede{font-size:clamp(18px,2.1vw,22px);color:var(--ink2);max-width:60ch;margin:0 0 34px}
.cta{display:flex;flex-wrap:wrap;gap:14px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:8px;font:600 16px var(--body);padding:12px 20px;border-radius:10px;text-decoration:none;border:1px solid var(--line);color:var(--ink)}
.btn.primary{background:var(--ember);border-color:var(--ember);color:#1a0f06}.btn.primary:hover{background:var(--ember2);color:#1a0f06}
.install{font:15px var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;display:flex;gap:12px;align-items:center;max-width:100%;overflow-x:auto}
.install b{color:var(--ember)}.install code{white-space:pre-wrap;word-break:break-all}
.ticker{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:56px}
.ticker div{background:var(--bg2);padding:20px 22px}.ticker strong{display:block;font:800 34px var(--display);letter-spacing:-.02em;color:var(--ink)}.ticker span{color:var(--mute);font-size:14px}
section{padding:84px 0;border-top:1px solid var(--line)}
h2{font:700 clamp(30px,4vw,46px)/1.05 var(--display);letter-spacing:-.025em;margin:10px 0 18px;max-width:22ch}
h3{font:700 21px var(--display);margin:0 0 8px;letter-spacing:-.01em}
.sub{color:var(--ink2);max-width:66ch}
.grid{display:grid;gap:18px}.grid>*,.cta>*{min-width:0}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
.card p{margin:0;color:var(--ink2)}
.step{counter-increment:s;position:relative;padding-top:56px}.step::before{content:counter(s,decimal-leading-zero);position:absolute;top:20px;left:24px;font:600 14px var(--mono);color:var(--ember)}
.steps{counter-reset:s}
pre,code{font-family:var(--mono)}pre{background:#0f0d0b;border:1px solid var(--line);border-radius:12px;padding:18px;overflow-x:auto;font-size:14px;line-height:1.55;margin:0;color:#e9e1d6}
.k{color:var(--ember2)}.s{color:var(--ok)}.c{color:var(--mute)}
.arch{width:100%;height:auto;color:var(--mute);margin-top:28px}
.arch .lane rect{fill:rgba(143,179,217,.04);stroke:var(--line);stroke-dasharray:4 5}.arch .forge rect{fill:rgba(255,122,26,.04);stroke:rgba(255,122,26,.4)}
.arch .lane-t{fill:var(--mute);font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase}
.arch .node rect{fill:var(--panel);stroke:var(--line)}.arch .node.hot rect{stroke:var(--ember)}
.arch text{fill:var(--ink);font:600 14px var(--body)}.arch .sm{fill:var(--mute);font:11px var(--mono)}
.arch .edges path{stroke:#6d6156;stroke-width:1.4}.arch .edges .loop{stroke:var(--ember);stroke-dasharray:4 4}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line)}th{font:600 13px var(--mono);color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
.tbl{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow-x:auto}
.charts img{width:100%;height:auto;border-radius:12px;border:1px solid var(--line);background:#1a1a19}
.note{font-size:14px;color:var(--mute);border-left:3px solid var(--ember);padding:4px 0 4px 14px;margin-top:20px}
.shot{border-radius:14px;border:1px solid var(--line);width:100%;height:auto;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.feat h3::before{content:"";display:inline-block;width:9px;height:9px;background:var(--ember);border-radius:2px;margin-right:10px;transform:translateY(-2px)}
.roadmap li{margin:6px 0;color:var(--ink2)}
footer{border-top:1px solid var(--line);padding:40px 0 60px;color:var(--mute);font-size:14px}
.reveal{animation:rise .8s cubic-bezier(.2,.7,.2,1) both}.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}.d4{animation-delay:.32s}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.reveal{animation:none}html{scroll-behavior:auto}}
@media (max-width:860px){.g2,.g3{grid-template-columns:1fr}.ticker{grid-template-columns:repeat(2,minmax(0,1fr))}nav.top ul li:not(:last-child){display:none}}
@media (max-width:480px){.wrap{padding:0 16px}header.hero{padding-top:64px}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<nav class="top" aria-label="Main"><div class="wrap">
<a class="brand" href="#top"><i aria-hidden="true"></i>toolsmith-mcp</a>
<ul><li><a href="#how">How it works</a></li><li><a href="#benchmarks">Benchmarks</a></li><li><a href="#security">Security</a></li><li><a href="#docs">Docs</a></li><li><a class="gh" href="${REPO}">GitHub</a></li></ul>
</div></nav>

<main id="main">
<header class="hero" id="top"><div class="wrap">
<div class="eyebrow reveal">Open source · MCP gateway · v${esc(pkg.version)}</div>
<h1 class="reveal d1">Give any AI agent the tools it <em>needs</em>.</h1>
<p class="lede reveal d2">Discover APIs, generate MCP integrations, identify repeated workflows, and create optimized tools for AI agents. Every generated tool is evaluated and approved by a human before an agent sees it.</p>
<div class="cta reveal d3">
<div class="install" aria-label="Install command"><b>$</b><code>npm install -g toolsmith-mcp &amp;&amp; toolsmith-mcp demo</code></div>
<a class="btn primary" href="${REPO}">View on GitHub</a>
<a class="btn" href="${doc('docs/INSTALLATION.md')}">Install guide</a>
</div>
<div class="ticker reveal d4" aria-label="Measured results">
<div><strong>${seq.mcpCalls} → ${comp.mcpCalls}</strong><span>MCP calls for a fan-out workflow</span></div>
<div><strong>${r1(seq.latency.p50)} → ${r1(comp.latency.p50)} ms</strong><span>p50 vs a sequential agent, ${headline.apiLatencyMs} ms API</span></div>
<div><strong>${pct(comp.correctness)}</strong><span>composite runs identical to the original calls</span></div>
<div><strong>F1 ${pat.overall.f1.mean}</strong><span>workflow discovery, ${pat.grid.filter((r) => r.variant === 'default').length} synthetic conditions</span></div>
</div>
</div></header>

<section id="vision"><div class="wrap grid g2">
<div><div class="eyebrow">Vision</div><h2>Agents shouldn't be limited to the tools someone already wrote.</h2></div>
<div><p class="sub">If a service has an API description, an agent should be able to use it, safely. If an agent keeps doing the same five calls, the platform should notice and offer one better tool. toolsmith-mcp does both, behind one standard MCP endpoint that works with any client.</p></div>
</div></section>

<section id="problem"><div class="wrap">
<div class="eyebrow">The problem</div><h2>Three gaps between agents and the APIs they need</h2>
<div class="grid g3" style="margin-top:28px">
<div class="card"><h3>Missing integrations</h3><p>Most APIs have no MCP server. Hand-writing one per API doesn't scale, and generated ones are rarely checked against the live API.</p></div>
<div class="card"><h3>Chatty workflows</h3><p>Agents fetch a customer, their orders, then items and payments per order, one round-trip and one model turn at a time.</p></div>
<div class="card"><h3>Unsafe automation</h3><p>Auto-generated tools with write access, credentials in logs, SSRF through a base URL: generation without guardrails is a liability.</p></div>
</div></div></section>

<section id="how"><div class="wrap">
<div class="eyebrow">How it works</div><h2>From API description to approved, optimized tool</h2>
<div class="grid g3 steps" style="margin-top:28px">
<div class="card step"><h3>Import</h3><p>OpenAPI 3.x, Swagger 2.0 or a plain endpoint list becomes typed MCP tools. Missing information is reported, never invented.</p></div>
<div class="card step"><h3>Verify</h3><p>Every read operation is called with real values from examples or from other endpoints. Writes are never called.</p></div>
<div class="card step"><h3>Approve</h3><p>A human reviews tools, findings and permissions. Write and destructive tools stay hidden until granted.</p></div>
<div class="card step"><h3>Observe</h3><p>Calls are traced with keyed value fingerprints, not payloads, so data flow is visible without storing data.</p></div>
<div class="card step"><h3>Discover</h3><p>Repeated, data-linked workflows are mined; loops and parallelizable steps are recognised.</p></div>
<div class="card step"><h3>Compose</h3><p>A composite tool is proposed, checked to return exactly what the original calls return, then approved and tracked for real usage.</p></div>
</div>
${archSvg}
<p class="note">Dashed arrow: composite steps call back through the dispatcher, so they get the same validation, policy and tracing. Nothing generated runs as code: imported operations and composites are declarative data executed by fixed, tested code. <a href="${doc('docs/ARCHITECTURE.md')}">Architecture in detail →</a></p>
</div></section>

<section id="api"><div class="wrap grid g2">
<div><div class="eyebrow">API → MCP</div><h2>One command per API</h2><p class="sub">Each operation becomes a tool with input and output schemas, auth from environment variables, timeouts, rate limits and safe retries. Live verification classifies every read tool: verified, wrong parameter value, schema mismatch, auth failure, and more, after <a href="${doc('docs/PAPERS.md')}#toolfactory">ToolFactory</a>.</p></div>
<pre aria-label="Import example"><span class="c">$</span> toolsmith-mcp import ./shop.yaml --name shop --token-env SHOP_TOKEN
<span class="s">✓</span> Demo Shop API: 11 operations (8 read, 2 write, 1 destructive)

  <span class="s">✓</span> live verification — 8/8 read operations verified
  <span class="s">✓</span> live: getOrderItems — verified [values: orderId←listOrders.id]
  <span class="k">!</span> permission review — 2 write, 1 destructive stay hidden

Review, then approve: <span class="k">toolsmith-mcp approve shop</span></pre>
</div></section>

<section id="composite"><div class="wrap grid g2">
<pre aria-label="Composite plan">{
  <span class="k">"toolName"</span>: <span class="s">"flow__getUserOrdersDetails"</span>,
  <span class="k">"steps"</span>: [
    { <span class="k">"id"</span>: <span class="s">"getUser"</span>,   <span class="k">"args"</span>: { <span class="s">"userId"</span>: { <span class="k">"$ref"</span>: <span class="s">"input.userId"</span> } } },
    { <span class="k">"id"</span>: <span class="s">"getOrders"</span>, <span class="k">"args"</span>: { <span class="s">"userId"</span>: { <span class="k">"$ref"</span>: <span class="s">"input.userId"</span> } } },
    { <span class="k">"id"</span>: <span class="s">"getOrderItems"</span>, <span class="k">"forEach"</span>: <span class="s">"steps.getOrders.result[*]"</span>,
      <span class="k">"args"</span>: { <span class="s">"orderId"</span>: { <span class="k">"$ref"</span>: <span class="s">"item.id"</span> } } },
    { <span class="k">"id"</span>: <span class="s">"getPayments"</span>,   <span class="k">"forEach"</span>: <span class="s">"steps.getOrders.result[*]"</span>,
      <span class="k">"args"</span>: { <span class="s">"orderId"</span>: { <span class="k">"$ref"</span>: <span class="s">"item.id"</span> } } }
  ]
}</pre>
<div><div class="eyebrow">Composite tools</div><h2>Workflows agents repeat, as one call</h2><p class="sub">The miner links calls by data flow, folds loops, treats independent reads as commutative and applies a majority rule from <a href="${doc('docs/PAPERS.md')}#awo-optimizing-agentic-workflows-using-meta-tools">AWO</a>. The plan above was discovered from traces, with no hand-written wiring. Independent steps run in parallel; failures give partial results.</p></div>
</div></section>

<section id="benchmarks"><div class="wrap">
<div class="eyebrow">Real benchmark results</div><h2>Measured, not estimated</h2>
<p class="sub">Generated by <code>npm run benchmark</code> on ${envLine}. Client, gateway and a demo API on loopback; latency measured at the MCP client over Streamable HTTP. <strong>Synthetic setup, not production measurements.</strong></p>
<div class="tbl" style="margin-top:24px"><table>
<caption class="sr-only" style="position:absolute;left:-999px">Median latency of the order-details workflow</caption>
<thead><tr><th>Demo API latency</th><th>Sequential agent (${seq.mcpCalls} calls)</th><th>Best-case parallel client (${par.mcpCalls} calls)</th><th>Composite (${comp.mcpCalls} call)</th></tr></thead>
<tbody>${perfRows}</tbody></table></div>
<p class="note">Against a client that already parallelizes perfectly, this run measured the composite ${signed(Math.min(...parGain))} to ${signed(Math.max(...parGain))} faster, but an independent re-run measured it slightly slower at 25 ms, so treat the latency difference as noise. The real saving is ${par.mcpCalls - comp.mcpCalls} fewer MCP round-trips, which in a real agent are model turns this benchmark does not include. A strictly sequential 3-step chain gains ${pctRange(chainGain)}. LLM tokens were not measured, and no token claim is made.</p>
${loadNote}
<div class="grid g2 charts" style="margin-top:28px">
<figure style="margin:0"><img src="assets/load-throughput.svg" alt="Bar chart: workflows completed per second at 1 to 100 concurrent agents for sequential agents, parallel clients and the composite tool" loading="lazy" width="760" height="320"></figure>
<figure style="margin:0"><img src="assets/load-p95.svg" alt="Bar chart: p95 workflow latency at 1 to 100 concurrent agents for the three variants" loading="lazy" width="760" height="320"></figure>
</div>
<div class="grid g2 charts" style="margin-top:18px">
<figure style="margin:0"><img src="assets/latency-order-details.svg" alt="Bar chart: median latency of the order-details workflow for sequential, parallel-client and composite variants at each API latency" loading="lazy" width="760" height="320"></figure>
<figure style="margin:0"><img src="assets/patterns-f1.svg" alt="Bar chart: workflow discovery F1 per condition for the shipped miner, without AWO rules, and the first contiguous version" loading="lazy" width="760" height="800"></figure>
</div>
<p class="note">Workflow discovery: mean F1 ${pat.overall.f1.mean} across conditions (first version: ${pat.overallBaseline.f1.mean}). Weakest case: <em>${esc(weakest.condition)}</em> at precision ${weakest.precision.mean}. Throughput: ${maxThr.callsPerSec} calls/s at ${maxThr.concurrency} concurrent clients (p95 ${maxThr.latency.p95} ms). <a href="${doc('benchmarks/reports/REPORT.md')}">Full report, method and limitations →</a></p>
</div></section>

<section id="install"><div class="wrap grid g2">
<div><div class="eyebrow">Installation</div><h2>Running in a minute</h2><p class="sub">Node 22.13+. No database or service to set up. Or use the Docker image.</p>
<p><a href="${doc('docs/INSTALLATION.md')}">Installation guide</a> · <a href="${doc('docs/MCP-INTEGRATION.md')}">Connect a client</a></p></div>
<pre aria-label="Quick start"><span class="c"># install and try the full lifecycle</span>
npm install -g toolsmith-mcp
toolsmith-mcp demo

<span class="c"># your own API</span>
toolsmith-mcp init
toolsmith-mcp import ./openapi.yaml --name shop
toolsmith-mcp approve shop
toolsmith-mcp start
toolsmith-mcp client-config</pre>
</div></section>

<section id="features"><div class="wrap">
<div class="eyebrow">Features</div><h2>Implemented in v${esc(pkg.version)}</h2>
<div class="grid g3 feat" style="margin-top:28px">
<div class="card"><h3>Both MCP eras</h3><p>2025-11-25 and 2026-07-28 over stdio and Streamable HTTP, through the official v2 SDK. Works with any client.</p></div>
<div class="card"><h3>Server aggregation</h3><p>Upstream MCP servers behind one endpoint, prefixed, traced and usable in composites.</p></div>
<div class="card"><h3>Capability requests</h3><p>Agents ask for what is missing. The answer: available, composable, needs approval, or unsupported.</p></div>
<div class="card"><h3>Lifecycle &amp; rollback</h3><p>Versioned integrations and composites, human-only approval, disable, enable, rollback, audit log.</p></div>
<div class="card"><h3>Usage tracking</h3><p>Calls, round-trips saved, and how often agents still do the workflow by hand. Unused tools are flagged.</p></div>
<div class="card"><h3>Dashboard</h3><p>No build step. Approvals, traces, workflows, benchmarks. English and Arabic, with right-to-left layout.</p></div>
<div class="card"><h3>More sources</h3><p>OpenAPI, Swagger, Postman collections, GraphQL introspection, gRPC (.proto or server reflection), plain endpoint lists, and (optionally, via an LLM) free-text docs.</p></div>
<div class="card"><h3>Large catalogs</h3><p>Per-client allow-lists enforced on every call, a search listing mode, and a tool-search meta tool.</p></div>
<div class="card"><h3>Transforms &amp; constants</h3><p>Composites can filter, sort and pick ("the latest order") with a fixed vocabulary, and bake in arguments that never change.</p></div>
<div class="card"><h3>OAuth 2.1 sign-in</h3><p>MCP clients sign in through your own authorization server: JWT validation, audience checks, protected-resource metadata. New in 0.2.0.</p></div>
<div class="card"><h3>Teams &amp; scale</h3><p>Per-client allow-lists and rate limits, and PostgreSQL so several gateway nodes share one state. New in 0.2.0.</p></div>
<div class="card"><h3>Telemetry &amp; API auth</h3><p>OpenTelemetry span export; OAuth 2.0 client credentials toward APIs; opt-in in-client approval via MCP elicitation.</p></div>
</div>
<img class="shot" style="margin-top:36px" src="assets/dashboard-composite.png" alt="Dashboard showing an evaluated composite tool with passed equivalence checks and its plan" loading="lazy" width="1280" height="1100">
</div></section>

<section id="security"><div class="wrap grid g2">
<div><div class="eyebrow">Security</div><h2>Guardrails are the product</h2><p class="sub">Security is built in, not added later. <a href="${doc('docs/SECURITY.md')}">Threat model →</a></p></div>
<div class="card"><ul style="margin:0;padding-left:18px;color:var(--ink2)">
<li>Nothing generated runs as code</li><li>SSRF guard: allow-list, connect-time private-address block, no redirects</li><li>Secrets only from the environment, redacted everywhere</li><li>Traces keep keyed hashes, never tool results</li><li>Generated write and destructive tools hidden until granted</li><li>Per-call approval for destructive actions, including those of connected MCP servers, bound to exact arguments and the calling client's token</li><li>Approvals from the dashboard or an interactive terminal, never through MCP</li><li>Composites can never exceed their steps' permissions, and writing composites need their own write grant</li><li>Tool-poisoning text in specs blocks approval</li></ul></div>
</div></section>

<section id="docs"><div class="wrap">
<div class="eyebrow">Documentation</div><h2>Everything is written down</h2>
<div class="grid g3" style="margin-top:28px">
<a class="card" href="${doc('docs/INSTALLATION.md')}"><h3>Installation</h3><p>npm, Docker, source.</p></a>
<a class="card" href="${doc('docs/CONFIGURATION.md')}"><h3>Configuration</h3><p>Every field and default.</p></a>
<a class="card" href="${doc('docs/API-INTEGRATION.md')}"><h3>API integration</h3><p>Specs, endpoint lists, auth.</p></a>
<a class="card" href="${doc('docs/MCP-INTEGRATION.md')}"><h3>MCP clients</h3><p>stdio and HTTP setup.</p></a>
<a class="card" href="${doc('docs/TOOL-GENERATION.md')}"><h3>Composite tools</h3><p>Discovery, evaluation, usage.</p></a>
<a class="card" href="${doc('docs/ARCHITECTURE.md')}"><h3>Architecture &amp; ADRs</h3><p>Components and decisions.</p></a>
</div></div></section>

<section id="roadmap"><div class="wrap grid g2">
<div><div class="eyebrow">Roadmap</div><h2>What's next</h2><p class="sub">Not built yet; tracked in the <a href="${doc('docs/ROADMAP.md')}">roadmap</a>.</p></div>
<ul class="roadmap"><li>Shared rate limits across gateway nodes</li><li>Optional calls inside loop bodies</li></ul>
</div></section>

<section id="community"><div class="wrap">
<div class="eyebrow">Community</div><h2>Built in the open</h2>
<p class="sub">MIT licensed. Issues, ideas and pull requests welcome. Read the <a href="${doc('CONTRIBUTING.md')}">contributing guide</a> and <a href="${doc('CODE_OF_CONDUCT.md')}">code of conduct</a>; report vulnerabilities privately per the <a href="${doc('SECURITY.md')}">security policy</a>.</p>
<div class="cta" style="margin-top:20px"><a class="btn primary" href="${REPO}">Star on GitHub</a><a class="btn" href="${REPO}/issues">Issues</a><a class="btn" href="${REPO}/releases">Releases</a><a class="btn" href="${doc('CHANGELOG.md')}">Changelog</a></div>
</div></section>
</main>

<footer><div class="wrap">toolsmith-mcp v${esc(pkg.version)} · MIT · Builds on research credited in <a href="${doc('docs/PAPERS.md')}">PAPERS.md</a> and <a href="${doc('docs/COMPETITIVE_ANALYSIS.md')}">COMPETITIVE_ANALYSIS.md</a>. Benchmark data generated ${esc(String(bench.generatedAt).slice(0, 10))}.</div></footer>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(
  join(OUT, '404.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · toolsmith-mcp</title><style>body{background:#14110f;color:#f3ece2;font:18px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#ffb36b}</style></head><body><main><h1>Not found</h1><p><a href="${SITE}">Back to toolsmith-mcp</a></p></main></body></html>\n`,
);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url></urlset>\n`,
);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`Built site/dist (${Math.round(html.length / 1024)} KB HTML).`);
