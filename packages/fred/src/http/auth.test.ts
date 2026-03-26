import { fromBase64 } from '@cosmjs/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthTimestampTracker,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

describe('createSignMessage', () => {
  it('formats tenant:leaseUuid:timestamp', () => {
    expect(createSignMessage('t1', 'uuid1', 1735689600)).toBe(
      't1:uuid1:1735689600',
    );
  });
});

describe('createLeaseDataSignMessage', () => {
  it('formats with manifest lease data prefix', () => {
    expect(createLeaseDataSignMessage('uuid1', 'abc123', 1735689600)).toBe(
      'manifest lease data uuid1 abc123 1735689600',
    );
  });
});

describe('createAuthToken', () => {
  it('creates base64-encoded JSON token without meta_hash', () => {
    const token = createAuthToken(
      'tenant1',
      'lease1',
      1735689600,
      'pk1',
      'sig1',
    );
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.tenant).toBe('tenant1');
    expect(decoded.lease_uuid).toBe('lease1');
    expect(decoded.timestamp).toBe(1735689600);
    expect(decoded.pub_key).toBe('pk1');
    expect(decoded.signature).toBe('sig1');
    expect(decoded.meta_hash).toBeUndefined();
  });

  it('includes meta_hash when provided', () => {
    const token = createAuthToken(
      't',
      'l',
      1735689600,
      'pk',
      'sig',
      'deadbeef',
    );
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.meta_hash).toBe('deadbeef');
  });
});

describe('AuthTimestampTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the current unix second on first call', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    const tracker = new AuthTimestampTracker();
    const ts = await tracker.next();
    expect(ts).toBe(
      Math.floor(new Date('2026-01-01T00:00:05Z').getTime() / 1000),
    );
  });

  it('returns a strictly greater timestamp when called twice in the same second', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const tracker = new AuthTimestampTracker();
    const ts1 = await tracker.next();

    // Still the same second — next() should wait for the clock to advance
    const p2 = tracker.next();
    // Advance the clock by 1 second so the setTimeout resolves
    vi.advanceTimersByTime(1000);
    const ts2 = await p2;

    expect(ts2).toBeGreaterThan(ts1);
  });

  it('serializes concurrent callers so each gets a unique timestamp', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'));
    const tracker = new AuthTimestampTracker();

    // Fire three calls concurrently
    const p1 = tracker.next();
    const p2 = tracker.next();
    const p3 = tracker.next();

    // Use async timer advancement so the promise chain's microtasks
    // interleave with timer resolution
    await vi.advanceTimersByTimeAsync(3000);

    const [ts1, ts2, ts3] = await Promise.all([p1, p2, p3]);
    const unique = new Set([ts1, ts2, ts3]);
    expect(unique.size).toBe(3);
  });
});
