import type { OfflineSigner } from '@cosmjs/proto-signing';
import { type Address, parseAddress } from './brands.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SignArbitraryResult,
  type WalletProvider,
} from './types.js';

/**
 * SDK Signer port (interface-segregated). `OfflineSigner` is `@cosmjs/proto-signing`'s
 * (the `@manifest-network/stargate` fork overrides `@cosmjs/stargate`, not proto-signing).
 * `TxSigner` covers tx broadcasting; `AuthSigner` adds ADR-036 `signArbitrary` for off-chain auth.
 */
export interface TxSigner {
  getAddress(): Promise<Address>;
  getSigner(): Promise<OfflineSigner>;
}
export interface AuthSigner extends TxSigner {
  signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>;
}
export type Signer = AuthSigner;

/**
 * Adapt a concrete `WalletProvider` (whose `getAddress(): string`) to the `Signer` port.
 * `parseAddress`-once: the branded `Address` is memoized so the bech32 validation runs a single
 * time (parse-once; ENG-258). `signArbitrary` is OPTIONAL on `WalletProvider` — the adapter throws
 * `INVALID_CONFIG` when absent (mirrors `fred`'s `AuthTokenService.requireSignArbitrary`).
 */
export function createSignerAdapter(
  wallet: WalletProvider,
  expectedPrefix?: string,
): Signer {
  let addressPromise: Promise<Address> | undefined;
  const getAddress = (): Promise<Address> => {
    // Memoize on SUCCESS only: `wallet.getAddress()` can throw a TRANSIENT
    // WALLET_NOT_CONNECTED (it calls `connect()` internally), so caching a
    // rejected promise would permanently poison this long-lived port — every
    // later getAddress()/signArbitrary() would replay the failure without
    // retrying. Reset on rejection so a transient failure can recover.
    addressPromise ??= wallet
      .getAddress()
      .then((a) => parseAddress(a, expectedPrefix))
      .catch((err) => {
        addressPromise = undefined;
        throw err;
      });
    return addressPromise;
  };
  return {
    getAddress,
    getSigner: () => wallet.getSigner(),
    async signArbitrary(address, data) {
      if (!wallet.signArbitrary) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Wallet does not support signArbitrary (ADR-036). Required for provider/auth-token operations; use a wallet that implements signArbitrary.',
        );
      }
      return wallet.signArbitrary(address, data);
    },
  };
}

/**
 * Narrow a client/ctx carrying an optional signer to a guaranteed `AuthSigner`, or throw
 * `INVALID_CONFIG` (query-only mode). Arg is typed structurally so this module does not depend on
 * `CapabilityCtx` (Plan 4b) — 4b's `CapabilityCtx` satisfies `{ signer?: Signer }`.
 */
export function requireAuthSigner(ctx: {
  readonly signer?: Signer;
}): AuthSigner {
  if (!ctx.signer) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'This operation requires a signer (wallet); the client was created in query-only mode.',
    );
  }
  return ctx.signer;
}
