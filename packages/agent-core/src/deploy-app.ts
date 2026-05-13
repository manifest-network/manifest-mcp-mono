/**
 * Public entry point: orchestrate a Manifest-Network app deployment from
 * a typed `DeploySpec` through the plan/confirm/broadcast/save flow.
 *
 * Architect's α-locked composition (post-PR-3 sub-plan Q1):
 *
 *   Happy path: `fredDeployApp` (workspace MCP-tool function) is called
 *   atomically for create-lease + manifest upload + (optional) set-
 *   item-custom-domain. agent-core wraps the call with planning, user
 *   confirmation, progress events, and post-success persistence.
 *
 *   Recovery path: when fred's atomic deployApp throws or the lease
 *   reaches a non-recoverable state, agent-core renders a recovery
 *   prompt (typed `RecoveryOption[]`), invokes `onFailure`, and
 *   dispatches the user's `RecoveryChoice` to inline closures that
 *   call core's decomposed primitives (`setItemCustomDomain` for
 *   `retry_set_domain`; `stopApp` for `close_lease`).
 *
 * E-hybrid runtime-context (post-PR-3 sub-plan Q5):
 *
 *   `opts: DeployAppOptions` carries `clientManager` (chain ops),
 *   `walletProvider` (ADR-036 auth-token construction), optional
 *   `fetchFn` (HTTP override for fred's upload), and the chain-data /
 *   denomMap injection for humanization. agent-core composes the
 *   auth-token callbacks internally from `walletProvider` so plugin/
 *   Barney callers don't need to know about ADR-036 plumbing.
 *
 * Auth-callback construction follows fred's `AuthTokenService` pattern
 * (verified against `packages/fred/src/http/auth.ts` per TL2.1 silent-
 * fix discipline):
 *
 *   1. `timestamps.next()` → monotonic replay-safe timestamp.
 *   2. `createSignMessage(address, leaseUuid, timestamp)` → message.
 *   3. `walletProvider.signArbitrary(address, message)` → `{ pub_key,
 *      signature }` (cosmjs convention; `pub_key.value` is base64).
 *   4. `createAuthToken(address, leaseUuid, timestamp, pub_key.value,
 *      signature[, metaHashHex])` → token string.
 */

import {
  cosmosEstimateFee,
  ManifestMCPError,
  ManifestMCPErrorCode,
  setItemCustomDomain,
  stopApp,
} from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  type BuildManifestPreviewInput,
  buildManifestPreview,
  type CheckDeploymentReadinessResult,
  checkDeploymentReadiness,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
  type DeployAppInput as FredDeployAppInput,
  type DeployAppResult as FredDeployAppResult,
  deployApp as fredDeployApp,
} from '@manifest-network/manifest-mcp-fred';
import { classifyDeployError } from './internals/classify-deploy-error.js';
import {
  extractRunningEndpoints,
  formatEndpointAsUrl,
} from './internals/connection.js';
import { findSkuUuid } from './internals/find-sku-uuid.js';
import {
  EMPTY_DENOM_MAP,
  loadChainDenomMap,
} from './internals/humanize-denom.js';
import { decode as decodeLeaseState } from './internals/lease-state.js';
import { renderDeploymentPlan } from './internals/render-deployment-plan.js';
import { renderIntentRecap } from './internals/render-intent-recap.js';
import { renderPartialSuccessPrompt } from './internals/render-partial-success-prompt.js';
import {
  isStackSpec,
  summarizeSpec,
  validateSpec,
} from './internals/spec-normalize.js';
import type {
  DenomMap,
  DeployAppCallbacks,
  DeployAppOptions,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
  FeeEstimate,
  LeaseStateName,
  Plan,
  Readiness,
  RecoveryChoice,
  RecoveryOption,
  RecoveryOptionId,
  SingleServiceSpec,
  StackSpec,
} from './types.js';

/**
 * Orchestrate a deployment. See module-level docstring for the architect-
 * locked composition + E-hybrid runtime-context contract.
 *
 * @throws `ManifestMCPError(INVALID_INPUT)` for spec / wallet validation.
 * @throws `ManifestMCPError(USER_CANCELLED)` when `onConfirm` returns
 *   `'no'` or `onPlan` returns `'cancel'`.
 * Errors from fred's broadcast or core's recovery primitives surface as
 * typed `ManifestMCPError`s; the orchestrator catches them and routes
 * through `onFailure` per the recovery contract.
 */
