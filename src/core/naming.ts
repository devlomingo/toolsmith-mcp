import { NAMESPACE_SEP, TOOL_NAME_PATTERN } from './types.js';

/** camelCase an arbitrary phrase: "get user by id" -> "getUserById". */
export function camelCase(input: string): string {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
}

export function sanitizeSegment(input: string): string {
  const s = input.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s : 'x';
}

/**
 * Build a namespaced tool name that is valid for the strictest common client
 * rules (^[A-Za-z0-9_-]{1,64}$). Dots are avoided on purpose: several
 * clients reject them even though the MCP spec allows them.
 */
export function toolName(namespace: string, name: string): string {
  const ns = sanitizeSegment(namespace);
  let base = sanitizeSegment(name);
  const max = 64 - ns.length - NAMESPACE_SEP.length;
  if (max < 8) throw new Error(`Namespace "${namespace}" is too long for tool names`);
  if (base.length > max) base = base.slice(0, max);
  const full = `${ns}${NAMESPACE_SEP}${base}`;
  if (!TOOL_NAME_PATTERN.test(full)) throw new Error(`Invalid tool name generated: ${full}`);
  return full;
}

/** Glob with `*` wildcards, anchored, case-sensitive (tool names). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(value);
}

/** Validate a user-chosen integration/composite name. */
export function isValidNamespace(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,30}$/.test(name);
}
