import { calculateFee } from '@cosmjs/stargate';
import type { CosmosClientManager } from './client.js';
import { DEFAULT_GAS_MULTIPLIER } from './config.js';
import { getQueryHandler, getTxHandler, getTxMsgBuilder } from './modules.js';
import { withRetry } from './retry.js';
import {
  type CosmosQueryResult,
  type CosmosTxResult,
  type FeeEstimateResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxOptions,
  type TxOverrides,
} from './types.js';

// Validation pattern for module/subcommand names (alphanumeric, hyphens, underscores)
// First character must not be a hyphen to prevent potential issues
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * Validate that a string is safe for use as a module or subcommand name.
 * Uses the appropriate UNSUPPORTED_QUERY or UNSUPPORTED_TX code so that
 * the error is immediately classified as non-retryable.
 */
function validateName(
  name: string,
  field: string,
  errorCode: ManifestMCPErrorCode,
): void {
  if (!name || !VALID_NAME_PATTERN.test(name)) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${field}: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }
}

/**
 * Execute a Cosmos query via manifestjs RPC client
 *
 * Automatically retries on transient failures (network errors, timeouts, 5xx)
 * with exponential backoff. Configure retry behavior via `config.retry`.
 */
export async function cosmosQuery(
  clientManager: CosmosClientManager,
  module: string,
  subcommand: string,
  args: string[] = [],
): Promise<CosmosQueryResult> {
  validateName(module, 'module', ManifestMCPErrorCode.UNSUPPORTED_QUERY);
  validateName(
    subcommand,
    'subcommand',
    ManifestMCPErrorCode.UNSUPPORTED_QUERY,
  );

  // Get handler from registry (throws if module not found) - do this before retry loop
  const handler = getQueryHandler(module);

  return withRetry(
    async () => {
      // Apply rate limiting before making RPC request
      await clientManager.acquireRateLimit();

      const queryClient = await clientManager.getQueryClient();

      try {
        const result = await handler(queryClient, subcommand, args);

        return {
          module,
          subcommand,
          result,
        };
      } catch (error) {
        if (error instanceof ManifestMCPError) {
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    {
      config: clientManager.getConfig().retry,
      operationName: `query ${module} ${subcommand}`,
    },
  );
}

/**
 * Execute a Cosmos transaction via manifestjs signing client
 *
 * Automatically retries on transient failures (network errors, timeouts, 5xx)
 * with exponential backoff. Configure retry behavior via `config.retry`.
 *
 * Note: Only network-level failures are retried. Transaction validation errors
 * (insufficient funds, invalid args, etc.) are not retried as they won't succeed.
 */
export async function cosmosTx(
  clientManager: CosmosClientManager,
  module: string,
  subcommand: string,
  args: string[] = [],
  waitForConfirmation: boolean = false,
  overrides?: TxOverrides,
): Promise<CosmosTxResult> {
  validateName(module, 'module', ManifestMCPErrorCode.UNSUPPORTED_TX);
  validateName(subcommand, 'subcommand', ManifestMCPErrorCode.UNSUPPORTED_TX);

  // Build fully-resolved gas options from caller overrides + server config
  let txOptions: TxOptions | undefined;
  if (overrides?.gasMultiplier !== undefined) {
    if (
      !Number.isFinite(overrides.gasMultiplier) ||
      overrides.gasMultiplier < 1
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${overrides.gasMultiplier}`,
      );
    }
    const gasPrice = clientManager.getConfig().gasPrice;
    if (!gasPrice) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'gasMultiplier override requires gasPrice configuration',
      );
    }
    txOptions = { gasMultiplier: overrides.gasMultiplier, gasPrice };
  }

  // Get handler from registry (throws if module not found) - do this before retry loop
  const handler = getTxHandler(module);

  return withRetry(
    async () => {
      // Apply rate limiting before making RPC request
      await clientManager.acquireRateLimit();

      const signingClient = await clientManager.getSigningClient();
      const senderAddress = await clientManager.getAddress();

      try {
        return await handler(
          signingClient,
          senderAddress,
          subcommand,
          args,
          waitForConfirmation,
          txOptions,
        );
      } catch (error) {
        if (error instanceof ManifestMCPError) {
          // Re-throw with enriched context if not already present
          if (!error.details?.module) {
            throw new ManifestMCPError(error.code, error.message, {
              ...error.details,
              module,
              subcommand,
              args,
            });
          }
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          `Tx ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand, args },
        );
      }
    },
    {
      config: clientManager.getConfig().retry,
      operationName: `tx ${module} ${subcommand}`,
    },
  );
}