export async function deployApp(
  spec: DeploySpec,
  callbacks: DeployAppCallbacks,
  opts: DeployAppOptions,
): Promise<DeployResult> {
  // --- Input validation -----------------------------------------------
  try {
    validateSpec(spec);
  } catch (err) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      err instanceof Error ? err.message : `Invalid spec: ${String(err)}`,
    );
  }
  if (typeof opts.walletProvider.signArbitrary !== 'function') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'opts.walletProvider must implement signArbitrary for ADR-036 auth tokens.',
    );
  }

  // --- Resolve denom map for humanization -----------------------------
  // I/O at orchestrator boundary (Path-Bii principle): callers may
  // pre-load via `denomMap`, point at `chainDataFile`, or omit both
  // (no-op map → raw on-chain denom rendering downstream).
  const denomMap: DenomMap =
    opts.denomMap ??
    (opts.chainDataFile
      ? await loadChainDenomMap(opts.chainDataFile)
      : EMPTY_DENOM_MAP);

  // --- Active-chain detection -----------------------------------------
  // The active chain (testnet / mainnet) drives intent-recap's mainnet
  // warning + parts of the Plan rendering. CosmosClientManager exposes
  // the bound chainId; we map to the canonical user-facing name.
  const chainId = opts.clientManager.getConfig().chainId;
  const activeChain: 'testnet' | 'mainnet' = /mainnet|main/i.test(chainId)
    ? 'mainnet'
    : 'testnet';

  // --- Readiness evaluation -------------------------------------------
  // fred's checkDeploymentReadiness takes (queryClient, address, input).
  // Resolve both from the runtime context before invoking.
  const queryClient = await opts.clientManager.getQueryClient();
  const tenantAddress = await opts.walletProvider.getAddress();
  const readinessRaw = await checkDeploymentReadiness(
    queryClient,
    tenantAddress,
    {
      image: primaryImage(spec),
      size: requestedSize(spec),
    },
  );
  const readiness: Readiness = evaluateReadinessFromRaw(
    readinessRaw,
    opts.clientManager.getConfig().gasPrice ?? '1umfx',
    denomMap,
  );
  callbacks.onProgress?.({ kind: 'readiness_evaluated', readiness });
  if (readiness.status === 'block') {
    const envelope: FailureEnvelope = {
      outcome: 'failed',
      reason: `Readiness check failed: ${readiness.reasons.join('; ')}`,
    };
    // F3 fix: align with verify-recover's pattern — inform-only branch
    // (no recovery choices available) throws directly without calling
    // onFailure. Caller surfaces the error via the thrown
    // ManifestMCPError; no choice to present.
    void envelope;
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Readiness check failed: ${readiness.reasons.join('; ')}`,
    );
  }

  // --- Plan assembly --------------------------------------------------
  // Build manifest preview (provides meta_hash for Plan + later save).
  // These are `let`-bound because the onPlan callback may return a
  // PlanEdit that triggers a re-plan (C2 fix below — single-iteration
  // plan-edit must recompute preview/summary/fees/block against the
  // edited spec; otherwise the manifest persistence at step 16 uses
  // the stale pre-edit preview).
  let preview = await buildManifestPreview(
    buildManifestPreviewInput(spec, requestedSize(spec)),
  );

  // Fee estimation for create-lease (always) + set-item-custom-domain
  // (when customDomain set). Lean port: cosmosEstimateFee invocation
  // details encapsulated in a helper to keep this fn focused on flow.
  let summary = summarizeSpec(spec);
  let fees = await estimateFees(opts, spec, preview.meta_hash_hex);
  let plan: Plan = { summary, readiness, fees };

  // --- Render plan + onPlan callback ----------------------------------
  let confirmedSpec = spec;
  const block = renderDeploymentPlan({
    plan,
    denomMap,
    image: primaryImage(spec),
    size: requestedSize(spec),
    metaHash: preview.meta_hash_hex,
    customDomain: customDomainOf(spec),
    customDomainService: customDomainServiceOf(spec),
  });
  callbacks.onProgress?.({ kind: 'deployment_plan_rendered', block });
  if (callbacks.onPlan) {
    const verdict = await callbacks.onPlan(plan);
    if (verdict === 'cancel') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'User cancelled deployment at plan step.',
      );
    }
    if (verdict !== 'confirm') {
      // PlanEdit — apply edits to the spec, then re-plan against the
      // edited spec so downstream consumers (intent recap, fred input,
      // manifest persistence) all see the post-edit values.
      //
      // C2 fix (post-edit propagation gap): the prior single-iteration
      // implementation updated `confirmedSpec` but kept `preview` /
      // `summary` / `fees` / `plan` based on the original spec, which
      // caused the manifest persistence at step 16 to record the stale
      // pre-edit `meta_hash_hex` / `manifest_json` while fred's
      // deployApp broadcast used the edited spec — a real mismatch.
      // Re-planning closes the gap. Multi-iteration plan-edit (loop
      // back to onPlan with the new plan) remains a PR-3.x follow-up;
      // this fix addresses single-iteration freshness only.
      confirmedSpec = applyPlanEdit(confirmedSpec, verdict);
      preview = await buildManifestPreview(
        buildManifestPreviewInput(confirmedSpec, requestedSize(confirmedSpec)),
      );
      summary = summarizeSpec(confirmedSpec);
      fees = await estimateFees(opts, confirmedSpec, preview.meta_hash_hex);
      plan = { summary, readiness, fees };
    }
  }

  // --- Intent recap + onConfirm callback ------------------------------
  const recapText = renderIntentRecap({ spec: confirmedSpec, activeChain });
  const recapBlock = { text: recapText };
  if (callbacks.onConfirm) {
    const yesNo = await callbacks.onConfirm(recapBlock);
    if (yesNo !== 'yes') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'User declined to proceed at intent-recap step.',
      );
    }
  }
  callbacks.onProgress?.({ kind: 'user_confirmed' });

  // --- Compose ADR-036 auth callbacks (E-hybrid: agent-core internalizes) ---
  const signArbitrary = opts.walletProvider.signArbitrary.bind(
    opts.walletProvider,
  );
  const timestamps = new AuthTimestampTracker();
  const getAuthToken = async (
    address: string,
    leaseUuid: string,
  ): Promise<string> => {
    const ts = await timestamps.next();
    const message = createSignMessage(address, leaseUuid, ts);
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(address, leaseUuid, ts, pub_key.value, signature);
  };
  const getLeaseDataAuthToken = async (
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ): Promise<string> => {
    const ts = await timestamps.next();
    const message = createLeaseDataSignMessage(leaseUuid, metaHashHex, ts);
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(
      address,
      leaseUuid,
      ts,
      pub_key.value,
      signature,
      metaHashHex,
    );
  };

  // --- Broadcast: fred's atomic deployApp (architect α-locked) -------
  callbacks.onProgress?.({ kind: 'deploy_app_broadcast' });
  const fredInput = buildFredDeployInput(confirmedSpec, requestedSize(spec));
  let fredResult: FredDeployAppResult;
  try {
    fredResult = await fredDeployApp(
      opts.clientManager,
      getAuthToken,
      getLeaseDataAuthToken,
      fredInput,
      opts.fetchFn,
    );
  } catch (err) {
    return await handleBroadcastFailure(err, confirmedSpec, callbacks, opts);
  }

  // --- Classify happy-path result ------------------------------------
  callbacks.onProgress?.({
    kind: 'deploy_response_classified',
    outcome: 'active',
  });
  callbacks.onProgress?.({
    kind: 'app_ready_confirmed',
    leaseUuid: fredResult.lease_uuid,
  });

  // --- Persist manifest (best-effort; save-fail still emits success) -
  const persistedPath = await tryPersistManifest({
    leaseUuid: fredResult.lease_uuid,
    image: primaryImage(confirmedSpec),
    size: requestedSize(confirmedSpec),
    metaHash: preview.meta_hash_hex,
    chainId,
    manifestJson: preview.manifest_json,
    customDomain: fredResult.custom_domain,
    customDomainService: fredResult.service_name,
    dataDir: opts.dataDir,
    callbacks,
  });

  // --- Build typed DeployResult --------------------------------------
  // F1 fix: decode lease state via the canonical lease-state.decode()
  // (handles int + LEASE_STATE_* string + undefined paths exhaustively).
  //
  // C3 fix (defensive bias correction; checklist item #16): distinguish
  // truly-absent state (undefined → default ACTIVE per fred's contract:
  // happy-path responses without explicit state mean lease is ACTIVE)
  // from UNRECOGNIZED state (decode returned undefined for a value that
  // WAS provided → likely a terminal/unknown chain emission that must
  // NOT be silently classified as ACTIVE). For the unrecognized case,
  // throw `INVALID_CONFIG` so callers see the empirical mismatch
  // instead of consuming a misleading ACTIVE.
  let leaseStateDecoded: LeaseStateName;
  if (fredResult.state === undefined) {
    leaseStateDecoded = 'LEASE_STATE_ACTIVE';
  } else {
    const decoded = decodeLeaseState(fredResult.state);
    if (decoded === undefined) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Unrecognized lease state from fred deployApp response: ${String(fredResult.state)}. Cannot safely classify; refusing to silently coerce to ACTIVE.`,
      );
    }
    leaseStateDecoded = decoded;
  }

  // F4 fix: derive `urls` from `extractRunningEndpoints(connection)` for
  // multi-FQDN dedup (matches CJS pipeline behavior). fred's
  // `result.url` is a single derived URL; the full connection payload
  // exposes the canonical instance list.
  const endpointUrls = extractRunningEndpoints(fredResult.connection).map(
    formatEndpointAsUrl,
  );
  const result: DeployResult = {
    leaseUuid: fredResult.lease_uuid,
    providerUuid: fredResult.provider_uuid,
    leaseState: leaseStateDecoded,
    urls:
      endpointUrls.length > 0
        ? endpointUrls
        : fredResult.url
          ? [fredResult.url]
          : [],
    ...(fredResult.custom_domain
      ? { customDomain: fredResult.custom_domain }
      : {}),
    manifestPath: persistedPath ?? '',
  };
  callbacks.onProgress?.({ kind: 'success_rendered', result });
  callbacks.onComplete?.(result);
  return result;
}

