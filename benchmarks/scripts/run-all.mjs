// Runs every benchmark in sequence, then builds the report.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extra = process.argv.slice(2);
for (const script of [
  'performance.mjs',
  'load.mjs',
  'patterns.mjs',
  'scalability.mjs',
  'report.mjs',
]) {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), ...extra],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
