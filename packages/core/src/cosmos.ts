import { CosmosClientManager } from './client.js';
import { CosmosQueryResult, CosmosTxResult, ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { getQueryHandler, getTxHandler } from './modules.js';
import { withRetry } from './retry.js';

// Validation pattern for module/subcommand names (alphanumeric, hyphens, underscores)
// First character must not be a hyphen to prevent potential issues
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * Validate that a string is safe for use as a module or subcommand name
 */
function validateName(name: string, field: string): void {
  if (!name || !VALID_NAME_PATTERN.test(name)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Invalid ${field}: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`
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
  args: string[] = []
): Promise<CosmosQueryResult> {
  validateName(module, 'module');
  validateName(subcommand, 'subcommand');

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
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    {
      config: clientManager.getConfig().retry,
      operationName: `query ${module} ${subcommand}`,
    }
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
  waitForConfirmation: boolean = false
): Promise<CosmosTxResult> {
  validateName(module, 'module');
  validateName(subcommand, 'subcommand');

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
          waitForConfirmation
        );
      } catch (error) {
        if (error instanceof ManifestMCPError) {
          // Re-throw with enriched context if not already present
          if (!error.details?.module) {
            throw new ManifestMCPError(
              error.code,
              error.message,
              { ...error.details, module, subcommand, args }
            );
          }
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          `Tx ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand, args }
        );
      }
    },
    {
      config: clientManager.getConfig().retry,
      operationName: `tx ${module} ${subcommand}`,
    }
  );
}
