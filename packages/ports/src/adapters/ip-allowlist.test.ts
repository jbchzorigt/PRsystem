import { describe, expect, it } from 'vitest';
import { ipInCidr, isAllowedSource, parseCidr, parseCidrList } from './ip-allowlist';

describe('CIDR allowlisting', () => {
  it('parses IPv4 and IPv6 ranges, and a bare address as a host range', () => {
    expect(parseCidr('203.0.113.0/24')).toEqual({ family: 4, network: 3405803776n, prefix: 24 });
    expect(parseCidr('203.0.113.7')?.prefix).toBe(32);
    expect(parseCidr('2001:db8::/32')).toEqual({
      family: 6,
      network: (0x2001n << 112n) | (0xdb8n << 96n),
      prefix: 32,
    });
    expect(parseCidr('::1')?.prefix).toBe(128);
  });

  it('refuses what is not a range', () => {
    for (const bad of [
      '',
      'nowhere',
      '203.0.113.0/33',
      '203.0.113/24',
      '2001:db8::/129',
      '1.2.3.4/x',
    ]) {
      expect({ bad, parsed: parseCidr(bad) }).toEqual({ bad, parsed: undefined });
    }
    expect(parseCidrList('203.0.113.0/24, nowhere')).toBeUndefined();
    expect(parseCidrList('')).toEqual([]);
  });

  it('decides membership for IPv4, IPv6 and an IPv4-mapped IPv6 source', () => {
    const list = parseCidrList('203.0.113.0/24, 2001:db8:1::/48')!;
    expect(isAllowedSource('203.0.113.200', list)).toBe(true);
    expect(isAllowedSource('203.0.114.1', list)).toBe(false);
    expect(isAllowedSource('::ffff:203.0.113.9', list)).toBe(true);
    expect(isAllowedSource('2001:db8:1:ffff::1', list)).toBe(true);
    expect(isAllowedSource('2001:db8:2::1', list)).toBe(false);
    expect(isAllowedSource('fe80::1%en0', list)).toBe(false);
    expect(isAllowedSource('garbage', list)).toBe(false);
  });

  it('allows nothing on an empty list, and everything on /0', () => {
    expect(isAllowedSource('203.0.113.1', [])).toBe(false);
    expect(ipInCidr('8.8.8.8', parseCidr('0.0.0.0/0')!)).toBe(true);
    expect(ipInCidr('2001:db8::1', parseCidr('::/0')!)).toBe(true);
    // A family mismatch is never a match, even against /0.
    expect(ipInCidr('2001:db8::1', parseCidr('0.0.0.0/0')!)).toBe(false);
  });
});
