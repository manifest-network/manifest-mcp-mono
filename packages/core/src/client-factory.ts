import { CosmosClientManager } from './client.js';
import { createValidatedConfig } from './config.js';
import type { CapabilityCtx, EventTransport, QueryCtx } from './ctx.js';
import type { Logger, LogLevel } from './logger.js';
import { noopLogger } from './logger.js';
import type { Signer } from './signer.js';
import { createSignerAdapter } from './signer.js';
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
 * A `WalletProvider` for query-only clients. `getInstance` requires a wallet even in query-only mode, but
 * queries never sign — so this stub is stored and never invoked. Every signing accessor REJECTS with
 * `INVALID_CONFIG` (a rejected promise, NOT a sync throw — the methods are `Promise`-returning, so a
 * consumer's `await wallet.getSigner()` must see a rejection) as a hard backstop. `signArbitrary` is
 * included (optional on `WalletProvider`) so the stub fails closed there too.
 */
function queryOnlyWalletStub(): WalletProvider {
  const fail = (): Promise<never> =>
    Promise.reject(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'This client was created in query-only mode (createManifestReadClient) and cannot sign or broadcast. Use createManifestClient with a walletProvider for transactions.',
      ),
    );
  return { getAddress: fail, getSigner: fail, signArbitrary: fail };
}

/**
 * Shared ctx builder. Returns the base `ManifestReadClient` (ctx fields + `dispose`); the full factory
 * up-casts to `ManifestClient` (sound — `withSigner=true` ⇒ a defined signer). NOTE (cross-ctx hazard,
 * OI-DISPOSE): `getInstance` mutates the shared instance for a given config key, so do not construct a
 * read client (wallet stub) against a key a full client already holds — the common case is safe because
 * read configs omit `rpcUrl` → a different key.
 */
async function buildClient(
  opts: BaseClientOptions,
  walletProvider: WalletProvider,
  withSigner: boolean,
): Promise<ManifestReadClient> {
  const config = createValidatedConfig(opts.config); // throws INVALID_CONFIG before any instance is keyed
  const chain = CosmosClientManager.getInstance(config, walletProvider); // ONCE; acquires one refCount
  try {
    const signer = withSigner
      ? createSignerAdapter(walletProvider, config.addressPrefix) // config.addressPrefix defaulted in createConfig
      : undefined;
    // NEUTRAL fetch resolution — never import the node-only guarded fetch (ENG-281 browser-bundle hazard).
    // The node/fred edge injects the guarded fetch via opts.fetch; default to the platform global.
    const fetch = opts.fetch ?? globalThis.fetch;
    const logger = opts.logger ?? noopLogger;
    chain.setLogger(logger); // route the manager's 2 init diagnostics to the per-ctx logger (OI-LOG)
    // Await the query client ONCE so ctx.query is concrete (the await-once-then-read Cosmos idiom).
    const query = await chain.getQueryClient();

    // dispose: balance the single getInstance refCount; idempotent so a double-dispose is safe.
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      chain.disconnect();
    };

    // In query-only mode OMIT the signer key entirely (so `'signer' in client` is false — the runtime
    // matches the read type) rather than carrying `signer: undefined`. 4d binds the read/tx action
    // methods over this ctx; 4b returns the ctx + dispose shell. Structurally a ManifestReadClient; the
    // full factory up-casts to ManifestClient.
    const base = { chain, query, fetch, logger, dispose };
    const client = signer ? { ...base, signer } : base;
    return client as ManifestReadClient;
  } catch (err) {
    // getQueryClient (or signer construction) failed AFTER getInstance acquired the refCount, and the
    // caller never received a `dispose()` handle. Release the acquire once so a construction failure does
    // not leak a phantom holder (OI-DISPOSE failure path), then re-throw.
    chain.disconnect();
    throw err;
  }
}

export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // withSigner=true → the returned client always has a defined signer, so the up-cast to the
  // required-signer ManifestClient is sound (mirrors SigningStargateClient.connectWithSigner's subtype).
  return (await buildClient(opts, opts.walletProvider, true)) as ManifestClient;
}

export async function createManifestReadClient(
  opts: ReadClientOptions,
): Promise<ManifestReadClient> {
  return buildClient(opts, queryOnlyWalletStub(), false);
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
