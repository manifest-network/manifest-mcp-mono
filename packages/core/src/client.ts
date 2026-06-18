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
import { createLCDQueryClient } from './lcd-adapter.js';
import { type Logger, noopLogger } from './logger.js';
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

  /** Per-instance logger for the 2 init-time diagnostics. Defaults to noopLogger (silent); see setLogger. */
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
  ) {
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
      instance = new CosmosClientManager(config, walletProvider);
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
   * Automatically retries on transient connection failures with exponential backoff.
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

    // Start initialization and cache the promise to prevent concurrent init
    this.queryClientPromise = (async () => {
      // Capture reference to detect if superseded by disconnect/config change
      const thisInitPromise = this.queryClientPromise;
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
        // Only store if this is still the active promise
        if (this.queryClientPromise === thisInitPromise) {
          this.queryClient = client;
          this.queryClientPromise = null;
        }
        return client;
      } catch (error) {
        // Clear promise on failure so retry is possible (only if still active)
        if (this.queryClientPromise === thisInitPromise) {
          this.queryClientPromise = null;
        }
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
    })();

    return this.queryClientPromise;
  }

  /**
   * Get a signing client with all Manifest registries (for transactions)
   *
   * Automatically retries on transient connection failures with exponential backoff.
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

    // Start initialization and cache the promise to prevent concurrent init
    this.signingClientPromise = (async () => {
      // Capture reference to detect if superseded by disconnect/config change
      const thisInitPromise = this.signingClientPromise;
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
        // Only store if this is still the active promise
        if (this.signingClientPromise === thisInitPromise) {
          this.signingClient = client;
          this.signingClientPromise = null;
        } else {
          // Promise was superseded, clean up the client we just created
          client.disconnect();
        }
        return client;
      } catch (error) {
        // Clear promise on failure so retry is possible (only if still active)
        if (this.signingClientPromise === thisInitPromise) {
          this.signingClientPromise = null;
        }
        if (error instanceof ManifestMCPError) {
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          `Failed to connect signing client: ${error instanceof Error ? error.message : String(error)}`,
          { rpcUrl: this.config.rpcUrl },
        );
      }
    })();

    return this.signingClientPromise;
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
   * Inject a per-instance Logger for the 2 init-time diagnostics (signing-client gasMultiplier
   * fallback; LCD wasm-patch missing-method). NON-KEY + non-invalidating: NOT part of the getInstance
   * key (chainId:rpcUrl[:restUrl]) and NOT in the signing/query-client invalidation gate — a pure
   * reference mutation, mirroring the existing config/walletProvider mutation. Defaults to noopLogger
   * (silent, per spec §5.3). Shared-key last-writer-wins: if two ctxs share a config key the later
   * setLogger wins; acceptable because both diagnostics are one-time, init-cached, never re-firing.
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Acquire a rate limit token before making an RPC request.
   * This will wait if the rate limit has been exceeded.
   */
  async acquireRateLimit(): Promise<void> {
    await this.rateLimiter.removeTokens(1);
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
    if (this.refCount > 0) this.refCount -= 1;
    if (this.refCount === 0) this.teardown();
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
  }
}
