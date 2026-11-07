/**
 * node:sqlite prints an ExperimentalWarning on first import. It is noise for
 * end users (and on stdio it lands in the MCP client's log), so drop exactly
 * that warning and let every other warning through.
 */
let installed = false;

export function silenceSqliteWarning(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
