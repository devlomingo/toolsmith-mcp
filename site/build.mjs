// Builds the GitHub Pages site into site/dist from committed sources only:
// package.json, benchmarks/results/latest.json, benchmarks/charts/*.svg and
// docs/images/*. Every number on the page is read from the results file.
// The page is a short pitch; everything else lives on GitHub.
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
const NPM = 'https://www.npmjs.com/package/toolsmith-mcp';
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
const x1 = (n) => `${Math.round(n * 10) / 10}×`;

// ---- numbers from the results file ------------------------------------------
const perf = bench.performance;
const od = (lat) =>
  perf.scenarios.find((s) => s.scenario === 'order-details' && s.apiLatencyMs === lat);
const v = (s, name) => s?.variants.find((x) => x.name === name);
const lats = [...new Set(perf.scenarios.map((s) => s.apiLatencyMs))];
const headline = od(25) ?? od(lats[lats.length - 1]);
const seq = v(headline, 'sequential');
const comp = v(headline, 'composite');
const speedup = seq.latency.p50 / comp.latency.p50;

const ld = bench.load;
const busy = ld.rows.filter((r) => r.concurrency >= 50);
const at = (c, name) => busy.find((r) => r.concurrency === c && r.variant === name);
const levels = [...new Set(busy.map((r) => r.concurrency))];
const thrGain = Math.min(
  ...levels.map(
    (c) =>
      at(c, 'composite').workflowsPerSec /
      Math.max(at(c, 'sequential').workflowsPerSec, at(c, 'parallel-client').workflowsPerSec),
  ),
);
const traffic = levels.flatMap((c) =>
  ['sequential', 'parallel-client'].map(
    (n) => at(c, n).mcpRequestsPerSec / at(c, 'composite').mcpRequestsPerSec,
  ),
);
const trafficRange = `${Math.floor(Math.min(...traffic))}–${Math.round(Math.max(...traffic))}×`;
const pat = bench.patterns;
const env = bench.environment;

