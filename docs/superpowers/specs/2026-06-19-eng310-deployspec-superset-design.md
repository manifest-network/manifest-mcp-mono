# ENG-310 — agent-core DeploySpec superset (loss-free orchestration tier) — Design

**Issue:** ENG-310 (SDK P1, parent ENG-308). **Status:** design approved, pre-implementation.
**Branch:** `eng-310-deployspec-superset`.

## 1. Goal

Make the agent-core orchestration tier (`deployApp`/`manageDomain`/`troubleshootDeployment`/`closeLease`)
a **loss-free, optional** layer over the directly-usable core/fred actions. Today it is lossy: agent-core
declares its **own** narrow deploy input (`DeploySpec = SingleServiceSpec | StackSpec`) that **drops 9 rich
fields** (`user`, `tmpfs`, `health_check`, `stop_grace_period`, `init`, `expose`, `labels`, `depends_on`,
`storage`) and reshapes ports, and a subtractive mapper (`internals/build-fred-input.ts`) translates it down
to the canonical type. That narrowing is *why Barney bypassed agent-core* (per the issue). The fix: the
orchestration tier consumes the **canonical** deploy type verbatim, so no field can be lost and the two
types can never re-diverge.

The canonical deploy type already exists in `core`: **`AppDeploySpec`** (`packages/core/src/manifest-types.ts`),
of which fred's `DeployAppInput` is an alias. It is deliberately **data-only**; runtime knobs live on fred's
**`DeployCallOptions`** (`abortSignal`/`pollOptions`/`gasMultiplier`/`onLeaseCreated`).

## 2. Decisions (all validated sound + idiomatic — see §9 for sources)

### D1 — Strict verbatim reuse
agent-core's deploy input **IS `AppDeploySpec`**, imported from `core` and used **by name** across
core/fred/agent-core. **No** separate friendlier type, **no** `Omit`/derive. The agent-core `DeploySpec`
union (`SingleServiceSpec`/`StackSpec`/`ServiceDef`) is **deleted**.

*Why idiomatic:* this is the **limit case** of the wagmi-over-viem pattern. wagmi *derives*
(`type X = viem_X & ChainIdParameter`) **only because it adds a data field** (`chainId`). agent-core adds
**no** data field — its only additions are runtime concerns (abort/timeout/wallet), which belong on the
*options* type — so the intersection collapses to `& {}`, i.e. verbatim reuse + a separate options type.
Re-declaring or `Omit`-deriving here would be ceremony that reintroduces the exact drift ENG-310 fixes
(a wrapper re-declaring the wrapped shape is the Law-of-Leaky-Abstractions leak).

*Precondition (documented at the use site):* verbatim reuse is correct **only while** agent-core adds no
DATA field. If a future change genuinely needs an orchestration-only data field, the idiomatic escape hatch
is wagmi-style **derivation** (`AppDeploySpec & { newField }`), **never** a forked parallel type.

### D2 — `size` required (drop the silent `'small'` default)
`AppDeploySpec.size` is already required; agent-core's old auto-default-to-`'small'`
(`deploy-app.ts` `requestedSize()`) and its `size?` optionality are **removed**. A caller must name a tier
(or pin `skuUuid`) explicitly.

*Why idiomatic:* `size` selects a **billing tier** that draws down finite funded credit at a per-SKU price —
a cost-bearing, hard-to-undo selector. API-design authority (Google AIP, Terraform required-variable practice,
Principle of Least Astonishment) says such selectors must be **required**, not silently defaulted. The old
`'small'` was the *worst* case: a **surprising** default — a name-resolved, provider-ambiguous string (not a
guaranteed cheapest floor) whose consequence is ongoing credit drain.

*Implementation hazard (must address):* deleting the type-level optionality **without** deleting the
`requestedSize()` `'small'` fallback would silently re-introduce the default behind a required type — the same
class of divergence we are removing. Both must go together.

