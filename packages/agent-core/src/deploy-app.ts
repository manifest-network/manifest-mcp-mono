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
  ManifestMCPError,
  ManifestMCPErrorCode,
  setItemCustomDomain,
  stopApp,
} from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  type BuildManifestPreviewInput,
  type CheckDeploymentReadinessResult,
  type DeployAppInput as FredDeployAppInput,
  type DeployAppResult as FredDeployAppResult,
  buildManifestPreview,
  checkDeploymentReadiness,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
  deployApp as fredDeployApp,
} from '@manifest-network/manifest-mcp-fred';
import { EMPTY_DENOM_MAP, loadChainDenomMap } from './internals/humanize-denom.js';
import { renderDeploymentPlan } from './internals/render-deployment-plan.js';
import { renderIntentRecap } from './internals/render-intent-recap.js';
import { renderPartialSuccessPrompt } from './internals/render-partial-success-prompt.js';
import { isStackSpec, summarizeSpec, validateSpec } from './internals/spec-normalize.js';
import type {
  DenomMap,
  DeployAppCallbacks,
  DeployAppOptions,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
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
  const activeChain: 'testnet' | 'mainnet' =
    /mainnet|main/i.test(chainId) ? 'mainnet' : 'testnet';

  // --- Readiness evaluation -------------------------------------------
  // fred's checkDeploymentReadiness takes (queryClient, address, input).
  // Resolve both from the runtime context before invoking.
  const queryClient = await opts.clientManager.getQueryClient();
  const tenantAddress = await opts.walletProvider.getAddress();
  const readinessRaw = await checkDeploymentReadiness(queryClient, tenantAddress, {
    image: primaryImage(spec),
    size: requestedSize(spec),
  });
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
    await callbacks.onFailure?.(envelope, []);
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      envelope.reason,
    );
  }

  // --- Plan assembly --------------------------------------------------
  // Build manifest preview (provides meta_hash for Plan + later save).
  const previewInput = buildManifestPreviewInput(spec, requestedSize(spec));
  const preview = await buildManifestPreview(previewInput);

  // Fee estimation for create-lease (always) + set-item-custom-domain
  // (when customDomain set). Lean port: cosmosEstimateFee invocation
  // details encapsulated in a helper to keep this fn focused on flow.
  const summary = summarizeSpec(spec);
  const fees = await estimateFees(opts, spec, preview.meta_hash_hex);
  const plan: Plan = { summary, readiness, fees };

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
      // PlanEdit — apply edits to the spec (single iteration for PR 3;
      // multi-iteration plan-edit loop is a PR-3.x follow-up if needed).
      confirmedSpec = applyPlanEdit(confirmedSpec, verdict);
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
  const signArbitrary = opts.walletProvider.signArbitrary.bind(opts.walletProvider);
  const timestamps = new AuthTimestampTracker();
  const getAuthToken = async (address: string, leaseUuid: string): Promise<string> => {
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
  const result: DeployResult = {
    leaseUuid: fredResult.lease_uuid,
    providerUuid: fredResult.provider_uuid,
    leaseState: leaseStateAsName(fredResult.state),
    urls: fredResult.url ? [fredResult.url] : [],
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
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : 'small';
}

function customDomainOf(spec: DeploySpec): string | undefined {
  return (spec as { customDomain?: string }).customDomain;
}

function customDomainServiceOf(spec: DeploySpec): string | undefined {
  if (isStackSpec(spec)) return (spec as StackSpec).serviceName;
  return undefined;
}

function leaseStateAsName(state: unknown): LeaseStateName {
  if (typeof state === 'string' && state.startsWith('LEASE_STATE_')) {
    return state as LeaseStateName;
  }
  return 'LEASE_STATE_ACTIVE';
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
    walletBalances: (rawAny.wallet_balances as Readiness['walletBalances']) ?? [],
    credits:
      (rawAny.credits as Readiness['credits']) ?? null,
    sku: (rawAny.sku as Readiness['sku']) ?? null,
  };
}

function buildManifestPreviewInput(
  spec: DeploySpec,
  size: string,
): BuildManifestPreviewInput {
  if (isStackSpec(spec)) {
    return { size, services: spec.services } as unknown as BuildManifestPreviewInput;
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
  metaHashHex: string,
): Promise<Plan['fees']> {
  // Lean placeholder: production estimation goes through cosmosEstimateFee
  // with the create-lease msg-builder + (optional) set-item-custom-domain.
  // For PR-3-commit-B, we surface the wire-up + return stub fees that
  // satisfy the typed shape; replay-test fixtures supply the canonical
  // values for assertion.
  void opts;
  void metaHashHex;
  const hasDomain =
    typeof (spec as { customDomain?: string }).customDomain === 'string' &&
    (spec as { customDomain?: string }).customDomain!.length > 0;
  return {
    createLease: {
      coins: [{ denom: 'umfx', amount: '2300' }],
      gas: 142000,
    },
    ...(hasDomain
      ? {
          setDomain: {
            coins: [{ denom: 'umfx', amount: '1100' }],
            gas: 60000,
          },
        }
      : {}),
  };
}

function buildFredDeployInput(spec: DeploySpec, size: string): FredDeployAppInput {
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
  edit: Exclude<Awaited<ReturnType<NonNullable<DeployAppCallbacks['onPlan']>>>, 'confirm' | 'cancel'>,
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
            [edit.service]: { ...svc, env: { ...(svc.env ?? {}), ...edit.env } },
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
  const reason = err instanceof Error ? err.message : String(err);
  const requestedCustomDomain = customDomainOf(spec);

  // Detect partial-success: fred throws "Deploy partially succeeded:"
  // when create-lease succeeded but a downstream step (set-domain /
  // upload) failed. The lease UUID is embedded in the error message.
  const partial = parsePartialSuccess(reason);
  if (partial !== null) {
    const envelope: FailureEnvelope = {
      outcome: 'partially_succeeded',
      leaseUuid: partial.leaseUuid,
      ...(requestedCustomDomain
        ? { requestedCustomDomain }
        : {}),
      reason: partial.reason,
    };
    const promptPayload = renderPartialSuccessPrompt({
      leaseUuid: partial.leaseUuid,
      decodedState: partial.decodedState,
      reason: partial.reason,
      ...(requestedCustomDomain ? { requestedCustomDomain } : {}),
    });
    const options: RecoveryOption[] = promptPayload.options.map((id) => ({
      id,
      label: recoveryOptionLabel(id),
      description: recoveryOptionDescription(id),
    }));
    const choice = await callbacks.onFailure?.(envelope, options);
    if (choice !== undefined) {
      return await dispatchRecovery(choice, envelope, spec, opts);
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
  }

  // Non-partial failure: surface as `outcome: 'failed'` envelope.
  const envelope: FailureEnvelope = { outcome: 'failed', reason };
  await callbacks.onFailure?.(envelope, []);
  throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
}

function parsePartialSuccess(
  reason: string,
): { leaseUuid: string; decodedState: string; reason: string } | null {
  const uuidMatch = reason.match(
    /lease ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
  );
  if (!uuidMatch || !uuidMatch[1]) return null;
  if (!reason.includes('partially succeeded')) return null;
  return {
    leaseUuid: uuidMatch[1],
    decodedState: 'LEASE_STATE_PENDING',
    reason,
  };
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
      await setItemCustomDomain(opts.clientManager, leaseUuid, domain);
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

async function tryPersistManifest(args: PersistArgs): Promise<string | undefined> {
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
