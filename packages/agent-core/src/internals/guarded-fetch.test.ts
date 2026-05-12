import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  createGuardedFetch,
  isBlocked,
} from './guarded-fetch.js';

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

describe('createGuardedFetch — Node-runtime check', () => {
  it('returns a fetch-shaped function on Node', () => {
    const fn = createGuardedFetch();
    expect(typeof fn).toBe('function');
    // Function length: 2 (input, init?) — but JS arity counting may differ.
    // Don't pin .length; just verify it's callable.
  });

  it('throws a clear, actionable error on non-Node runtimes', () => {
    // Simulate non-Node by stashing process.versions.
    const original = process.versions;
    Object.defineProperty(process, 'versions', {
      value: {},
      configurable: true,
    });
    try {
      expect(() => createGuardedFetch()).toThrow(/Node\.js runtime/);
    } finally {
      Object.defineProperty(process, 'versions', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('createGuardedFetch — integration SSRF rejection (slow)', () => {
  // Integration tests against actual SSRF rejection of loopback / metadata
  // targets. These exercise the full pipeline (createGuardedFetch → undici
  // Dispatcher → DNS lookup → ipaddr.js check → connect-time reject).
  //
  // Skip-friendly: if the environment doesn't expose `undici` (e.g. an
  // older Node), the test naturally falls through to `null` result of the
  // outer try.

  it('rejects fetch to 127.0.0.1 with SSRF block message', async () => {
    const guarded = createGuardedFetch();
    let caught: Error | undefined;
    try {
      // Port 9999: unlikely to be in use, but the agent should reject at
      // CONNECT time before any TCP attempt.
      await guarded('http://127.0.0.1:9999/probe');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // The undici fetch wraps connection errors in a TypeError with a
    // `cause` chain. The original SSRF-block message should be visible
    // somewhere in the chain.
    const chain = collectErrorMessages(caught);
    expect(chain).toMatch(/SSRF blocked/);
    expect(chain).toMatch(/loopback/);
  }, 10_000);

  it('rejects fetch to 169.254.169.254 (AWS metadata) with linkLocal block', async () => {
    const guarded = createGuardedFetch();
    let caught: Error | undefined;
    try {
      await guarded('http://169.254.169.254:80/latest/meta-data/');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const chain = collectErrorMessages(caught);
    expect(chain).toMatch(/SSRF blocked/);
    expect(chain).toMatch(/linkLocal/);
  }, 10_000);
});

describe('createGuardedFetch — cachedP recovery after rejection', () => {
  afterEach(() => {
    vi.doUnmock('undici');
    vi.resetModules();
  });

  it('clears cachedP after a rejected buildSsrfDispatcher so the next call retries', async () => {
    // Mock `undici` so the first `new Agent({...})` invocation inside
    // `buildSsrfDispatcher` throws, then subsequent invocations succeed.
    // Without the catch-and-reset, the cached rejected Promise would
    // make EVERY subsequent createGuardedFetch() call fail permanently.
    let constructAttempts = 0;
    vi.doMock('undici', async () => {
      const actual = await vi.importActual<typeof import('undici')>('undici');
      class FlakyAgent extends actual.Agent {
        constructor(opts: ConstructorParameters<typeof actual.Agent>[0]) {
          constructAttempts += 1;
          if (constructAttempts === 1) {
            throw new Error('simulated dispatcher construction failure');
          }
          super(opts);
        }
      }
      return { ...actual, Agent: FlakyAgent };
    });

    // Re-import the SUT so it picks up the mocked undici. Each `vi.resetModules`
    // + dynamic import yields a fresh module instance with cachedP undefined.
    vi.resetModules();
    const { createGuardedFetch: freshCreate } = await import(
      './guarded-fetch.js'
    );
    const guarded = freshCreate();

    // First call: Agent constructor throws → buildSsrfDispatcher rejects →
    // the catch arm clears cachedP and re-throws.
    await expect(guarded('https://example.com/')).rejects.toThrow(
      /simulated dispatcher construction failure/,
    );
    expect(constructAttempts).toBe(1);

    // Second call: cachedP was reset, so buildSsrfDispatcher is invoked
    // again. The Agent constructor succeeds this time. The fetch itself
    // may fail for unrelated reasons (the SSRF guard blocks the test URL),
    // but the failure mode must NOT be "simulated dispatcher construction
    // failure" anymore — proving the cached rejected Promise was cleared.
    let secondError: Error | undefined;
    try {
      // 127.0.0.1: SSRF-blocked target so we don't hit the real network.
      await guarded('http://127.0.0.1:9999/probe');
    } catch (err) {
      secondError = err as Error;
    }
    expect(constructAttempts).toBe(2);
    const secondMessage = secondError ? collectErrorMessages(secondError) : '';
    expect(secondMessage).not.toMatch(
      /simulated dispatcher construction failure/,
    );
  }, 10_000);
});

/**
 * Walk an Error's cause chain (Node 16.9+ supports Error.cause) and join
 * all message strings. undici wraps connect errors in a fetch TypeError
 * with the real cause nested via `.cause`.
 */
function collectErrorMessages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (
    current !== null &&
    current !== undefined &&
    depth < 10 // defensive bound
  ) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  return parts.join(' | ');
}
