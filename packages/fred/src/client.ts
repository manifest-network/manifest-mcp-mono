import {
  createManifestClient,
  type FullClientOptions,
  type LeaseUuid,
  type ManifestClient,
} from '@manifest-network/manifest-mcp-core';
import {
  type SubscribeLeaseStatusOptions,
  subscribeLeaseStatus,
} from './tools/subscribeLeaseStatus.js';

/** Provider-backed methods layered onto a core ManifestClient by createFredClient. */
export interface FredActions {
  subscribeLeaseStatus(
    leaseUuid: LeaseUuid,
    opts: SubscribeLeaseStatusOptions,
  ): () => void;
}

/** A full Manifest client + the Fred provider methods. */
export type FredClient = ManifestClient & FredActions;

/** The fred-action decorator: thin .bind(ctx) closures over the free fns (viem-style; ctx = the client). */
export function fredActions(ctx: ManifestClient): FredActions {
  return {
    subscribeLeaseStatus: (leaseUuid, opts) =>
      subscribeLeaseStatus(ctx, leaseUuid, opts),
  };
}

/**
 * Create a full app client: core's chain-backed ManifestClient plus the Fred provider methods. The
 * fully-decorated factory lives in fred (not core) because subscribeLeaseStatus hits the Fred backend,
 * not the chain ctx wraps (viem one-client-one-backend rule, #2535). Requires a walletProvider.
 *
 * @remarks
 * Wraps {@link createManifestClient}, so the same shared-config-key caveat applies: each client acquires
 * one reference on a `CosmosClientManager` instance keyed by config (`chainId:rpcUrl[:restUrl]`), and
 * `getInstance` mutates the shared instance — do NOT construct a separate read/full client against a key
 * this client already holds. Always `dispose()` each client; the shared clients tear down only once the
 * last holder disposes.
 */
export async function createFredClient(
  opts: FullClientOptions,
): Promise<FredClient> {
  const client = await createManifestClient(opts);
  // Single Object.assign over the SAME client object (it IS the ctx the actions close over).
  return Object.assign(client, fredActions(client));
}
