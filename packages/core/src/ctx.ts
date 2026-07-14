import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type { Logger } from './logger.js';
import type { Signer } from './signer.js';

/**
 * @beta — the injected WebSocket seam, mirroring the `fetch` seam. `ctx.events` (optional) lets a
 * push-based surface (`waitForLeaseStatus`) transparently upgrade from polling to a provider WebSocket;
 * absent ⇒ poll fallback. The SSRF-guarded, `ws`-backed NODE default lives behind
 * `@manifest-network/manifest-mcp-core/events-node` (`createNodeEventTransport`); a browser consumer
 * injects a native-`WebSocket`-backed transport. `open()` establishes ONE connection — reconnection,
 * backoff, liveness and poll-fallback live in the consumer (fred's lease-status driver), NOT here.
 */
export interface EventTransport {
  /**
   * Open a WebSocket to `url` and return a live socket handle. Auth is carried IN the URL (Fred uses a
   * `?token=` query param — WebSocket clients cannot set request headers). @beta
   */
  open(url: string): EventSocket;
}

/**
 * @beta — a minimal, normalized WebSocket handle that adapts both the node `ws` client and the browser
 * `WebSocket`. Listeners are registered once, before or right after `open()`.
 */
export interface EventSocket {
  /** Handler for each inbound text frame (raw UTF-8 string, typically JSON). */
  onMessage(listener: (data: string) => void): void;
  /** Handler for the connection becoming open. */
  onOpen(listener: () => void): void;
  /** Handler for the connection closing — WS close `code` + `reason`. Fires at most once. */
  onClose(listener: (code: number, reason: string) => void): void;
  /** Handler for a connection/transport error. */
  onError(listener: (err: Error) => void): void;
  /** Close the connection (optional WS close `code`). Idempotent. */
  close(code?: number): void;
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
 * NOTE: 4c/4d do NOT consume `ctx.signer` for on-chain txs — the wallet AND the query-only
 * INVALID_CONFIG guard come from `ctx.chain` (via getSigningClient), and 4d's per-signer broadcast
 * mutex keys off the resolved CHAIN ADDRESS (ctx.chain.getAddress()), NOT ctx.signer. `signer?` is
 * carried for the full client's required-signer narrowing + provider ops (waitForLeaseStatus); do
 * not call requireAuthSigner on the signer-less ctx the on-chain tx call sites build.
 */
export type TxCtx = Pick<CapabilityCtx, 'chain' | 'signer' | 'logger'>;