/**
 * Estimate the fee for a Cosmos transaction without broadcasting it.
 *
 * Looks up the message builder for the given module, builds the messages,
 * and calls `client.simulate()` to get a gas estimate. Multiplies by the
 * configured (or overridden) gas multiplier and computes the fee.
 *
 * Automatically retries on transient failures via `withRetry`.
 *
 * @returns FeeEstimateResult with raw gas estimate and computed fee
 */
export async function cosmosEstimateFee(
  clientManager: CosmosClientManager,
  module: string,
  subcommand: string,
  args: string[] = [],
  overrides?: TxOverrides,
): Promise<FeeEstimateResult> {
  validateName(module, 'module', ManifestMCPErrorCode.UNSUPPORTED_TX);
  validateName(subcommand, 'subcommand', ManifestMCPErrorCode.UNSUPPORTED_TX);

  // Always need gasPrice for fee calculation (unlike cosmosTx which can use 'auto')
  const config = clientManager.getConfig();
  const gasPrice = config.gasPrice;
  if (!gasPrice) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'Fee estimation requires gasPrice configuration',
    );
  }

  // Validate the override eagerly (the resolved fallback values are always valid).
  if (overrides?.gasMultiplier !== undefined) {
    if (
      !Number.isFinite(overrides.gasMultiplier) ||
      overrides.gasMultiplier < 1
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${overrides.gasMultiplier}`,
      );
    }
  }

  // Get builder from registry (throws if module not found) - do this before retry loop
  const builder = getTxMsgBuilder(module);

  return withRetry(
    async () => {
      // Apply rate limiting before making RPC request
      await clientManager.acquireRateLimit();

      const signingClient = await clientManager.getSigningClient();
      const senderAddress = await clientManager.getAddress();

      // Resolve gasMultiplier from the signing client when no override is provided.
      // This guarantees parity with cosmosTx's 'auto' path: client.ts patches the
      // signing client's defaultGasMultiplier to config.gasMultiplier; if that
      // patch fails (rare — only when CosmJS internals change), the client
      // falls back to CosmJS's built-in default. Reading from the client uses
      // the same value cosmosTx would.
      const clientMultiplier = (
        signingClient as unknown as { defaultGasMultiplier?: unknown }
      ).defaultGasMultiplier;
      const gasMultiplier =
        overrides?.gasMultiplier ??
        (typeof clientMultiplier === 'number'
          ? clientMultiplier
          : DEFAULT_GAS_MULTIPLIER);

      try {
        const built = builder(senderAddress, subcommand, args);
        const gasEstimate = await signingClient.simulate(
          senderAddress,
          built.messages,
          built.memo,
        );
        const gasLimit = Math.ceil(gasEstimate * gasMultiplier);
        const fee = calculateFee(gasLimit, gasPrice);

        return {
          module,
          subcommand: built.canonicalSubcommand ?? subcommand,
          gasEstimate: String(gasEstimate),
          fee: { amount: fee.amount, gas: fee.gas },
        };
      } catch (error) {
        if (error instanceof ManifestMCPError) {
          // Re-throw with enriched context if not already present (mirrors cosmosTx)
          if (!error.details?.module) {
            throw new ManifestMCPError(error.code, error.message, {
              ...error.details,
              module,
              subcommand,
              args,
            });
          }
          throw error;
        }
        // SIMULATION_FAILED is NOT in NON_RETRYABLE_ERROR_CODES, so withRetry
        // will fall through to isTransientErrorMessage for message-based
        // classification. Transient errors (network/5xx) get retried; real
        // simulation failures (insufficient funds, etc) fail fast.
        throw new ManifestMCPError(
          ManifestMCPErrorCode.SIMULATION_FAILED,
          `Fee estimation for ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand, args },
        );
      }
    },
    {
      config: config.retry,
      operationName: `estimate ${module} ${subcommand}`,
    },
  );
}
