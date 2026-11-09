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
  const y = 30 + i * (240 / Math.max(1, seq.mcpCalls - 1));
  const d = (i * 0.16).toFixed(2);
  return `<path class="wire" d="M56 ${y} C 180 ${y}, 210 150, 318 150" style="--d:${d}s"/><circle class="pulse" r="3.2" style="--d:${d}s"><animateMotion dur="2.4s" begin="${d}s" repeatCount="indefinite" path="M56 ${y} C 180 ${y}, 210 150, 318 150"/></circle><circle class="call" cx="56" cy="${y}" r="6.5"/>`;
}).join('');
const visual = `<svg class="collapse" viewBox="0 0 420 300" role="img" aria-labelledby="vt vd">
<title id="vt">${seq.mcpCalls} tool calls become 1</title>
<desc id="vd">${seq.mcpCalls} separate tool calls on the left flow into a single composite tool on the right.</desc>
<defs><radialGradient id="g1"><stop offset="0" stop-color="#ff8a3d" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>
<linearGradient id="g2" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#ffb070"/><stop offset="1" stop-color="#ff5f1f"/></linearGradient></defs>
<g>${calls}</g>
<circle class="halo" cx="342" cy="150" r="58" fill="url(#g1)"/>
<rect x="314" y="122" width="56" height="56" rx="16" fill="url(#g2)"/>
<path d="M332 150h20m-6-6 6 6-6 6" stroke="#1a0b02" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<text x="56" y="296" text-anchor="middle" class="lbl">${seq.mcpCalls} calls</text>
<text x="342" y="206" text-anchor="middle" class="lbl hot">1 tool</text>
</svg>`;

const gh = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const arrow = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>toolsmith-mcp · your agent's ${seq.mcpCalls} tool calls, in 1</title>
<meta name="description" content="${esc(pkg.description)}">
<link rel="canonical" href="${SITE}">
<meta property="og:title" content="toolsmith-mcp">
<meta property="og:description" content="Turn your APIs into MCP tools, and the workflows agents repeat into one verified tool. Nothing goes live without human approval.">
<meta property="og:url" content="${SITE}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}assets/dashboard-composite.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#07080b">
<link rel="icon" href="assets/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareSourceCode', name: 'toolsmith-mcp', codeRepository: REPO, programmingLanguage: 'TypeScript', license: 'https://opensource.org/licenses/MIT', version: pkg.version, description: pkg.description })}</script>
<style>
:root{--bg:#07080b;--card:rgba(255,255,255,.035);--card2:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);--line2:rgba(255,255,255,.16);--ink:#f5f7fb;--ink2:#a9b0bd;--mute:#6f7684;--blue:#4c8dff;--orange:#ff7a2f;--sans:'Geist',ui-sans-serif,system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
:focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:8px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:8px;z-index:20}
.wrap{max-width:1140px;margin:0 auto;padding:0 24px}