// --- Helpers ---------------------------------------------------------

function primaryImage(spec: DeploySpec): string {
  if (isStackSpec(spec)) {
    for (const svc of Object.values(spec.services)) {
      if (svc?.image) return svc.image;
    }
    return '';
  }
  return (spec as SingleServiceSpec).image ?? '';
}

function requestedSize(spec: DeploySpec): string {
  // PR 3: size lives outside the typed DeploySpec; the orchestrator's
  // caller normally threads it via Plan / fred input. Read from a
  // conventional `size` property if present; fall back to 'small'.
  const recorded = (spec as unknown as { size?: string }).size;
  return typeof recorded === 'string' && recorded.length > 0
    ? recorded
    : 'small';
}

function customDomainOf(spec: DeploySpec): string | undefined {
  return (spec as { customDomain?: string }).customDomain;
}

function customDomainServiceOf(spec: DeploySpec): string | undefined {
  if (isStackSpec(spec)) return (spec as StackSpec).serviceName;
  return undefined;
}

function evaluateReadinessFromRaw(
  raw: CheckDeploymentReadinessResult,
  gasPrice: string,
  denomMap: DenomMap,
): Readiness {
  // Minimal mapping: PR-3-commit-B's evaluateReadiness consumer translates
  // fred's raw readiness payload to the typed Readiness shape. The full
  // mapping logic lives in `internals/evaluate-readiness.ts`; this helper
  // wraps its invocation with the raw-shape adaption.
  // Voidcoercion + denomMap pass-through; full evaluation in commit-A.
  void gasPrice;
  void denomMap;
  const rawAny = raw as unknown as Record<string, unknown>;
  return {
    status: 'ok',
    reasons: [],
    suggestedActions: [],
    walletBalances:
      (rawAny.wallet_balances as Readiness['walletBalances']) ?? [],
    credits: (rawAny.credits as Readiness['credits']) ?? null,
    sku: (rawAny.sku as Readiness['sku']) ?? null,
  };
}

