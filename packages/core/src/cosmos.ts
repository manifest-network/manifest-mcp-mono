import { calculateFee, type StdFee } from '@cosmjs/stargate';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import { DEFAULT_GAS_MULTIPLIER, DEFAULT_MAX_GAS } from './config.js';
import { isNotFoundError } from './internals/classify-query-error.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';
import { withRetry } from './retry.js';
import { assertExplicitFeeWithinCeiling } from './transactions/utils.js';
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
 * chain read — and, importantly, skip building a query client it never uses.
 *
 * Owns its own retry ladder over the loader call (parity with `cosmosQuery`'s
 * params reads) and acquires a rate-limit token per attempt so each extra RPC
 * is counted against the same budget every other RPC respects. Any
 * non-`ManifestMCPError` failure is wrapped as `QUERY_FAILED` with
 * `{module, subcommand}` details for symmetric error classification on both
 * broadcast and estimate paths.
 *
 * The query client is acquired ONCE, above that ladder — see
 * {@link cosmosQuery} for why (ENG-679).
 */
async function loadBuildContext(
  clientManager: CosmosClientManager,
  module: string,
  subcommand: string,
): Promise<TxBuildContext | undefined> {
  const loader = getTxContextLoader(module, subcommand);
  if (!loader) return undefined;

  let queryClient: ManifestQueryClient;
  try {
    queryClient = await clientManager.getQueryClient();
  } catch (error) {
    throw enrichBuildContextError(error, module, subcommand);
  }

  return withRetry(
    async () => {
      // The loader call runs inside the try/catch so every failure mode gets
      // the {module, subcommand} attribution callers expect from a structured
      // error, matching the acquisition leg above.
      try {
        await clientManager.acquireRateLimit();
        return await loader(queryClient);
      } catch (error) {
        throw enrichBuildContextError(error, module, subcommand);
      }
    },
    {
      config: clientManager.getConfig().retry,
      operationName: `load-context ${module} ${subcommand}`,
    },
  );
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
 * The branch every `enrich*` below duplicates: a `ManifestMCPError` that already
 * carries a `module` is final (no double-enrichment); one without is re-wrapped
 * preserving its code + details. Returns `null` when the thrown value is not ours,
 * so each caller can apply its own fallback classification.
 */
function attributeManifestError(
  error: unknown,
  details: Record<string, unknown>,
): ManifestMCPError | null {
  if (!(error instanceof ManifestMCPError)) return null;
  if (error.details?.module) return error;
  return new ManifestMCPError(error.code, error.message, {
    ...error.details,
    ...details,
  });
}

/** Attribute a query-leg failure. Raw throws classify as NOT_FOUND or QUERY_FAILED. */
function enrichQueryError(
  error: unknown,
  module: string,
  subcommand: string,
): ManifestMCPError {
  return (
    attributeManifestError(error, { module, subcommand }) ??
    // The RPC leg throws plain Errors — classify so the generic query path
    // yields NOT_FOUND on BOTH transports (the LCD leg already arrives as a
    // structured ManifestMCPError and is preserved above). ENG-536.
    new ManifestMCPError(
      isNotFoundError(error)
        ? ManifestMCPErrorCode.NOT_FOUND
        : ManifestMCPErrorCode.QUERY_FAILED,
      `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
      { module, subcommand },
    )
  );
}

/** Attribute a build-context failure. Raw throws classify as QUERY_FAILED. */
function enrichBuildContextError(
  error: unknown,
  module: string,
  subcommand: string,
): ManifestMCPError {
  return (
    attributeManifestError(error, { module, subcommand }) ??
    new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Failed to load build context for ${module} ${subcommand}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { module, subcommand },
    )
  );
}

/**
 * Execute a Cosmos query via manifestjs RPC client
 *
 * Automatically retries the QUERY LEG on transient failures (network errors,
 * timeouts, 5xx) with exponential backoff. Configure retry behavior via
 * `config.retry`. The query client is acquired once, outside that ladder —
 * `getQueryClient` owns connect-retry itself, and nesting the two multiplied
 * attempts (4 outer x 4 inner x 5 namespace clients = 77 connects on a dead
 * endpoint). ENG-679.
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

  // Acquired ONCE, outside the ladder below: `getQueryClient` retries the connect
  // internally, so wrapping it in a second ladder multiplies attempts (ENG-679).
  // Its own try/catch preserves the {module, subcommand} attribution that put the
  // acquisition inside the retry block in the first place — an INVALID_CONFIG or an
  // exhausted connect would otherwise propagate without telling the caller which
  // query was being routed.
  let queryClient: ManifestQueryClient;
  try {
    queryClient = await clientManager.getQueryClient();
  } catch (error) {
    throw enrichQueryError(error, module, subcommand);
  }

  return withRetry(
    async () => {
      try {
        // One rate-limit token per attempt: the token is a request budget, not a
        // connection budget, so it stays inside the ladder.
        await clientManager.acquireRateLimit();
        const result = await handler(queryClient, subcommand, args);

        return {
          module,
          subcommand,
          result,
        };
      } catch (error) {
        throw enrichQueryError(error, module, subcommand);
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
  return (
    attributeManifestError(error, { module, subcommand, args }) ??
    new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Tx ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
      { module, subcommand, args },
    )
  );
}

/** Attribute an estimate-leg failure. Raw throws classify as SIMULATION_FAILED. */
function enrichEstimateError(
  error: unknown,
  module: string,
  subcommand: string,
  args: string[],
): ManifestMCPError {
  return (
    attributeManifestError(error, { module, subcommand, args }) ??
    // SIMULATION_FAILED is NOT in NON_RETRYABLE_ERROR_CODES, so withRetry
    // will fall through to isTransientErrorMessage for message-based
    // classification. Transient errors (network/5xx) get retried; real
    // simulation failures (insufficient funds, etc) fail fast.
    new ManifestMCPError(
      ManifestMCPErrorCode.SIMULATION_FAILED,
      `Fee estimation for ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
      { module, subcommand, args },
    )
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
  // Default true = wait for block inclusion (`signAndBroadcast`). `false` broadcasts at the SYNC/CheckTx
  // level (`signAndBroadcastSync`): hash only, no block wait, and NO throw on a DeliverTx failure — so the
  // safe default matches the documented `TxCallOptions` contract and never silently swallows on-chain
  // failures for a caller that omits this argument.
  waitForConfirmation: boolean = true,
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

  // ENG-665: an explicit fee must not switch the ENG-556 ceiling off. The
  // simulate path enforces it inside buildGasFee via TxOptions.maxGas, but the
  // FEE-WINS branch below deliberately skips building TxOptions, so the one code
  // path where a caller states a fee explicitly — i.e. where they are being most
  // careful about cost — was the only unbounded one. Enforced here, before
  // dispatch, so it covers every module rather than only those whose handler
  // reaches resolveTxFeeAndMemo.
  if (txExtras?.fee !== undefined) {
    assertExplicitFeeWithinCeiling(
      txExtras.fee,
      clientManager.getConfig().maxGas,
    );
  }

  // Validate an explicit gasMultiplier override eagerly (unchanged semantics).
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

  // Resolve fully-resolved gas options for the SIMULATE path. Always build them on
  // the non-explicit-fee path (not just when an override is present) so the maxGas
  // ceiling in buildGasFee covers the default cosmos_tx path too (ENG-556). Skipped
  // when an explicit fee wins (FEE-WINS bypasses simulate). When gasPrice is not
  // configured this stays undefined -> buildGasFee returns 'auto' -> the broadcast
  // still fails downstream at getBroadcastClient (query-only mode), exactly as before.
  let txOptions: TxOptions | undefined;
  if (txExtras?.fee === undefined) {
    const config = clientManager.getConfig();
    const gasPrice = config.gasPrice;
    if (!gasPrice) {
      if (overrides?.gasMultiplier !== undefined) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'gasMultiplier override requires gasPrice configuration',
        );
      }
    } else {
      txOptions = {
        gasMultiplier:
          overrides?.gasMultiplier ??
          config.gasMultiplier ??
          DEFAULT_GAS_MULTIPLIER,
        gasPrice,
        maxGas: config.maxGas ?? DEFAULT_MAX_GAS,
      };
    }
  }

  // Get handler from registry (throws if module not found) - do this before retry loop
  const handler = getTxHandler(module);
  // Fetch chain context once before the broadcast retry loop: every broadcast
  // attempt uses the same snapshot and we don't consume extra rate-limit
  // tokens per broadcast retry. loadBuildContext owns its own withRetry over
  // the loader call, so transient LCD failures during the chain read still get
  // retried (parity with cosmosQuery's params reads) without nesting a second
  // ladder around its client acquisition (ENG-679).
  const buildContext = await loadBuildContext(
    clientManager,
    module,
    subcommand,
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
  return clientManager.withBroadcastLock(senderAddress, async () => {
    // Broadcast client — manages the signer's sequence for non-blocking (SYNC) broadcasts so a
    // burst of waitForConfirmation:false txs from one signer doesn't collide on the committed
    // sequence. Serialized per signer by the surrounding withBroadcastLock. See getBroadcastClient.
    //
    // Acquired INSIDE the lock (serialization must cover the whole cycle) but OUTSIDE the ladder
    // below: getSigningClient owns connect-retry, and nesting the two multiplied attempts
    // (ENG-679). The sequenced client is a stateless proxy — all sequence-cache access happens
    // per broadcast call — so reusing it across attempts is safe.
    let signingClient: Awaited<
      ReturnType<CosmosClientManager['getBroadcastClient']>
    >;
    try {
      signingClient = await clientManager.getBroadcastClient();
    } catch (error) {
      throw enrichTxError(error, module, subcommand, args);
    }

    return withRetry(
      async () => {
        // The handler leg runs inside the try/catch so a failure is wrapped with
        // {module, subcommand, args} attribution, matching the acquisition leg above.
        try {
          await clientManager.acquireRateLimit();
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
    );
  });
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
  // tokens per simulate retry. loadBuildContext owns its own withRetry over
  // the loader call, so transient LCD failures during the chain read still get
  // retried (parity with cosmosQuery's params reads) without nesting a second
  // ladder around its client acquisition (ENG-679).
  const buildContext = await loadBuildContext(
    clientManager,
    module,
    subcommand,
  );

  // Acquired ONCE, outside the ladder below — getSigningClient owns connect-retry
  // (ENG-679). `getAddress` stays inside: it is a wallet call whose failures are
  // non-retryable WALLET_* codes, so it cannot amplify.
  let signingClient: Awaited<
    ReturnType<CosmosClientManager['getSigningClient']>
  >;
  try {
    signingClient = await clientManager.getSigningClient();
  } catch (error) {
    throw enrichEstimateError(error, module, subcommand, args);
  }

  return withRetry(
    async () => {
      // The rate-limit + address acquisition runs inside the try/catch so a
      // failure during any of those steps is wrapped with {module, subcommand,
      // args} attribution, matching the acquisition leg above. Otherwise a
      // wallet error would propagate without telling the caller which estimate
      // was being computed.
      try {
        await clientManager.acquireRateLimit();
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
        throw enrichEstimateError(error, module, subcommand, args);
      }
    },
    {
      config: config.retry,
      operationName: `estimate ${module} ${subcommand}`,
    },
  );
}