### D3 — Delete `build-fred-input.ts`; replace with a loss-free pin-override
The lossy mapper is deleted. The broadcast payload is built by spreading the (validated, possibly plan-edited)
spec through untouched and stamping only the **already-resolved** SKU identity:

```ts
const fredInput: AppDeploySpec = {
  ...spec,                       // every field survives — incl. the 9 formerly-dropped rich fields
  size: resolvedSku.name,        // the SKU the plan/confirm step already resolved
  skuUuid: resolvedSku.skuUuid,  // authoritative resolved pin (overwrites any raw pre-resolution hint)
  providerUuid: resolvedSku.providerUuid,
};
```

This **threads the resolved identity** (not raw input) — the repo's hard-won rule — so the broadcast can
never carry a contradictory pre-resolution hint, and it is loss-free by construction (the spec types are now
identical). The override may be inlined into `deployApp`; `internals/build-fred-input.ts` and
`build-fred-input.test.ts` are removed.

> The current mapper's own header documents two silent data-loss bugs it caused (`port[]` truncation to
> `port[0]`; preview-vs-deploy shape drift corrupting the on-chain meta-hash). Eliminating the mapping surface
> removes that whole bug class.

### D4 — Cancellation contract (abort/timeout on options + the callback contract)
`abortSignal` is added to **`DeployAppOptions`** (and the sibling options types), forwarded into fred's
existing `DeployCallOptions.abortSignal` — never onto the data spec (keeps the spec serializable; it is
persisted via `saveManifest`). The concrete contract:

1. **Signal placement & threading.** `abortSignal?: AbortSignal` on the options type → forwarded to fred →
   also threaded to the **interactive await points** (`onConfirm`/`onPlan`/`onResolveSku`/`onFailure`) so a
   pending human prompt rejects promptly on abort, and checked at each step boundary
   (`signal.throwIfAborted()` between awaits and around each `onProgress` emission).
