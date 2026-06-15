import type { CapabilityCtx, EventTransport, QueryCtx } from './ctx.js';
import type { Logger, LogLevel } from './logger.js';
import type { Signer } from './signer.js';
import type { ManifestMCPConfig, WalletProvider } from './types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/** Shared factory inputs. `skuSpecs`/`events`/`logLevel` are accepted but NOT threaded in 4b (see plan OI-BETA). */
interface BaseClientOptions {
  config: ManifestMCPConfig;
  /** Injected at the edge (node: guarded-undici; browser: providerFetch). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-instance logging sink; defaults to the silent `noopLogger`. */
  logger?: Logger;
  /** @beta — carried for the later SDK-side level gate; the gate is NOT built in 4b. */
  logLevel?: LogLevel;
  /** @beta — §5.5 placeholder; not a real core type yet, not threaded in 4b. */
  skuSpecs?: unknown;
  /** @beta — §5.9 forward-declared transport stub; not threaded in 4b. */
  events?: EventTransport;
}

/** @public — inputs to {@link createManifestClient} (full/signing). A `walletProvider` is REQUIRED. */
export interface FullClientOptions extends BaseClientOptions {
  walletProvider: WalletProvider;
}

/** @public — inputs to {@link createManifestReadClient} (query-only). No `walletProvider`. */
export type ReadClientOptions = BaseClientOptions;

/**
 * @public — construct a FULL (signing) Manifest client. ASYNC: awaits the underlying query client once
 * so `client.query` is concrete (the Cosmos await-once-then-read idiom). Throws `INVALID_CONFIG` on bad
 * config or a wallet lacking `signArbitrary` (the latter at first auth use).
 */
export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // Body lands in Task 4. Temporary throw keeps the signature honest under tsc.
  void opts;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    'not implemented',
  );
}

/**
 * @public — construct a QUERY-ONLY Manifest client (no signer/tx/subscribe at the type level). ASYNC.
 */
export async function createManifestReadClient(
  opts: ReadClientOptions,
): Promise<ManifestReadClient> {
  void opts;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    'not implemented',
  );
}

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
