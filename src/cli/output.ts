const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap =
  (code: string) =>
  (s: string | number): string =>
    tty ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
};

/** stdout is reserved for MCP traffic in stdio mode, so the CLI logs to stderr there. */
let stream: NodeJS.WriteStream = process.stdout;
export function useStderr(): void {
  stream = process.stderr;
}

export function say(...lines: string[]): void {
  for (const l of lines) stream.write(`${l}\n`);
}

export function table(rows: Array<Record<string, string | number | null | undefined>>): void {
  if (rows.length === 0) return say(c.dim('  (none)'));
  const cols = Object.keys(rows[0]!);
  const width = (col: string) =>
    Math.max(col.length, ...rows.map((r) => stripAnsi(String(r[col] ?? '')).length));
  const widths = cols.map(width);
  say(`  ${cols.map((col, i) => c.dim(col.padEnd(widths[i]!))).join('  ')}`);
  for (const r of rows) {
    say(`  ${cols.map((col, i) => pad(String(r[col] ?? ''), widths[i]!)).join('  ')}`);
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
}

export function statusColor(status: string): string {
  if (status === 'published' || status === 'approved') return c.green(status);
  if (
    status === 'awaiting_approval' ||
    status === 'proposed' ||
    status === 'testing' ||
    status === 'generating'
  )
    return c.yellow(status);
  if (status === 'failed' || status === 'rejected' || status === 'disabled') return c.red(status);
  return status;
}