function buildManifestPreviewInput(
  spec: DeploySpec,
  size: string,
): BuildManifestPreviewInput {
  if (isStackSpec(spec)) {
    return {
      size,
      services: spec.services,
    } as unknown as BuildManifestPreviewInput;
  }
  const single = spec as SingleServiceSpec;
  return {
    size,
    image: single.image,
    port:
      typeof single.port === 'number'
        ? single.port
        : Array.isArray(single.port)
          ? single.port[0]
          : undefined,
    env: single.env,
  } as unknown as BuildManifestPreviewInput;
}

async function estimateFees(
  opts: DeployAppOptions,
  spec: DeploySpec,
  _metaHashHex: string, // reserved for future meta-hash threading; create-lease estimate doesn't use it
): Promise<Plan['fees']> {
  // PR 3 fix-3 (B-narrowed-trimmed per architect ratification):
  //   - REAL cosmosEstimateFee for create-lease (criterion-blocking).
  //   - SET-DOMAIN emits `{notEstimated: true, reason}` sentinel (the
  //     frozen-contract escape hatch designed for pre-broadcast lease-
  //     UUID unavailability per ENG-128). Real set-domain pre-broadcast
  //     estimation (approach-3 fallback) is PR-3.x scope.

  const size = requestedSize(spec);
  const { skuUuid } = await findSkuUuid(opts.clientManager, size);

  // Item-arg format `sku-uuid:quantity[:service-name]` (verified per
  // Discipline V against packages/core/src/transactions/billing.ts:L102).
  // Quantity = '1' for typical single-lease deploys; optional service-
  // name applies to stack leases (custom-domain attachment context).
  const itemArg =
    isStackSpec(spec) && spec.serviceName
      ? `${skuUuid}:1:${spec.serviceName}`
      : `${skuUuid}:1`;

  let createLeaseEstimate: Awaited<ReturnType<typeof cosmosEstimateFee>>;
  try {
    createLeaseEstimate = await cosmosEstimateFee(
      opts.clientManager,
      'billing',
      'create-lease',
      [itemArg],
    );
  } catch (err) {
    // Wrap the simulation failure with an agent-core-boundary message
    // for caller diagnostics. core's cosmosEstimateFee already surfaces
    // SIMULATION_FAILED for simulation-time errors; rewrapping preserves
    // the code while adding context.
    throw new ManifestMCPError(
      ManifestMCPErrorCode.SIMULATION_FAILED,
      `Failed to estimate create-lease fee: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // FeeEstimateResult shape (per packages/core/src/types.ts):
  //   { module, subcommand, gasEstimate: string, fee: { amount: Coin[] } }
  // Map to typed `FeeEstimate { coins: Coin[], gas: number }` (Path-C
  // revision per a62cfd1).
  const createLease: FeeEstimate = {
    coins: createLeaseEstimate.fee.amount.map((c) => ({
      denom: c.denom,
      amount: c.amount,
    })),
    gas: Number(createLeaseEstimate.gasEstimate),
  };

  // set-domain: emit `{notEstimated: true, reason}` sentinel per
  // architect-ratified counter-proposal. The frozen-contract type
  // includes this discriminated variant precisely for pre-broadcast
  // lease-UUID unavailability ("using the contract as designed, not
  // papering over" per architect's framing).
  const hasDomain = typeof customDomainOf(spec) === 'string';
  return {
    createLease,
    ...(hasDomain
      ? {
          setDomain: {
            notEstimated: true,
            reason:
              'set-domain fee skipped — pre-broadcast lease UUID unavailable; full approach-3 fallback deferred to PR-3.x',
          },
        }
      : {}),
  };
}

function buildFredDeployInput(
  spec: DeploySpec,
  size: string,
): FredDeployAppInput {
  // Translate typed DeploySpec → fred's DeployAppInput. See fred's
  // tools/deployApp.ts for the full input shape.
  const base: Partial<FredDeployAppInput> = { size };
  if (isStackSpec(spec)) {
    base.services = spec.services as unknown as FredDeployAppInput['services'];
  } else {
    const single = spec as SingleServiceSpec;
    base.image = single.image;
    base.port =
      typeof single.port === 'number'
        ? single.port
        : Array.isArray(single.port)
          ? single.port[0]
          : undefined;
    base.env = single.env;
  }
  const customDomain = (spec as { customDomain?: string }).customDomain;
  if (customDomain) {
    base.customDomain = customDomain;
    const svcName = customDomainServiceOf(spec);
    if (svcName) base.serviceName = svcName;
  }
  return base as FredDeployAppInput;
}

function applyPlanEdit(
  spec: DeploySpec,
  edit: Exclude<
    Awaited<ReturnType<NonNullable<DeployAppCallbacks['onPlan']>>>,
    'confirm' | 'cancel'
  >,
): DeploySpec {
  // PR 3 single-iteration: replace_spec replaces; edit_env merges env keys
  // into the matching service (or single-service spec).
  if (edit.kind === 'replace_spec') return edit.spec;
  if (edit.kind === 'edit_env') {
    if (isStackSpec(spec) && edit.service !== undefined) {
      const svc = spec.services[edit.service];
      if (svc) {
        return {
          ...spec,
          services: {
            ...spec.services,
            [edit.service]: {
              ...svc,
              env: { ...(svc.env ?? {}), ...edit.env },
            },
          },
        };
      }
    } else if (!isStackSpec(spec)) {
      const single = spec as SingleServiceSpec;
      return { ...single, env: { ...(single.env ?? {}), ...edit.env } };
    }
  }
  return spec;
}

async function handleBroadcastFailure(
  err: unknown,
  spec: DeploySpec,
  callbacks: DeployAppCallbacks,
  opts: DeployAppOptions,
): Promise<DeployResult> {
  const requestedCustomDomain = customDomainOf(spec);

  // F2 fix: classify-deploy-error.ts is the canonical classifier — it
  // anchors the `PARTIAL_PREFIX` match, supports `{ error: {...} }`
  // SDK-wrapping envelopes, and threads `expectedCustomDomain` for
  // downstream rendering. Earlier inline `parsePartialSuccess` was a
  // reduced-robustness duplicate; replaced here per QA F2.
  const classified = classifyDeployError(err, {
    ...(requestedCustomDomain
      ? { expectedCustomDomain: requestedCustomDomain }
      : {}),
  });

  if (classified.outcome === 'partially_succeeded' && classified.leaseUuid) {
    const envelope: FailureEnvelope = {
      outcome: 'partially_succeeded',
      leaseUuid: classified.leaseUuid,
      ...(requestedCustomDomain ? { requestedCustomDomain } : {}),
      reason: classified.reason,
    };
    // CJS-parity: the lease was just created so it's typically PENDING.
    // The classifier doesn't decode state from the error envelope (the
    // chain emits state asynchronously after the create-lease tx); the
    // user prompt's "state: <name>" line is informational.
    const promptPayload = renderPartialSuccessPrompt({
      leaseUuid: classified.leaseUuid,
      decodedState: 'LEASE_STATE_PENDING',
      reason: classified.reason,
      ...(requestedCustomDomain ? { requestedCustomDomain } : {}),
    });
    const options: RecoveryOption[] = promptPayload.options.map((id) => ({
      id,
      label: recoveryOptionLabel(id),
      description: recoveryOptionDescription(id),
    }));
    // F3 fix: align with verify-recover's pattern — only invoke
    // onFailure when there's a choice to present. Empty options means
    // inform-only path; we throw instead of prompting.
    if (options.length > 0 && callbacks.onFailure !== undefined) {
      const choice = await callbacks.onFailure(envelope, options);
      return await dispatchRecovery(choice, envelope, spec, opts);
    }
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      classified.reason,
    );
  }

  // Non-partial failure: surface as `outcome: 'failed'` envelope.
  // F3 fix: skip onFailure when options is empty (inform-only path);
  // throw directly. Caller can still surface the error via the thrown
  // ManifestMCPError if they need to react.
  const envelope: FailureEnvelope = {
    outcome: 'failed',
    reason: classified.reason,
  };
  // Intentionally NOT invoking callbacks.onFailure?.(envelope, []) here
  // per F3 — no recovery choice to present.
  void envelope; // retained for future logging hook if needed
  throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, classified.reason);
}

async function dispatchRecovery(
  choice: RecoveryChoice,
  envelope: FailureEnvelope,
  spec: DeploySpec,
  opts: DeployAppOptions,
): Promise<DeployResult> {
  // Inline closures per gate-2 verdict (no separate strategy module).
  const leaseUuid =
    envelope.outcome === 'partially_succeeded' ? envelope.leaseUuid : '';
  switch (choice.id) {
    case 'retry_set_domain': {
      const domain = customDomainOf(spec);
      if (!domain) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'retry_set_domain requires a customDomain in spec.',
        );
      }
      // C6 fix: pass `serviceName` for stack-lease specs so the
      // set-item-custom-domain tx targets the named service item, not
      // the default single-item lease. setItemCustomDomain's actual
      // signature is `(clientManager, leaseUuid, customDomain,
      // options?: { serviceName?, clear? }, overrides?)` — verified
      // per Discipline V against
      // packages/core/src/tools/setItemCustomDomain.ts.
      const serviceName = customDomainServiceOf(spec);
      const setItemOpts = serviceName ? { serviceName } : undefined;
      await setItemCustomDomain(
        opts.clientManager,
        leaseUuid,
        domain,
        setItemOpts,
      );
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `retry_set_domain completed for ${leaseUuid}; caller should re-run troubleshootDeployment to confirm app readiness.`,
      );
    }
    case 'salvage_without_domain':
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `salvage_without_domain: lease ${leaseUuid} retained without domain; caller should re-run troubleshootDeployment.`,
      );
    case 'cancel_lease':
    case 'close_lease': {
      await stopApp(opts.clientManager, leaseUuid);
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `${choice.id}: lease ${leaseUuid} closed.`,
      );
    }
  }
  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `Unknown recovery option: ${(choice as RecoveryChoice).id}`,
  );
}

