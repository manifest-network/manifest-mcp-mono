import { describe, expectTypeOf, it } from 'vitest';
import {
  createManifestReadClient,
  type FullClientOptions,
  type ManifestReadClient,
  type ReadClientOptions,
} from './client-factory.js';
import { createManifestClient, type ManifestClient } from './client-full.js';
import type { CapabilityCtx, QueryCtx } from './ctx.js';
import type { Signer } from './signer.js';
import type { executeTx } from './tools/executeTx.js';
import type { fundCredits } from './tools/fundCredits.js';
import type { getLease } from './tools/reads.js';
import type { setItemCustomDomain } from './tools/setItemCustomDomain.js';
import type { stopApp } from './tools/stopApp.js';
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

describe('ManifestClient bound tx + executeTx methods (type-level)', () => {
  it('exposes the 3 tx methods + executeTx with the free-fn tail (ctx dropped)', () => {
    expectTypeOf<ManifestClient['fundCredits']>().parameters.toEqualTypeOf<
      Parameters<typeof fundCredits> extends [unknown, ...infer R] ? R : never
    >();
    expectTypeOf<
      ManifestClient['setItemCustomDomain']
    >().parameters.toEqualTypeOf<
      Parameters<typeof setItemCustomDomain> extends [unknown, ...infer R]
        ? R
        : never
    >();
    expectTypeOf<ManifestClient['stopApp']>().parameters.toEqualTypeOf<
      Parameters<typeof stopApp> extends [unknown, ...infer R] ? R : never
    >();
    expectTypeOf<ManifestClient['executeTx']>().parameters.toEqualTypeOf<
      Parameters<typeof executeTx> extends [unknown, ...infer R] ? R : never
    >();
  });
  it('the tx methods are absent from ManifestReadClient at the type level', () => {
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('fundCredits');
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('executeTx');
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

describe('ManifestReadClient bound reads', () => {
  it('exposes getLease with the free-fn tail (ctx dropped)', () => {
    expectTypeOf<ManifestReadClient['getLease']>().toEqualTypeOf<
      (
        leaseUuid: string,
        opts?: import('./options.js').CallOptions,
      ) => ReturnType<typeof getLease>
    >();
  });
  it('getBalance return matches the free fn (drift guard)', () => {
    expectTypeOf<ReturnType<ManifestReadClient['getBalance']>>().toEqualTypeOf<
      ReturnType<typeof import('./tools/getBalance.js').getBalance>
    >();
  });
});
