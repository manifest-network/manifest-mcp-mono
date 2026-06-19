import { toBech32 } from '@cosmjs/encoding';
import {
  type AuthSigner,
  parseLeaseUuid,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import { createAuthTokens } from './auth-tokens-factory.js';

const ADDR = toBech32('manifest', new Uint8Array(20));
const LEASE = parseLeaseUuid('550e8400-e29b-41d4-a716-446655440000');

function fakeSigner(): AuthSigner {
  return {
    getAddress: vi.fn(async () => ADDR as never),
    getSigner: async () => ({}) as never,
    signArbitrary: vi.fn(async () => ({
      pub_key: { type: 't', value: 'pk' },
      signature: 'sig',
    })),
  };
}

describe('createAuthTokens', () => {
  it('does not resolve the address at construction (no wallet/network side effect)', () => {
    const signer = fakeSigner();
    createAuthTokens(signer, { chainId: 'manifest-1' });
    expect(signer.getAddress).not.toHaveBeenCalled(); // lazy: deferred to first mint
  });
  it('memoizes the address on success only — a transient getAddress() rejection does not poison the factory', async () => {
    const signer = fakeSigner();
    (signer.getAddress as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('WALLET_NOT_CONNECTED'))
      .mockResolvedValue(ADDR as never);
    const tokens = createAuthTokens(signer, { chainId: 'manifest-1' });
    await expect(tokens.getAuthToken(LEASE)).rejects.toThrow(
      'WALLET_NOT_CONNECTED',
    );
    // retry on the SAME factory recovers (rejected promise was reset, not cached)
    const t = await tokens.getAuthToken(LEASE);
    expect(typeof t).toBe('string');
    expect(signer.getAddress).toHaveBeenCalledTimes(2);
  });
  it('binds the address once and mints a token (base64 JSON payload)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const signer = fakeSigner();
      const tokens = createAuthTokens(signer, { chainId: 'manifest-1' });
      // Fire both mints concurrently, then advance the fake clock so the
      // AuthTimestampTracker's 1 s serialization wait elapses instantly
      // (mirrors auth-token-service.test.ts — keeps the unit suite fast).
      const p1 = tokens.getAuthToken(LEASE);
      const p2 = tokens.getAuthToken(LEASE);
      await vi.advanceTimersByTimeAsync(1000);
      const [t1] = await Promise.all([p1, p2]);
      expect(signer.getAddress).toHaveBeenCalledTimes(1); // address bound once (memoized on success)
      expect(typeof t1).toBe('string');
      const payload = JSON.parse(Buffer.from(t1, 'base64').toString());
      expect(payload).toMatchObject({
        tenant: ADDR,
        lease_uuid: LEASE,
        pub_key: 'pk',
        signature: 'sig',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('mints a FRESH token per call (no caching — replay-tracker safety): strictly increasing timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const signer = fakeSigner();
      const tokens = createAuthTokens(signer, { chainId: 'manifest-1' });
      const p1 = tokens.getAuthToken(LEASE);
      const p2 = tokens.getAuthToken(LEASE);
      await vi.advanceTimersByTimeAsync(1000);
      const [r1, r2] = await Promise.all([p1, p2]);
      const a = JSON.parse(Buffer.from(r1, 'base64').toString());
      const b = JSON.parse(Buffer.from(r2, 'base64').toString());
      expect(signer.signArbitrary).toHaveBeenCalledTimes(2); // re-signed, not cached
      expect(b.timestamp).toBeGreaterThan(a.timestamp); // serialized, strictly increasing
    } finally {
      vi.useRealTimers();
    }
  });
  it('getLeaseDataAuthToken embeds meta_hash', async () => {
    const tokens = createAuthTokens(fakeSigner(), { chainId: 'manifest-1' });
    const t = await tokens.getLeaseDataAuthToken(LEASE, 'abc123');
    const payload = JSON.parse(Buffer.from(t, 'base64').toString());
    expect(payload.meta_hash).toBe('abc123');
  });
});
