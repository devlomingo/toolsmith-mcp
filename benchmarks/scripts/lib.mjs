// Shared helpers for the benchmark scripts. Everything here measures; nothing
// estimates. Results are written as JSON so reports and charts are generated
// only from recorded data.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RESULTS = join(ROOT, 'benchmarks', 'results');

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length || 1));
  const r = (x) => Math.round(x * 100) / 100;
  return {
    n: s.length,
    mean: r(mean),
    sd: r(sd),
    min: r(s[0] ?? 0),
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s[s.length - 1] ?? 0),
  };
}

export function environment() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dep = (n) => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'node_modules', n, 'package.json'), 'utf8'))
        .version;
    } catch {
      return null;
    }
  };
  let commit = null;
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  return {
    toolsmith: pkg.version,
    commit,
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1e9),
    ci: Boolean(process.env.CI),
    mcpSdk: {
      server: dep('@modelcontextprotocol/server'),
      client: dep('@modelcontextprotocol/client'),
    },
  };
}

export function save(name, data) {
  mkdirSync(RESULTS, { recursive: true });
  const out = {
    benchmark: name,
    generatedAt: new Date().toISOString(),
    environment: environment(),
    ...data,
  };
  writeFileSync(join(RESULTS, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export const quick = process.argv.includes('--quick') || process.env.BENCH_QUICK === '1';
