import { describe, expectTypeOf, it } from 'vitest';
// The tx/lifecycle value surface re-emitted on the `/deploy` subpath.
import type {
  AppDeploySpec,
  executeTx,
  FredAuthCtx,
  FredReadCtx,
  fundCredits,
  ProviderAuthPort,
  setItemCustomDomain,
  stopApp,
} from './deploy.js';
import { createProviderAuth } from './deploy.js';
// Brand families re-emitted via the ROOT `export type *`.
import type {
  Address,
  EventTransport,
  Fqdn,
  LeaseUuid,
  ProviderUuid,
  ReadCtx,
  SkuUuid,
  TxCtx,
} from './index.js';
// Import the PUBLIC surface through the SDK's own modules (the same specifiers a
// consumer writes), NOT the upstream packages — this is the codegen-passthrough
// tripwire (spec §14): a barrel mis-edit, a dropped `export type *`, or an upstream
// type-shape drift that survives a value-only test surfaces HERE as a type error.
import {
  type CapabilityCtx,
  createFredClient,
  createManifestClient,
  createManifestReadClient,
  type FredClient,
  type FullClientOptions,
  type ManifestClient,
  type ManifestReadClient,
  type QueryCtx,
  type ReadClientOptions,
} from './index.js';

describe('SDK factory return types (re-emitted; codegen-passthrough tripwire)', () => {
  it('the 3 client factories are async and resolve to the precise re-emitted client type', () => {
    expectTypeOf(
      createManifestClient,
    ).returns.resolves.toEqualTypeOf<ManifestClient>();
    expectTypeOf(
      createManifestReadClient,
    ).returns.resolves.toEqualTypeOf<ManifestReadClient>();
    expectTypeOf(createFredClient).returns.resolves.toEqualTypeOf<FredClient>();
  });

  it('FredClient is a strict superset of ManifestClient (full client + the provider method)', () => {
    expectTypeOf<FredClient>().toExtend<ManifestClient>();
    expectTypeOf<FredClient>().toHaveProperty('subscribeLeaseStatus');
  });
});

describe('ManifestClient bound read + tx + executeTx methods (re-emitted)', () => {
  it('carries the bound read methods', () => {
    expectTypeOf<ManifestClient>().toHaveProperty('getLease');
    expectTypeOf<ManifestClient>().toHaveProperty('getBalance');
    expectTypeOf<ManifestClient>().toHaveProperty('getSKUs');
  });

  it('carries the 3 bound tx methods + executeTx with the free-fn tail (ctx dropped)', () => {
    expectTypeOf<ManifestClient>().toHaveProperty('fundCredits');
    expectTypeOf<ManifestClient>().toHaveProperty('setItemCustomDomain');
    expectTypeOf<ManifestClient>().toHaveProperty('stopApp');
    expectTypeOf<ManifestClient>().toHaveProperty('executeTx');
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
});

describe('read-vs-full guarantee (re-emitted)', () => {
  it('ManifestReadClient is NOT assignable to ManifestClient (required signer narrows the full client)', () => {
    expectTypeOf<ManifestReadClient>().not.toExtend<ManifestClient>();
  });

  it('ManifestReadClient has no signer/tx surface at the type level', () => {
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('signer');
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('fundCredits');
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('executeTx');
  });

  it('full opts REQUIRE a walletProvider; read opts carry none', () => {
    expectTypeOf<FullClientOptions>().toHaveProperty('walletProvider');
    expectTypeOf<ReadClientOptions>().not.toHaveProperty('walletProvider');
  });
});

describe('brand families + ports re-emit as types', () => {
  it('the 5-brand family is structurally string but each is its own nominal type', () => {
    expectTypeOf<Address>().toExtend<string>();
    expectTypeOf<Fqdn>().toExtend<string>();
    expectTypeOf<LeaseUuid>().toExtend<string>();
    expectTypeOf<ProviderUuid>().toExtend<string>();
    expectTypeOf<SkuUuid>().toExtend<string>();
    // a plain string is NOT a brand — the parse/as boundary is load-bearing.
    expectTypeOf<string>().not.toExtend<Address>();
    expectTypeOf<string>().not.toExtend<LeaseUuid>();
    // distinct brands are not interchangeable.
    expectTypeOf<LeaseUuid>().not.toExtend<ProviderUuid>();
  });

  it('the ctx ports re-emit (CapabilityCtx / QueryCtx / ReadCtx / TxCtx / EventTransport)', () => {
    expectTypeOf<ManifestClient>().toExtend<CapabilityCtx>();
    expectTypeOf<ManifestReadClient>().toExtend<QueryCtx>();
    expectTypeOf<ReadCtx>().toHaveProperty('query');
    expectTypeOf<TxCtx>().toHaveProperty('signer');
    expectTypeOf<EventTransport>().not.toBeNever();
  });
});

describe('/deploy re-exports the provider-auth compose surface (ENG-446 D1/D3)', () => {
  it('createProviderAuth builds a ProviderAuthPort from a Signer', () => {
    expectTypeOf(createProviderAuth).returns.toEqualTypeOf<ProviderAuthPort>();
    expectTypeOf<ProviderAuthPort>().toHaveProperty('providerToken');
    expectTypeOf<ProviderAuthPort>().toHaveProperty('leaseDataToken');
  });

  it('FredAuthCtx / FredReadCtx / AppDeploySpec re-emit as types', () => {
    expectTypeOf<FredAuthCtx>().toHaveProperty('providerAuth');
    expectTypeOf<FredReadCtx>().toHaveProperty('query');
    expectTypeOf<AppDeploySpec>().not.toBeNever();
  });
});
