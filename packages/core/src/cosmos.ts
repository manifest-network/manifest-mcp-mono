import { calculateFee, type StdFee } from '@cosmjs/stargate';
import type { CosmosClientManager } from './client.js';
import { DEFAULT_GAS_MULTIPLIER } from './config.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';
import { withRetry } from './retry.js';
import {
  type CosmosQueryResult,
  type CosmosTxResult,
  type FeeEstimateResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxBuildContext,
  type TxOptions,
  type TxOverrides,
} from './types.js';

// Validation pattern for module/subcommand names (alphanumeric, hyphens, underscores)
// First character must not be a hyphen to prevent potential issues
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/**
 * Resolve and run the `TxBuildContext` loader registered for `(module,
 * subcommand)` in `TX_MODULES`. Returns `undefined` when no loader is
 * registered (the common case) so the caller can short-circuit and skip the
 * chain read.
 *
 * Acquires a rate-limit token before the loader runs so each extra RPC is
 * counted against the same budget every other RPC respects, and wraps any
 * non-`ManifestMCPError` failure as `QUERY_FAILED` with `{module, subcommand}`
 * details for symmetric error classification on both broadcast and estimate
 * paths.
 */
async function loadBuildContext(
  clientManager: CosmosClientManager,
  module: string,
  subcommand: string,
): Promise<TxBuildContext | undefined> {
  const loader = getTxContextLoader(module, subcommand);
  if (!loader) return undefined;

  // The full loader call sequence — rate-limit acquire, query-client
  // construction, loader invocation — runs inside the try/catch so every
  // failure mode gets the {module, subcommand} attribution callers expect
  // from a structured error. Without the wrap, an INVALID_CONFIG from
  // `getQueryClient` (or a connection failure that escapes the inner
  // withRetry) would propagate without telling the caller which tx was
  // being prepared.
  try {
    await clientManager.acquireRateLimit();
    const queryClient = await clientManager.getQueryClient();
    return await loader(queryClient);
  } catch (error) {
    if (error instanceof ManifestMCPError) {
      if (!error.details?.module) {
        throw new ManifestMCPError(error.code, error.message, {
          ...error.details,
          module,
          subcommand,
        });
      }
      throw error;
    }
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Failed to load build context for ${module} ${subcommand}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { module, subcommand },
    );
  }
}

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
      // The rate-limit + query-client acquisition runs inside the try/catch
      // so a failure during either step is wrapped with {module, subcommand}
      // attribution, matching the handler-leg semantics. Otherwise an
      // INVALID_CONFIG from `getQueryClient` (or a connection failure that
      // escapes the inner withRetry) would propagate without telling the
      // caller which query was being routed.
      try {
        await clientManager.acquireRateLimit();
        const queryClient = await clientManager.getQueryClient();
        const result = await handler(queryClient, subcommand, args);

        return {
          module,
          subcommand,
          result,
        };
      } catch (error) {
        if (error instanceof ManifestMCPError) {
          if (!error.details?.module) {
            throw new ManifestMCPError(error.code, error.message, {
              ...error.details,
              module,
              subcommand,
            });
          }
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand },
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
 * Attribute a tx-leg failure with `{module, subcommand, args}`. A `ManifestMCPError`
 * that already carries a `module` is returned untouched (no double-enrichment);
 * one without is re-wrapped preserving its code + details; any other thrown value
 * is wrapped as `TX_FAILED` (a NON_RETRYABLE code — so `withRetry` cannot re-broadcast
 * a submitted tx on a raw transient error, guarding against double-spend).
 */
function enrichTxError(
  error: unknown,
  module: string,
  subcommand: string,
  args: string[],
): ManifestMCPError {
  if (error instanceof ManifestMCPError) {
    if (!error.details?.module) {
      return new ManifestMCPError(error.code, error.message, {
        ...error.details,
        module,
        subcommand,
        args,
      });
    }
    return error;
  }
  return new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `Tx ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
    { module, subcommand, args },
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
  txExtras?: { readonly fee?: StdFee; readonly memo?: string },
): Promise<CosmosTxResult> {
  validateName(module, 'module', ManifestMCPErrorCode.UNSUPPORTED_TX);
  validateName(subcommand, 'subcommand', ManifestMCPErrorCode.UNSUPPORTED_TX);

  // NET-NEW: explicit fee and gasMultiplier are mutually exclusive (fee wins; gasMultiplier
  // applies only on the simulate path). Co-located with the gas validations below.
  if (txExtras?.fee !== undefined && overrides?.gasMultiplier !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'passing both fee and gasMultiplier is a caller error; fee wins (it skips simulation), gasMultiplier applies only on the simulate path',
    );
  }

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
  // Fetch chain context once before the broadcast retry loop: every broadcast
  // attempt uses the same snapshot and we don't consume extra rate-limit
  // tokens per broadcast retry. The loader is independently wrapped in its
  // own withRetry so transient LCD failures during the chain read still get
  // retried (parity with cosmosQuery's params reads).
  const buildContext = await withRetry(
    () => loadBuildContext(clientManager, module, subcommand),
    {
      config: clientManager.getConfig().retry,
      operationName: `load-context ${module} ${subcommand}`,
    },
  );

  // Resolve the sender ONCE — it is both the broadcast-lock key and the signAndBroadcast sender.
  // Resolve BEFORE the lock so the per-signer mutex can key on it; enrich a wallet failure with the
  // same {module,subcommand,args} attribution the broadcast leg uses.
  let senderAddress: string;
  try {
    senderAddress = await clientManager.getAddress();
  } catch (error) {
    throw enrichTxError(error, module, subcommand, args);
  }

  // Per-signer broadcast mutex (OUTER) serializes the whole simulate→sign→broadcast→commit cycle
  // for this address; acquireRateLimit stays INNER. Acquired ONCE around withRetry.
  return clientManager.withBroadcastLock(senderAddress, () =>
    withRetry(
      async () => {
        // The rate-limit + signing-client acquisition runs inside the
        // try/catch so a failure during any of those steps is wrapped with
        // {module, subcommand, args} attribution, matching the handler-leg
        // semantics. Otherwise an INVALID_CONFIG / wallet error from these
        // calls would propagate without telling the caller which tx was being
        // prepared.
        try {
          await clientManager.acquireRateLimit();
          const signingClient = await clientManager.getSigningClient();
          return await handler(
            signingClient,
            senderAddress,
            subcommand,
            args,
            waitForConfirmation,
            txOptions,
            buildContext,
            txExtras,
          );
        } catch (error) {
          throw enrichTxError(error, module, subcommand, args);
        }
      },
      {
        config: clientManager.getConfig().retry,
        operationName: `tx ${module} ${subcommand}`,
      },
    ),
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
  // Fetch chain context once before the simulate retry loop: every simulate
  // attempt uses the same snapshot and we don't consume extra rate-limit
  // tokens per simulate retry. The loader is independently wrapped in its
  // own withRetry so transient LCD failures during the chain read still get
  // retried (parity with cosmosQuery's params reads).
  const buildContext = await withRetry(
    () => loadBuildContext(clientManager, module, subcommand),
    {
      config: config.retry,
      operationName: `load-context ${module} ${subcommand}`,
    },
  );

  return withRetry(
    async () => {
      // The rate-limit + signing-client + address acquisition runs inside
      // the try/catch so a failure during any of those steps is wrapped
      // with {module, subcommand, args} attribution, matching the
      // handler-leg semantics. Otherwise an INVALID_CONFIG / wallet error
      // from these calls would propagate without telling the caller which
      // estimate was being computed.
      try {
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

        const built = builder(senderAddress, subcommand, args, buildContext);
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
