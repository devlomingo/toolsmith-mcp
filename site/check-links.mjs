// Link checker for site/dist. Internal links and assets must exist on disk.
// Links into the GitHub repository (blob/main/<path>) must point to files
// that exist in this checkout. With --external, every http(s) link is also
// fetched (used after deployment, when the repository is public).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');
const REPO_BLOB = 'https://github.com/devlomingo/toolsmith-mcp/blob/main/';
const external = process.argv.includes('--external');
const problems = [];
const externals = new Set();

for (const file of readdirSync(DIST).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(DIST, file), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    if (url.startsWith('data:') || url.startsWith('mailto:')) continue;
    if (url.startsWith('#')) {
      if (url.length > 1 && !ids.has(url.slice(1))) problems.push(`${file}: missing anchor ${url}`);
      continue;
    }
    if (/^https?:\/\//.test(url)) {
      if (url.startsWith(REPO_BLOB)) {
        const path = decodeURIComponent(url.slice(REPO_BLOB.length).split('#')[0]);
        if (!existsSync(join(ROOT, path)))
          problems.push(`${file}: repository file does not exist: ${path}`);
      }
      externals.add(url.split('#')[0]);
      continue;
    }
    const local = join(DIST, url.split('#')[0].split('?')[0]);
    if (!existsSync(local)) problems.push(`${file}: missing local file ${url}`);
  }
}

if (external) {
  for (const url of externals) {
    if (url.includes('fonts.g')) continue; // preconnect hosts, not pages
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'toolsmith-mcp-link-check' },
      });
      if (res.status >= 400) problems.push(`external ${res.status}: ${url}`);
    } catch (err) {
      problems.push(`external unreachable: ${url} (${err.message})`);
    }
  }
}

if (problems.length) {
  console.error(`Link check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `Link check passed (${externals.size} external links${external ? ' fetched' : ' not fetched'}).`,
);
