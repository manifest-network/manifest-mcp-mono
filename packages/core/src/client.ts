import { SigningStargateClient, GasPrice, HttpEndpoint } from '@cosmjs/stargate';
import {
  cosmosProtoRegistry,
  cosmosAminoConverters,
  liftedinitProtoRegistry,
  liftedinitAminoConverters,
  strangeloveVenturesProtoRegistry,
  strangeloveVenturesAminoConverters,
  osmosisProtoRegistry,
  osmosisAminoConverters,
  liftedinit,
} from '@manifest-network/manifestjs';
import { Registry } from '@cosmjs/proto-signing';
import { AminoTypes } from '@cosmjs/stargate';
import { RateLimiter } from 'limiter';
import { ManifestMCPConfig, WalletProvider, ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { DEFAULT_REQUESTS_PER_SECOND } from './config.js';
import { withRetry } from './retry.js';

// Type for the RPC query client from manifestjs liftedinit bundle
// This includes cosmos modules + liftedinit-specific modules (billing, manifest, sku)
export type ManifestQueryClient = Awaited<ReturnType<typeof liftedinit.ClientFactory.createRPCQueryClient>>;

/**
 * Extract the registry type expected by SigningStargateClient.connectWithSigner.
 *
 * The Registry type from @cosmjs/proto-signing doesn't perfectly match the registry type
 * in SigningStargateClientOptions due to telescope-generated proto types. This type alias
 * extracts the expected registry type from the function signature to enable type-safe casting.
 */
type SigningClientRegistry = Parameters<typeof SigningStargateClient.connectWithSigner>[2] extends { registry?: infer R } ? R : never;

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
  ]);

  const aminoTypes = new AminoTypes({
    ...cosmosAminoConverters,
    ...liftedinitAminoConverters,
    ...strangeloveVenturesAminoConverters,
    ...osmosisAminoConverters,
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

  // Promises to prevent concurrent client initialization (lazy init race condition)
  private queryClientPromise: Promise<ManifestQueryClient> | null = null;
  private signingClientPromise: Promise<SigningStargateClient> | null = null;

  private constructor(config: ManifestMCPConfig, walletProvider: WalletProvider) {
    this.config = config;
    this.walletProvider = walletProvider;

    // Initialize rate limiter with configured or default requests per second
    const requestsPerSecond = config.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: requestsPerSecond,
      interval: 'second',
    });
  }

  /**
   * Get or create a singleton instance for the given config.
   * Instances are keyed by chainId:rpcUrl. For existing instances:
   * - Config and walletProvider references are always updated
   * - Signing client is disconnected/recreated if gasPrice or walletProvider changed
   * - Rate limiter is updated if requestsPerSecond changed (without affecting signing client)
   */
  static getInstance(
    config: ManifestMCPConfig,
    walletProvider: WalletProvider
  ): CosmosClientManager {
    const key = `${config.chainId}:${config.rpcUrl}`;
    let instance = CosmosClientManager.instances.get(key);

    if (!instance) {
      instance = new CosmosClientManager(config, walletProvider);
      CosmosClientManager.instances.set(key, instance);
    } else {
      // Check what changed to determine what needs updating
      const signingClientAffected =
        instance.config.gasPrice !== config.gasPrice ||
        instance.walletProvider !== walletProvider;

      const rateLimitChanged =
        instance.config.rateLimit?.requestsPerSecond !== config.rateLimit?.requestsPerSecond;

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
        const newRps = config.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
        instance.rateLimiter = new RateLimiter({
          tokensPerInterval: newRps,
          interval: 'second',
        });
      }
    }

    return instance;
  }

  /**
   * Clear all cached instances (useful for testing or reconnection).
   * Disconnects signing clients and releases query client references before clearing.
   */
  static clearInstances(): void {
    for (const instance of CosmosClientManager.instances.values()) {
      instance.disconnect();
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
        // Use liftedinit ClientFactory which includes cosmos + liftedinit modules
        // Wrap with retry for transient connection failures
        const client = await withRetry(
          () => liftedinit.ClientFactory.createRPCQueryClient({
            rpcEndpoint: this.config.rpcUrl,
          }),
          {
            config: this.config.retry,
            operationName: 'connect query client',
          }
        );
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
        throw new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          `Failed to connect to RPC endpoint: ${error instanceof Error ? error.message : String(error)}`,
          { rpcUrl: this.config.rpcUrl }
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
        const gasPrice = GasPrice.fromString(this.config.gasPrice);
        const { registry, aminoTypes } = getSigningManifestClientOptions();

        // Configure endpoint with HTTP timeout
        const endpoint: HttpEndpoint = {
          url: this.config.rpcUrl,
          headers: {},
        };

        // Note: Registry type from @cosmjs/proto-signing doesn't perfectly match
        // SigningStargateClientOptions due to telescope-generated proto types.
        // This is a known limitation with custom cosmos-sdk module registries.
        // Wrap with retry for transient connection failures
        const client = await withRetry(
          () => SigningStargateClient.connectWithSigner(
            endpoint,
            signer,
            {
              registry: registry as SigningClientRegistry,
              aminoTypes,
              gasPrice,
              broadcastTimeoutMs: DEFAULT_BROADCAST_TIMEOUT_MS,
              broadcastPollIntervalMs: DEFAULT_BROADCAST_POLL_INTERVAL_MS,
            }
          ),
          {
            config: this.config.retry,
            operationName: 'connect signing client',
          }
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
          { rpcUrl: this.config.rpcUrl }
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
   * Acquire a rate limit token before making an RPC request.
   * This will wait if the rate limit has been exceeded.
   */
  async acquireRateLimit(): Promise<void> {
    await this.rateLimiter.removeTokens(1);
  }

  /**
   * Disconnect the signing client and release query client references.
   * The query client's underlying HTTP transport is stateless and does not
   * require an explicit disconnect.
   */
  disconnect(): void {
    if (this.signingClient) {
      this.signingClient.disconnect();
      this.signingClient = null;
    }
    this.signingClientPromise = null;
    this.queryClient = null;
    this.queryClientPromise = null;
  }
}
