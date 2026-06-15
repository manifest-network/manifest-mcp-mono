import type {
  Address,
  AuthSigner,
  LeaseUuid,
} from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

/**
 * Signer-bound ADR-036 auth-token factory. Replaces the per-call `makeFredAuthTokens` closures
 * (Barney's `getProviderAuthToken`). Resolves the address from `signer.getAddress()` LAZILY on the
 * first token call (memoized on SUCCESS only — construction has no wallet/network side effect; see
 * the inline comment), then mints a FRESH token per call (serialized by `AuthTimestampTracker`). It
 * does NOT cache tokens: ADR-036 signing is deterministic, so a reused token is a duplicate signature
 * the provider's replay tracker rejects on protected endpoints (see `auth.ts` AuthTimestampTracker
 * doc). Reuses the same stateless builders `AuthTokenService` uses, so behavior matches the proven
 * server path.
 *
 * The returned `getAuthToken(leaseUuid)` is ADDRESS-BOUND (the address is closed over here, not a
 * param). The deploy path's callbacks are `(address, leaseUuid) =>`, so when 4c wires this in it
 * wraps with an address-closing thunk — `() => tokens.getAuthToken(uuid)` — the same idiom the real
 * consumer (Barney `compositeTransactions.ts`) already uses. This is the intended SDK shape, not a
 * mismatch. See plan OI-A1.
 *
 * `chainId` is accepted for forward-compat / API symmetry (spec §5.3); it is NOT yet embedded in the
 * ADR-036 message — reserved for a future chain-scoped token format. See plan OI-CHAIN.
 */
export function createAuthTokens(
  signer: AuthSigner,
  opts: { chainId: string },
): {
  getAuthToken(leaseUuid: LeaseUuid): Promise<string>;
  getLeaseDataAuthToken(
    leaseUuid: LeaseUuid,
    metaHashHex: string,
  ): Promise<string>;
} {
  void opts.chainId; // reserved (OI-CHAIN); silences noUnusedParameters
  const timestamps = new AuthTimestampTracker();

  // Resolve the address LAZILY on first token mint, memoizing on SUCCESS only.
  // Two reasons (both mirror core's `createSignerAdapter`, signer.ts:34-49):
  //   1. No construction-time side effect — the signer's `getAddress()` triggers
  //      wallet `connect()` internally, so an eager call would couple merely
  //      constructing the factory to a wallet/network round-trip.
  //   2. No promise poisoning — `getAddress()` can reject with a TRANSIENT
  //      WALLET_NOT_CONNECTED. Caching a rejected promise would permanently
  //      poison this long-lived factory: every later token call would replay
  //      the failure without retrying. Reset on rejection so a transient
  //      failure can recover on the next call.
  let addressPromise: Promise<Address> | undefined;
  const getAddress = (): Promise<Address> => {
    addressPromise ??= signer.getAddress().catch((err) => {
      addressPromise = undefined;
      throw err;
    });
    return addressPromise;
  };

  return {
    async getAuthToken(leaseUuid) {
      const address = await getAddress();
      const timestamp = await timestamps.next();
      const message = createSignMessage(address, leaseUuid, timestamp);
      const { pub_key, signature } = await signer.signArbitrary(
        address,
        message,
      );
      return createAuthToken(
        address,
        leaseUuid,
        timestamp,
        pub_key.value,
        signature,
      );
    },
    async getLeaseDataAuthToken(leaseUuid, metaHashHex) {
      const address = await getAddress();
      const timestamp = await timestamps.next();
      const message = createLeaseDataSignMessage(
        leaseUuid,
        metaHashHex,
        timestamp,
      );
      const { pub_key, signature } = await signer.signArbitrary(
        address,
        message,
      );
      return createAuthToken(
        address,
        leaseUuid,
        timestamp,
        pub_key.value,
        signature,
        metaHashHex,
      );
    },
  };
}
