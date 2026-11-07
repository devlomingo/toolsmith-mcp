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

/** Expand an IPv6 address (any notation, optional zone, embedded IPv4) to 8 hextets. */
export function expandV6(ip: string): number[] | undefined {
  let addr = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!;
  const v4 = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((x) => x > 255)) return undefined;
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return undefined;
  return parts.map((h) => parseInt(h, 16));
}

const v4From = (hi: number, lo: number): string =>
  `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * True for any address that must not be reached without allowPrivateNetwork.
 * IPv6 is parsed numerically, so every spelling of an IPv4-embedding address
 * is caught: mapped (::ffff:a.b.c.d and ::ffff:7f00:1, which is how WHATWG
 * URL parsing normalises it), compatible (::a.b.c.d), NAT64 (64:ff9b::/96),
 * 6to4 (2002::/16) and Teredo (2001::/32).
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]!);
  if (family === 4) return V4_BLOCKED.some(([base, bits]) => inV4Range(ip, base, bits));
  if (family !== 6) return true; // not an IP at all: refuse
  const h = expandV6(ip);
  if (!h) return true;
  const zeroPrefix = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return true; // ::
  if (zeroPrefix(7) && h[7] === 1) return true; // ::1
  if (zeroPrefix(5) && h[5] === 0xffff) return isPrivateAddress(v4From(h[6]!, h[7]!)); // ::ffff:0:0/96 mapped
  if (zeroPrefix(6)) return isPrivateAddress(v4From(h[6]!, h[7]!)); // ::/96 compatible (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // NAT64: any v4 incl. private
  if (h[0] === 0x2002) return isPrivateAddress(v4From(h[1]!, h[2]!)); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo tunnels
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  return false;
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