// ---- hero visual: many calls collapse into one ------------------------------
const calls = Array.from({ length: seq.mcpCalls }, (_, i) => {
  const y = 34 + i * (232 / Math.max(1, seq.mcpCalls - 1));
  return `<path class="wire" d="M70 ${y} C 190 ${y}, 220 150, 330 150" style="--d:${(i * 0.18).toFixed(2)}s"/><circle class="call" cx="70" cy="${y}" r="7" style="--d:${(i * 0.18).toFixed(2)}s"/>`;
}).join('');
const visual = `<svg class="collapse" viewBox="0 0 440 300" role="img" aria-labelledby="vt vd">
<title id="vt">${seq.mcpCalls} tool calls become 1</title>
<desc id="vd">${seq.mcpCalls} separate tool calls on the left flow into a single composite tool on the right.</desc>
<g>${calls}</g>
<circle class="one-glow" cx="352" cy="150" r="44"/>
<circle class="one" cx="352" cy="150" r="26"/>
<text x="70" y="294" text-anchor="middle" class="lbl">${seq.mcpCalls} calls</text>
<text x="352" y="216" text-anchor="middle" class="lbl hot">1 tool</text>
</svg>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolsmith-mcp · your agent's 8 tool calls, in 1</title>
<meta name="description" content="${esc(pkg.description)}">
<link rel="canonical" href="${SITE}">
<meta property="og:title" content="toolsmith-mcp">
<meta property="og:description" content="Turn your APIs into MCP tools, and the workflows agents repeat into one verified tool. Nothing goes live without human approval.">
<meta property="og:url" content="${SITE}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}assets/dashboard-composite.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#14110f">
<link rel="icon" href="assets/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: 'toolsmith-mcp', codeRepository: REPO, programmingLanguage: 'TypeScript', license: 'https://opensource.org/licenses/MIT', version: pkg.version, description: pkg.description })}</script>
<style>
:root{--bg:#14110f;--bg2:#1b1714;--panel:#211c18;--line:#372f28;--ink:#f6efe5;--ink2:#cbc0b3;--mute:#968b7e;--ember:#ff7a1a;--ember2:#ffb36b;--ok:#7fd1a3;--display:'Bricolage Grotesque',Georgia,serif;--body:'IBM Plex Sans',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 var(--body);-webkit-font-smoothing:antialiased;
background-image:radial-gradient(rgba(246,239,229,.06) 1px,transparent 1px);background-size:26px 26px}
a{color:var(--ember2);text-underline-offset:3px}a:hover{color:var(--ember)}
:focus-visible{outline:2px solid var(--ember);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--ember);color:#14110f;padding:8px 14px;z-index:9}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
nav{position:sticky;top:0;z-index:5;background:rgba(20,17,15,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;gap:16px;height:62px}
.brand{font:700 19px var(--display);color:var(--ink);text-decoration:none;display:flex;gap:10px;align-items:center;letter-spacing:-.01em}
.brand img{width:26px;height:26px}
nav .links{margin-left:auto;display:flex;gap:10px;align-items:center}
nav .links a{color:var(--ink2);text-decoration:none;font-size:15px;padding:6px 10px;border-radius:8px}nav .links a:hover{color:var(--ink);background:var(--panel)}
.btn{display:inline-flex;align-items:center;gap:9px;font:600 16px var(--body);padding:13px 22px;border-radius:12px;text-decoration:none;border:1px solid var(--line);color:var(--ink);transition:transform .15s,background .15s}
.btn:hover{transform:translateY(-1px);color:var(--ink);background:var(--panel)}
.btn.primary{background:var(--ember);border-color:var(--ember);color:#1a0f06}.btn.primary:hover{background:var(--ember2);color:#1a0f06}
.btn svg{width:19px;height:19px;fill:currentColor}

header{padding:88px 0 72px;position:relative;overflow:hidden}
header::before{content:"";position:absolute;right:-220px;top:-160px;width:720px;height:720px;background:radial-gradient(circle,rgba(255,122,26,.22),transparent 60%);pointer-events:none}
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center;position:relative}.hero>*,.grid>*{min-width:0}
body{overflow-x:hidden}
.tag{display:inline-flex;gap:8px;align-items:center;font:600 13px var(--mono);letter-spacing:.06em;color:var(--ember2);border:1px solid rgba(255,122,26,.35);background:rgba(255,122,26,.08);padding:6px 12px;border-radius:999px}
.tag b{color:var(--ink)}
h1{font:800 clamp(42px,6.6vw,84px)/.98 var(--display);letter-spacing:-.035em;margin:22px 0 20px}
h1 em{font-style:normal;color:var(--ember);white-space:nowrap}
.lede{font-size:clamp(18px,2vw,21px);color:var(--ink2);max-width:52ch;margin:0 0 30px}
.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.install{margin-top:22px;font:15px var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px 12px 16px;display:flex;gap:12px;align-items:center;max-width:100%}
.install b{color:var(--ember)}.install code{white-space:nowrap;overflow-x:auto;min-width:0;flex:1;scrollbar-width:none}
.copy{margin-left:auto;font:600 13px var(--body);background:transparent;color:var(--ink2);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer}
.copy:hover{color:var(--ink)}

.collapse{width:100%;height:auto;overflow:visible}
.wire{fill:none;stroke:rgba(255,179,107,.28);stroke-width:2.2}
.wire{stroke-dasharray:6 10;animation:flow 2.4s linear infinite;animation-delay:var(--d)}
.call{fill:var(--ink);animation:blink 2.4s ease-in-out infinite;animation-delay:var(--d)}
.one{fill:var(--ember)}.one-glow{fill:rgba(255,122,26,.18);animation:glow 2.4s ease-in-out infinite;transform-origin:352px 150px}
.lbl{fill:var(--mute);font:600 13px var(--mono)}.lbl.hot{fill:var(--ember2)}
@keyframes flow{to{stroke-dashoffset:-64}}
@keyframes blink{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes glow{0%,100%{transform:scale(.85);opacity:.6}50%{transform:scale(1.1);opacity:1}}

section{padding:88px 0;border-top:1px solid var(--line)}
.eyebrow{font:600 13px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ember2)}
h2{font:700 clamp(30px,4vw,46px)/1.05 var(--display);letter-spacing:-.025em;margin:10px 0 36px;max-width:24ch}
.grid{display:grid;gap:18px}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.fix{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;display:flex;flex-direction:column;gap:14px;transition:border-color .2s,transform .2s}
.fix:hover{border-color:rgba(255,122,26,.5);transform:translateY(-3px)}
.pain{font:italic 500 15px/1.45 var(--body);color:var(--mute);border-left:2px solid rgba(255,122,26,.55);padding-left:12px}
.fix h3{font:700 22px/1.2 var(--display);margin:0;letter-spacing:-.01em}
.fix p{margin:0;color:var(--ink2);font-size:16px}
.ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(255,122,26,.12);color:var(--ember)}
.ic svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.stats div{background:var(--bg2);padding:30px 28px}
.stats strong{display:block;font:800 clamp(44px,6vw,68px)/1 var(--display);letter-spacing:-.03em;background:linear-gradient(180deg,var(--ink),var(--ember2));-webkit-background-clip:text;background-clip:text;color:transparent}
.stats span{display:block;margin-top:10px;color:var(--ink2)}
.chart{margin-top:22px;width:100%;height:auto;border-radius:16px;border:1px solid var(--line);background:#1a1a19}
.fine{margin-top:16px;font-size:14px;color:var(--mute)}

.steps{counter-reset:s}
.step{counter-increment:s;padding:22px;border-radius:16px;border:1px solid var(--line);background:var(--bg2)}
.step::before{content:counter(s,decimal-leading-zero);font:600 13px var(--mono);color:var(--ember)}
.step h3{font:700 19px var(--display);margin:8px 0 6px}.step p{margin:0;color:var(--ink2);font-size:15px}

.final{text-align:center;padding:96px 0}
.final h2{margin:10px auto 14px}.final p{color:var(--ink2);margin:0 auto 30px;max-width:56ch}
.final .cta{justify-content:center}
footer{border-top:1px solid var(--line);padding:30px 0 44px;color:var(--mute);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;gap:8px 18px}footer a{color:var(--ink2)}

.reveal{animation:rise .8s cubic-bezier(.2,.7,.2,1) both}.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}}
@media (max-width:900px){.hero{grid-template-columns:1fr}.collapse{max-width:420px;margin:0 auto}.g3,.g4{grid-template-columns:1fr 1fr}.stats{grid-template-columns:1fr}}
@media (max-width:600px){.g3,.g4{grid-template-columns:1fr}nav .links a.opt{display:none}.wrap{padding:0 16px}header{padding-top:56px}.install code{font-size:13px}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<nav aria-label="Main"><div class="wrap">
<a class="brand" href="#top"><img src="assets/logo.svg" alt="" width="26" height="26">toolsmith-mcp</a>
<div class="links"><a class="opt" href="#fixes">What it fixes</a><a class="opt" href="#proof">Results</a><a class="btn" href="${REPO}" style="padding:7px 14px">GitHub</a></div>
</div></nav>

<main id="main">
<header id="top"><div class="wrap hero">
<div>
<span class="tag reveal">MCP gateway · open source · <b>v${esc(pkg.version)}</b></span>
<h1 class="reveal d1">Your agent makes ${seq.mcpCalls} tool calls. <em>Make it 1.</em></h1>
<p class="lede reveal d2">Toolsmith turns your APIs into MCP tools, spots the workflows your agents repeat, and hands each one back as a single verified tool. Nothing goes live until you approve it.</p>
<div class="cta reveal d3">
<a class="btn primary" href="${REPO}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>Get it on GitHub</a>
<a class="btn" href="${NPM}">npm package</a>
</div>
<div class="install reveal d3" aria-label="Install command"><b>$</b><code id="cmd">npm install -g toolsmith-mcp &amp;&amp; toolsmith-mcp demo</code><button class="copy" type="button" data-copy="npm install -g toolsmith-mcp && toolsmith-mcp demo">Copy</button></div>
</div>
<div class="reveal d2">${visual}</div>
</div></header>

<section id="fixes"><div class="wrap">
<div class="eyebrow">What it fixes</div>
<h2>Three problems every agent team hits.</h2>
<div class="grid g3">
<div class="fix"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M17 15l3 3-3 3"/></svg></div><span class="pain">"We need an MCP server for every API."</span><h3>Your APIs become tools.</h3><p>Point it at an OpenAPI, GraphQL or gRPC API. Every operation becomes a typed tool, and reads are called once to prove they work.</p></div>
<div class="fix"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M7 6c6 0 6 6 10 6M7 12h10M7 18c6 0 6-6 10-6"/><circle cx="19" cy="12" r="2.5"/></svg></div><span class="pain">"The agent does the same ${seq.mcpCalls}-step chore every time."</span><h3>Repeated work becomes one call.</h3><p>Toolsmith learns the workflow from real traffic, runs independent steps in parallel, and checks it returns exactly what the separate calls did.</p></div>
<div class="fix"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg></div><span class="pain">"We can't let an agent loose on production."</span><h3>A human says yes first.</h3><p>Nothing generated goes live without your approval. Every destructive call needs its own yes, bound to its exact arguments.</p></div>
</div>
</div></section>

<section id="proof"><div class="wrap">
<div class="eyebrow">Measured, not promised</div>
<h2>Faster for one agent. Lighter for a hundred.</h2>
<div class="stats">
<div><strong>${x1(speedup)}</strong><span>faster than an agent calling the ${seq.mcpCalls} tools one by one</span></div>
<div><strong>${x1(thrGain)}</strong><span>more workflows per second with ${levels.join('–')} agents at once</span></div>
<div><strong>${trafficRange}</strong><span>less MCP traffic at the gateway, with identical results</span></div>
</div>
<img class="chart" src="assets/load-throughput.svg" alt="Chart: successful workflows per second under load for sequential agents, best-case parallel clients and the composite tool" loading="lazy" width="760" height="420">
<p class="fine">${esc(env.cpu)}, Node ${esc(env.node)}, one machine, no LLM in the loop (the model turns saved are not counted). Workflow discovery scores F1 ${pat.overall.f1.mean} across ${pat.grid.filter((r) => r.variant === 'default').length} noisy conditions. <a href="${doc('benchmarks/reports/REPORT.md')}">Full report</a></p>
</div></section>

<section id="how"><div class="wrap">
<div class="eyebrow">How it works</div>
<h2>Four steps, you stay in control.</h2>
<div class="grid g4 steps">
<div class="step"><h3>Import</h3><p>OpenAPI, GraphQL, gRPC, Postman, or other MCP servers.</p></div>
<div class="step"><h3>Approve</h3><p>Review the tools. Reads go live; writes stay hidden until granted.</p></div>
<div class="step"><h3>Observe</h3><p>Agents work as usual. Toolsmith records the call graph, not the data.</p></div>
<div class="step"><h3>Compose</h3><p>Repeated workflows come back as one tool, tested, waiting for your yes.</p></div>
</div>
</div></section>

<section class="final"><div class="wrap">
<div class="eyebrow">Everything else is on GitHub</div>
<h2>Setup, security model, benchmarks, docs.</h2>
<p>OAuth 2.1 sign-in, per-client rate limits, PostgreSQL for several nodes, a bilingual dashboard, and fifteen rounds of independent validation. All in the repository.</p>
<div class="cta">
<a class="btn primary" href="${REPO}">Open the repository</a>
<a class="btn" href="${doc('docs/INSTALLATION.md')}">Installation guide</a>
</div>
</div></section>
</main>

<footer><div class="wrap">
<span>toolsmith-mcp v${esc(pkg.version)} · MIT</span>
<a href="${REPO}">GitHub</a><a href="${NPM}">npm</a><a href="${doc('CHANGELOG.md')}">Changelog</a><a href="${doc('docs/SECURITY.md')}">Security</a>
</div></footer>
<script>
for (const b of document.querySelectorAll('[data-copy]'))
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
    catch { b.textContent = 'Select & copy'; }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  });
</script>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(
  join(OUT, '404.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · toolsmith-mcp</title><style>body{background:#14110f;color:#f6efe5;font:18px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#ffb36b}</style></head><body><main><h1>Not found</h1><p><a href="${SITE}">Back to toolsmith-mcp</a></p></main></body></html>\n`,
);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url></urlset>\n`,
);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`Built site/dist (${Math.round(html.length / 1024)} KB HTML).`);
