import type { Signer } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import { createProviderAuth } from './provider-auth.js';

function fakeSigner(): Signer {
  return {
    getAddress: vi.fn(async () => 'manifest1abc' as never),
    getSigner: vi.fn(),
    signArbitrary: vi.fn(async () => ({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'cHVi' },
      signature: 'c2ln',
    })),
  } as unknown as Signer;
}

describe('createProviderAuth', () => {
  it('providerToken is address-param and yields a base64 ADR-036 token', async () => {
    const signer = fakeSigner();
    const port = createProviderAuth(signer, { chainId: 'manifest-1' });
    const token = await port.providerToken({
      address: 'manifest1abc',
      leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(signer.signArbitrary).toHaveBeenCalledTimes(1);
  });

  it('mints FRESH per call (no caching) — two calls sign twice', async () => {
    const signer = fakeSigner();
    const port = createProviderAuth(signer, { chainId: 'manifest-1' });
    const input = {
      address: 'manifest1abc',
      leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    };
    await port.providerToken(input);
    await port.providerToken(input);
    expect(signer.signArbitrary).toHaveBeenCalledTimes(2);
  });

  it('leaseDataToken includes the meta hash path', async () => {
    const signer = fakeSigner();
    const port = createProviderAuth(signer, { chainId: 'manifest-1' });
    const token = await port.leaseDataToken({
      address: 'manifest1abc',
      leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
      metaHashHex: 'deadbeef',
    });
    expect(typeof token).toBe('string');
    expect(signer.signArbitrary).toHaveBeenCalledTimes(1);
  });

  it('does NOT embed chainId in the signed message (OI-CHAIN reserved)', async () => {
    const signer = fakeSigner();
    const port = createProviderAuth(signer, { chainId: 'manifest-XYZ' });
    await port.providerToken({
      address: 'manifest1abc',
      leaseUuid: 'lease-1',
    });
    const signedMessage = vi.mocked(signer.signArbitrary).mock.calls[0][1];
    expect(signedMessage).not.toContain('manifest-XYZ');
  });
});
