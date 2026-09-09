import { isIPv4, isIPv6 } from 'node:net';

/**
 * Source-address allowlisting for provider callbacks (build plan Phase 20;
 * doc 14 §5.6 names an IP allowlist among what CallPro must supply).
 *
 * A CIDR list is configuration a contract supplies. Nothing here knows a
 * provider's addresses: it decides whether one address is inside one of the
 * ranges it was given, in constant shape, for IPv4 and IPv6 alike. An
 * IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is the IPv4 address it maps.
 */

export interface Cidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
}

const V4_BITS = 32;
const V6_BITS = 128;

function ipv4ToBigInt(address: string): bigint {
  return address
    .split('.')
    .reduce((acc, octet) => (acc << 8n) | BigInt(Number.parseInt(octet, 10)), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) becomes two hextets.
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    const high = ((v4 >> 16n) & 0xffffn).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const [head, rest] = text.split('::');
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups =
    rest === undefined
      ? headGroups
      : [...headGroups, ...new Array<string>(Math.max(0, missing)).fill('0'), ...tailGroups];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

/** Strips a zone id and unwraps an IPv4-mapped IPv6 address. */
function normalise(address: string): { family: 4 | 6; value: bigint } | undefined {
  const bare = address.includes('%') ? address.slice(0, address.indexOf('%')) : address.trim();
  if (isIPv4(bare)) return { family: 4, value: ipv4ToBigInt(bare) };
  if (!isIPv6(bare)) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped !== null && mapped[1] !== undefined && isIPv4(mapped[1])) {
    return { family: 4, value: ipv4ToBigInt(mapped[1]) };
  }
  return { family: 6, value: ipv6ToBigInt(bare) };
}

/** Parses `a.b.c.d/n`, `a.b.c.d` (a /32), `x::y/n` or `x::y` (a /128). */
export function parseCidr(text: string): Cidr | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const slash = trimmed.indexOf('/');
  const addressText = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const address = normalise(addressText);
  if (address === undefined) return undefined;
  const bits = address.family === 4 ? V4_BITS : V6_BITS;
  let prefix = bits;
  if (slash >= 0) {
    const prefixText = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return undefined;
    prefix = Number.parseInt(prefixText, 10);
    if (prefix > bits) return undefined;
  }
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { family: address.family, network: address.value & mask, prefix };
}

/** Parses a comma- or whitespace-separated list. Refuses the whole list on one bad entry. */
export function parseCidrList(text: string): readonly Cidr[] | undefined {
  const entries = text
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const parsed: Cidr[] = [];
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr === undefined) return undefined;
    parsed.push(cidr);
  }
  return parsed;
}

export function ipInCidr(address: string, cidr: Cidr): boolean {
  const parsed = normalise(address);
  if (parsed === undefined || parsed.family !== cidr.family) return false;
  const bits = cidr.family === 4 ? V4_BITS : V6_BITS;
  const mask =
    cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(bits - cidr.prefix);
  return (parsed.value & mask) === cidr.network;
}

/** True when the address is inside at least one range. An empty list allows nothing. */
export function isAllowedSource(address: string, allowlist: readonly Cidr[]): boolean {
  return allowlist.some((cidr) => ipInCidr(address, cidr));
}
