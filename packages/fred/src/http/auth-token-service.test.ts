import { fromBase64 } from '@cosmjs/encoding';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import type { AuthTokenPayload } from './auth.js';
import { AuthTokenService } from './auth-token-service.js';

const TENANT = 'manifest1tenantaddress000000000000000000000';
const LEASE_UUID = '11111111-1111-1111-1111-111111111111';
const META_HASH = 'deadbeef'.repeat(8);

function decodeToken(token: string): AuthTokenPayload {
  const bytes = fromBase64(token);
  return JSON.parse(new TextDecoder().decode(bytes)) as AuthTokenPayload;
}

function makeWallet(withSign: boolean): WalletProvider {
  const wallet: WalletProvider = {
    getAddress: async () => TENANT,
    getSigner: async () => ({}) as unknown as OfflineSigner,
  };
  if (withSign) {
    wallet.signArbitrary = vi.fn(async (_addr: string, _msg: string) => ({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pubkey-b64' },
      signature: 'sig-b64',
    }));
  }
  return wallet;
}

describe('AuthTokenService', () => {
  it('produces a provider token with expected fields and no meta_hash', async () => {
    const service = new AuthTokenService(makeWallet(true));
    const token = await service.providerToken(TENANT, LEASE_UUID);
    const payload = decodeToken(token);

    expect(payload.tenant).toBe(TENANT);
    expect(payload.lease_uuid).toBe(LEASE_UUID);
    expect(payload.pub_key).toBe('pubkey-b64');
    expect(payload.signature).toBe('sig-b64');
    expect(payload.meta_hash).toBeUndefined();
    expect(typeof payload.timestamp).toBe('number');
  });

  it('includes meta_hash on lease-data tokens', async () => {
    const service = new AuthTokenService(makeWallet(true));
    const token = await service.leaseDataToken(TENANT, LEASE_UUID, META_HASH);
    const payload = decodeToken(token);

    expect(payload.meta_hash).toBe(META_HASH);
    expect(payload.tenant).toBe(TENANT);
    expect(payload.lease_uuid).toBe(LEASE_UUID);
  });

  it('signs over the expected message shape', async () => {
    const wallet = makeWallet(true);
    const service = new AuthTokenService(wallet);
    await service.providerToken(TENANT, LEASE_UUID);

    const signed = (wallet.signArbitrary as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(signed[0]).toBe(TENANT);
    expect(signed[1]).toMatch(new RegExp(`^${TENANT}:${LEASE_UUID}:[0-9]+$`));
  });

  it('throws INVALID_CONFIG when wallet lacks signArbitrary', async () => {
    const service = new AuthTokenService(makeWallet(false));
    await expect(service.providerToken(TENANT, LEASE_UUID)).rejects.toThrow(
      /signArbitrary/,
    );
  });

  it('serializes concurrent calls so timestamps are strictly increasing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const service = new AuthTokenService(makeWallet(true));
      const firstToken = service.providerToken(TENANT, LEASE_UUID);
      const secondToken = service.providerToken(TENANT, LEASE_UUID);

      await vi.advanceTimersByTimeAsync(1000);

      const [a, b] = await Promise.all([firstToken, secondToken]);
      const ta = decodeToken(a).timestamp;
      const tb = decodeToken(b).timestamp;
      expect(tb).toBeGreaterThan(ta);
    } finally {
      vi.useRealTimers();
    }
  });
});
