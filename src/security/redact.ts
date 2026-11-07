import { createHmac } from 'node:crypto';
import type { JsonValue } from '../core/types.js';

const SENSITIVE_KEY =
  /(authori[sz]ation|passw(or)?d|passwd|secret|token|api[-_]?key|apikey|cookie|session[-_]?id|credential|private[-_]?key|client[-_]?secret|ssn|card[-_]?number|cvv|cvc|iban)/i;

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
];

/** Card-like digit runs are redacted only when they pass the Luhn check. */
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const MAX_STRING = 512;
const MAX_DEPTH = 12;
const MAX_KEYS = 200;

/**
 * Redacts secrets and personal data from values before they are stored or
 * logged. Known secret values (resolved credentials) are matched exactly, on
 * top of the key-name and pattern rules, so a token is caught even when it
 * shows up somewhere unexpected such as an echoed request.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  registerSecret(value: string | undefined): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  redactString(input: string): string {
    let out = input;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED_SECRET]');
    }
    for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
    out = out.replace(CARD_LIKE, (m) => (luhn(m.replace(/\D/g, '')) ? '[REDACTED_CARD]' : m));
    if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated]`;
    return out;
  }

  redact(value: unknown, depth = 0): JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return this.redactString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_KEYS).map((v) => this.redact(v, depth + 1));
      if (value.length > MAX_KEYS) items.push(`[${value.length - MAX_KEYS} more items]`);
      return items;
    }
    if (typeof value === 'object') {
      const out: Record<string, JsonValue> = {};
      let n = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (n++ >= MAX_KEYS) {
          out['…'] = '[TRUNCATED_KEYS]';
          break;
        }
        out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : this.redact(v, depth + 1);
      }
      return out;
    }
    return String(value);
  }
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Privacy-preserving value fingerprints. Traces keep keyed hashes of leaf
 * values, not the values themselves; that is enough to see that an output of
 * one call fed an argument of the next (equal hashes) without storing data.
 */
export class Fingerprinter {
  constructor(private readonly key: string) {}

  hash(value: string | number): string {
    const canonical = typeof value === 'number' ? `n:${value}` : `s:${value}`;
    return createHmac('sha256', this.key).update(canonical).digest('hex').slice(0, 16);
  }

  /** path -> hash for every scalar leaf. Array indices become [*]. */
  leaves(value: unknown, maxLeaves = 2000): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const walk = (v: unknown, path: string, depth: number): void => {
      if (out.length >= maxLeaves || depth > MAX_DEPTH) return;
      if (typeof v === 'string') {
        if (v.length > 0 && v.length <= 256) out.push([path || '$', this.hash(v)]);
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        out.push([path || '$', this.hash(v)]);
      } else if (Array.isArray(v)) {
        for (const item of v) walk(item, `${path}[*]`, depth + 1);
      } else if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          if (isSensitiveKey(k)) continue;
          walk(child, path ? `${path}.${k}` : k, depth + 1);
        }
      }
    };
    walk(value, '', 0);
    return out;
  }

  /** Argument fingerprints: path -> hash (first occurrence wins). */
  argFingerprints(args: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, h] of this.leaves(args, 200)) if (!(p in out)) out[p] = h;
    return out;
  }

  /** Result fingerprints: hash -> distinct normalized paths. */
  resultFingerprints(result: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [p, h] of this.leaves(result)) {
      const paths = (out[h] ??= []);
      if (!paths.includes(p) && paths.length < 4) paths.push(p);
    }
    return out;
  }
}
