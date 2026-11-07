// Make the CLI entry executable after tsc (tsc does not preserve modes).
import { chmodSync } from 'node:fs';
chmodSync(new URL('../dist/cli/index.js', import.meta.url), 0o755);
