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
  cosmwasmAminoConverters,
  cosmwasm as cosmwasmNs,
  cosmwasmProtoRegistry,
  ibcAminoConverters,
  ibc as ibcNs,
  ibcProtoRegistry,
  liftedinit,
  liftedinitAminoConverters,
  liftedinitProtoRegistry,
  osmosisAminoConverters,
  osmosis as osmosisNs,
  osmosisProtoRegistry,
  strangeloveVenturesAminoConverters,
  strangelove_ventures as strangeloveVenturesNs,
  strangeloveVenturesProtoRegistry,
} from '@manifest-network/manifestjs';
import { RateLimiter } from 'limiter';
import {
  DEFAULT_GAS_MULTIPLIER,
  DEFAULT_REQUESTS_PER_SECOND,
} from './config.js';
import {
  type SequenceCache,
  sequencedSigningClient,
} from './internals/tx-sequence.js';
import { createLCDQueryClient } from './lcd-adapter.js';
import { type Logger, noopLogger } from './logger.js';
import { abortableSleep, abortReason } from './options.js';
import { withRetry } from './retry.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';

// Combined query client type: liftedinit modules (cosmos + billing/manifest/sku) + cosmwasm
// + strangelove_ventures (poa) + osmosis (tokenfactory) + ibc (transfer, channel, client, connection).
// Uses Pick to extract only each factory's unique namespace, avoiding conflicts with overlapping cosmos types.
type LiftedinitQueryClient = Awaited<
  ReturnType<typeof liftedinit.ClientFactory.createRPCQueryClient>
>;
type CosmwasmQueryClient = Awaited<
  ReturnType<typeof cosmwasmNs.ClientFactory.createRPCQueryClient>
>;
type StrangeloveVenturesQueryClient = Awaited<
  ReturnType<typeof strangeloveVenturesNs.ClientFactory.createRPCQueryClient>
>;
type OsmosisQueryClient = Awaited<
  ReturnType<typeof osmosisNs.ClientFactory.createRPCQueryClient>
>;
type IbcQueryClient = Awaited<
  ReturnType<typeof ibcNs.ClientFactory.createRPCQueryClient>
>;
export type ManifestQueryClient = LiftedinitQueryClient &
  Pick<CosmwasmQueryClient, 'cosmwasm'> &
  Pick<StrangeloveVenturesQueryClient, 'strangelove_ventures'> &
  Pick<OsmosisQueryClient, 'osmosis'> &
  Pick<IbcQueryClient, 'ibc'>;

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

/**
 * Poll granularity for the CANCELLABLE rate-limit wait (ENG-710). Deliberately a constant
 * rather than a value derived from `requestsPerSecond`: any derived form needs a clamp, and
 * for every rps below ~40 — which includes the default 10 and every value anyone configures —
 * the clamp returns this number anyway. Storing a derived value would also mean a second field
 * to update in lockstep at BOTH limiter-construction sites, next to the one hazard this class
 * already has (the limiter is replaced wholesale on reconfigure).
 *
 * Abort latency does NOT depend on it — the sleep is abort-aware, so a cancel rejects at once.
 * It bounds only the extra wait for a token, and only for a caller that is ALREADY throttled
 * (whose wait is otherwise up to a full interval), i.e. ≤2.5% overshoot on a 1s budget.
 */
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

/**
 * Manages CosmJS client instances with lazy initialization and singleton pattern
 */
export class CosmosClientManager {
  private static instances: Map<string, CosmosClientManager> = new Map();

  /** Registry key used to evict this manager when its final holder releases it. */
  private readonly instanceKey: string;
  private config: ManifestMCPConfig;
  private walletProvider: WalletProvider;
  private queryClient: ManifestQueryClient | null = null;
  private signingClient: SigningStargateClient | null = null;
  private rateLimiter: RateLimiter;

  // Per-signer broadcast serialization. A promise-chain lock keyed by signer ADDRESS so concurrent
  // signAndBroadcast calls from one account can't both read the same committed sequence (cosmjs
  // re-queries the sequence per broadcast — account-sequence-mismatch). Pure-JS (NO node:async_hooks
  // — browser-safe). One entry per distinct address (today one wallet ⇒ one entry).
  private broadcastLocks: Map<string, Promise<unknown>> = new Map();

