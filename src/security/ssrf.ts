import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { ToolsmithError } from '../core/errors.js';

/** IPv4 ranges that must never be reached unless explicitly allowed. */
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return V4_BLOCKED.some(([base, bits]) => inV4Range(ip, base, bits));
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 can reach v4 private space
    return false;
  }
  return true; // not an IP at all: refuse
}

export interface EgressPolicy {
  /** Hostnames the integration may contact. Exact match, case-insensitive. */
  allowedHosts: string[];
  /** Permit loopback / RFC1918 / link-local targets (local dev, demos). */
  allowPrivateNetwork: boolean;
}

export function assertHostAllowed(url: URL, policy: EgressPolicy): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ToolsmithError(`Blocked request: scheme ${url.protocol} is not allowed`, 'policy');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new ToolsmithError(
      `Blocked request: host "${host}" is not in this integration's allowed hosts`,
      'policy',
    );
  }
  if (url.username || url.password) {
    throw new ToolsmithError('Blocked request: credentials in URLs are not allowed', 'policy');
  }
  if (isIP(host) && !policy.allowPrivateNetwork && isPrivateAddress(host)) {
    throw new ToolsmithError(`Blocked request: ${host} is a private address`, 'policy');
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A dns.lookup replacement that refuses private addresses at connect time.
 * Checking inside the socket's own lookup closes the DNS-rebinding gap that a
 * resolve-then-fetch check leaves open.
 */
export function guardedLookup(policy: EgressPolicy) {
  return (hostname: string, options: object, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!policy.allowPrivateNetwork) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e: NodeJS.ErrnoException = new Error(
            `Blocked request: ${hostname} resolves to private address ${bad.address}`,
          );
          e.code = 'ESSRF';
          return callback(e, []);
        }
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`No address for ${hostname}`), []);
      callback(null, first.address, first.family);
    });
  };
}
