import type { Signer } from '@manifest-network/manifest-mcp-core';
import { AuthTokenService } from './auth-token-service.js';

/**
 * Fred-owned driven port: mints ADR-036 provider/lease-data auth tokens. Borrows the
 * AWS credential-provider idiom (an injected token provider) but deliberately INVERTS
 * AWS's cache-until-expiry: tokens are minted fresh per call (see `createProviderAuth`
 * below — ADR-036 deterministic signing makes a reused token a replay-rejected
 * duplicate). Backed by core's `Signer` at the `createFredClient` root and by an
 * `AuthTokenService` instance at the server. Address-PARAM (not address-bound) so it
 * composes onto `FredAuthCtx`.
 */
export interface ProviderAuthPort {
  providerToken(input: { address: string; leaseUuid: string }): Promise<string>;
  leaseDataToken(input: {
    address: string;
    leaseUuid: string;
    metaHashHex: string;
  }): Promise<string>;
}

/**
 * Build a `ProviderAuthPort` from core's `Signer`. Instantiates `new AuthTokenService(signer)`
 * — `Signer` (= `AuthSigner`) is structurally assignable to `AuthTokenService`'s `WalletProvider`
 * ctor param (both expose `getAddress`/`signArbitrary`; method-param bivariance), verified by tsc.
 * Fresh-per-call (ADR-036 deterministic signing makes a reused token a replay-rejected duplicate),
 * so no caching. `chainId` is reserved (OI-CHAIN) — NOT embedded in the message yet.
 */
export function createProviderAuth(
  signer: Signer,
  opts: { chainId: string },
): ProviderAuthPort {
  void opts.chainId; // reserved (OI-CHAIN); silences noUnusedParameters
  const svc = new AuthTokenService(signer);
  return {
    providerToken: ({ address, leaseUuid }) =>
      svc.providerToken(address, leaseUuid),
    leaseDataToken: ({ address, leaseUuid, metaHashHex }) =>
      svc.leaseDataToken(address, leaseUuid, metaHashHex),
  };
}