/* ambient background */
.bg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.bg::before{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:64px 64px;opacity:.35;mask-image:radial-gradient(ellipse 70% 55% at 50% 0%,#000 30%,transparent 75%)}
.orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55}
.orb.a{width:560px;height:560px;left:-160px;top:-220px;background:#2457d6}
.orb.b{width:520px;height:520px;right:-180px;top:40px;background:#c2410c;opacity:.4}

/* nav */
nav{position:sticky;top:14px;z-index:10;display:flex;justify-content:center;padding:0 16px}
.pill{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 14px;border:1px solid var(--line);border-radius:999px;background:rgba(12,14,19,.65);backdrop-filter:blur(16px) saturate(140%);box-shadow:0 10px 40px rgba(0,0,0,.35)}
.brand{display:flex;gap:9px;align-items:center;font-weight:650;letter-spacing:-.01em;text-decoration:none;margin-right:10px}
.brand img{width:22px;height:22px}
.pill .nl{color:var(--ink2);text-decoration:none;font-size:14px;padding:7px 12px;border-radius:999px}
.pill .nl:hover{color:var(--ink);background:var(--card2)}
.pill .go{display:inline-flex;gap:7px;align-items:center;font-size:14px;font-weight:600;text-decoration:none;padding:8px 14px;border-radius:999px;background:var(--ink);color:var(--bg)}
.pill .go svg{width:15px;height:15px;fill:currentColor}

/* buttons */
.btn{display:inline-flex;align-items:center;gap:9px;font:600 15px var(--sans);padding:12px 20px;border-radius:12px;text-decoration:none;border:1px solid var(--line2);background:var(--card);transition:transform .15s,background .15s,box-shadow .2s}
.btn:hover{transform:translateY(-1px);background:var(--card2)}
.btn svg{width:17px;height:17px;fill:currentColor}
.btn.primary{background:linear-gradient(180deg,#fff,#dfe5ef);color:#0a0c10;border-color:transparent;box-shadow:0 8px 30px rgba(76,141,255,.25)}
.btn.primary:hover{box-shadow:0 10px 40px rgba(76,141,255,.4)}

/* hero */
header{padding:84px 0 40px;text-align:center}
.badge{display:inline-flex;align-items:center;gap:10px;font-size:13.5px;color:var(--ink2);text-decoration:none;padding:5px 14px 5px 5px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
.badge b{font-weight:600;color:#fff;background:linear-gradient(90deg,var(--blue),var(--orange));padding:3px 10px;border-radius:999px;font-size:12px}
.badge:hover{border-color:var(--line2);color:var(--ink)}
.badge svg{width:14px;height:14px}
h1{font-size:clamp(44px,7.6vw,92px);line-height:.98;letter-spacing:-.045em;font-weight:750;margin:26px auto 22px;max-width:15ch}
.grad{background:linear-gradient(92deg,#ffd2a8 0%,var(--orange) 45%,#ff5f6d 100%);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap}
.dim{color:var(--ink2)}
.lede{font-size:clamp(17px,2vw,20px);color:var(--ink2);max-width:58ch;margin:0 auto 32px}
.cta{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
.install{margin:22px auto 0;width:max-content;max-width:100%;font:14px var(--mono);border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);padding:10px 10px 10px 16px;display:flex;gap:12px;align-items:center}
.install .p{color:var(--orange)}.install code{white-space:nowrap;overflow-x:auto;min-width:0;scrollbar-width:none;color:var(--ink2)}
.copy{font:600 12.5px var(--sans);background:var(--card2);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 11px;cursor:pointer}
.copy:hover{background:rgba(255,255,255,.1)}

/* product shot */
.shot{position:relative;margin:64px auto 0;max-width:1040px}
.shot::before{content:"";position:absolute;inset:8% 6% -4%;background:linear-gradient(90deg,rgba(76,141,255,.45),rgba(255,122,47,.4));filter:blur(70px);opacity:.55;z-index:-1}
.frame{border:1px solid var(--line2);border-radius:16px;background:#0d0f14;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.6)}
.bar{display:flex;gap:7px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
.bar i{width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,.14)}
.bar span{margin-left:12px;font:12px var(--mono);color:var(--mute)}
.frame .view{max-height:min(560px,62vw);overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.frame img{display:block;width:100%;height:auto}

/* sections */
section{padding:110px 0 0}
.kicker{font:500 13px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--blue)}
h2{font-size:clamp(32px,4.4vw,52px);line-height:1.04;letter-spacing:-.035em;font-weight:720;margin:12px 0 14px;max-width:20ch}
.sh{color:var(--ink2);max-width:58ch;margin:0 0 40px;font-size:17px}

/* bento */
.bento{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}
.tile{position:relative;border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));padding:28px;overflow:hidden;transition:border-color .25s,transform .25s}
.tile:hover{border-color:var(--line2);transform:translateY(-2px)}
.tile::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(400px circle at var(--mx,50%) var(--my,0%),rgba(255,255,255,.07),transparent 45%);opacity:0;transition:opacity .3s}
.tile:hover::after{opacity:1}
.s2{grid-column:span 2}.s3{grid-column:span 3}.s4{grid-column:span 4}.s6{grid-column:span 6}
.ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--card2);border:1px solid var(--line);color:var(--ink)}
.ic svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.quote{margin:20px 0 10px;font-size:14px;color:var(--mute);font-style:italic}
.tile h3{font-size:22px;letter-spacing:-.02em;font-weight:650;margin:0 0 8px;line-height:1.2}
.tile p{margin:0;color:var(--ink2);font-size:15.5px}
.viz{display:grid;grid-template-columns:1fr 1.1fr;gap:12px;align-items:center}
.collapse{width:100%;height:auto}
.wire{fill:none;stroke:rgba(255,255,255,.12);stroke-width:1.6}
.pulse{fill:#ffb070}
.call{fill:#c8d2e2}
.halo{transform-origin:342px 150px;animation:breathe 2.4s ease-in-out infinite}
.lbl{fill:var(--mute);font:500 12px var(--mono)}.lbl.hot{fill:#ffb070}
@keyframes breathe{0%,100%{transform:scale(.88);opacity:.7}50%{transform:scale(1.08);opacity:1}}

/* stats */
.num{font-size:clamp(52px,6.4vw,76px);line-height:1;font-weight:760;letter-spacing:-.05em;background:linear-gradient(180deg,#fff 20%,#8ea3c7);-webkit-background-clip:text;background-clip:text;color:transparent}
.num.o{background:linear-gradient(180deg,#ffd9b8 10%,var(--orange));-webkit-background-clip:text;background-clip:text}
.stat p{margin-top:12px}
.chart{display:block;width:100%;height:auto;border-radius:14px;margin-top:4px}
.fine{margin:18px 0 0;font-size:13.5px;color:var(--mute)}.fine a{color:var(--ink2)}

/* steps */
.steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;position:relative}
.steps::before{content:"";position:absolute;left:28px;right:28px;top:27px;height:1px;background:linear-gradient(90deg,var(--blue),var(--orange));opacity:.5}
.step{position:relative}
.dot{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;font:600 15px var(--mono);background:#0d0f14;border:1px solid var(--line2);margin-bottom:18px}
.step:last-child .dot{background:linear-gradient(135deg,#ffb070,var(--orange));color:#1a0b02;border-color:transparent}
.step h3{font-size:19px;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}.step p{margin:0;color:var(--ink2);font-size:15px}

/* final */
.final{margin:120px auto 0;text-align:center;position:relative;border-radius:28px;padding:72px 24px;border:1px solid var(--line);background:radial-gradient(600px 240px at 50% 0%,rgba(76,141,255,.22),transparent),radial-gradient(500px 220px at 50% 100%,rgba(255,122,47,.16),transparent),rgba(255,255,255,.02);overflow:hidden}
.final h2{margin:12px auto 14px}.final p{color:var(--ink2);max-width:56ch;margin:0 auto 30px}
.chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:0 auto 32px;max-width:720px}
.chips span{font-size:13.5px;color:var(--ink2);border:1px solid var(--line);background:var(--card);padding:6px 12px;border-radius:999px}
footer{padding:56px 0 48px;color:var(--mute);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center}footer a{color:var(--ink2);text-decoration:none}footer a:hover{color:var(--ink)}
footer .r{margin-left:auto}

.reveal{animation:rise .9s cubic-bezier(.2,.7,.2,1) both}.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}.d4{animation-delay:.36s}
@keyframes rise{from{opacity:0;transform:translateY(18px);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}html{scroll-behavior:auto}.pulse{display:none}}
@media (max-width:920px){.s2,.s3,.s4{grid-column:span 6}.viz{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.steps::before{display:none}}
@media (max-width:560px){.wrap{padding:0 16px}header{padding-top:60px}.pill .nl{display:none}.steps{grid-template-columns:1fr}.tile{padding:22px}footer .r{margin-left:0}.install{width:100%}}
</style>
</head>
<body>
<div class="bg" aria-hidden="true"><div class="orb a"></div><div class="orb b"></div></div>
<a class="skip" href="#main">Skip to content</a>
<nav aria-label="Main"><div class="pill">
<a class="brand" href="#top"><img src="assets/logo.svg" alt="" width="22" height="22">toolsmith</a>
<a class="nl" href="#fixes">What it fixes</a><a class="nl" href="#proof">Results</a><a class="nl" href="#how">How</a>
<a class="go" href="${REPO}">${gh}GitHub</a>
</div></nav>

<main id="main">
<header id="top"><div class="wrap">
<a class="badge reveal" href="${doc('CHANGELOG.md')}"><b>v${esc(pkg.version)}</b>OAuth sign-in, gRPC, PostgreSQL ${arrow}</a>
<h1 class="reveal d1"><span class="dim">${seq.mcpCalls} tool calls.</span><br><span class="grad">Now just 1.</span></h1>
<p class="lede reveal d2">Toolsmith is an MCP gateway that turns your APIs into tools, spots the workflows your agents repeat, and hands each one back as a single verified tool. Nothing goes live until you approve it.</p>
<div class="cta reveal d3">
<a class="btn primary" href="${REPO}">${gh}Get started on GitHub</a>
<a class="btn" href="${NPM}">npm package ${arrow}</a>
</div>
<div class="install reveal d3" aria-label="Install command"><span class="p">$</span><code>npm install -g toolsmith-mcp &amp;&amp; toolsmith-mcp demo</code><button class="copy" type="button" data-copy="npm install -g toolsmith-mcp && toolsmith-mcp demo">Copy</button></div>
<div class="shot reveal d4"><div class="frame"><div class="bar"><i></i><i></i><i></i><span>localhost:7420/dashboard</span></div><div class="view"><img src="assets/dashboard-composite.png" alt="Toolsmith dashboard showing a composite tool with its plan and passed equivalence checks" width="1280" height="1100"></div></div></div>
</div></header>

<section id="fixes"><div class="wrap">
<div class="kicker">What it fixes</div>
<h2>Three problems every agent team hits.</h2>
<p class="sh">One gateway between your agents and your systems. It writes the tools, makes them faster, and keeps a human in charge.</p>
<div class="bento">
<div class="tile s4"><div class="viz"><div><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M7 6c6 0 6 6 10 6M7 12h10M7 18c6 0 6-6 10-6"/><circle cx="19" cy="12" r="2.5"/></svg></div><p class="quote">"The agent does the same ${seq.mcpCalls}-step chore every time."</p><h3>Repeated work becomes one call.</h3><p>Toolsmith learns the workflow from real traffic, runs independent steps in parallel, and checks it returns exactly what the separate calls did.</p></div>${visual}</div></div>
<div class="tile s2"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M17 15l3 3-3 3"/></svg></div><p class="quote">"We need an MCP server for every API."</p><h3>Your APIs become tools.</h3><p>OpenAPI, GraphQL or gRPC in; typed tools out, each read verified with a real call.</p></div>
<div class="tile s3"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg></div><p class="quote">"We can't let an agent loose on production."</p><h3>A human says yes first.</h3><p>Nothing generated goes live without approval, and every destructive call needs its own yes, bound to its exact arguments.</p></div>
<div class="tile s3"><div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg></div><p class="quote">"Every client needs ten servers configured."</p><h3>One endpoint for everything.</h3><p>Your APIs and other MCP servers behind one URL, with sign-in, allow-lists and rate limits per client.</p></div>
</div>
</div></section>

<section id="proof"><div class="wrap">
<div class="kicker">Measured, not promised</div>
<h2>Faster for one agent. Lighter for a hundred.</h2>
<p class="sh">Same results as the separate calls, every run. Numbers from the committed benchmark, not estimates.</p>
<div class="bento">
<div class="tile s2 stat"><div class="num o">${x1(speedup)}</div><p>faster than an agent calling the ${seq.mcpCalls} tools one by one</p></div>
<div class="tile s2 stat"><div class="num">${x1(thrGain)}</div><p>more workflows per second with ${levels.join('–')} agents at once</p></div>
<div class="tile s2 stat"><div class="num">${trafficRange}</div><p>less MCP traffic hitting your gateway</p></div>
<div class="tile s6"><img class="chart" src="assets/load-throughput.svg" alt="Chart: successful workflows per second under load for sequential agents, best-case parallel clients and the composite tool" loading="lazy" width="760" height="420"></div>
</div>
<p class="fine">${esc(env.cpu)} · Node ${esc(env.node)} · one machine, no LLM in the loop, so the model turns saved are not even counted. Workflow discovery scores F1 ${pat.overall.f1.mean} across ${pat.grid.filter((r) => r.variant === 'default').length} noisy conditions. <a href="${doc('benchmarks/reports/REPORT.md')}">Full report →</a></p>
</div></section>

<section id="how"><div class="wrap">
<div class="kicker">How it works</div>
<h2>Four steps. You stay in control.</h2>
<div class="steps" style="margin-top:40px">
<div class="step"><div class="dot">01</div><h3>Import</h3><p>OpenAPI, GraphQL, gRPC, Postman, or other MCP servers.</p></div>
<div class="step"><div class="dot">02</div><h3>Approve</h3><p>Review the tools. Reads go live; writes stay hidden until granted.</p></div>
<div class="step"><div class="dot">03</div><h3>Observe</h3><p>Agents work as usual. Toolsmith records the call graph, never the data.</p></div>
<div class="step"><div class="dot">04</div><h3>Compose</h3><p>Repeated workflows come back as one tested tool, waiting for your yes.</p></div>
</div>
</div></section>

<div class="wrap"><div class="final">
<div class="kicker">Everything else is on GitHub</div>
<h2>Ready when your agents are.</h2>
<p>Setup, configuration, the security model and every benchmark live in the repository.</p>
<div class="chips"><span>OAuth 2.1 sign-in</span><span>Per-client rate limits</span><span>PostgreSQL, many nodes</span><span>gRPC · GraphQL · OpenAPI</span><span>English + Arabic dashboard</span><span>15 independent validation rounds</span></div>
<div class="cta"><a class="btn primary" href="${REPO}">${gh}Open the repository</a><a class="btn" href="${doc('docs/INSTALLATION.md')}">Installation guide ${arrow}</a></div>
</div></div>
</main>

<footer><div class="wrap">
<span>toolsmith-mcp v${esc(pkg.version)} · MIT</span>
<span class="r"></span><a href="${REPO}">GitHub</a><a href="${NPM}">npm</a><a href="${doc('CHANGELOG.md')}">Changelog</a><a href="${doc('docs/SECURITY.md')}">Security</a>
</div></footer>
<script>
for (const b of document.querySelectorAll('[data-copy]'))
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
    catch { b.textContent = 'Select & copy'; }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  });
for (const t of document.querySelectorAll('.tile'))
  t.addEventListener('pointermove', (e) => {
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', e.clientX - r.left + 'px');
    t.style.setProperty('--my', e.clientY - r.top + 'px');
  });
</script>
</body>
</html>
`;

writeFileSync(join(OUT, 'index.html'), html);
writeFileSync(
  join(OUT, '404.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · toolsmith-mcp</title><style>body{background:#07080b;color:#f5f7fb;font:18px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#7fb0ff}</style></head><body><main><h1>Not found</h1><p><a href="${SITE}">Back to toolsmith-mcp</a></p></main></body></html>\n`,
);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url></urlset>\n`,
);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`Built site/dist (${Math.round(html.length / 1024)} KB HTML).`);
