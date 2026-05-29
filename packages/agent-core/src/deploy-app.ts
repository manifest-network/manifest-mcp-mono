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
 *   auth-token callbacks internally from `walletProvider` so callers
 *   don't need to know about ADR-036 plumbing.
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
  buildManifestPreview,
  checkDeploymentReadiness,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
  type DeployAppResult as FredDeployAppResult,
  deployApp as fredDeployApp,
  waitForAppReady,
} from '@manifest-network/manifest-mcp-fred';
import {
  buildFredDeployInput,
  buildManifestPreviewInput,
} from './internals/build-fred-input.js';
import { classifyDeployError } from './internals/classify-deploy-error.js';
import {
  classifyDeployResponse,
  type DeployResponseShape,
} from './internals/classify-deploy-response.js';
import {
  extractRunningEndpoints,
  formatEndpointAsUrl,
  normalizeFredUrl,
} from './internals/connection.js';
import { evaluateReadinessFromFredResponse } from './internals/evaluate-readiness-from-fred.js';
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
  ServiceDef,
  SingleServiceSpec,
  StackSpec,
} from './types.js';

/**
 * Orchestrate a deployment. See module-level docstring for the architect-
 * locked composition + E-hybrid runtime-context contract.
 *
 * @throws `ManifestMCPError(INVALID_CONFIG)` for spec / wallet validation.
 * @throws `ManifestMCPError(INVALID_CONFIG)` when `onConfirm` returns
 *   `'no'` or `onPlan` returns `'cancel'`.
 *
 * Errors from fred's broadcast or core's recovery primitives surface as
 * typed `ManifestMCPError`s. Partial-success failures with applicable
 * recovery options route through `onFailure(envelope, options)` — the
 * callback's return value drives recovery dispatch via the inline
 * closures in `dispatchRecovery`. Non-partial or inform-only failures
 * (no recovery choices to present, per `handleBroadcastFailure`'s F3
 * branch) throw directly as `ManifestMCPError(TX_FAILED)` without
 * invoking `onFailure`.
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

  // --- Address-source consistency guard -------------------------------
  // Copilot review fix (PR #58 r3248900328): `opts.walletProvider` and
  // `opts.clientManager` are independently-injected runtime objects.
  // The readiness check + ADR-036 auth-token signing read the address
  // from `walletProvider`; fred's atomic `deployApp` (create-lease +
  // manifest upload) reads it from `clientManager`. If the two are
  // bound to different wallets (misconfiguration / copy-paste in
  // host-surface composition / multi-tenant test rig), readiness is
  // evaluated for wallet A while create-lease + upload execute as
  // wallet B — orphaning a lease on wallet B with auth tokens signed
  // by wallet A (provider auth-fails after the chain tx confirms).
  // Resolve both up-front, fail fast on mismatch, then reuse the
  // single value as the canonical `tenantAddress` for the rest of
  // the orchestration.
  const walletAddress = await opts.walletProvider.getAddress();
  const clientAddress = await opts.clientManager.getAddress();
  if (walletAddress !== clientAddress) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `opts.walletProvider and opts.clientManager are bound to different addresses ` +
        `(walletProvider=${walletAddress}, clientManager=${clientAddress}); they must reference the same wallet ` +
        `to avoid creating an orphaned lease on the clientManager wallet when ADR-036 auth (signed by walletProvider) fails.`,
    );
  }
  const tenantAddress = walletAddress;

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
  // `tenantAddress` was resolved + validated as consistent across
  // walletProvider/clientManager in the address-source guard above.
  const queryClient = await opts.clientManager.getQueryClient();
  const readinessRaw = await checkDeploymentReadiness(
    queryClient,
    tenantAddress,
    {
      image: primaryImage(spec),
      size: requestedSize(spec),
    },
  );
  // `readiness` is `let`-bound because the post-edit recompute branch
  // re-evaluates it against the edited spec (Copilot r3267373084 — see
  // the recall block inside the `onPlan` `verdict !== 'confirm'` arm).
  let readiness: Readiness = evaluateReadinessFromFredResponse(
    readinessRaw,
    opts.clientManager.getConfig().gasPrice ?? '1umfx',
    denomMap,
    tenantAddress,
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
      // Copilot review fix (PR #58 r3249684686): re-validate the post-
      // edit spec at the agent-core boundary. `validateSpec` runs once
      // on the original input at the top of `deployApp`; without this
      // second invocation a `replace_spec` edit returning an invalid
      // spec (portless single-service, out-of-range port, stack-
      // without-services, stack-with-customDomain-missing-serviceName,
      // etc.) flows through to `buildManifestPreview` / fred's
      // broadcast and surfaces only as a mid-orchestration error.
      // Placed BEFORE the recompute so we don't spend a
      // `buildManifestPreview` round-trip on a known-bad spec. Wraps
      // `TypeError` from `validateSpec` into `INVALID_CONFIG` to match
      // the initial-input-validation convention at the top of this fn.
      try {
        validateSpec(confirmedSpec);
      } catch (err) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          err instanceof Error
            ? `Post-edit spec failed validation: ${err.message}`
            : `Post-edit spec failed validation: ${String(err)}`,
        );
      }
      // Copilot review fix (PR #58 r3267373084): readiness recall.
      // The original-spec `readiness` (captured pre-`onPlan`) gates
      // SKU + credit-balance pre-flight; a `replace_spec` /
      // `edit_env` edit that changes `image` or `size` can produce a
      // different readiness outcome. Without this recall, the
      // post-edit `plan` still carries the original-spec readiness,
      // which mis-renders the plan and may bypass a `status: 'block'`
      // condition specific to the edited shape.
      //
      // ENG-185 #1 (sub-PR B): the always-`'ok'` stub
      // `evaluateReadinessFromRaw` has been replaced by
      // `evaluateReadinessFromFredResponse` (the canonical evaluator
      // wired through the snake_case → camelCase translator). Both
      // call sites now fire the `status === 'block'` short-circuit
      // correctly (initial-spec L207 + post-edit recall below).
      const editedReadinessRaw = await checkDeploymentReadiness(
        queryClient,
        tenantAddress,
        {
          image: primaryImage(confirmedSpec),
          size: requestedSize(confirmedSpec),
        },
      );
      readiness = evaluateReadinessFromFredResponse(
        editedReadinessRaw,
        opts.clientManager.getConfig().gasPrice ?? '1umfx',
        denomMap,
        tenantAddress,
      );
      callbacks.onProgress?.({ kind: 'readiness_evaluated', readiness });
      if (readiness.status === 'block') {
        // Same fail-fast as the original-spec readiness gate above.
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Post-edit readiness check failed: ${readiness.reasons.join('; ')}`,
        );
      }
      preview = await buildManifestPreview(
        buildManifestPreviewInput(confirmedSpec, requestedSize(confirmedSpec)),
      );
      summary = summarizeSpec(confirmedSpec);
      fees = await estimateFees(opts, confirmedSpec, preview.meta_hash_hex);
      plan = { summary, readiness, fees };
      // Copilot review fix (PR #58 r3237308843): the pre-edit
      // `deployment_plan_rendered` event already fired with the original
      // spec's block. After applying the edit + recomputing preview /
      // summary / fees / plan, re-render and emit a fresh block so
      // consumers see the post-edit plan alongside the post-edit intent
      // recap. Without this re-emit, the event stream is inconsistent
      // with the user's confirmation surface and the persisted manifest.
      const editedBlock = renderDeploymentPlan({
        plan,
        denomMap,
        image: primaryImage(confirmedSpec),
        size: requestedSize(confirmedSpec),
        metaHash: preview.meta_hash_hex,
        customDomain: customDomainOf(confirmedSpec),
        customDomainService: customDomainServiceOf(confirmedSpec),
      });
      callbacks.onProgress?.({
        kind: 'deployment_plan_rendered',
        block: editedBlock,
      });
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
  const fredInput = buildFredDeployInput(
    confirmedSpec,
    requestedSize(confirmedSpec),
  );
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

  // --- Classify happy-path result + full routing (ENG-185 sub-PR D) -
  // Architect's α-lock: fred returns after tx + manifest upload succeed,
  // NOT after the app is observably running. So `'needs_wait'` IS an
  // expected happy-path return shape (lease created, manifest uploaded,
  // container not yet started by the provider) — and `'failed'` covers
  // the terminal-state-on-return edge (e.g. REJECTED, when the chain
  // invalidated the lease between create and return).
  //
  // Routing (per architect's Q7 pseudocode):
  //   - `'failed'`     → throw TX_FAILED with the classifier's
  //                      `errorSummary` (F3 pattern, no onFailure for
  //                      this kind of failure — there's no recovery
  //                      choice once fred returns a terminal-state
  //                      response from a successful broadcast).
  //   - `'needs_wait'` → poll `wait_for_app_ready`, emit
  //                      `polling_for_readiness` events per onProgress
  //                      sample, then RE-classify the post-poll result
  //                      (Defense #2 — rare provider race where
  //                      pollLeaseUntilReady exits on state==ACTIVE
  //                      without a running instance). On post-poll
  //                      success, merge the polled fields back into
  //                      `fredResult` so downstream DeployResult
  //                      construction sees the final state/connection.
  //   - `'active'`     → fall through to `app_ready_confirmed` + persist.
  let classification = classifyDeployResponse(fredResult);
  callbacks.onProgress?.({
    kind: 'deploy_response_classified',
    outcome: classification.outcome,
  });

  if (classification.outcome === 'failed') {
    // F3 pattern (mirrors handleBroadcastFailure's empty-options path):
    // throw TX_FAILED directly; no onFailure invocation. The envelope
    // is constructed for a future logging hook but otherwise unused.
    const reason =
      classification.errorSummary ??
      `fred deployApp returned failed outcome for lease ${
        classification.leaseUuid ?? '<no-uuid>'
      }`;
    const envelope: FailureEnvelope = { outcome: 'failed', reason };
    void envelope;
    throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
  }

  if (classification.outcome === 'needs_wait') {
    // Defense #1: classifier guarantees leaseUuid when needs_wait
    // (`classify-deploy-response.ts`: !leaseUuid → outcome='failed'),
    // but the TS type doesn't narrow it. Defensive throw documents
    // the invariant for future maintainers + catches any classifier
    // regression that would break the assumption.
    if (!classification.leaseUuid) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Internal invariant: classifier returned needs_wait without leaseUuid.',
      );
    }
    const leaseUuid = classification.leaseUuid;
    // queryClient is already bound at L193 (function-level); reuse it.
    // (Copilot #1 fix: removed shadowing redeclaration. CosmosClientManager
    // keys its query client as a singleton so there was no behavioral
    // difference, but shadowing is a maintenance trap.)
    const pollStartMs = Date.now();
    let attempt = 0;

    let pollResult: Awaited<ReturnType<typeof waitForAppReady>>;
    try {
      pollResult = await waitForAppReady(
        queryClient,
        tenantAddress,
        leaseUuid,
        getAuthToken,
        {
          timeoutMs: opts.waitForReadyTimeoutMs ?? 480_000,
          onProgress: (status) => {
            attempt += 1;
            const stateName = decodeLeaseState(status.state);
            callbacks.onProgress?.({
              kind: 'polling_for_readiness',
              leaseUuid,
              attempt,
              elapsedMs: Date.now() - pollStartMs,
              ...(stateName !== undefined ? { state: stateName } : {}),
            });
          },
        },
        opts.fetchFn,
      );
    } catch (err) {
      // ProviderApiError / timeout / TerminalChainStateError → F3 route.
      const reason =
        err instanceof Error
          ? `wait_for_app_ready failed for lease ${leaseUuid}: ${err.message}`
          : `wait_for_app_ready failed for lease ${leaseUuid}: ${String(err)}`;
      const envelope: FailureEnvelope = { outcome: 'failed', reason };
      void envelope;
      throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
    }

    // Defense #2: re-classify post-poll. `pollLeaseUntilReady` exits on
    // state==ACTIVE but doesn't check running-instances; a rare provider-
    // side race could leave us at ACTIVE with no instances → outcome
    // 'needs_wait' on the re-classify. We treat that as TX_FAILED rather
    // than misleadingly emitting app_ready_confirmed + onComplete on a
    // non-running deploy.
    const postPollResponse: DeployResponseShape = {
      lease_uuid: pollResult.lease_uuid,
      provider_uuid: pollResult.provider_uuid,
      provider_url: pollResult.provider_url,
      state: pollResult.state,
      connection: pollResult.status,
    };
    classification = classifyDeployResponse(postPollResponse);
    if (classification.outcome !== 'active') {
      const reason =
        classification.errorSummary ??
        `wait_for_app_ready returned but post-poll classifier outcome is ${classification.outcome}`;
      throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
    }

    // Merge post-poll fields back into `fredResult` so downstream
    // DeployResult construction sees the final state + connection.
    fredResult = {
      ...fredResult,
      lease_uuid: pollResult.lease_uuid,
      provider_uuid: pollResult.provider_uuid,
      provider_url: pollResult.provider_url,
      state: pollResult.state as never,
      connection: pollResult.status as never,
    };
  }

  // 'active' (initial OR post-poll merge): emit + fall through to persist.
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
  //
  // Copilot review fix (PR #58 r3249097136): when no FQDN can be
  // extracted from `connection`, fall back to `fredResult.url` THROUGH
  // the shared `normalizeFredUrl` helper. Raw values like
  // `'app.example.com:443'` now surface as
  // `'https://app.example.com:443/'`, matching the classifier's
  // (`classify-deploy-response.ts`) and renderer's (`format-success.ts`)
  // handling. Empty / scheme-less inputs are normalized consistently.
  const endpointUrls = extractRunningEndpoints(fredResult.connection).map(
    formatEndpointAsUrl,
  );
  const fallbackUrl =
    typeof fredResult.url === 'string' ? normalizeFredUrl(fredResult.url) : '';
  const result: DeployResult = {
    leaseUuid: fredResult.lease_uuid,
    providerUuid: fredResult.provider_uuid,
    leaseState: leaseStateDecoded,
    urls:
      endpointUrls.length > 0
        ? endpointUrls
        : fallbackUrl.length > 0
          ? [fallbackUrl]
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

async function estimateFees(
  opts: DeployAppOptions,
  spec: DeploySpec,
  metaHashHex: string, // SHA-256 hex digest of the canonical manifest JSON; threaded into create-lease estimate via the `--meta-hash` flag (mirrors fred's deploy path at packages/fred/src/tools/deployApp.ts:363)
): Promise<Plan['fees']> {
  // PR 3 fix-3 (B-narrowed-trimmed per architect ratification):
  //   - REAL cosmosEstimateFee for create-lease (criterion-blocking).
  //   - SET-DOMAIN emits `{notEstimated: true, reason}` sentinel (the
  //     frozen-contract escape hatch designed for pre-broadcast lease-
  //     UUID unavailability per ENG-128). Per ENG-185 #3 sub-PR C
  //     (architect's verdict B): the chain rejects placeholder-UUID
  //     simulation of `MsgSetItemCustomDomain` (keeper's `GetLease()`
  //     fails first with ErrLeaseNotFound), so the sentinel is the
  //     PERMANENT shape — not a TODO.

  const size = requestedSize(spec);
  const { skuUuid } = await findSkuUuid(opts.clientManager, size);

  // ENG-185 #3 sub-PR C: mirror fred's deploy-time item creation verbatim
  // (`packages/fred/src/tools/deployApp.ts:336-341`). Stack specs create
  // ONE lease item per service (each with `${skuUuid}:1:${name}`); legacy
  // single-service specs create one bare `${skuUuid}:1`. The prior gate
  // on `spec.serviceName` underestimated multi-service stacks (only the
  // domain-target service was billed) and accidentally collapsed stacks
  // WITHOUT customDomain to legacy-mode args (`spec.serviceName` is only
  // set alongside customDomain — bug 2).
  //
  // Storage SKU items (fred's `input.storage` path) are deliberately NOT
  // handled here — agent-core's `DeploySpec` has no `storage` field,
  // unlike fred's input contract.
  const itemArgs: string[] = isStackSpec(spec)
    ? Object.keys(spec.services).map((name) => `${skuUuid}:1:${name}`)
    : [`${skuUuid}:1`];

  let createLeaseEstimate: Awaited<ReturnType<typeof cosmosEstimateFee>>;
  try {
    createLeaseEstimate = await cosmosEstimateFee(
      opts.clientManager,
      'billing',
      'create-lease',
      ['--meta-hash', metaHashHex, ...itemArgs],
    );
  } catch (err) {
    // Wrap the underlying failure with an agent-core-boundary message
    // for caller diagnostics. `core`'s `cosmosEstimateFee` (per
    // `packages/core/src/cosmos.ts`) throws across multiple sites with
    // different codes: `INVALID_CONFIG` for missing `gasPrice`,
    // `UNSUPPORTED_TX` for invalid module/subcommand,
    // `SIMULATION_FAILED` for actual simulation issues.
    //
    // Copilot review fix (PR #58 r3250192834): preserve the original
    // code when the underlying threw a typed `ManifestMCPError`;
    // fall back to `SIMULATION_FAILED` only for untyped failures.
    // The prior comment claimed code-preservation but the code
    // unconditionally cast to `SIMULATION_FAILED`.
    const msg = `Failed to estimate create-lease fee: ${err instanceof Error ? err.message : String(err)}`;
    if (err instanceof ManifestMCPError) {
      throw new ManifestMCPError(err.code, msg);
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.SIMULATION_FAILED, msg);
  }

  // FeeEstimateResult shape (per packages/core/src/types.ts):
  //   { module, subcommand, gasEstimate: string, fee: { gas: string, amount: Coin[] } }
  // Map to typed `FeeEstimate { coins: Coin[], gas: number }` (Path-C
  // revision per a62cfd1).
  //
  // Copilot review fix (PR #58 r3250192734): use `fee.gas` (post-
  // `gasMultiplier`), NOT `gasEstimate` (raw simulation gas). The
  // `coins` were priced at `fee.gas`; displaying `gasEstimate` shows
  // a number ~33% lower than the price reflects under the default
  // 1.5x multiplier (per CLAUDE.md `COSMOS_GAS_MULTIPLIER`), creating
  // a visible inconsistency in the rendered plan.
  const createLease: FeeEstimate = {
    coins: createLeaseEstimate.fee.amount.map((c) => ({
      denom: c.denom,
      amount: c.amount,
    })),
    gas: Number(createLeaseEstimate.fee.gas),
  };

  // set-domain: emit `{notEstimated: true, reason}` sentinel per
  // architect-ratified counter-proposal + ENG-185 #3 verdict B (the
  // chain rejects placeholder-UUID simulation of `MsgSetItemCustomDomain`
  // — keeper's `GetLease()` runs first and fails with ErrLeaseNotFound;
  // verified against manifest-ledger v2.1.0). The frozen-contract type
  // includes this discriminated variant precisely for this case.
  //
  // Reason string mirrors the canonical form already pinned in
  // `internals/render-deployment-plan.test.ts` so producer + renderer
  // share the same wording.
  const hasDomain = typeof customDomainOf(spec) === 'string';
  return {
    createLease,
    ...(hasDomain
      ? {
          setDomain: {
            notEstimated: true,
            reason: 'no representative lease for pre-broadcast simulation',
          },
        }
      : {}),
  };
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
    // Copilot review fix (PR #58 r3266642610): the prior implementation
    // silently no-op'd two stack-spec cases (missing `edit.service` or
    // unknown service name), returning the unchanged spec while the
    // callback caller perceived the edit as applied. Worst case: deploy
    // proceeds with wrong env vars / secrets without an error signal.
    // Fail-fast at the boundary instead, so the user's `onPlan` callback
    // gets a clear `INVALID_CONFIG` for misuse. Uses
    // `Object.keys().includes()` for the membership check — matches
    // Fix 16's cross-package symmetry with fred (avoids prototype-chain
    // bypass via `'constructor'` / `'toString'` / etc.).
    if (isStackSpec(spec)) {
      if (edit.service === undefined) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'applyPlanEdit: edit_env on a stack spec requires `service` identifying which service to edit.',
        );
      }
      if (!Object.keys(spec.services).includes(edit.service)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `applyPlanEdit: edit_env \`service\` "${edit.service}" is not a key in \`services\` (got: [${Object.keys(spec.services).join(', ')}]).`,
        );
      }
      const svc = spec.services[edit.service];
      // Membership check above guarantees `svc` is defined; the
      // non-null assertion documents that — TS narrows it after the
      // `includes` check, but the runtime invariant is in the
      // membership check.
      return {
        ...spec,
        services: {
          ...spec.services,
          [edit.service]: {
            ...(svc as ServiceDef),
            env: { ...((svc as ServiceDef).env ?? {}), ...edit.env },
          },
        },
      };
    }
    const single = spec as SingleServiceSpec;
    return { ...single, env: { ...(single.env ?? {}), ...edit.env } };
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
