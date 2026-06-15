import type { CapabilityCtx, QueryCtx } from './ctx.js';
import type { Signer } from './signer.js';

/**
 * @public — query-only bound client. EXTENDS `QueryCtx`, so NO `signer`/tx/subscribe at the TYPE level
 * (the viem Public Client invariant; cosmjs `StargateClient`). The bound READ action methods are added
 * in Plan 4c/4d; 4b declares only the ctx extension + lifecycle. `client.query`/`client.chain` are honest
 * Telescope/cosmjs drop-downs.
 */
export interface ManifestReadClient extends QueryCtx {
  /**
   * Release this client's share of the underlying keyed `CosmosClientManager` (balances the single
   * `getInstance` refCount the factory acquired). Idempotent. Implemented in 4b; the manager tears the
   * shared clients down only once the last holder disposes.
   */
  dispose(): void;
}

/**
 * @public — full bound client. Strict SUPERSET of `ManifestReadClient` (mirrors cosmjs
 * `SigningStargateClient extends StargateClient`) AND a `CapabilityCtx`, so a full client is usable
 * anywhere a read client OR a ctx is expected. The bound TX/provider action methods + `executeTx` +
 * `subscribeLeaseStatus` + the per-signer broadcast mutex are added in Plan 4d.
 */
export interface ManifestClient extends ManifestReadClient, CapabilityCtx {
  /**
   * Full clients ALWAYS carry a signer (`createManifestClient` requires a `walletProvider`) — NARROWED
   * from `CapabilityCtx`'s optional `signer?` to REQUIRED. This is what makes a `ManifestReadClient`
   * NOT assignable to a `ManifestClient` at the type level (the read-vs-full guarantee; mirrors viem's
   * required write surface). `CapabilityCtx.signer` itself stays optional — the spine fns take a ctx and
   * narrow via `requireAuthSigner`.
   */
  readonly signer: Signer;
}
