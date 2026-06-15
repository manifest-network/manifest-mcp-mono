import { describe, expectTypeOf, it } from 'vitest';
import {
  createManifestClient,
  createManifestReadClient,
  type FullClientOptions,
  type ManifestClient,
  type ManifestReadClient,
  type ReadClientOptions,
} from './client-factory.js';
import type { CapabilityCtx, QueryCtx } from './ctx.js';
import type { Signer } from './signer.js';
import type { WalletProvider } from './types.js';

describe('ManifestClient / ManifestReadClient (type-level)', () => {
  it('ManifestReadClient extends QueryCtx — no signer, plus a dispose()', () => {
    expectTypeOf<ManifestReadClient>().toExtend<QueryCtx>();
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('signer');
    expectTypeOf<ManifestReadClient['dispose']>().toEqualTypeOf<() => void>();
  });
  it('ManifestClient is a strict superset (extends read + ctx) with a REQUIRED signer', () => {
    expectTypeOf<ManifestClient>().toExtend<ManifestReadClient>();
    expectTypeOf<ManifestClient>().toExtend<CapabilityCtx>();
    expectTypeOf<ManifestClient['signer']>().toEqualTypeOf<Signer>(); // required — NOT Signer | undefined
  });
  it('a read client is NOT a full client (the read-vs-full guarantee holds because signer is required on the full client)', () => {
    expectTypeOf<ManifestReadClient>().not.toExtend<ManifestClient>();
  });
});

describe('createManifestClient / createManifestReadClient (type-level)', () => {
  it('both factories are async and resolve to the precise client type', () => {
    expectTypeOf(
      createManifestClient,
    ).returns.resolves.toEqualTypeOf<ManifestClient>();
    expectTypeOf(
      createManifestReadClient,
    ).returns.resolves.toEqualTypeOf<ManifestReadClient>();
  });
  it('full opts REQUIRE a walletProvider; read opts carry none', () => {
    expectTypeOf<
      FullClientOptions['walletProvider']
    >().toEqualTypeOf<WalletProvider>();
    expectTypeOf<ReadClientOptions>().not.toHaveProperty('walletProvider');
  });
});
