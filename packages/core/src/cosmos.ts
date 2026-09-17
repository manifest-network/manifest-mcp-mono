import { calculateFee, type StdFee } from '@cosmjs/stargate';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import { DEFAULT_GAS_MULTIPLIER } from './config.js';
import { attributeBroadcastFailure } from './internals/broadcast-failure.js';
import { isNotFoundError } from './internals/classify-query-error.js';
import { markErrorInspectionFailure } from './internals/error-inspection-failure.js';
import {
  guardedField,
  readableTxEvidence,
  snapshotErrorDetails,
} from './internals/guarded-error-fields.js';
import { redactPossibleMnemonic } from './internals/redact-mnemonic.js';
import {
  guardTxClient,
  type TxExecution,
  withTxExecution,
} from './internals/tx-confirmation.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';
import type { CallOptions } from './options.js';
import { withRetry } from './retry.js';
import { resolveBroadcastGasOptions } from './transactions/utils.js';
import {
  type CosmosQueryResult,
  type CosmosTxResult,
  type FeeEstimateResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxBuildContext,
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
  execution?: TxExecution,
): Promise<TxBuildContext | undefined> {
  const loader = getTxContextLoader(module, subcommand);
  if (!loader) return undefined;

  let queryClient: ManifestQueryClient;
  try {
    queryClient = await clientManager.getQueryClient();
    execution?.checkpoint();
  } catch (error) {
    throw enrichBuildContextError(error, module, subcommand);
  }

  return withRetry(
    async () => {
      // The loader call runs inside the try/catch so every failure mode gets
      // the {module, subcommand} attribution callers expect from a structured
      // error, matching the acquisition leg above.
      try {
        execution?.checkpoint();
        await clientManager.acquireRateLimit(execution?.signal);
        execution?.checkpoint();
        const context = await loader(queryClient);
        execution?.checkpoint();
        return context;
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

/** Preserve readable attribution; contain each diagnostic failure independently. */
function enrichOperationError(
  error: unknown,
  prefix: string,
  details: Record<string, unknown>,
  fallbackCode: ManifestMCPErrorCode,
  options: {
    transaction?: boolean;
    classifyRaw?: (error: unknown) => ManifestMCPErrorCode;
  } = {},
): ManifestMCPError {
  let unreadable = false;
  if (options.transaction) {
    try {
      const owned = attributeBroadcastFailure(error, prefix, details);
      if (owned) return owned;
    } catch {
      unreadable = true;
    }
  }

  let sdk = false;
  try {
    sdk = error instanceof ManifestMCPError;
  } catch {
    unreadable = true;
  }
  const codeField = sdk ? guardedField(error, 'code') : undefined;
  const sdkCode =
    codeField?.ok && typeof codeField.value === 'string'
      ? (codeField.value as ManifestMCPErrorCode)
      : undefined;
  const malformedCode = sdk && sdkCode === undefined && codeField?.ok === true;
  if (sdk && sdkCode === undefined && !malformedCode) unreadable = true;

  let message = 'Error message unavailable';
  let rawMessage: unknown;
  try {
    rawMessage = error instanceof Error ? error.message : String(error);
    message = String(rawMessage);
  } catch {
    unreadable = true;
  }
  // Coercing a non-string message can introduce transient text that its
  // original classifier never recognized. Normalization cannot authorize retries.
  if (typeof rawMessage !== 'string') unreadable = true;

  const detailsField = sdk ? guardedField(error, 'details') : undefined;
  const snapshot = snapshotErrorDetails(
    detailsField?.ok ? detailsField.value : undefined,
  );
  if (sdk && (!detailsField?.ok || !snapshot.readable)) unreadable = true;
  const readableDetails = detailsField?.ok
    ? snapshot.value
    : readableTxEvidence(error);

  if (sdk && !unreadable && !malformedCode) {
    if (snapshot.module) return error as ManifestMCPError;
    return new ManifestMCPError(sdkCode ?? fallbackCode, message, {
      ...readableDetails,
      ...details,
    });
  }

  let code = options.transaction ? fallbackCode : (sdkCode ?? fallbackCode);
  if (!sdk && options.classifyRaw) {
    try {
      code = options.classifyRaw(error);
    } catch {
      unreadable = true;
    }
  }
  const normalized = new ManifestMCPError(
    code,
    `${prefix}${redactPossibleMnemonic(message)}`,
    {
      ...(sdk ? readableDetails : unreadable ? readableTxEvidence(error) : {}),
      ...details,
    },
  );
  // Adding causes to readable wrappers changes retry policy. Only retain the
  // original when its diagnostics forced this normalization.
  // Invalid SDK codes have no reliable retry contract either: changing one to
  // QUERY_FAILED must not grant HTTP 408 or message-based retry permission.
  if (unreadable || malformedCode) markErrorInspectionFailure(normalized);
  if (unreadable || (options.transaction && malformedCode)) {
    Object.defineProperty(normalized, 'cause', {
      value: error,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}

/** Attribute a query-leg failure. Raw throws classify as NOT_FOUND or QUERY_FAILED. */
function enrichQueryError(
  error: unknown,
  module: string,
  subcommand: string,
): ManifestMCPError {
  return enrichOperationError(
    error,
    `Query ${module} ${subcommand} failed: `,
    { module, subcommand },
    ManifestMCPErrorCode.QUERY_FAILED,
    {
      classifyRaw: (raw) =>
        isNotFoundError(raw)
          ? ManifestMCPErrorCode.NOT_FOUND
          : ManifestMCPErrorCode.QUERY_FAILED,
    },
  );
}

/** Attribute a build-context failure. Raw throws classify as QUERY_FAILED. */
function enrichBuildContextError(
  error: unknown,
  module: string,
  subcommand: string,
): ManifestMCPError {
  return enrichOperationError(
    error,
    `Failed to load build context for ${module} ${subcommand}: `,
    { module, subcommand },
    ManifestMCPErrorCode.QUERY_FAILED,
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

/** Attribute a tx failure, retaining submission facts and forbidding malformed-error replay. */
function enrichTxError(
  error: unknown,
  module: string,
  subcommand: string,
  args: string[],
): ManifestMCPError {
  return enrichOperationError(
    error,
    `Tx ${module} ${subcommand} failed: `,
    { module, subcommand, args },
    ManifestMCPErrorCode.TX_FAILED,
    { transaction: true },
  );
}

/** Attribute an estimate failure; readable transient simulation errors still retry. */
function enrichEstimateError(
  error: unknown,
  module: string,
  subcommand: string,
  args: string[],
): ManifestMCPError {
  return enrichOperationError(
    error,
    `Fee estimation for ${module} ${subcommand} failed: `,
    { module, subcommand, args },
    ManifestMCPErrorCode.SIMULATION_FAILED,
  );
}

/**
 * Execute a Cosmos transaction via manifestjs signing client
 *
 * Client acquisition retries eligible connection failures separately. The
 * transaction leg uses the shared retry classifier and `config.retry`; raw
 * failures become non-retryable `TX_FAILED` errors. Permanent errors and
 * partial/submitted outcomes veto retry.
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
  callOptions?: CallOptions,
): Promise<CosmosTxResult> {
  validateName(module, 'module', ManifestMCPErrorCode.UNSUPPORTED_TX);
  validateName(subcommand, 'subcommand', ManifestMCPErrorCode.UNSUPPORTED_TX);

  // ENG-665 / ENG-744: resolve the explicit-fee and simulated-fee branches
  // through the same guard used by the direct executeTx broadcaster.
  const config = clientManager.getConfig();
  const txOptions = resolveBroadcastGasOptions(config, {
    fee: txExtras?.fee,
    gasMultiplier: overrides?.gasMultiplier,
  });

  return withTxExecution(async (execution) => {
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
      execution,
    );
    execution.checkpoint();

    // Resolve the sender ONCE — it is both the broadcast-lock key and the signAndBroadcast sender.
    // Resolve BEFORE the lock so the per-signer mutex can key on it; enrich a wallet failure with the
    // same {module,subcommand,args} attribution the broadcast leg uses.
    let senderAddress: string;
    try {
      senderAddress = await clientManager.getAddress();
    } catch (error) {
      throw enrichTxError(error, module, subcommand, args);
    }

    execution.checkpoint();
    // Per-signer broadcast mutex (OUTER) serializes the whole simulate→sign→broadcast→commit cycle
    // for this address; acquireRateLimit stays INNER. Acquired ONCE around withRetry.
    return clientManager.withBroadcastLock(senderAddress, async () => {
      execution.checkpoint();
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
        signingClient = guardTxClient(
          await clientManager.getBroadcastClient(execution.onAccepted),
          execution,
        );
        execution.checkpoint();
      } catch (error) {
        throw enrichTxError(error, module, subcommand, args);
      }

      return withRetry(
        async () => {
          // The handler leg runs inside the try/catch so a failure is wrapped with
          // {module, subcommand, args} attribution, matching the acquisition leg above.
          try {
            execution.checkpoint();
            await clientManager.acquireRateLimit(execution.signal);
            execution.checkpoint();
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
            execution.checkpoint();
            throw enrichTxError(error, module, subcommand, args);
          }
        },
        {
          config: config.retry,
          operationName: `tx ${module} ${subcommand}`,
        },
      );
    });
  }, callOptions);
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
