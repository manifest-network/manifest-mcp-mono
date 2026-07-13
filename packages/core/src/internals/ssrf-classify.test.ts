import { describe, expect, it } from 'vitest';
import {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  isBlocked,
  isIpLiteral,
} from './ssrf-classify.js';

describe('BLOCKED_RANGES_IPV4 / BLOCKED_RANGES_IPV6', () => {
  it('IPv4 list covers the 8 expected ipaddr.js range labels', () => {
    const ranges = BLOCKED_RANGES_IPV4.map((r) => r.range).sort();
    expect(ranges).toEqual(
      [
        'broadcast',
        'carrierGradeNat',
        'linkLocal',
        'loopback',
        'multicast',
        'private',
        'reserved',
        'unspecified',
      ].sort(),
    );
  });

  it('IPv6 list covers the 6 expected ipaddr.js range labels (NO ipv4Mapped — normalized first)', () => {
    const ranges = BLOCKED_RANGES_IPV6.map((r) => r.range).sort();
    expect(ranges).toEqual(
      [
        'linkLocal',
        'loopback',
        'multicast',
        'reserved',
        'uniqueLocal',
        'unspecified',
      ].sort(),
    );
    // Key invariant: ipv4Mapped is NOT in the IPv6 blocked list. Normalization
    // step in isBlocked() handles ::ffff:* by converting to IPv4 first, so the
    // ipv4Mapped label classification never reaches the IPv6 set.
    expect(ranges).not.toContain('ipv4Mapped');
  });

  it('every IPv4 range entry carries an RFC citation', () => {
    for (const entry of BLOCKED_RANGES_IPV4) {
      expect(entry.rfc).toMatch(/RFC\s*\d+/);
    }
  });

  it('every IPv6 range entry carries an RFC citation', () => {
    for (const entry of BLOCKED_RANGES_IPV6) {
      expect(entry.rfc).toMatch(/RFC\s*\d+/);
    }
  });
});

describe('isBlocked — IPv4 representative inputs per range', () => {
  it.each<[string, string]>([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.5.5', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'linkLocal'], // AWS metadata
    ['169.254.0.1', 'linkLocal'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'carrierGradeNat'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.0.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
  ])('blocks %s as %s', (ip, expectedRange) => {
    const result = isBlocked(ip);
    expect(result).not.toBeNull();
    expect(result?.range).toBe(expectedRange);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34' /* example.com */,
  ])('allows public IPv4 %s', (ip) => {
    expect(isBlocked(ip)).toBeNull();
  });
});

describe('isBlocked — IPv6 representative inputs per range', () => {
  it.each<[string, string]>([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'linkLocal'],
    ['fc00::1', 'uniqueLocal'],
    ['fd00::1', 'uniqueLocal'],
    ['ff00::1', 'multicast'],
  ])('blocks %s as %s', (ip, expectedRange) => {
    const result = isBlocked(ip);
    expect(result).not.toBeNull();
    expect(result?.range).toBe(expectedRange);
  });

  it.each([
    '2001:4860:4860::8888' /* Google DNS */,
    '2606:4700:4700::1111' /* Cloudflare */,
  ])('allows public IPv6 %s', (ip) => {
    expect(isBlocked(ip)).toBeNull();
  });
});

