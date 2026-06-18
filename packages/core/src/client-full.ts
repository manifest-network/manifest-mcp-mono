import {
  type BoundFn,
  buildClient,
  type FullClientOptions,
  type ManifestReadClient,
  type TailOf,
} from './client-factory.js';
import type { CapabilityCtx } from './ctx.js';
import type { Signer } from './signer.js';
import { executeTx } from './tools/executeTx.js';
import { fundCredits } from './tools/fundCredits.js';
import { setItemCustomDomain } from './tools/setItemCustomDomain.js';
import { stopApp } from './tools/stopApp.js';

/**
 * @public — full bound client: ManifestReadClient + the on-chain tx methods + executeTx, with a
 * REQUIRED signer (the read-vs-full type guarantee). Provider methods (subscribeLeaseStatus) are NOT
 * here — they hit the Fred backend; see fred's createFredClient (viem one-client-one-backend rule).
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
  fundCredits: BoundFn<typeof fundCredits>;
  setItemCustomDomain: BoundFn<typeof setItemCustomDomain>;
  stopApp: BoundFn<typeof stopApp>;
  executeTx: BoundFn<typeof executeTx>;
}

/**
 * @public — construct a full (signing) {@link ManifestClient}. Requires a `walletProvider`.
 *
 * @remarks
 * Each client acquires one reference on a `CosmosClientManager` instance keyed by config
 * (`chainId:rpcUrl[:restUrl]`). Clients sharing a config key share that one underlying instance, and
 * `getInstance` mutates it — so do NOT construct a separate read/full client against a config key this
 * client already holds. Always `dispose()` each client; the shared clients tear down only once the last
 * holder disposes.
 */
export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // buildClient (withSigner=true) returns the read-bound, signer-carrying shell.
  const client = (await buildClient(
    opts,
    opts.walletProvider,
    true,
  )) as ManifestClient;
  // Layer the tx + executeTx methods over the SAME object (Q6 single Object.assign over final const).
  Object.assign(client, {
    fundCredits: (...a: TailOf<typeof fundCredits>) =>
      fundCredits(client, ...a),
    setItemCustomDomain: (...a: TailOf<typeof setItemCustomDomain>) =>
      setItemCustomDomain(client, ...a),
    stopApp: (...a: TailOf<typeof stopApp>) => stopApp(client, ...a),
    executeTx: (...a: TailOf<typeof executeTx>) => executeTx(client, ...a),
  });
  return client;
}