  // Per-signer local sequence tracking for non-blocking (SYNC) broadcasts (see internals/tx-sequence.ts).
  // Only populated while a signer has an unconfirmed sync tx in flight; self-heals on error. Cleared
  // whenever the signing client is replaced (config change / disconnect) since the account/chain may differ.
  private txSequenceCache: SequenceCache = new Map();

  /** Per-instance logger for the 3 init-time diagnostics. Defaults to noopLogger (silent); see setLogger. */
  private logger: Logger = noopLogger;

  // Number of live holders (servers) sharing this instance. Each getInstance
  // acquisition increments it; each disconnect() decrements it. The underlying
  // clients are only torn down once the count reaches zero (the last holder
  // disconnects), so one server's shutdown can't sever another's shared client.
  private refCount = 0;

  // Promises to prevent concurrent client initialization (lazy init race condition)
  private queryClientPromise: Promise<ManifestQueryClient> | null = null;
  private signingClientPromise: Promise<SigningStargateClient> | null = null;

  private constructor(
    config: ManifestMCPConfig,
    walletProvider: WalletProvider,
    instanceKey: string,
  ) {
    this.instanceKey = instanceKey;
    this.config = config;
    this.walletProvider = walletProvider;

    // Initialize rate limiter with configured or default requests per second
    const requestsPerSecond =
      config.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: requestsPerSecond,
      interval: 'second',
    });
  }

  /**
   * Get or create a singleton instance for the given config.
   * Instances are keyed by chainId:rpcUrl:restUrl. For existing instances:
   * - Config and walletProvider references are always updated
   * - Signing client is disconnected/recreated if gasPrice, gasMultiplier, or walletProvider changed
   * - Rate limiter is updated if requestsPerSecond changed (without affecting signing client)
   *
   * Every call acquires a reference (increments refCount). Each caller must
   * balance it with exactly one disconnect() so the shared clients are torn
   * down only once the last holder releases (see disconnect()).
   *
   * Reference accounting counts calls, not distinct callers: a call that only
   * updates config on an existing key (changed gasPrice/gasMultiplier/
   * walletProvider/rate limit) still acquires a reference. A holder that
   * re-invokes getInstance to reconfigure a key it already holds therefore
   * takes an ADDITIONAL reference and must balance it with an additional
   * disconnect(), or refCount never reaches zero and the clients leak. Today
   * every server acquires once at construction and releases once at shutdown,
   * so this caveat only applies to callers that reconfigure a live key in place.
   */
  static getInstance(
    config: ManifestMCPConfig,
    walletProvider: WalletProvider,
  ): CosmosClientManager {
    const parts = [config.chainId, config.rpcUrl ?? ''];
    if (config.restUrl) parts.push(config.restUrl);
    const key = parts.join(':');
    let instance = CosmosClientManager.instances.get(key);

    if (!instance) {
      instance = new CosmosClientManager(config, walletProvider, key);
      CosmosClientManager.instances.set(key, instance);
    } else {
      // Check what changed to determine what needs updating
      const signingClientAffected =
        instance.config.gasPrice !== config.gasPrice ||
        instance.config.gasMultiplier !== config.gasMultiplier ||
        instance.walletProvider !== walletProvider;

      const rateLimitChanged =
        instance.config.rateLimit?.requestsPerSecond !==
        config.rateLimit?.requestsPerSecond;

      // Always update config reference
      instance.config = config;
      instance.walletProvider = walletProvider;

      // Only invalidate signing client if fields it depends on changed
      if (signingClientAffected) {
        if (instance.signingClient) {
          instance.signingClient.disconnect();
          instance.signingClient = null;
        }
        // Also clear the promise to allow re-initialization with new config
        instance.signingClientPromise = null;
        // Drop local sequence tracking — the account/chain the counters were seeded from may differ.
        instance.txSequenceCache.clear();
      }

      // Update rate limiter independently (doesn't affect signing client)
      if (rateLimitChanged) {
        const newRps =
          config.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
        instance.rateLimiter = new RateLimiter({
          tokensPerInterval: newRps,
          interval: 'second',
        });
      }
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
          () => createLCDQueryClient(this.config.restUrl!, this.logger),
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
        // Superseded mid-flight by teardown()/disconnect() or a getInstance config change.
        // Unlike the query client this one owns a live transport, so the orphan MUST be
        // released — and it must NOT be handed back. Over a WebSocket endpoint a disconnected
        // client is dead (the old always-superseded code only appeared to work because
        // @cosmjs/tendermint-rpc's HttpClient.disconnect() is a no-op), and after a config
        // change it was built from the superseded gasPrice/wallet. Fail loudly; the caller
        // re-invokes and gets a client built from the CURRENT configuration.
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
          'Signing client initialization was superseded by a disconnect or configuration change before it completed. Retry to obtain a client for the current configuration.',
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
   * Get the configuration
   */
  getConfig(): ManifestMCPConfig {
    return this.config;
  }

  /**
   * Inject a per-instance Logger for the 3 init-time diagnostics (signing-client gasMultiplier
   * fallback; LCD wasm-patch missing-method; orphaned-signing-client disconnect failure on a
   * superseded init — ENG-636). NON-KEY + non-invalidating: NOT part of the getInstance
   * key (chainId:rpcUrl[:restUrl]) and NOT in the signing/query-client invalidation gate — a pure
   * reference mutation, mirroring the existing config/walletProvider mutation. Defaults to noopLogger
   * (silent, per spec §5.3). Shared-key last-writer-wins: if two ctxs share a config key the later
   * setLogger wins; acceptable because the two gasMultiplier/LCD diagnostics are one-time,
   * init-cached and never re-fire, and the supersede diagnostic only fires on a shutdown or
   * reconfiguration race, where "whichever holder's logger is current" is the right answer anyway.
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
    // `this.rateLimiter` is re-read every pass on purpose: a getInstance reconfigure REPLACES
    // the limiter object, and an in-flight waiter should adopt the new budget rather than
    // drain an orphaned one. The guard is re-run against each snapshot for the same reason —
    // adopting a REPLACEMENT budget means adopting its validity too. Checking only on entry
    // would let a reconfigure to an undersized bucket turn a parked waiter into a silent
    // spin (`tryRemoveTokens` declines forever below 1 token) instead of the fast, typed
    // failure this raises.
    while (true) {
      if (this.rateLimiter.tryRemoveTokens(1)) return;
      this.assertBudgetAdmitsOneToken();
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
    const prev = this.broadcastLocks.get(address) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior task's outcome
    // Store a swallowed tail so the next waiter chains cleanly and no unhandledRejection escapes.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.broadcastLocks.set(address, tail);
    // Release the entry once this chain drains, so the map stays bounded to
    // in-flight chains — a long-lived manager broadcasting from many distinct
    // addresses would otherwise grow it without bound (code-review PR #102 +
    // Copilot). Delete only if no newer broadcast has replaced this tail.
    void tail.then(() => {
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
    if (this.refCount === 0) return;
    this.refCount -= 1;
    if (this.refCount === 0) {
      this.teardown();
      // A released manager is no longer reusable: keeping it in the registry
      // makes a long-lived SDK process retain one RateLimiter + config per
      // endpoint it has ever touched. The identity guard protects a fresh
      // manager registered under the same key from a stale holder's extra
      // disconnect after clearInstances()/reacquisition.
      if (CosmosClientManager.instances.get(this.instanceKey) === this) {
        CosmosClientManager.instances.delete(this.instanceKey);
      }
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
    // Reset the per-signer broadcast-lock chain so a reused config key
    // (disconnect → getInstance) starts clean and the map does not retain
    // stale settled tails (code-review PR #102).
    this.broadcastLocks.clear();
    // Drop local sequence tracking too — a reused config key must re-seed from committed state.
    this.txSequenceCache.clear();
  }
}
