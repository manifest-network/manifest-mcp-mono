import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type { Logger } from './logger.js';
import type { Signer } from './signer.js';

/**
 * @beta — DEFERRED (§5.9). The WS transport + `subscribeLeaseStatus`'s push path land in a later
 * phase (poll-backed in P0). Forward-declared as an opaque stub so `CapabilityCtx` compiles without
 * the transport; absent `events` ⇒ poll fallback.
 */
export interface EventTransport {
  /** @beta — intentionally-empty placeholder; the real shape is defined when the §5.9 transport lands. */
  readonly __beta?: never;
}

/**
 * @public — the capability bundle every SDK action consumes (spec §5.2). Exactly 6 fields.
 *
 * `chain` is the keyed-singleton `CosmosClientManager` (NOT a `SigningStargateClient`): the cosmjs
 * drop-down is the async `chain.getSigningClient()`, and `chain.getQueryClient()` is the async/lazy
 * query accessor. `query` holds the concrete `ManifestQueryClient` the factory awaited ONCE at
 * construction (so raw-typed reads `ctx.query.<module>.<service>(...)` need no per-read await). In
 * REST mode a read over an LCD-unsupported module (`cosmos.orm`, `liftedinit.manifest`) throws
 * `UNSUPPORTED_QUERY` synchronously (the lcd-adapter proxy). `signer` (§5.3) is present in full mode
 * only. `fetch` is injected (guarded-undici at the node edge, providerFetch in browser; the factory
 * defaults it to `globalThis.fetch`). `logger` defaults to the frozen `noopLogger` (silent).
 */
export interface CapabilityCtx {
  readonly chain: CosmosClientManager;
  readonly query: ManifestQueryClient;
  readonly signer?: Signer;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: Logger;
  readonly events?: EventTransport;
}

/** @public — query-only capability subset; only `signer` drops (spec §5.2). */
export type QueryCtx = Omit<CapabilityCtx, 'signer'>;

/** @public — the read-path ISP slice (spec §5.4): the typed reads take only query+chain+logger (no signer/fetch). */
export type ReadCtx = Pick<CapabilityCtx, 'query' | 'chain' | 'logger'>;

/**
 * @public — the tx-path ISP slice (spec §5.5): txs take chain+signer+logger (no query/fetch).
 * NOTE: 4c-txs does NOT consume `ctx.signer` — the wallet AND the query-only INVALID_CONFIG guard
 * come from `ctx.chain` (via getSigningClient). `signer?` (optional) is reserved for 4d's per-signer
 * broadcast mutex; do not call requireAuthSigner here (it would throw on the signer-less ctx the call sites build).
 */
export type TxCtx = Pick<CapabilityCtx, 'chain' | 'signer' | 'logger'>;
