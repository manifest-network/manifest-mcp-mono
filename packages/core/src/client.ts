import { Registry } from '@cosmjs/proto-signing';
import {
  AminoTypes,
  GasPrice,
  type HttpEndpoint,
  SigningStargateClient,
} from '@cosmjs/stargate';
import {
  cosmosAminoConverters,
  cosmosProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/client.js';
import { cosmwasm as cosmwasmNs } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js';
import {
  cosmwasmAminoConverters,
  cosmwasmProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/cosmwasm/client.js';
import { ibc as ibcNs } from '@manifest-network/manifestjs/dist/codegen/ibc/bundle.js';
import {
  ibcAminoConverters,
  ibcProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/ibc/client.js';
import { liftedinit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js';
import {
  liftedinitAminoConverters,
  liftedinitProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/client.js';
import { osmosis as osmosisNs } from '@manifest-network/manifestjs/dist/codegen/osmosis/bundle.js';
import {
  osmosisAminoConverters,
  osmosisProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/osmosis/client.js';
import { strangelove_ventures as strangeloveVenturesNs } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/bundle.js';
import {
  strangeloveVenturesAminoConverters,
  strangeloveVenturesProtoRegistry,
} from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/client.js';
import { RateLimiter } from 'limiter';
import {
  DEFAULT_GAS_MULTIPLIER,
  DEFAULT_REQUESTS_PER_SECOND,
} from './config.js';
import { verifyRestChainIdentity } from './internals/chain-identity.js';
import {
  type SequenceCache,
  sequencedSigningClient,
} from './internals/tx-sequence.js';
import { createLCDQueryClient } from './lcd-adapter.js';
import { type Logger, noopLogger } from './logger.js';
import type { ManifestQueryClient } from './manifest-query-client.js';
import { abortableSleep, abortReason } from './options.js';
import { withRetry } from './retry.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';

export type { ManifestQueryClient } from './manifest-query-client.js';

/**
 * Extract the registry type expected by SigningStargateClient.connectWithSigner.
 *
 * The Registry type from @cosmjs/proto-signing doesn't perfectly match the registry type
 * in SigningStargateClientOptions due to telescope-generated proto types. This type alias
 * extracts the expected registry type from the function signature to enable type-safe casting.
 */
type SigningClientRegistry = Parameters<
  typeof SigningStargateClient.connectWithSigner
>[2] extends { registry?: infer R }
  ? R
  : never;

/** Default timeout for transaction broadcast (60 seconds) */
const DEFAULT_BROADCAST_TIMEOUT_MS = 60_000;

/** Default polling interval for transaction confirmation (3 seconds) */
const DEFAULT_BROADCAST_POLL_INTERVAL_MS = 3_000;

/** Poll for an available rate-limit token; abort-aware sleep rejects immediately on cancellation. */
const RATE_LIMIT_POLL_MS = 25;

/**
 * Get combined signing client options with all Manifest registries
 */
function getSigningManifestClientOptions() {
  const registry = new Registry([
    ...cosmosProtoRegistry,
    ...liftedinitProtoRegistry,
    ...strangeloveVenturesProtoRegistry,
    ...osmosisProtoRegistry,
    ...cosmwasmProtoRegistry,
    ...ibcProtoRegistry,
  ]);

  const aminoTypes = new AminoTypes({
    ...cosmosAminoConverters,
    ...liftedinitAminoConverters,
    ...strangeloveVenturesAminoConverters,
    ...osmosisAminoConverters,
    ...cosmwasmAminoConverters,
    ...ibcAminoConverters,
  });

  return { registry, aminoTypes };
}

/** Only account sequencing is shared between independently configured clients. */
interface ChainCoordination {
  readonly locks: Map<string, Promise<unknown>>;
  readonly sequences: SequenceCache;
  managers: number;
}

/** A stable, owned snapshot: caller mutations cannot change an approved transaction's policy. */
function snapshotConfig(config: ManifestMCPConfig): ManifestMCPConfig {
  return Object.freeze({
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    restUrl: config.restUrl,
    addressPrefix: config.addressPrefix,
    gasPrice: config.gasPrice,
    gasMultiplier: config.gasMultiplier,
    maxGas: config.maxGas,
    rateLimit:
      config.rateLimit &&
      Object.freeze({
        requestsPerSecond: config.rateLimit.requestsPerSecond,
      }),
    retry:
      config.retry &&
      Object.freeze({
        maxRetries: config.retry.maxRetries,
        baseDelayMs: config.retry.baseDelayMs,
        maxDelayMs: config.retry.maxDelayMs,
      }),
  } satisfies Record<keyof ManifestMCPConfig, unknown>);
}

/** Lazy clients shared only by holders with the same wallet and transaction policy. */
export class CosmosClientManager {
  private static instances: Map<string, CosmosClientManager> = new Map();
  private static readonly walletIds = new WeakMap<WalletProvider, number>();
  private static nextWalletId = 0;
  private static readonly fetchIds = new WeakMap<
    typeof globalThis.fetch,
    number
  >();
  private static nextFetchId = 0;
  private static readonly chainCoordination = new Map<
    string,
    ChainCoordination
  >();

  /** Registry key used to evict this manager when its final holder releases it. */
  private readonly instanceKey: string;
  private readonly config: ManifestMCPConfig;
  private readonly walletProvider: WalletProvider;
  private readonly coordination: ChainCoordination;
  private coordinationReleased = false;
  private queryClient: ManifestQueryClient | null = null;
  private signingClient: SigningStargateClient | null = null;
  private readonly rateLimiter: RateLimiter;

  // Shared by chain ID and then signer address, including across wallets and RPC endpoints.
  private readonly broadcastLocks: Map<string, Promise<unknown>>;
  private readonly txSequenceCache: SequenceCache;
  private readonly pendingBroadcasts = new Set<Promise<unknown>>();

  /** Per-instance logger for the 3 init-time diagnostics. Defaults to noopLogger (silent); see setLogger. */
  private logger: Logger = noopLogger;

  // Number of live holders (servers) sharing this instance. Each getInstance
  // acquisition increments it; each disconnect() decrements it. The underlying
  // clients are only torn down once the count reaches zero (the last holder
  // disconnects), so one server's shutdown can't sever another's shared client.
  private refCount = 0;

  // Keep compatible holders reusable while this manager's accepted broadcast work drains.
  private pendingRelease: Promise<void> | null = null;

  // Promises to prevent concurrent client initialization (lazy init race condition)
  private queryClientPromise: Promise<ManifestQueryClient> | null = null;
  private signingClientPromise: Promise<SigningStargateClient> | null = null;

  private constructor(
    config: ManifestMCPConfig,
    walletProvider: WalletProvider,
    instanceKey: string,
    private readonly fetchFn: typeof globalThis.fetch,
  ) {
    this.instanceKey = instanceKey;
    this.config = config;
    this.walletProvider = walletProvider;
    let coordination = CosmosClientManager.chainCoordination.get(
      config.chainId,
    );
    if (!coordination) {
      coordination = { locks: new Map(), sequences: new Map(), managers: 0 };
      CosmosClientManager.chainCoordination.set(config.chainId, coordination);
    }
    coordination.managers += 1;
    this.coordination = coordination;
    this.broadcastLocks = coordination.locks;
    this.txSequenceCache = coordination.sequences;

    // Initialize rate limiter with configured or default requests per second
    const requestsPerSecond =
      config.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: requestsPerSecond,
      interval: 'second',
    });
  }

  /**
   * Acquire a manager for this wallet reference and immutable configuration snapshot.
   * Compatible sibling servers share clients; a different wallet or policy gets an independent
   * manager. Constructing another client never reconfigures existing holders. Broadcast locks and
   * pending account sequences remain shared across every manager for the same chain ID.
   * The optional fetch transport only verifies REST node-info; it does not serve provider or LCD requests.
   * Balance each acquisition with one disconnect(), including repeated compatible acquisitions.
   */
  static getInstance(
    config: ManifestMCPConfig,
    walletProvider: WalletProvider,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): CosmosClientManager {
    let walletId = CosmosClientManager.walletIds.get(walletProvider);
    if (walletId === undefined) {
      walletId = CosmosClientManager.nextWalletId++;
      CosmosClientManager.walletIds.set(walletProvider, walletId);
    }
    let fetchId = CosmosClientManager.fetchIds.get(fetchFn);
    if (fetchId === undefined) {
      fetchId = CosmosClientManager.nextFetchId++;
      CosmosClientManager.fetchIds.set(fetchFn, fetchId);
    }
    const snapshot = snapshotConfig(config);
    const key = JSON.stringify([walletId, fetchId, snapshot]);
    let instance = CosmosClientManager.instances.get(key);
    if (!instance) {
      instance = new CosmosClientManager(
        snapshot,
        walletProvider,
        key,
        fetchFn,
      );
      CosmosClientManager.instances.set(key, instance);
    }
    instance.refCount += 1;
    return instance;
  }

  /**
   * Clear all cached instances (useful for testing or reconnection).
   * Force-tears-down each instance regardless of its refCount — clearing the
   * registry is an unconditional reset, so it ignores outstanding holders,
   * disconnects signing clients, releases query client references, and resets
   * refCount to zero before clearing.
   */
  static clearInstances(): void {
    for (const instance of CosmosClientManager.instances.values()) {
      // Force teardown regardless of refCount — clearing the registry is an
      // unconditional reset (used by tests/reconnection), so drop all holders.
      instance.teardown();
      instance.refCount = 0;
    }
    CosmosClientManager.instances.clear();
    CosmosClientManager.chainCoordination.clear();
  }

  /**
   * Get the manifestjs RPC query client with all module extensions
   *
   * Automatically retries on transient connection failures with exponential backoff —
   * so callers MUST NOT wrap this call in another `withRetry`. The ladders multiply,
   * and the RPC branch builds five namespace clients per attempt (ENG-679).
   */
  async getQueryClient(): Promise<ManifestQueryClient> {
    // Return cached client if available
    if (this.queryClient) {
      return this.queryClient;
    }

    // If initialization is already in progress, wait for it
    if (this.queryClientPromise) {
      return this.queryClientPromise;
    }

    // ENG-636: build the init promise from a SEPARATE call and do the cache bookkeeping in
    // `.then` handlers, so the identity guard compares against the promise that is actually
    // stored. The previous self-referencing async IIFE captured `this.queryClientPromise` in
    // its SYNCHRONOUS prologue — i.e. before the assignment landed, and the early return above
    // proves the field is null at that instant — so the capture was always null, every guard
    // was permanently false, and one transient failure latched a rejected promise for the
    // process lifetime.
    //
    // Do NOT "simplify" this back to an IIFE that references a `const p`: that body's prologue
    // — and, on the neither-restUrl-nor-rpcUrl branch, its catch — runs in the SAME tick as the
    // `const p` initializer, so the reference hits the temporal dead zone and throws
    // `ReferenceError: Cannot access 'p' before initialization` instead of the INVALID_CONFIG
    // this method promises. `.then` callbacks can only run in a later microtask, so they are
    // TDZ-safe by construction.
    //
    // The explicit annotation on `p` is required: a `const` referenced inside its own
    // initializer is otherwise implicitly `any` (TS7022).
    const p: Promise<ManifestQueryClient> = this.initQueryClient().then(
      (client) => {
        // Promote to the object cache only while this init is still the active one. A
        // teardown/disconnect that landed mid-flight already nulled the slot, and a newer init
        // may already own it — a stale handler must never clobber that newer state.
        if (this.queryClientPromise === p) {
          this.queryClient = client;
          this.queryClientPromise = null;
        }
        // A superseded query client is still handed to its caller: the query transport is
        // stateless HTTP with nothing to release (see teardown), so being superseded only means
        // "not cached". The signing path differs — it owns a live transport.
        return client;
      },
      (error: unknown) => {
        // Clear the slot on failure so the next caller retries instead of re-awaiting a latched
        // rejection (the ENG-636 headline defect) — again only while still active.
        if (this.queryClientPromise === p) {
          this.queryClientPromise = null;
        }
        throw error;
      },
    );
    this.queryClientPromise = p;
    return p;
  }

  /**
   * Construct a query client. Pure construction + error normalization — caching, dedup and
   * supersede bookkeeping belong to {@link getQueryClient}. Kept as a separate method (NOT an
   * IIFE) so nothing in here can reference the promise being cached (ENG-636).
   */
  private async initQueryClient(): Promise<ManifestQueryClient> {
    try {
      let client: ManifestQueryClient;
      if (this.config.restUrl) {
        // Use LCD/REST for queries when restUrl is configured
        client = await withRetry(
          async () => {
            await verifyRestChainIdentity(
              this.config.restUrl!,
              this.config.chainId,
              this.fetchFn,
            );
            return createLCDQueryClient(this.config.restUrl!, this.logger);
          },
          {
            config: this.config.retry,
            operationName: 'connect LCD query client',
          },
        );
      } else if (this.config.rpcUrl) {
        // Use RPC: merge liftedinit + cosmwasm + strangelove_ventures + osmosis + ibc namespaces
        client = await withRetry(
          async () => {
            const [
              liftedinitClient,
              cosmwasmClient,
              strangeloveClient,
              osmosisClient,
              ibcClient,
            ] = await Promise.all([
              liftedinit.ClientFactory.createRPCQueryClient({
                rpcEndpoint: this.config.rpcUrl!,
              }),
              cosmwasmNs.ClientFactory.createRPCQueryClient({
                rpcEndpoint: this.config.rpcUrl!,
              }),
              strangeloveVenturesNs.ClientFactory.createRPCQueryClient({
                rpcEndpoint: this.config.rpcUrl!,
              }),
              osmosisNs.ClientFactory.createRPCQueryClient({
                rpcEndpoint: this.config.rpcUrl!,
              }),
              ibcNs.ClientFactory.createRPCQueryClient({
                rpcEndpoint: this.config.rpcUrl!,
              }),
            ]);
            return {
              ...liftedinitClient,
              cosmwasm: cosmwasmClient.cosmwasm,
              strangelove_ventures: strangeloveClient.strangelove_ventures,
              osmosis: osmosisClient.osmosis,
              ibc: ibcClient.ibc,
            } as ManifestQueryClient;
          },
          {
            config: this.config.retry,
            operationName: 'connect query client',
          },
        );
      } else {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Cannot create query client: neither restUrl nor rpcUrl is configured.',
        );
      }
      return client;
    } catch (error) {
      if (error instanceof ManifestMCPError) {
        throw error;
      }
      const endpoint = this.config.restUrl ?? this.config.rpcUrl;
      throw new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        `Failed to connect to ${this.config.restUrl ? 'REST' : 'RPC'} endpoint: ${error instanceof Error ? error.message : String(error)}`,
        { url: endpoint },
      );
    }
  }

  /**
   * Get a signing client with all Manifest registries (for transactions)
   *
   * Automatically retries on transient connection failures with exponential backoff —
   * so callers MUST NOT wrap this call in another `withRetry` (ENG-679; see
   * {@link getQueryClient}).
   */
  async getSigningClient(): Promise<SigningStargateClient> {
    this.assertActive();
    if (!this.config.rpcUrl || !this.config.gasPrice) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Signing client requires rpcUrl and gasPrice configuration. Current config is query-only (REST).',
      );
    }

    // Return cached client if available
    if (this.signingClient) {
      return this.signingClient;
    }

    // If initialization is already in progress, wait for it
    if (this.signingClientPromise) {
      return this.signingClientPromise;
    }

    // ENG-636 — see getQueryClient for why the bookkeeping lives in `.then` handlers over a
    // separately-called init method rather than in a self-referencing async IIFE.
    const p: Promise<SigningStargateClient> = this.initSigningClient().then(
      (client) => {
        if (this.signingClientPromise === p) {
          this.signingClient = client;
          this.signingClientPromise = null;
          return client;
        }
        // A disconnect or forced reset superseded this initialization. Release its live transport
        // and refuse to expose an orphan signing client, including on WebSocket endpoints.
        try {
          client.disconnect();
        } catch (err) {
          // A failing orphan cleanup must never mask the supersede error below.
          this.logger.debug(
            `orphaned signing client disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          'Signing client initialization was superseded by a disconnect before it completed. Retry with a live client.',
          { rpcUrl: this.config.rpcUrl, reason: 'superseded' },
        );
      },
      (error: unknown) => {
        if (this.signingClientPromise === p) {
          this.signingClientPromise = null;
        }
        throw error;
      },
    );
    this.signingClientPromise = p;
    return p;
  }

  /**
   * Construct a signing client. Pure construction + error normalization — caching, dedup and
   * supersede bookkeeping belong to {@link getSigningClient}. In particular the supersede error
   * is thrown from the accessor, NOT here, so it cannot be re-wrapped by the catch below.
   */
  private async initSigningClient(): Promise<SigningStargateClient> {
    try {
      // Query and signing endpoints must agree. Read clients run the same REST identity check.
      if (this.config.restUrl) await this.getQueryClient();
      const signer = await this.walletProvider.getSigner();
      const gasPrice = GasPrice.fromString(this.config.gasPrice!);
      const { registry, aminoTypes } = getSigningManifestClientOptions();

      // Configure endpoint as HttpEndpoint object (required for custom options)
      const endpoint: HttpEndpoint = {
        url: this.config.rpcUrl!,
        headers: {},
      };

      // Note: Registry type from @cosmjs/proto-signing doesn't perfectly match
      // SigningStargateClientOptions due to telescope-generated proto types.
      // This is a known limitation with custom cosmos-sdk module registries.
      // Wrap with retry for transient connection failures
      const client = await withRetry(
        async () => {
          const c = await SigningStargateClient.connectWithSigner(
            endpoint,
            signer,
            {
              registry: registry as SigningClientRegistry,
              aminoTypes,
              gasPrice,
              broadcastTimeoutMs: DEFAULT_BROADCAST_TIMEOUT_MS,
              broadcastPollIntervalMs: DEFAULT_BROADCAST_POLL_INTERVAL_MS,
            },
          );
          try {
            const actualChainId = await c.getChainId();
            if (actualChainId !== this.config.chainId) {
              throw new ManifestMCPError(
                ManifestMCPErrorCode.INVALID_CONFIG,
                'RPC chain identity does not match the configured chainId.',
                {
                  expectedChainId: this.config.chainId,
                  actualChainId,
                  rpcUrl: this.config.rpcUrl,
                },
              );
            }
          } catch (error) {
            // A failed identity read must not leak a connected client or make it usable for signing.
            try {
              c.disconnect();
            } catch {
              /* Preserve the identity failure. */
            }
            throw error;
          }
          // The property is private readonly with no constructor option,
          // so we must bypass TypeScript's access control to override it.
          const record = c as unknown as Record<string, unknown>;
          if (typeof record.defaultGasMultiplier === 'number') {
            record.defaultGasMultiplier =
              this.config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER;
          } else {
            const effective =
              this.config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER;
            this.logger.warn(
              `gasMultiplier ${effective} could not be applied: ` +
                `signing client defaultGasMultiplier is ${typeof record.defaultGasMultiplier}, expected number. ` +
                `Transactions will use the CosmJS built-in gas multiplier instead.`,
            );
          }
          return c;
        },
        {
          config: this.config.retry,
          operationName: 'connect signing client',
        },
      );
      return client;
    } catch (error) {
      if (error instanceof ManifestMCPError) {
        throw error;
      }
      throw new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        `Failed to connect signing client: ${error instanceof Error ? error.message : String(error)}`,
        { rpcUrl: this.config.rpcUrl },
      );
    }
  }

  /**
   * Get a signing client for BROADCASTING that manages the signer's sequence locally for non-blocking
   * (SYNC) broadcasts, so a burst of `waitForConfirmation:false` txs from one signer uses consecutive
   * sequences instead of all re-reading the pre-inclusion committed sequence and colliding
   * (`account sequence mismatch`). The blocking path is unchanged for the common case (no in-flight sync
   * tx). Callers MUST hold {@link withBroadcastLock} for the signer around the broadcast (cosmosTx does),
   * so the per-signer counter is only touched serially. Non-broadcast methods delegate to the raw client.
   */
  async getBroadcastClient(): Promise<SigningStargateClient> {
    return sequencedSigningClient(
      await this.getSigningClient(),
      this.txSequenceCache,
    );
  }

  /**
   * Get the wallet address
   */
  async getAddress(): Promise<string> {
    return this.walletProvider.getAddress();
  }

  /**
   * Get this manager's frozen, owned configuration snapshot.
   */
  getConfig(): ManifestMCPConfig {
    return this.config;
  }

  /**
   * Set the sink for cached-client initialization diagnostics. Compatible sibling servers share
   * this sink; callers needing independent diagnostics can use distinct wallet-provider adapters.
   * Logging does not change the immutable wallet/configuration or invalidate a connection.
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Acquire a rate limit token before making an RPC request.
   * This will wait if the rate limit has been exceeded.
   *
   * Pass `signal` to make that wait CANCELLABLE (ENG-710). This is the one blocking wait the
   * SDK actually owns — the RPC underneath it takes no `AbortSignal` — and without a signal an
   * abort is invisible until the token arrives: measured at t+3004ms for a cancel issued at
   * t+100ms on a 3s limiter, which then still consumed the token it immediately discarded.
   * The MCP spec asks a receiver of a cancellation to stop processing and free resources.
   *
   * Rejects with the caller's own abort reason (the read/transport convention — see
   * {@link abortReason}), never a wrapper, so a cancel stays unrecognizable to every retry
   * classifier by construction.
   *
   * MECHANISM. `limiter`'s `removeTokens` exposes no cancellation and cannot be raced usefully:
   * the abandoned promise still resolves later and still consumes a token (its own issue #33,
   * "cancel removeTokens()", is open with the internal timer id unreachable). So the signal
   * path polls the SYNCHRONOUS `tryRemoveTokens`, which consumes nothing when it declines —
   * the cancelled acquisition therefore leaves the budget untouched, which is the invariant
   * Go's `x/time/rate` reaches by refunding a cancelled `Reservation`, only without the refund.
   * The no-signal path keeps `removeTokens` as its wait, so the ~20 call sites that pass no
   * signal are timing-identical. Measured equivalent regardless: 4 sequential acquires at
   * rps=2 take 1004ms both ways.
   */
  async acquireRateLimit(signal?: AbortSignal): Promise<void> {
    this.assertBudgetAdmitsOneToken();
    if (signal === undefined) {
      await this.rateLimiter.removeTokens(1);
      return;
    }
    if (signal.aborted) throw abortReason(signal);
    while (true) {
      if (this.rateLimiter.tryRemoveTokens(1)) return;
      await abortableSleep(RATE_LIMIT_POLL_MS, signal);
    }
  }

  /**
   * Fail fast when the configured budget cannot admit a single request. `tryRemoveTokens(1)`
   * declines FOREVER below one token where `removeTokens` throws, so the poll path needs this
   * to keep the two acquisition paths reporting the same misconfiguration the same way —
   * typed and non-retryable rather than a hang on one side and a vendored library's wording on
   * the other. It agrees with `validateConfig`, which already rejects a non-positive-integer
   * `requestsPerSecond`; `getInstance` takes an UNVALIDATED config and is on the public SDK
   * barrel, which is how such a value gets here at all.
   */
  private assertBudgetAdmitsOneToken(): void {
    const { bucketSize } = this.rateLimiter.tokenBucket;
    if (bucketSize < 1) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `rateLimit.requestsPerSecond must be at least 1, got ${bucketSize}; a single request cannot fit the budget.`,
      );
    }
  }

  /**
   * Serialize an async fn against all other broadcasts for `address`, holding the lock until `fn`
   * settles (success OR failure). The next waiter chains off the prior settlement regardless of
   * outcome, so a rejected broadcast neither wedges the queue nor leaks an unhandledRejection.
   * Orthogonal to the rate limiter: callers acquire THIS (outer), then acquireRateLimit (inner).
   * Acquire ONCE per logical broadcast — NOT inside a withRetry attempt (re-acquiring the same key
   * deadlocks); a transient retry re-broadcasts under the same held lock, which is correct for
   * sequence safety.
   */
  async withBroadcastLock<T>(
    address: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    const prev = this.broadcastLocks.get(address) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior task's outcome
    // Store a swallowed tail so the next waiter chains cleanly and no unhandledRejection escapes.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.broadcastLocks.set(address, tail);
    this.pendingBroadcasts.add(tail);
    // Release the entry once this chain drains, so the map stays bounded to
    // in-flight chains — a long-lived manager broadcasting from many distinct
    // addresses would otherwise grow it without bound (code-review PR #102 +
    // Copilot). Delete only if no newer broadcast has replaced this tail.
    void tail.then(() => {
      this.pendingBroadcasts.delete(tail);
      if (this.broadcastLocks.get(address) === tail) {
        this.broadcastLocks.delete(address);
      }
    });
    return run;
  }

  /**
   * Release this holder's reference to the shared instance. The underlying
   * clients are only torn down once the last holder disconnects (refCount
   * reaches zero), so one server's shutdown cannot sever a client still in
   * use by another server sharing the same config key. Calling disconnect()
   * more times than getInstance() was called is safe and never drives the
   * count negative.
   */
  disconnect(): void {
    void this.releaseReference();
  }

  /**
   * Release this holder and resolve after any already-queued broadcasts have
   * drained and final teardown has completed. CLI shutdown uses this form so
   * transport cancellation cannot sever a transaction or its compensation
   * path halfway through. Reacquisition during the drain cancels teardown and
   * continues to share this manager.
   */
  disconnectWhenIdle(): Promise<void> {
    return this.releaseReference();
  }

  private releaseReference(): Promise<void> {
    if (this.refCount === 0) {
      return this.pendingRelease ?? Promise.resolve();
    }

    this.refCount -= 1;
    if (this.refCount > 0) return Promise.resolve();

    // Preserve the historical synchronous teardown behavior when there is no
    // broadcast work to drain.
    if (this.pendingBroadcasts.size === 0) {
      this.finalizeRelease();
      return Promise.resolve();
    }

    if (!this.pendingRelease) {
      const release = this.releaseWhenBroadcastsDrain();
      this.pendingRelease = release;
      // Clear only this generation: clearInstances/reacquisition can schedule
      // subsequent work before an older drain settles.
      void release.then(
        () => {
          if (this.pendingRelease === release) this.pendingRelease = null;
        },
        () => {
          if (this.pendingRelease === release) this.pendingRelease = null;
        },
      );
    }
    return this.pendingRelease;
  }

  private async releaseWhenBroadcastsDrain(): Promise<void> {
    while (this.refCount === 0 && this.pendingBroadcasts.size > 0) {
      await Promise.allSettled([...this.pendingBroadcasts]);
    }
    if (this.refCount === 0) this.finalizeRelease();
  }

  private assertActive(): void {
    if (this.coordinationReleased) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'This client has been released. Acquire a new client before signing or broadcasting.',
      );
    }
  }

  private finalizeRelease(): void {
    this.teardown();
    // A released manager is no longer reusable: keeping it in the registry
    // makes a long-lived SDK process retain one RateLimiter + config per
    // endpoint it has ever touched. The identity guard protects a fresh
    // manager registered under the same key when an older deferred release
    // settles after clearInstances()/reacquisition.
    if (CosmosClientManager.instances.get(this.instanceKey) === this) {
      CosmosClientManager.instances.delete(this.instanceKey);
    }
  }

  /**
   * Tear down the signing client and release query client references.
   * The query client's underlying HTTP transport is stateless and does not
   * require an explicit disconnect.
   */
  private teardown(): void {
    if (this.signingClient) {
      this.signingClient.disconnect();
      this.signingClient = null;
    }
    this.signingClientPromise = null;
    this.queryClient = null;
    this.queryClientPromise = null;
    this.pendingBroadcasts.clear();
    // Releasing one wallet/policy must not reset another manager's account coordination.
    if (!this.coordinationReleased) {
      this.coordinationReleased = true;
      this.coordination.managers -= 1;
      if (this.coordination.managers === 0) {
        this.broadcastLocks.clear();
        this.txSequenceCache.clear();
        if (
          CosmosClientManager.chainCoordination.get(this.config.chainId) ===
          this.coordination
        ) {
          CosmosClientManager.chainCoordination.delete(this.config.chainId);
        }
      }
    }
  }
}