2. **Two timeouts, NOT one — and no new third knob.** Keep the existing post-broadcast
   `waitForReadyTimeoutMs` (the *poll* budget) **separate** from the interactive-confirm timeout (the agent
   server's `MANIFEST_AGENT_ELICIT_TIMEOUT_MS`). Folding them into a single wall-clock budget would bill human
   deliberation against provisioning (MCP idle-vs-wall-clock guidance). The **only** public addition is
   `abortSignal?` — we deliberately do **not** add a generic `timeout?` field (it would be a third, confusable
   timeout alongside the two above). A caller who wants an overall operation deadline passes
   `AbortSignal.timeout(ms)` (composed with their own via `AbortSignal.any`) **as** that `abortSignal`; the
   orchestrator just honors whatever signal it is given.
3. **One cancellation outcome.** Both signal-abort and callback-decline (`onConfirm:'no'`/`onPlan:'cancel'`)
   map to the **existing** `ManifestMCPErrorCode.OPERATION_CANCELLED`. Caller-abort vs deadline is
   distinguishable via `signal.reason` (`AbortError` vs `TimeoutError`). No second "cancelled" error type.
4. **Observable via `onProgress`.** Emit a terminal `ProgressEvent` `kind: 'cancelled'` immediately before the
   `OPERATION_CANCELLED` throw (advisory UX only — the rejection stays the source of truth; this mirrors the
   existing "ride render payloads on ProgressEvents" posture).
5. **Partial-side-effect contract, stated out loud.** A **pre-broadcast** abort sends nothing (safe, no lease).
   A **post-broadcast** abort may leave a created lease / committed tx the signal cannot undo — it routes to
   the existing partial-success / `close_lease` recovery path and **never auto-retries** (verbatim from the
   `tx-confirmation.ts` "tx MAY STILL COMMIT → re-query" seam).

### D5 — Accept the canonical flat shape; runtime-guard the invalid combos; defer the discriminant
`AppDeploySpec` is flat (`image?` xor `services?`, no literal discriminant), so it *permits* the invalid
both/neither combos at the type level. We accept this (it is fred's existing shape) and guard it at runtime
via a single `validateSpec(spec)`. Tightening the **canonical type** with a real literal discriminant is a
*wider, breaking* change to `core` and is **deferred to a separate issue** — tracked, not hidden.

*Requirement:* `validateSpec` is the **mandatory single gate on every entry path** (initial call **and** the
post-edit `replace_spec` re-plan), run **before** the D3 spread. Because the type is shared verbatim, no layer
may assume an upstream layer validated — each independently-callable action validates at its entry.

## 3. Type surface (after)

- **Deploy input:** `AppDeploySpec` (core), re-exported from fred and agent-core **by name**. The
  `DeployAppInput = AppDeploySpec` alias in fred is marked a back-compat alias of the canonical name (doc-only,
  to prevent a de-facto second source).
- **`DeployAppOptions`** gains `abortSignal?: AbortSignal` (and keeps `waitForReadyTimeoutMs?`). Same
  `abortSignal?` added to `ManageDomainOptions`/`CloseLeaseOptions`/`TroubleshootOptions` for parity.
- **Callback contract** (`DeployAppCallbacks` and siblings): documented cancellation semantics per D4; add the
  `'cancelled'` `ProgressEvent` kind. The interactive callbacks receive/observe the effective signal.
- **`DeployResult`** is **unchanged** — it stays a deliberate camelCase *domain projection*, distinct from
  fred's snake_case `DeployResult` DTO (pinned by a mapping test). **Only the INPUT spec is unified**; do not
  collapse the output DTO-vs-domain boundary.

## 4. Migration / consumer impact

- **`deploy-app.ts` internals** switch from the union to `AppDeploySpec`: remove the unsafe
  `spec as SingleServiceSpec` / `spec as StackSpec` casts (`~:870/906/1067`); replace the `isStackSpec` guard
  with the canonical `'services' in spec`; delete `requestedSize()`'s `'small'` default; helpers
  (`primaryImage`/`customDomainOf`/`estimateFees`/`applyPlanEdit`/…) read canonical fields.
- **`internals/spec-normalize.ts`** (`isStackSpec`/`summarizeSpec`/`validateSpec`/`normalizeServices`) updates
  to the canonical shape; `validateSpec` becomes the both/neither gate.
- **Frozen-surface type test** (`types.test.ts` pinning `SingleServiceSpec`/`StackSpec`/`ServiceDef`) is
  replaced by a test asserting agent-core's deploy input **is** `AppDeploySpec` (e.g. a `*.test-d.ts`
  equivalence assertion) — the surface is now defined by reuse, not a frozen copy.
- **`agent/elicitation.ts`** parses user JSON `as AppDeploySpec`; the MCP `deploy_app_orchestrated` input
  schema marks **`size` required** so AI hosts elicit it, and the size-missing error points the caller at
  `get_skus`/`list_skus`.
- **`examples/sdk-acceptance/src/flow.ts`** keeps deriving `Parameters<typeof deployApp>[…]` (drift-proof) —
  it now resolves to `AppDeploySpec`; the example deploy already passes a `size`, so no behavior change there.
- **Breaking change:** `size`-required + the input-shape change are **source-breaking** for external/headless
  callers — land as a documented entry in the pre-1.0 `0.x` lockstep notes (same posture as PR #102).

## 5. Governance / boundary housekeeping

- **§8 chokepoint:** verified there is **no agent-core-specific exemption** in `.dependency-cruiser.cjs` — the
  `manifestjs-types-chokepoint` rule already forbids agent-core from importing manifestjs codegen types
  (agent-core routes through `core`). So ENG-310's "remove the §8 exemption" is **satisfied by construction**
  once the narrow `DeploySpec` is gone; **no depcruise rule change is needed**. (Confirm during implementation;
  if a grandfather note exists only in spec *text*, that historical note — not on `main` post-PR-#102 — is a
  doc cleanup, not an enforced rule.)
- Add a one-line comment at the `AppDeploySpec` reuse/alias site stating the **no-data-delta precondition**
  and the derive-don't-fork escape hatch (D1).

## 6. Testing strategy

- **Loss-free proof (the headline):** a test deploys via agent-core `deployApp` with a spec populated with
  **all 9 formerly-dropped rich fields** + a stack `services` map, and asserts the fred broadcast payload
  carries every one of them unchanged (the inverse of today's `build-fred-input.test.ts`, which had no path
  for those fields).
- **Resolved-identity threading:** assert the broadcast `size`/`skuUuid`/`providerUuid` are the **resolved**
  values, overwriting any raw pre-resolution hints in the spread (D3).
- **`validateSpec` matrix:** all four image×services combos (image-only ✓, services-only ✓, both ✗, neither ✗)
  on **both** the initial and post-`replace_spec` paths.
- **Cancellation paths (D4):** pre-broadcast abort → `OPERATION_CANCELLED`, no lease; post-broadcast abort →
  `OPERATION_CANCELLED` + routes to partial-success/`close_lease`, **no** auto-retry; abort during a pending
  `onConfirm` rejects promptly; `TimeoutError` vs `AbortError` distinguishable; terminal `'cancelled'`
  ProgressEvent emitted before the throw; callback-decline and signal-abort share the one error code.
- **`size` required:** missing `size` → clear validation error referencing `get_skus`; MCP schema marks it
  required.
- **Boundary preservation:** the existing `DeployResult` camelCase-domain vs snake_case-DTO mapping test stays
  green (unchanged).
- Full-repo gate (`build`/`lint`/`vitest`/`check`/`depcruise`/size) green.

## 7. Out of scope / deferred

- A **real literal discriminant** on the canonical `AppDeploySpec` (single-vs-stack) — a wider breaking change
  to `core`, tracked as a separate follow-up (D5).
- `PortConfig` (ENG-282) wiring into `ServiceConfig.ports` — already forward-declared, not part of ENG-310.
- ctx-ification of the remaining positional fred functions (a later phase).

## 8. Open questions

None blocking. The two judgment calls the user blessed: **two separate timeouts** (interactive-confirm vs
post-broadcast poll) and **one `OPERATION_CANCELLED` outcome** for both abort and callback-decline.

## 9. Idiom sources (research-backed)

- Verbatim reuse as the zero-delta limit of wagmi derivation: wagmi `readContract`/`writeContract`/`getBalance`
  intersect an added `chainId` data field onto viem's params (wevm/wagmi core source); single-source-of-truth
  for types (Total TypeScript; TS monorepo type-sharing). "Sharing is harmful" applies to **external** or
  **cross-concept** reuse, not same-operation internal layers (DEV `pyjac`; CodeOpinion).
- Delete the lossy mapper: CodeOpinion "DTOs & Mapping: The Good, The Bad, And The Excessive".
- `size` required: Google AIP-149/203; Terraform required-variables practice; Principle of Least Astonishment.
- abort/timeout on options + cooperative cancellation + `throwIfAborted`/`AbortSignal.any`/`AbortSignal.timeout`:
  OpenJS "Using AbortSignal in Node.js"; MDN; NearForm/AppSignal/Simon Plenderleith; ArcGIS async-cancellation.
- Orchestration/façade tier: Wikipedia (Wrapper library; Hexagonal output-ports); AWS Prescriptive Guidance
  (Saga orchestration); event-driven.io ("keep orchestration optional").
- MCP long-running cancellation (idle-vs-wall-clock; cancelled call still resolves): MCP SEP-1539;
  anthropics/claude-code#58687; openai/codex#20925.
- Flat-optional vs discriminant (deferred): TS Handbook (Narrowing); Optique 1.0 case study; Convex/Stevekinney.