describe('isBlocked — IPv6 bypass vectors (allow-list policy default-deny)', () => {
  // These IPv6 categories are NOT enumerated in BLOCKED_RANGES_IPV6. Under
  // the prior deny-list implementation they would have fallen through as
  // "allowed" — a security-critical bias error. Under the allow-list flip,
  // they default-deny because ipaddr.js classifies them as non-unicast.
  // The {range} label matches ipaddr.js's classification verbatim; the
  // {rfc} string is the default-deny audit reason (not a named RFC).

  it.each<[string, string, string]>([
    [
      '2002:7f00:0001::',
      '6to4',
      '6to4 wrapping IPv4 loopback (2002::/16 → 127.0.0.1)',
    ],
    ['2002:a9fe:a9fe::', '6to4', '6to4 wrapping AWS metadata 169.254.169.254'],
    ['2001:0::1', 'teredo', 'Teredo tunneling (RFC 4380, 2001::/32)'],
    ['64:ff9b::1', 'rfc6052', 'NAT64 well-known prefix (RFC 6052)'],
    ['100::1', 'discard', 'Discard-only prefix (RFC 6666)'],
  ])('blocks %s as %s — %s', (ip, expectedRange, _description) => {
    const result = isBlocked(ip);
    expect(result).not.toBeNull();
    expect(result?.range).toBe(expectedRange);
    // Either a named BLOCKED_RANGES_IPV6 entry (rfc starts with "RFC")
    // OR the default-deny fallback audit string. Both are acceptable
    // per the allow-list policy spec.
    expect(result?.rfc).toMatch(/(RFC\s*\d+|default-deny non-unicast)/i);
  });

  it('default-deny fallback audit string is used for unknown non-unicast labels', () => {
    // 6to4 / teredo / rfc6052 / discard are not in BLOCKED_RANGES_IPV6
    // (they were missed by the deny-list approach). Confirm the fallback
    // path is what fires, not a named-list hit.
    const result = isBlocked('2002:7f00:0001::');
    expect(result?.rfc).toMatch(/default-deny non-unicast/);
  });
});

describe('isBlocked — IPv4-mapped IPv6 normalization (security-critical)', () => {
  it('blocks ::ffff:127.0.0.1 (normalizes to loopback IPv4)', () => {
    // Without IPv4-mapped normalization, this would either pass (only IPv4
    // check consulted) or block as 'ipv4Mapped' (structural reason, not
    // security). With normalization, the security verdict tracks the
    // underlying IPv4 → loopback → blocked.
    const result = isBlocked('::ffff:127.0.0.1');
    expect(result).not.toBeNull();
    expect(result?.range).toBe('loopback');
  });

  it('blocks ::ffff:169.254.169.254 (AWS metadata via v4-mapped wrapping)', () => {
    const result = isBlocked('::ffff:169.254.169.254');
    expect(result).not.toBeNull();
    expect(result?.range).toBe('linkLocal');
  });

  it('blocks ::ffff:10.0.0.1 (RFC 1918 via v4-mapped wrapping)', () => {
    const result = isBlocked('::ffff:10.0.0.1');
    expect(result?.range).toBe('private');
  });

  it('ALLOWS ::ffff:8.8.8.8 (public IPv4 via v4-mapped wrapping — bypass-resistant)', () => {
    // The IPv6 ipv4Mapped range itself is NOT a security block. Public IPs
    // wrapped as v4-mapped IPv6 should be allowed because their underlying
    // IPv4 is unicast.
    expect(isBlocked('::ffff:8.8.8.8')).toBeNull();
  });
});

describe('isBlocked — error cases', () => {
  it('throws on unparseable input (caller fail-closes via catch)', () => {
    expect(() => isBlocked('not-an-ip')).toThrow();
    expect(() => isBlocked('')).toThrow();
  });
});

describe('isIpLiteral', () => {
  it('returns true for IPv4/IPv6 literals', () => {
    expect(isIpLiteral('8.8.8.8')).toBe(true);
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('::ffff:10.0.0.1')).toBe(true);
  });
  it('returns false for DNS names and empty string', () => {
    expect(isIpLiteral('localhost')).toBe(false);
    expect(isIpLiteral('provider.example.com')).toBe(false);
    expect(isIpLiteral('')).toBe(false);
  });
  it('accepts non-canonical IPv4 encodings (intentional — see doc)', () => {
    // Pins the intentional non-canonical acceptance: ipaddr.js treats the
    // decimal form of 127.0.0.1 as a valid IP literal, so isIpLiteral is a
    // "should I classify this host?" predicate, not a canonical-IP detector.
    expect(isIpLiteral('2130706433')).toBe(true);
  });
});
