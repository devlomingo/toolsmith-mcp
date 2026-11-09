#!/usr/bin/env bash
# The full release cycle, end to end, as one command. Run after every change:
# static checks, tests, quick benchmarks with the regression gate, the real
# demo lifecycle over HTTP, a packed install in a clean prefix, and the site.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/toolsmith-cycle.XXXXXX")"
DEMO_PID=""
cleanup() {
  if [[ -n "$DEMO_PID" ]]; then kill "$DEMO_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }

step "lint, format, types, build"
npm run -s lint
npm run -s format:check >/dev/null
npm run -s typecheck
npm run -s build

step "tests"
npx vitest run --reporter=dot

step "quick benchmarks + regression gate"
node benchmarks/scripts/performance.mjs --quick >/dev/null
node benchmarks/scripts/patterns.mjs --quick >/dev/null
npm run -s benchmark:check
git checkout -q -- benchmarks/results benchmarks/charts benchmarks/reports 2>/dev/null || true

step "demo lifecycle over HTTP"
PORT=$((20000 + RANDOM % 20000))
node dist/cli/index.js demo --port "$PORT" >"$WORK/demo.log" 2>&1 &
DEMO_PID=$!
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$DEMO_PID" 2>/dev/null; then cat "$WORK/demo.log"; exit 1; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null
for expect in 'identical results' 'flow__'; do
  grep -q "$expect" "$WORK/demo.log" || { echo "demo output lacks: $expect"; cat "$WORK/demo.log"; exit 1; }
done
kill "$DEMO_PID"
wait "$DEMO_PID" 2>/dev/null || true
DEMO_PID=""
echo "demo: import → evaluate → approve → traffic → mined composite → evaluated → served"

step "packed install in a clean prefix"
TGZ="$(npm pack --silent --pack-destination "$WORK" | tail -1)"
npm install -g --prefix "$WORK/prefix" "$WORK/$TGZ" --silent >/dev/null 2>&1
"$WORK/prefix/bin/toolsmith-mcp" --version

step "site"
node site/build.mjs >/dev/null
node site/check-links.mjs | tail -1

printf '\nCycle passed.\n'