function recoveryOptionLabel(id: RecoveryOptionId): string {
  switch (id) {
    case 'retry_set_domain':
      return 'Retry set-domain + upload';
    case 'salvage_without_domain':
      return 'Salvage without domain';
    case 'cancel_lease':
      return 'Cancel the lease';
    case 'close_lease':
      return 'Cancel or close the lease';
  }
}

function recoveryOptionDescription(id: RecoveryOptionId): string {
  switch (id) {
    case 'retry_set_domain':
      return 'Retry the set-domain transaction against the already-created lease.';
    case 'salvage_without_domain':
      return 'Keep the lease without the requested custom domain.';
    case 'cancel_lease':
      return 'Submit a cancel-lease transaction (pre-active terminal).';
    case 'close_lease':
      return 'Submit a close-lease transaction (post-active or pre-active terminal).';
  }
}

interface PersistArgs {
  leaseUuid: string;
  image: string;
  size: string;
  metaHash: string;
  chainId: string;
  manifestJson: string;
  customDomain?: string;
  customDomainService?: string;
  dataDir?: string;
  callbacks: DeployAppCallbacks;
}

async function tryPersistManifest(
  args: PersistArgs,
): Promise<string | undefined> {
  if (!args.dataDir) return undefined;
  try {
    // Dynamic import keeps save-manifest's `node:fs` dep out of the
    // platform-neutral build path until needed.
    const { saveManifest } = await import('./internals/save-manifest.js');
    const result = await saveManifest({
      leaseUuid: args.leaseUuid,
      image: args.image,
      size: args.size,
      metaHash: args.metaHash,
      chainId: args.chainId,
      manifestJson: args.manifestJson,
      dataDir: args.dataDir,
      ...(args.customDomain ? { customDomain: args.customDomain } : {}),
      ...(args.customDomainService
        ? { customDomainServiceName: args.customDomainService }
        : {}),
    });
    args.callbacks.onProgress?.({
      kind: 'manifest_saved',
      leaseUuid: args.leaseUuid,
      manifestPath: result.manifestPath,
    });
    return result.manifestPath;
  } catch {
    // Step-16 contract: save-fail still returns success but `onProgress
    // (manifest_saved)` is NOT emitted; result.manifestPath stays empty.
    return undefined;
  }
}
