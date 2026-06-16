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
  asLeaseUuid,
  asProviderUuid,
  cosmosEstimateFee,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
  type ReadCtx,
  resolveSku,
  type SkuCandidate,
  setItemCustomDomain,
  stopApp,
} from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  buildManifestPreview,
  type ConnectionDetails,
  checkDeploymentReadiness,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
  type DeployAppResult as FredDeployAppResult,
  type FredLeaseStatus,
  fetchActiveLease,
  deployApp as fredDeployApp,
  pollLeaseUntilReady,
  resolveProviderUrl,
  uploadLeaseData,
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
 * @throws `ManifestMCPError(OPERATION_CANCELLED)` when `onConfirm` returns
 *   `'no'` or `onPlan` returns `'cancel'` (deliberate user cancellation —
 *   ENG-272).
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
  // fred's checkDeploymentReadiness takes (ctx: ReadCtx, address, input),
  // where ReadCtx = { query, chain, logger } (spec §5.4). It forwards the
  // ctx to core's getBalance → withReadSignal → ctx.chain.acquireRateLimit,
  // so the ctx MUST carry the clientManager as `chain` (a bare queryClient
  // would crash). `tenantAddress` was resolved + validated as consistent
  // across walletProvider/clientManager in the address-source guard above.
  const queryClient = await opts.clientManager.getQueryClient();
  const readCtx: ReadCtx = {
    query: queryClient,
    chain: opts.clientManager,
    logger: noopLogger,
  };

  // --- SKU pin resolution (ENG-258) -----------------------------------
  // Resolve the requested `size` to a single concrete (skuUuid,
  // providerUuid) pin ONCE, BEFORE readiness/plan/fee/broadcast, so all
  // four reference the same SKU. Ambiguity routes through `onResolveSku`
  // (interactive) or re-throws SKU_AMBIGUOUS (headless). Defined as a
  // closure so it captures `queryClient` + `callbacks` and can be reused
  // by the post-edit re-plan branch (an edit can change size/provider).
  //
  // Returns `{ pin, elicited }` where `elicited` is true ONLY when
  // `onResolveSku` was actually invoked (i.e. an ambiguous-name
  // interactivity happened). The caller uses `elicited` to decide whether
  // to stamp the chosen pin onto `confirmedSpec` — stamping is only
  // needed to suppress a re-elicit on the post-edit re-plan; non-elicited
  // resolutions (unique-name or UUID-direct) don't need it and shouldn't
  // carry a stale pin if the user later issues a `replace_spec` edit that
  // changes the size.
  const resolvePin = async (
    s: DeploySpec,
  ): Promise<{ pin: SkuCandidate; elicited: boolean }> => {
    const providerUuid = requestedProviderUuid(s);
    const skuUuid = requestedSkuUuid(s);
    try {
      const pin = await resolveSku(queryClient, {
        size: requestedSize(s),
        ...(providerUuid !== undefined ? { providerUuid } : {}),
        ...(skuUuid !== undefined ? { skuUuid } : {}),
      });
      return { pin, elicited: false };
    } catch (err) {
      if (
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.SKU_AMBIGUOUS &&
        callbacks.onResolveSku
      ) {
        const candidates = (err.details?.candidates as SkuCandidate[]) ?? [];
        callbacks.onProgress?.({ kind: 'sku_ambiguous', candidates });
        const pick = await callbacks.onResolveSku(candidates);
        const pin = await resolveSku(queryClient, {
          size: requestedSize(s),
          skuUuid: pick.skuUuid,
          providerUuid: pick.providerUuid,
        });
        return { pin, elicited: true };
      }
      throw err;
    }
  };
  let { pin: pinned, elicited: pinElicited } = await resolvePin(spec);

  // FIX 1 (ENG-258 review): `pinned.name` is the RESOLVED SKU's on-chain
  // name. When a deploy is pinned by `skuUuid` (or by provider) whose
  // on-chain name differs from the user's requested `size` (or size was
  // omitted → defaulted to 'small'), `requestedSize(spec)` no longer
  // matches the resolved SKU. fred's `evaluateReadiness` gate
  // (`skuCandidates.some(c => c.name === inputs.size)`) would then fail
  // and block a valid pin. Thread `pinned.name` — not `requestedSize` —
  // as the canonical SKU name into every downstream consumer (readiness,
  // plan render, fred input, persisted manifest). `requestedSize(spec)`
  // survives ONLY as the input to `resolvePin` (the user's request).
  const readinessRaw = await checkDeploymentReadiness(readCtx, tenantAddress, {
    image: primaryImage(spec),
    size: pinned.name,
    providerUuid: pinned.providerUuid,
    skuUuid: pinned.skuUuid,
  });
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
  let fees = await estimateFees(
    opts,
    spec,
    preview.meta_hash_hex,
    pinned.skuUuid,
  );
  let plan: Plan = { summary, readiness, fees };

  // --- Render plan + onPlan callback ----------------------------------
  // FIX 2 (ENG-258 review): stamp the resolved pin identity onto the
  // working spec ONLY when an ambiguous SKU was resolved interactively
  // via `onResolveSku` (i.e. `pinElicited === true`). The stamp prevents
  // re-eliciting on the post-edit re-plan: an `edit_env` edit spreads
  // the prior spec and preserves the stamped skuUuid/providerUuid, so
  // the by-UUID second resolve skips the ambiguity entirely.
  //
  // When the SKU was resolved by a UNIQUE name or by explicit UUID
  // (non-elicited paths), the original `spec` already carries the right
  // identity — stamping is unnecessary and risks locking in a stale pin
  // if a `replace_spec` edit changes `size` (that edit replaces the
  // spec wholesale anyway, but avoiding the stamp keeps the non-elicited
  // path behaviorally minimal).
  let confirmedSpec: DeploySpec = pinElicited
    ? { ...spec, skuUuid: pinned.skuUuid, providerUuid: pinned.providerUuid }
    : spec;
  const block = renderDeploymentPlan({
    plan,
    denomMap,
    image: primaryImage(spec),
    // FIX 1: show the RESOLVED SKU name (honest when pinned by uuid).
    size: pinned.name,
    metaHash: preview.meta_hash_hex,
    customDomain: customDomainOf(spec),
    customDomainService: customDomainServiceOf(spec),
    providerUuid: pinned.providerUuid,
  });
  callbacks.onProgress?.({ kind: 'deployment_plan_rendered', block });
  if (callbacks.onPlan) {
    const verdict = await callbacks.onPlan(plan);
    if (verdict === 'cancel') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
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
      // Re-resolve the SKU pin for the edited spec (ENG-258): an edit can
      // change `size` / `providerUuid`, so the pin threaded into the
      // post-edit readiness/fee/plan/broadcast must reflect the edit.
      // Track elicitation again: if the post-edit resolve is also
      // interactive, stamp the new pin so a further re-plan won't
      // re-elicit for the same choice.
      ({ pin: pinned, elicited: pinElicited } =
        await resolvePin(confirmedSpec));
      if (pinElicited) {
        confirmedSpec = {
          ...confirmedSpec,
          skuUuid: pinned.skuUuid,
          providerUuid: pinned.providerUuid,
        };
      }
      const editedReadinessRaw = await checkDeploymentReadiness(
        readCtx,
        tenantAddress,
        {
          image: primaryImage(confirmedSpec),
          // FIX 1: canonical resolved SKU name, not the user's requested size.
          size: pinned.name,
          providerUuid: pinned.providerUuid,
          skuUuid: pinned.skuUuid,
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
      fees = await estimateFees(
        opts,
        confirmedSpec,
        preview.meta_hash_hex,
        pinned.skuUuid,
      );
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
        // FIX 1: canonical resolved SKU name, not the user's requested size.
        size: pinned.name,
        metaHash: preview.meta_hash_hex,
        customDomain: customDomainOf(confirmedSpec),
        customDomainService: customDomainServiceOf(confirmedSpec),
        providerUuid: pinned.providerUuid,
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
        ManifestMCPErrorCode.OPERATION_CANCELLED,
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
  // FIX 1: pass the RESOLVED SKU name so fred records the lease item with
  // the on-chain SKU's name, consistent with the readiness/plan above.
  const fredInput = buildFredDeployInput(confirmedSpec, pinned.name, {
    skuUuid: pinned.skuUuid,
    providerUuid: pinned.providerUuid,
  });
  let fredResult: FredDeployAppResult;
  try {
    fredResult = await fredDeployApp(
      opts.clientManager,
      getAuthToken,
      getLeaseDataAuthToken,
      fredInput,
      {},
      opts.fetchFn,
    );
  } catch (err) {
    // ENG-185 sub-PR E: thread a `RecoveryContext` so the
    // `retry_set_domain` branch can decompose the deploy into
    // `setItemCustomDomain` + `uploadLeaseData` + `pollLeaseUntilReady`.
    // Captured values mirror what fred's atomic `deployApp` had: the
    // ADR-036 auth closures, the manifest payload + hash, and the chain
    // identity (for downstream `tryPersistManifest`).
    const recoveryCtx: RecoveryContext = {
      manifestJson: preview.manifest_json,
      metaHash: preview.meta_hash_hex,
      getAuthToken,
      getLeaseDataAuthToken,
      tenantAddress,
      chainId,
      denomMap,
      // FIX 1: thread the RESOLVED SKU name so the recovery path's
      // manifest persistence records the same name the broadcast used.
      skuName: pinned.name,
    };
    return await handleBroadcastFailure(
      err,
      confirmedSpec,
      callbacks,
      opts,
      recoveryCtx,
    );
  }

  // Live-state + live-connection trackers (Copilot fix-3, post-PR-D):
  // the pre-fix code merged `pollResult.state` (a JSON-encoded string from
  // `waitForAppReady`) into `fredResult.state` (numeric `LeaseState`) via
  // a width-erasing cast, hiding a type mismatch. Same for `pollResult.status`
  // (`FredLeaseStatus`) → `fredResult.connection` (`ConnectionDetails`):
  // runtime worked (duck-typed reads via `extractRunningEndpoints` /
  // `hasRunningInstances` / `decodeLeaseState`, all of which accept the
  // wider shape), but the type contract was violated.
  //
  // The fix: track the FINAL (post-poll if applicable, else initial)
  // state + connection in two separate locals with HONEST types. Each
  // upstream source has a typed slot:
  //   - `fredResult.state` (`LeaseState`) when no polling fired.
  //   - `pollResult.status.state` (`LeaseState`) when polling did fire —
  //     NOTE: `pollResult.state` is the STRING form (JSON-encoded), wrong
  //     source. The numeric form lives one level deeper.
  //   - `fredResult.connection` (`ConnectionDetails | undefined`) initial.
  //   - `pollResult.status` (`FredLeaseStatus`) post-poll.
  let liveState: FredDeployAppResult['state'] | undefined = fredResult.state;
  let liveConnection: ConnectionDetails | FredLeaseStatus | undefined =
    fredResult.connection;

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
      // Copilot fix-6: include `leaseUuid` in the fallback message so
      // log/user-report correlation matches the sibling
      // `waitForAppReady` catch path at L548-550. Diagnostic consistency
      // invariant — locked in by the Defense #2 test's
      // `expect(...).toContain(leaseUuid)` assertion. The
      // `errorSummary` path is unaffected; the classifier already
      // includes leaseUuid in its terminal-state summary
      // (`classify-deploy-response.ts:120`), but errorSummary fires only
      // for `outcome === 'failed'`. The no-errorSummary fallback
      // (this branch) fires when post-poll outcome is `'needs_wait'`
      // (Defense #2's race scenario) — that's the gap we're closing.
      const reason =
        classification.errorSummary ??
        `wait_for_app_ready returned for lease ${leaseUuid} but post-poll classifier outcome is ${classification.outcome}`;
      throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
    }

    // Merge post-poll fields back into `fredResult` so downstream
    // DeployResult construction sees the final lease/provider identity.
    // lease_uuid / provider_uuid are chain-polled, trusted ids — they are
    // trust-cast (asLeaseUuid / asProviderUuid) to satisfy DeployResult's
    // branded wire types (brands erase at runtime; zero behavior change).
    // provider_url stays a plain string. The state + connection fields are
    // NOT merged here — they go into `liveState` and `liveConnection` so
    // each carries the type that matches its upstream source (no
    // width-erasing casts). See the live-tracker declarations above for
    // the full rationale.
    fredResult = {
      ...fredResult,
      lease_uuid: asLeaseUuid(pollResult.lease_uuid),
      provider_uuid: asProviderUuid(pollResult.provider_uuid),
      provider_url: pollResult.provider_url,
    };
    liveState = pollResult.status.state;
    liveConnection = pollResult.status;
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
    // FIX 1: persist the RESOLVED SKU name (matches what was broadcast).
    size: pinned.name,
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
  // absent state (undefined → default ACTIVE as defense-in-depth against
  // legacy/mocked shapes that bypass fred's required-state contract —
  // fred itself always sets `state` in `DeployAppResult`)
  // from UNRECOGNIZED state (decode returned undefined for a value that
  // WAS provided → likely a terminal/unknown chain emission that must
  // NOT be silently classified as ACTIVE). For the unrecognized case,
  // throw `INVALID_CONFIG` so callers see the empirical mismatch
  // instead of consuming a misleading ACTIVE.
  // Reads via `liveState` (Copilot fix-3): carries the post-poll
  // `pollResult.status.state` (numeric `LeaseState`) when the needs_wait
  // branch fired; falls back to `fredResult.state` for the direct-active
  // path. Effective type is `LeaseState | undefined` — numeric only after
  // the fix-3 type-tightening. The `undefined` branch handles the C3
  // defense-in-depth case above (legacy/mocked shapes that bypass fred's
  // required-state contract). The numeric branch decodes the enum via
  // `decodeLeaseState`; the `decoded === undefined` arm catches
  // UNRECOGNIZED enum values (defense-in-depth against future chain
  // emissions that add new states beyond the current `LeaseStateName`
  // union).
  let leaseStateDecoded: LeaseStateName;
  if (liveState === undefined) {
    leaseStateDecoded = 'LEASE_STATE_ACTIVE';
  } else {
    const decoded = decodeLeaseState(liveState);
    if (decoded === undefined) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Unrecognized lease state from fred deployApp response: ${String(liveState)}. Cannot safely classify; refusing to silently coerce to ACTIVE.`,
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
  // Reads via `liveConnection` (Copilot fix-3): carries
  // `pollResult.status` (FredLeaseStatus) when the needs_wait branch
  // fired, falls back to `fredResult.connection` (ConnectionDetails)
  // for the direct-active path. `extractRunningEndpoints` takes
  // `unknown` and walks `instances` / `services.*.instances` — both
  // shapes are accepted at runtime.
  const endpointUrls =
    extractRunningEndpoints(liveConnection).map(formatEndpointAsUrl);
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
  // ENG-275: `size` is a first-class optional field on both DeploySpec
  // variants (`types.ts`). This helper centralizes the default: a
  // non-empty string wins; absent / empty falls back to 'small'. The
  // `typeof` guard still degrades a non-string value smuggled in by an
  // `unknown`-cast (e.g. JSON.parse) caller to the safe default.
  const recorded = spec.size;
  return typeof recorded === 'string' && recorded.length > 0
    ? recorded
    : 'small';
}

/**
 * SKU disambiguator intent helpers. `providerUuid` / `skuUuid` are
 * first-class optional fields on both `DeploySpec` variants (ENG-296,
 * mirroring ENG-275's typed `size`). Returns `undefined` for absent /
 * empty values so `resolveSku` only narrows when a real disambiguator is
 * supplied.
 */
function requestedProviderUuid(spec: DeploySpec): string | undefined {
  const v = spec.providerUuid;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function requestedSkuUuid(spec: DeploySpec): string | undefined {
  const v = spec.skuUuid;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
  skuUuid: string, // ENG-258: pre-resolved SKU pin from the orchestrator; no second lookup here.
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

  // ENG-258: `skuUuid` is now a pre-resolved parameter (the orchestrator
  // resolves the pin ONCE via core's `resolveSku` so plan, fee, and
  // broadcast share one SKU). The prior in-function second lookup is gone.

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

/**
 * Recovery-path execution context. Threaded from `deployApp`'s enclosing
 * scope through `handleBroadcastFailure` → `dispatchRecovery` → the
 * per-choice closures. Internal (not exported, not in `types.ts`); each
 * field's upstream source lives in `deployApp`'s scope when the broadcast
 * failure surfaces, so the context is just a parameter bundle, not a
 * stateful object.
 *
 * Added by ENG-185 sub-PR E so the `retry_set_domain` branch can
 * decompose the deploy: it needs the manifest payload + hash for
 * `uploadLeaseData`, the auth closures for the upload + poll, and the
 * tenant/chain identity for `pollLeaseUntilReady` + downstream
 * `tryPersistManifest`. Other recovery branches (`salvage_without_domain`,
 * `cancel_lease`, `close_lease`) currently ignore the context — they
 * route through `stopApp` or a bare throw — but the widened signature
 * keeps future expansions cheap.
 */
interface RecoveryContext {
  manifestJson: string;
  metaHash: string;
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ) => Promise<string>;
  tenantAddress: string;
  chainId: string;
  denomMap: DenomMap;
  /**
   * Resolved on-chain SKU name (FIX 1, ENG-258 review). The recovery
   * path's manifest persistence records this — not the user's requested
   * `size` — so a deploy pinned by `skuUuid` persists the actual SKU name.
   */
  skuName: string;
}

async function handleBroadcastFailure(
  err: unknown,
  spec: DeploySpec,
  callbacks: DeployAppCallbacks,
  opts: DeployAppOptions,
  ctx: RecoveryContext,
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
      // Route β (ENG-185 #7): the rendered prompt body would otherwise be
      // dropped (only `options` flow into `onFailure`). Ride it on a
      // ProgressEvent emitted exactly once, immediately before the
      // (single) `onFailure` call — so it never fires on the inform-only
      // throw path below and `onFailure` stays invoked exactly once.
      callbacks.onProgress?.({
        kind: 'partial_success_prompt_rendered',
        prompt: promptPayload.prompt,
        leaseUuid: envelope.leaseUuid,
      });
      const choice = await callbacks.onFailure(envelope, options);
      return await dispatchRecovery(
        choice,
        envelope,
        spec,
        opts,
        callbacks,
        ctx,
      );
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
  callbacks: DeployAppCallbacks,
  ctx: RecoveryContext,
): Promise<DeployResult> {
  // Inline closures per gate-2 verdict (no separate strategy module).
  const leaseUuid =
    envelope.outcome === 'partially_succeeded' ? envelope.leaseUuid : '';
  switch (choice.id) {
    case 'retry_set_domain':
      return await retrySetDomainAndComplete(
        leaseUuid,
        spec,
        opts,
        callbacks,
        ctx,
      );
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

/**
 * `retry_set_domain` recovery: decompose the deploy after the partial-
 * success failure. ENG-185 sub-PR E.
 *
 * Steps (mirrors fred's atomic `deployApp` minus the create-lease tx,
 * which already succeeded):
 *   1. `setItemCustomDomain` — broadcast the domain claim against the
 *      pre-existing lease. Stack specs thread `serviceName` so the
 *      tx targets the named lease item.
 *   2. `fetchActiveLease` + `resolveProviderUrl` — look up the provider
 *      URL from the on-chain lease record (the partial-success error
 *      envelope only carries `leaseUuid`).
 *   3. `uploadLeaseData` — push the manifest payload to the provider.
 *      Uses the ADR-036 lease-data auth token (signed against the
 *      manifest's meta-hash).
 *   4. `pollLeaseUntilReady` — poll until the provider reports ACTIVE +
 *      running. Uses the LOWER-LEVEL primitive (not `waitForAppReady`)
 *      so the already-resolved `providerApiUrl` and auth-token closure
 *      pass through directly — no redundant on-chain queries (Copilot
 *      fix-1, PR #71). Reuses D's canonical polling-emission pattern:
 *      `onProgress` closure translates each `FredLeaseStatus` sample
 *      into a typed `polling_for_readiness` ProgressEvent, default
 *      480_000ms timeout overridable via `opts.waitForReadyTimeoutMs`.
 *   5. Defense #2 parity (post-poll re-classify) — guard the
 *      ACTIVE-with-no-instances race per D's pattern.
 *   6. Persist manifest (best-effort) + build typed `DeployResult` +
 *      emit `app_ready_confirmed` + `success_rendered` + onComplete.
 *
 * Failure paths (sibling-parity wraps — every catch site surfaces
 * `retry_set_domain <primitive-name> failed for lease ${leaseUuid}:
 * ${err.message}` in the thrown message, matching D's L548-550 style).
 * Error-code policy: typed `ManifestMCPError`s flow through with their
 * original code preserved (precedent at `estimateFees` — see the
 * `cosmosEstimateFee` catch block); untyped errors default to
 * `TX_FAILED`. The post-poll re-classify path likewise prefixes BOTH
 * the errorSummary-set and the no-errorSummary branches with
 * `retry_set_domain` + leaseUuid (Copilot fix-4, PR #71):
 *   - `setItemCustomDomain` throws → wrap with prefix + leaseUuid +
 *     code preservation. Most likely cause: chain rejected the
 *     set-item-custom-domain tx (FQDN validation, reserved-suffix
 *     match, lease not active, etc.).
 *   - `fetchActiveLease` / `resolveProviderUrl` throw → wrap with
 *     prefix + leaseUuid.
 *   - `uploadLeaseData` throws → wrap with prefix + leaseUuid.
 *   - `pollLeaseUntilReady` throws → wrap with prefix + leaseUuid.
 *   - Post-poll re-classify outcome !== 'active' → wrap both
 *     branches: errorSummary-set (terminal-state response) AND
 *     no-errorSummary fallback (ACTIVE-with-no-instances Defense #2
 *     race) carry prefix + leaseUuid.
 */
async function retrySetDomainAndComplete(
  leaseUuid: string,
  spec: DeploySpec,
  opts: DeployAppOptions,
  callbacks: DeployAppCallbacks,
  ctx: RecoveryContext,
): Promise<DeployResult> {
  const domain = customDomainOf(spec);
  if (!domain) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'retry_set_domain requires a customDomain in spec.',
    );
  }
  // C6 fix (preserved from pre-E impl): pass `serviceName` for stack
  // leases so the set-item-custom-domain tx targets the named service
  // item, not the default single-item lease.
  const serviceName = customDomainServiceOf(spec);
  const setItemOpts = serviceName ? { serviceName } : undefined;
  try {
    await setItemCustomDomain(
      opts.clientManager,
      leaseUuid,
      domain,
      setItemOpts,
    );
  } catch (err) {
    // Copilot fix-3 (PR #71): sibling-parity wrap. Every throw site in
    // this helper now surfaces `retry_set_domain` + leaseUuid in the
    // message for log/user-report correlation, matching the
    // fetchActiveLease/uploadLeaseData/pollLeaseUntilReady wraps below.
    // Preserve the original ManifestMCPError code when applicable
    // (precedent at `estimateFees` — see the cosmosEstimateFee catch
    // block); fall back to TX_FAILED for untyped errors.
    // Upstream traceability (Copilot fix-6, PR #71): `setItemCustomDomain`
    // from `core/src/tools/setItemCustomDomain.ts:63,69` genuinely throws
    // `ManifestMCPError(INVALID_CONFIG)` for validation failures — the
    // typed branch here is LIVE for the canonical chain-side errors
    // (FQDN shape, reserved-suffix match, etc.).
    const reason =
      err instanceof Error
        ? `retry_set_domain set-item-custom-domain failed for lease ${leaseUuid}: ${err.message}`
        : `retry_set_domain set-item-custom-domain failed for lease ${leaseUuid}: ${String(err)}`;
    const code =
      err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.TX_FAILED;
    throw new ManifestMCPError(code, reason);
  }

  // Resolve the lease + provider URL via on-chain queries. The
  // partial-success envelope only carried `leaseUuid` — fred's atomic
  // deployApp already had providerUuid in scope, but here we recover it.
  // BOTH values are hoisted to outer scope so the poll + DeployResult
  // build below can reuse them WITHOUT re-running the on-chain queries
  // (Copilot fix-1, PR #71: switching from `waitForAppReady` to the
  // lower-level `pollLeaseUntilReady` removes the 2 redundant queries
  // that `waitForAppReady`'s internal `fetchActiveLease` +
  // `resolveProviderUrl` calls would otherwise add per recovery).
  const queryClient = await opts.clientManager.getQueryClient();
  let lease: Awaited<ReturnType<typeof fetchActiveLease>>;
  let providerApiUrl: string;
  try {
    lease = await fetchActiveLease(
      queryClient,
      leaseUuid,
      'cannot complete retry_set_domain',
    );
    providerApiUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  } catch (err) {
    // Copilot fix-5 (PR #71): preserve typed ManifestMCPError codes
    // (matches the L1147 setItemCustomDomain precedent + the L818
    // estimateFees precedent). Honors fixup-4's JSDoc claim.
    // Upstream traceability (Copilot fix-6, PR #71):
    //   - `fetchActiveLease` throws `ManifestMCPError(QUERY_FAILED)` at
    //     `fred/src/tools/fetchActiveLease.ts:23,35` (lease not found
    //     on chain + lease-not-active).
    //   - `resolveProviderUrl` throws `ManifestMCPError(QUERY_FAILED)`
    //     at `fred/src/tools/resolveLeaseProvider.ts:13,25,36` (empty
    //     providerUuid + missing apiUrl + chain query failure).
    //   - Either can also surface `ProviderApiError` (validateProviderUrl
    //     path); untyped → TX_FAILED fallback.
    // Typed branch is LIVE for the canonical chain-side errors at this
    // catch — both upstream call sites genuinely emit ManifestMCPError.
    const reason =
      err instanceof Error
        ? `retry_set_domain failed to resolve provider for lease ${leaseUuid}: ${err.message}`
        : `retry_set_domain failed to resolve provider for lease ${leaseUuid}: ${String(err)}`;
    const code =
      err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.TX_FAILED;
    throw new ManifestMCPError(code, reason);
  }

  // Upload the manifest payload via the ADR-036 lease-data auth token
  // (signed against the manifest's meta-hash).
  const manifestBytes = new TextEncoder().encode(ctx.manifestJson);
  try {
    const leaseDataAuthToken = await ctx.getLeaseDataAuthToken(
      ctx.tenantAddress,
      leaseUuid,
      ctx.metaHash,
    );
    await uploadLeaseData(
      providerApiUrl,
      leaseUuid,
      manifestBytes,
      leaseDataAuthToken,
      opts.fetchFn,
    );
  } catch (err) {
    // Copilot fix-5 (PR #71): preserve typed ManifestMCPError codes.
    // Upstream traceability (Copilot fix-6, PR #71): fred's
    // `uploadLeaseData` does NOT throw typed `ManifestMCPError` — both
    // its underlying `validateProviderUrl` (`fred/src/http/provider.ts:14`)
    // and the wrapped `checkedFetch` surface throw `ProviderApiError`,
    // which is NOT a `ManifestMCPError`. So this `instanceof
    // ManifestMCPError` check is effectively a no-op for the typical
    // fred path — the typed branch is dead code today for this catch.
    // Pattern is kept for symmetry with the L1196/L1284 sites + safety
    // against future deps that DO throw typed errors (e.g. a hypothetical
    // core dependency in the upload path). For the typical fred-only
    // case, the fallback `TX_FAILED` is what surfaces.
    const reason =
      err instanceof Error
        ? `retry_set_domain manifest upload failed for lease ${leaseUuid}: ${err.message}`
        : `retry_set_domain manifest upload failed for lease ${leaseUuid}: ${String(err)}`;
    const code =
      err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.TX_FAILED;
    throw new ManifestMCPError(code, reason);
  }

  // Poll until the provider reports ACTIVE + running. Uses the LOWER-
  // LEVEL `pollLeaseUntilReady` directly (Copilot fix-1, PR #71) — not
  // `waitForAppReady` — so the already-resolved `providerApiUrl` and
  // auth-token closure pass through without re-running the on-chain
  // `fetchActiveLease` + `resolveProviderUrl` calls that
  // `waitForAppReady` would do internally. Saves ~2 queries (and ~2-6s
  // of avoidable latency) per recovery.
  //
  // The `onProgress` closure + `state?` discriminator-spread idiom +
  // `opts.waitForReadyTimeoutMs ?? 480_000` default mirror D's
  // canonical polling pattern verbatim.
  const pollStartMs = Date.now();
  let attempt = 0;
  let pollResult: Awaited<ReturnType<typeof pollLeaseUntilReady>>;
  try {
    pollResult = await pollLeaseUntilReady(
      providerApiUrl,
      leaseUuid,
      () => ctx.getAuthToken(ctx.tenantAddress, leaseUuid),
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
    // Names the actual primitive being awaited (post-fixup-1 +
    // fixup-4 consistency): `pollLeaseUntilReady`, not the higher-level
    // `waitForAppReady`. Matches the post-poll re-classify fallback's
    // wording at L1287 + the UNRECOGNIZED-state message at L1308 — all
    // three sites consistently name the primitive that's actually
    // running in this helper. Copilot fix-5 (PR #71): preserve typed
    // ManifestMCPError codes.
    // Upstream traceability (Copilot fix-6, PR #71): fred's
    // `pollLeaseUntilReady` does NOT throw typed `ManifestMCPError` —
    // its terminal-state path throws `TerminalChainStateError` which
    // `extends ProviderApiError` (`fred/src/http/fred.ts:278`), and its
    // timeout/HTTP paths throw `ProviderApiError` directly. Neither is
    // a `ManifestMCPError`. So this `instanceof ManifestMCPError` check
    // is effectively a no-op for the typical fred path — typed branch
    // is dead code today for this catch. Pattern is kept for symmetry
    // with the L1196/L1228 sites + safety against future deps that DO
    // throw typed errors. For the typical fred-only case, the fallback
    // `TX_FAILED` is what surfaces.
    const reason =
      err instanceof Error
        ? `retry_set_domain pollLeaseUntilReady failed for lease ${leaseUuid}: ${err.message}`
        : `retry_set_domain pollLeaseUntilReady failed for lease ${leaseUuid}: ${String(err)}`;
    const code =
      err instanceof ManifestMCPError
        ? err.code
        : ManifestMCPErrorCode.TX_FAILED;
    throw new ManifestMCPError(code, reason);
  }

  // Defense #2 parity (from D): re-classify the post-poll response and
  // refuse to declare success if the classifier doesn't see ACTIVE +
  // running instances. Catches the rare provider race where
  // `pollLeaseUntilReady` exits on state==ACTIVE but instances are empty.
  //
  // pollResult IS a `FredLeaseStatus` directly (no `WaitForAppReadyResult`
  // wrapping — that's what the refactor unlocked). The lease/provider
  // identity fields below come from the already-resolved values, NOT
  // from a (no-longer-existing) nested response object.
  const postPollResponse: DeployResponseShape = {
    lease_uuid: leaseUuid,
    provider_uuid: lease.providerUuid,
    provider_url: providerApiUrl,
    state: pollResult.state,
    connection: pollResult,
  };
  const classification = classifyDeployResponse(postPollResponse);
  if (classification.outcome !== 'active') {
    // Copilot fix-4 (PR #71): sibling-parity for BOTH branches. The
    // pre-fix `??` collapsed errorSummary (set when the post-poll
    // classifier produces 'failed' with a terminal-state response)
    // directly into the throw — no `retry_set_domain` prefix, no
    // leaseUuid. Both branches now carry the prefix + leaseUuid, and
    // the no-errorSummary fallback names the actual primitive
    // (`pollLeaseUntilReady` post-fixup-1, not `wait_for_app_ready`).
    const reason =
      classification.errorSummary !== undefined
        ? `retry_set_domain post-poll re-classification failed for lease ${leaseUuid}: ${classification.errorSummary}`
        : `retry_set_domain: pollLeaseUntilReady returned for lease ${leaseUuid} but post-poll classifier outcome is ${classification.outcome}`;
    throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
  }

  callbacks.onProgress?.({ kind: 'app_ready_confirmed', leaseUuid });

  // Persist manifest (best-effort; save-fail still emits success — same
  // contract as D's happy path).
  const persistedPath = await tryPersistManifest({
    leaseUuid,
    image: primaryImage(spec),
    // FIX 1: persist the RESOLVED SKU name (matches what was broadcast).
    size: ctx.skuName,
    metaHash: ctx.metaHash,
    chainId: ctx.chainId,
    manifestJson: ctx.manifestJson,
    customDomain: domain,
    customDomainService: serviceName,
    dataDir: opts.dataDir,
    callbacks,
  });

  // Build DeployResult. State decoding + urls extraction mirror the
  // happy-path block in `deployApp` verbatim. After the Copilot fix-1
  // refactor, `pollResult` IS a `FredLeaseStatus` (no wrapping), so
  // `liveState` reads from `pollResult.state` directly (numeric
  // `LeaseState`) and `extractRunningEndpoints` walks `pollResult` itself.
  const liveState = pollResult.state;
  let leaseStateDecoded: LeaseStateName;
  const decoded = decodeLeaseState(liveState);
  if (decoded === undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Unrecognized lease state from pollLeaseUntilReady response: ${String(liveState)}. Cannot safely classify; refusing to silently coerce to ACTIVE.`,
    );
  }
  leaseStateDecoded = decoded;
  const endpointUrls =
    extractRunningEndpoints(pollResult).map(formatEndpointAsUrl);
  // Lease + provider identity come from the already-resolved values,
  // not from a (no-longer-existing) wrapping response object.
  const result: DeployResult = {
    leaseUuid,
    providerUuid: lease.providerUuid,
    leaseState: leaseStateDecoded,
    urls: endpointUrls,
    customDomain: domain,
    manifestPath: persistedPath ?? '',
  };
  callbacks.onProgress?.({ kind: 'success_rendered', result });
  callbacks.onComplete?.(result);
  return result;
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
