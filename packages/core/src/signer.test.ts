import { toBech32 } from '@cosmjs/encoding';
import { describe, expect, it } from 'vitest';
import { createSignerAdapter, requireAuthSigner } from './signer.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';

const ADDR = toBech32('manifest', new Uint8Array(20));
function fakeWallet(over: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: async () => ADDR,
    getSigner: async () => ({}) as never,
    signArbitrary: async () => ({
      pub_key: { type: 't', value: 'v' },
      signature: 's',
    }),
    ...over,
  };
}

describe('createSignerAdapter', () => {
  it('parses the address once and returns the branded Address', async () => {
    let calls = 0;
    const signer = createSignerAdapter(
      fakeWallet({
        getAddress: async () => {
          calls++;
          return ADDR;
        },
      }),
    );
    const a1 = await signer.getAddress();
    const a2 = await signer.getAddress();
    expect(a1).toBe(ADDR);
    expect(a2).toBe(a1);
    expect(calls).toBe(1); // memoized — getAddress + parseAddress run once
  });
  it('does not cache a rejected getAddress — a transient failure recovers on retry', async () => {
    let calls = 0;
    const signer = createSignerAdapter(
      fakeWallet({
        getAddress: async () => {
          calls++;
          // First call simulates a transient WALLET_NOT_CONNECTED (connect()
          // throws inside getAddress); subsequent calls succeed.
          if (calls === 1) throw new Error('transient WALLET_NOT_CONNECTED');
          return ADDR;
        },
      }),
    );
    await expect(signer.getAddress()).rejects.toThrow(
      'transient WALLET_NOT_CONNECTED',
    );
    // The rejected promise must NOT be memoized: the retry re-invokes the wallet.
    const a = await signer.getAddress();
    expect(a).toBe(ADDR);
    expect(calls).toBe(2);
    // ...and a success after recovery is memoized (no third wallet call).
    const a2 = await signer.getAddress();
    expect(a2).toBe(a);
    expect(calls).toBe(2);
  });
  it('enforces the prefix when given (throws INVALID_ADDRESS)', async () => {
    const signer = createSignerAdapter(fakeWallet(), 'cosmos');
    // parseAddress → validateAddress throws INVALID_ADDRESS on a prefix mismatch (validation.ts:115-119)
    await expect(signer.getAddress()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_ADDRESS,
    });
  });
  it('throws INVALID_CONFIG when the wallet lacks signArbitrary (ADR-036)', async () => {
    const signer = createSignerAdapter(
      fakeWallet({ signArbitrary: undefined }),
    );
    const addr = await signer.getAddress();
    await expect(signer.signArbitrary(addr, 'msg')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });
});

describe('requireAuthSigner', () => {
  it('returns the signer when present', () => {
    const signer = createSignerAdapter(fakeWallet());
    expect(requireAuthSigner({ signer })).toBe(signer);
  });
  it('throws INVALID_CONFIG when absent (query-only ctx)', () => {
    expect(() => requireAuthSigner({})).toThrow(ManifestMCPError);
  });
});
