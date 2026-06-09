# ENG-258 — SKU resolution by name with duplicate names (design)

- **Issue:** [ENG-258](https://linear.app/liftedinit/issue/ENG-258) — *manifest-mcp-mono (fred/agent-core): SKU resolution by name assumes uniqueness; breaks with duplicate SKU names*
- **Date:** 2026-06-09
- **Scope:** `manifest-mcp-mono` only (packages `core`, `fred`, `agent-core`, `agent`). Cross-repo siblings (ENG-257 barney, ENG-259 manifest-deploy, ENG-260 plugin) are **out of scope**.
- **Status:** design — awaiting review before planning.

## 1. Problem

The chain (`manifest-ledger` `x/sku`) identifies a SKU solely by a server-assigned UUIDv7. `name` is a free-form label; the chain enforces **no** name-uniqueness and carries a `provider_uuid` on every SKU. Two providers — or one provider — can each publish a SKU named `docker-micro`.

The TS code resolves a user's `size`/`storage` **name** to a SKU in several places and assumes the name is unique:

- It returns the **first** name match (lease creation + fee estimation).
- It builds a `Map`/object keyed by name with **last-wins** (readiness pre-flight).
- It gates on bare name **membership** (readiness verdict).
- It collapses same-named SKUs into one tier row keyed by name (`browse_catalog`).

The user-visible failure: a deploy of `docker-micro` lands a **paid lease on a non-deterministic provider** at that provider's price, and the plan/fee/readiness verdict can describe a *different* SKU than the one actually leased — with no channel to say "the `docker-micro` from provider X".

The product goal is to **support** duplicate names end-to-end. `provider_uuid` + name is the natural disambiguator; the SKU UUID is the fully-safe key.

## 2. Current state on `main` (what ENG-280 already landed)

PR #88 (ENG-280, "split deployApp into buildManifest + deployManifest") incidentally laid groundwork in **fred's `deployManifest.ts`**:

- `findSkuUuid(queryClient, size, providerUuid?)` — filters by provider, throws `INVALID_CONFIG` when the named SKU isn't offered by the requested provider. ✅
- Storage SKU resolved against the **same** provider as compute (issue fix #2). ✅
- A `SkuSelector` union — `{ kind: 'byName'; size }` | `{ kind: 'resolved'; skuUuid; providerUuid }` — where `resolved` bypasses name lookup. ✅
- `checkDeploymentReadiness` already returns `sku` with `uuid` + `provider_uuid` (single).

**Still missing / unchanged (the bulk of ENG-258):**

- fred `findSkuUuid` still **silently picks `named[0]`** when no `providerUuid` is given — no AMBIGUOUS path (fix #1 incomplete).
- agent-core `internals/find-sku-uuid.ts` is still the **old** `(clientManager, size)` first-match, with a docstring justifying *not* unifying it with fred.
- fred `checkDeploymentReadiness` still builds a **last-wins** `Map(name→sku)` and a flat `available_sku_names`.
- agent-core `evaluate-readiness.ts` still gates on bare **name membership** (`availableSkuNames.includes(size)`).
- fred `browseCatalog` tier entries carry **no** SKU uuid, and the `provider` field is overloaded (`apiUrl ?? providerUuid`).
- `deploy_app` / `check_deployment_readiness` tool schemas have **no** `provider_uuid`/`sku_uuid` input.
- agent-core's `DeploySpec` / `estimateFees` have no disambiguator to thread, so plan/fee/broadcast can disagree (fix #8).

## 3. Decisions

Q1, Q2, Q5, Q6 were **confirmed** with the issue author. Q3 and Q4 are my **proposed** answers to the issue's open questions — please confirm or steer them at the review gate.

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Disambiguator inputs + precedence | Accept **both** optional `provider_uuid` (narrows name lookup) and raw `sku_uuid` (bypasses name lookup). `sku_uuid` wins; `provider_uuid`, if also supplied, is validated against the resolved SKU. |
| Q2 | Behavior on ambiguity | **Both:** fred/core throws a structured `SKU_AMBIGUOUS` error enumerating candidates; the elicitation-capable **agent** server catches it and asks the user inline. fred-direct callers get the error and re-call. |
| Q3 | Render provider in the deployment plan | **Yes** — add a `Provider` line to `renderDeploymentPlan` when the SKU is pinned (show `provider_uuid`, and `provider_url` when available). A paid lease must show which provider gets it. |
| Q4 | Storage SKU provider | **Same provider as compute, enforced.** A lease binds a single provider (single-`providerUrl` model). Mixed-provider leases are a **non-goal**. ENG-280 already enforces this; the shared resolver preserves it. |
| Q5 | findSkuUuid unification | **Extract one shared resolver into `core`.** Both fred and agent-core consume it. Supersedes the prior "keep duplicated" verdict — ENG-258 needs identical AMBIGUOUS logic in both, so a single source removes the divergence risk. |
| Q6 | `browse_catalog` shape | **Flat `skus[]` array** of self-identified resources; drop the name-keyed `tiers`. Grounded in API-design idiom (Google AIP-132, JSON:API, general REST): collections are arrays of resources each carrying a stable id, never objects keyed by a (non-unique) value. The current `tiers: Record<name, …>` is structurally the bug. |

## 4. Architecture

**Single resolution point, pinned end-to-end.** Today the SKU name is resolved independently at fee-estimation time *and* again inside fred's broadcast — they can disagree. The new design resolves the name to a concrete `(skuUuid, providerUuid)` **once, as early as possible**, then threads that pin through every downstream step so plan, fee estimate, and broadcast all reference the same SKU (fix #8).

Layering (respecting the existing `node → {fred, agent} → {agent-core} → core` direction):

```
core/sku-resolution.ts   ← NEW. resolveSku(queryClient, {size, providerUuid?, skuUuid?})
        │                   → { skuUuid, providerUuid, name, price, active }
        │                   throws QUERY_FAILED (0 matches) | SKU_AMBIGUOUS (>1, no pin)
        ├── fred  (deployManifest, deployApp input, checkDeploymentReadiness, browseCatalog)
        └── agent-core (deploy-app pin → estimateFees + fred 'resolved' selector; evaluate-readiness)
                 └── agent (elicit on SKU_AMBIGUOUS via onResolveSku)
```

### 4.1 `core` — new shared resolver + error code

**New error code.** Add `SKU_AMBIGUOUS = 'SKU_AMBIGUOUS'` to `ManifestMCPErrorCode` (`packages/core/src/types.ts`) under a new "SKU resolution" category. Classify it **non-retryable** (`retry.ts` `NON_RETRYABLE_ERROR_CODES`) — like `OPERATION_CANCELLED`, retrying without new input is pointless; it needs caller disambiguation. It is **not** an infrastructure error.

*Why a dedicated code (vs. overloading `INVALID_CONFIG`):* in the repo's extensible domain-error enum, a named code is the idiomatic analog of [AIP-193](https://google.aip.dev/193)'s "differentiate by stable `reason`" rule — AIP-193 can't add gRPC canonical codes, so it discriminates via `(reason, domain)` in `ErrorInfo.details`; the repo *can* add a code, so it does. Semantically the condition is input-insufficiency (the `size` is non-unique) regardless of which SKUs exist, i.e. `INVALID_ARGUMENT`-like, hence non-retryable.

**Machine-readable details.** Per AIP-193 (request-specific data belongs in structured `details`, not just the message) and the MCP tools spec (tool errors are returned as a result with `isError: true` whose content the client feeds back to the model for self-correction), the error carries:

```ts
new ManifestMCPError(ManifestMCPErrorCode.SKU_AMBIGUOUS, humanMessageEnumeratingCandidates, {
  reason: 'AMBIGUOUS_SKU_NAME',   // stable discriminator — agent-core's catch keys off this, not the prose
  size,
  candidates: SkuCandidate[],     // name + sku_uuid + provider_uuid + price + active
});
```

This is already wired end-to-end: `withErrorHandling` (`core/server-utils.ts:155-197`) returns `{ isError: true, content: [JSON of { code, message, details }] }` — **not** a JSON-RPC protocol error — so the candidate list reaches the model verbatim. agent-core's catch branches on `err.code === SKU_AMBIGUOUS` (and reads `err.details.candidates`); the agent server passes the same candidates to `onResolveSku`. *(Optional polish: also mirror `candidates` into `structuredContent` on the error result; not required since the text-JSON content already carries it and error results have no `outputSchema`.)*

**New module `packages/core/src/sku-resolution.ts`** (platform-neutral; uses only `ManifestQueryClient`, `createPagination`, `MAX_PAGE_LIMIT`, `ManifestMCPError` — all already in core, no node-only deps). Exported from the core barrel (`index.ts`).

```ts
export interface SkuCandidate {
  readonly skuUuid: string;
  readonly providerUuid: string;
  readonly name: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
}

export interface ResolveSkuInput {
  readonly size: string;
  readonly providerUuid?: string; // narrow name matches to one provider
  readonly skuUuid?: string;      // bypass name lookup entirely; wins over size/providerUuid
}

/**
 * Resolve a SKU intent to a single concrete SKU.
 *  - skuUuid given  → look it up directly; validate providerUuid if also given.
 *  - else by name   → collect ALL active name matches:
 *      0           → throw QUERY_FAILED (lists available names)
 *      1           → return it
 *      >1, no prov  → throw SKU_AMBIGUOUS (details = { reason: 'AMBIGUOUS_SKU_NAME', size, candidates: SkuCandidate[] })
 *      >1 + prov    → filter to provider; 1 → return; 0 → QUERY_FAILED; >1 → SKU_AMBIGUOUS (same-provider dupes → require skuUuid)
 */
export async function resolveSku(
  queryClient: ManifestQueryClient,
  input: ResolveSkuInput,
): Promise<SkuCandidate>;

/** List all active candidates for a name (no throw on >1). Used by readiness. */
export async function listSkuCandidates(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string,
): Promise<SkuCandidate[]>;
```

The `SKU_AMBIGUOUS` error carries `details.candidates: SkuCandidate[]` (name + provider_uuid + sku_uuid + price) and a human message enumerating them, so any caller — LLM driving fred directly, or the agent server eliciting — has the full menu without a second query.

**`skuUuid` lookup** uses the existing `sku.v1.sKU({ uuid })` single-SKU query (already routed in `core/queries/sku.ts`).

### 4.2 `fred` — consume the resolver; expose the inputs

**`deployManifest.ts`:** delete the local `findSkuUuid`; call `resolveSku`. Extend the `byName` selector to carry the optional provider pin:

```ts
type SkuSelector =
  | { kind: 'byName'; size: string; providerUuid?: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };
```

- `byName` → `resolveSku(qc, { size, providerUuid })`.
- `resolved` → trusted verbatim (existing non-empty validation stays).
- **Storage** still resolves against the compute `providerUuid` (Q4) via `resolveSku(qc, { size: storage, providerUuid })`; same-provider dupes surface `SKU_AMBIGUOUS`. (Optional escape hatch `storageSkuUuid` deferred unless review wants it now.)

**`deployApp.ts` (`DeployAppInput`):** add optional `providerUuid?` and `skuUuid?`. Map to the selector: `skuUuid` present → `{ kind: 'resolved', skuUuid, providerUuid }` (providerUuid required when skuUuid is used as a `resolved` pin — if absent, resolve via `resolveSku({skuUuid})` first to learn the provider, then pass `resolved`); else `{ kind: 'byName', size, providerUuid }`.

**`checkDeploymentReadiness.ts`:** drop the `Map(name→sku)` last-wins. New behavior:

- New inputs: `providerUuid?`, `skuUuid?`.
- `sku_candidates: SkuSummary[]` — **all** active matches for `size` after any narrowing (0/1/many), each `{ name, uuid, provider_uuid, price?, active }`.
- `sku: SkuSummary | null` — the determinate pick when exactly one candidate remains (naturally unique or narrowed); `null` when 0 or still-ambiguous.
- `available_skus: { name; uuid; provider_uuid }[]` — structured replacement for the flat list.
- `available_sku_names: string[]` — **removed** (clean-break policy, §9). Because agent-core's `evaluate-readiness-from-fred` reads this field today, its removal is sequenced into Phase 4 *together* with the translator update — never a release where one package compiles and the other doesn't.
- `missing_steps` / `ready`: size given & 0 candidates → "not available"; >1 candidates & no pin → "ambiguous — specify provider_uuid or sku_uuid" (`ready:false`); exactly 1 → run the existing balance/credit checks against that SKU's price.

This makes readiness do **no** silent picking; it reports the candidate set honestly.

**`browseCatalog.ts`:** return a flat `skus` array, drop `tiers`:

```ts
return {
  providers,                 // unchanged: { uuid, address, apiUrl, active, healthy, ... }
  skus: skusResult.skus.map((s) => ({
    name: s.name,
    sku_uuid: s.uuid,
    provider_uuid: s.providerUuid,
    provider_url: providerByUuid.get(s.providerUuid)?.apiUrl ?? null,
    price: s.basePrice?.amount ?? null,
    unit: s.basePrice?.denom ?? null,
    active: s.active,
  })),
};
```

Splits the overloaded `provider` field into explicit `provider_uuid` + `provider_url` (latent bug fix). The same flat shape is mirrored in `register-resources.ts` (the `manifest://catalog` resource builds the same payload).

**`register-tools.ts` schemas:**
- `deploy_app`: add optional `provider_uuid` (string) + `sku_uuid` (string, uuid) with `.describe(...)` explaining the disambiguation flow; output already returns `provider_uuid`.
- `check_deployment_readiness`: add optional `provider_uuid` + `sku_uuid`; output `sku_candidates[]` + `available_skus[]` (keep `sku` nullable + `available_sku_names` deprecated).
- `browse_catalog`: replace `tiers` output schema with `skus: z.array(z.looseObject({}))` (or a precise object schema).

**`register-prompts.ts` (`deploy-containerized-app`):** update step 3 prose — instead of "provider from `check_deployment_readiness.sku`", instruct: if `sku_candidates` has >1 entry, present them and ask the user to pick a `provider_uuid` (or `sku_uuid`), then pass it to `deploy_app`. Drop the assumption that name → a single SKU/provider.

### 4.3 `agent-core` — resolve the pin early, thread it everywhere

**Delete `internals/find-sku-uuid.ts`** (and its `SkuResolution` type); import `resolveSku` from core. Update `find-sku-uuid.test.ts` accordingly (move/retarget to core's resolver test).

**`deploy-app.ts` flow change.** Resolve the SKU pin **before** readiness/plan, reading the intent from the spec the same way `requestedSize` does today (extend the loosely-read intent to `{ size, providerUuid?, skuUuid? }`; a typed `SkuIntent` is an optional cleanup):

1. `candidate = resolveSku(queryClient, { size, providerUuid, skuUuid })` —
   - 0 → throw `QUERY_FAILED` (not found).
   - 1 → pin it.
   - `SKU_AMBIGUOUS` → if `callbacks.onResolveSku` is present, call it with `details.candidates` to get a `{ skuUuid, providerUuid }` pin, then re-resolve as `resolved`; if absent, **re-throw** `SKU_AMBIGUOUS` (headless callers surface the error).
2. Thread the pinned `(skuUuid, providerUuid, price)` into:
   - `estimateFees` — replace `findSkuUuid(clientManager, size)` with the pin (no second resolution).
   - `evaluateReadiness` — pass the pinned candidate + its price.
   - `buildFredDeployInput` — emit a `resolved` selector so fred does **not** re-resolve by name. (Requires `DeployAppInput.skuUuid`/`providerUuid` from §4.2; `buildFredDeployInput` sets them.)
3. `renderDeploymentPlan` — add the `Provider` line (Q3).

**New callback** in `DeployAppCallbacks` (`types.ts`):

```ts
onResolveSku?: (
  candidates: SkuCandidate[],
) => Promise<{ skuUuid: string; providerUuid: string }>;
```

Plus a `ProgressEvent` `{ kind: 'sku_ambiguous'; candidates }` emitted before the call (mirrors the `partial_success_prompt_rendered` pattern), and re-export `SkuCandidate` from agent-core's public types.

**`evaluate-readiness.ts` (fix #4):** replace the `availableSkuNames.includes(size)` gate. New input: `skuCandidates: { name; providerUuid; price? }[]` (+ optional `requestedProviderUuid`). Block when `size` is set and no candidate matches name (and provider, if requested). Price math uses the matched/pinned candidate. `availableSkuNames` stays as an *optional* fallback for direct/legacy callers; the fred path always supplies `skuCandidates`, so the old ">50-name fold" is deleted.

**`evaluate-readiness-from-fred.ts`:** map fred's `sku_candidates` into the evaluator's `skuCandidates` input. Derive the evaluator's `availableSkuNames` from `available_skus` (the flat `available_sku_names` field is being removed in this same Phase-4 change). This is the file that pins the clean-break sequencing: the PR that drops `available_sku_names` from fred's result + tool schema is the PR that lands this translator update.

### 4.4 `agent` — elicit on ambiguity

**`elicitation.ts`:** add `buildSkuPickSchema(candidates)` — a flat enum of `sku_uuid` values with `enumNames` = `"<name> @ <provider_uuid> (<price>)"` — and `parseSkuChoice(result, candidates)` returning `{ skuUuid, providerUuid }`. Dismiss/timeout default: **cancel** (throw `OPERATION_CANCELLED`) — no on-chain state exists at resolution time, so cancelling is fully safe (mirrors the `onPlan` reject path).

**`callbacks.ts` (`makeDeployCallbacks`):** wire `onResolveSku` → `server.elicitInput(buildSkuPickSchema(...))` → `parseSkuChoice`, with the same `elicitOptions(extra)` timeout/abort handling and a warning notification on dismiss.

**`index.ts` / `register-tools` (agent):** add `provider_uuid` + `sku_uuid` to `deploy_app_orchestrated`'s input schema and thread them into the spec intent. `assertElicitationCapability` already gates the broadcasting tools.

### 4.5 Consistency: resolve-early, pin-by-UUID, commit-on-chain

The SKU is resolved to a concrete UUID at plan time, but the `create-lease` tx is broadcast **later** — possibly minutes later, after the user sits in an `onResolveSku`/`onConfirm` elicitation. That is a classic time-of-check-to-time-of-use window: between pin and broadcast a provider could deactivate or re-price the SKU. The design is deliberately safe across that window:

- **The pin is an immutable UUID.** Unlike the status quo (re-resolving the *name* inside fred's broadcast), a stale UUID can never silently resolve to a *different* SKU/provider/price than the plan showed. The worst case is the exact SKU disappearing.
- **The chain is the atomic commit point.** `create-lease` re-validates the SKU UUID at execution; a deactivated/again-ambiguous pin yields a clean **tx rejection**, never a wrong or mispriced lease. This is the "make the authorization check and the state mutation it gates atomic" principle from TOCTOU guidance — here the chain provides that atomicity for free, so agent-core needs no optimistic-lock/CAS of its own.
- **Readiness and the plan are advisory snapshots**, explicitly not a lock. The chain tx is the source of truth; a snapshot going stale degrades to a clean failure the caller can retry, not a correctness bug.

Net: pinning by UUID is *strictly more* consistent than today's resolve-by-name-at-broadcast, and the existing partial-success error path already handles a `create-lease` rejection.

## 5. End-to-end data flow (duplicate `docker-micro` on providers P1, P2)

**fred-direct (LLM driving the fred server):**
1. LLM calls `check_deployment_readiness({ size: 'docker-micro' })` → `sku_candidates: [P1, P2]`, `sku: null`, `ready:false`, missing_step "ambiguous — specify provider_uuid".
2. LLM calls `deploy_app({ size: 'docker-micro' })` → `SKU_AMBIGUOUS` error with `candidates`.
3. LLM re-calls `deploy_app({ size: 'docker-micro', provider_uuid: P2 })` → resolves to P2's SKU, leases on P2 at P2's price.

**agent (orchestrated):**
1. `deploy_app_orchestrated({ size: 'docker-micro' })`.
2. agent-core `resolveSku` → `SKU_AMBIGUOUS` → `onResolveSku([P1,P2])`.
3. agent server elicits a pick → user chooses P2 → `{ skuUuid, providerUuid: P2 }`.
4. agent-core pins P2; plan (with `Provider: P2`), fee estimate, and fred broadcast all reference P2's SKU. One lease, on the intended provider, at the shown price.

## 6. Testing strategy

**Invert the bug-asserting tests:**
- `agent-core/.../find-sku-uuid.test.ts:92-101` ("matches first SKU on name… if duplicates exist") — **invert** to expect `SKU_AMBIGUOUS` / provider-narrowed result. (Test moves to core's resolver suite.)
- `fred/.../checkDeploymentReadiness.test.ts` single-SKU-by-name + flat `available_sku_names` cases — update to the candidates shape; add a duplicate-name case.
- `fred/.../deployManifest.test.ts` — extend the existing `ENG-258 #2` provider-filter tests with the AMBIGUOUS path.
- `browseCatalog.test.ts`, `fred/.../server.test.ts` (annotation/shape pins), agent-core `deploy-app.test.ts` (mocks `findSkuUuid`/`checkDeploymentReadiness`), `evaluate-readiness*.test.ts` — update to new signatures/shapes.

**New unit cases:**
- core `resolveSku`: 0 → QUERY_FAILED; 1 → ok; >1 no provider → SKU_AMBIGUOUS w/ candidates; >1 + provider → narrowed; same-provider dupes + provider → SKU_AMBIGUOUS (require uuid); `skuUuid` bypass; `skuUuid` + mismatched `providerUuid` → error.
- readiness: same-name/different-provider returns both candidates with distinct provider/price; storage SKU on a different provider than compute is rejected.
- agent elicitation: `parseSkuChoice` accept/dismiss; `buildSkuPickSchema` enum/enumNames.

**Annotation contract:** `deploy_app` / `check_deployment_readiness` / `browse_catalog` annotation + `_meta.manifest` matrices in `server.test.ts` are the public contract — update the pinned shapes deliberately (downstream-visible; coordinate with ENG-260).

**e2e:** SKU-by-name `.find(s => s.name === …)` helpers (deploy-roundtrip, misc-edges, lifecycle, billing-*, chain-routing) pin by `sku_uuid`/`provider_uuid` and consume the flat `skus[]` shape.

## 7. Non-goals

- **Pagination** of `browse_catalog` (AIP-132 `next_page_token`) — the tool already pulls the full bounded page; out of scope.
- **Mixed-provider leases** — the lease model binds one provider; storage stays on the compute provider.
- **Cross-repo consumers** (barney, manifest-deploy, plugin) — tracked by ENG-257/259/260. This work *unblocks* ENG-260 by shipping `sku_uuid`/`provider_uuid` in `browse_catalog` + `check_deployment_readiness`.
- The **Fred backend service** — confirmed uninvolved in name→uuid resolution (SKUs are read from chain; backend operates on lease/SKU UUIDs).

## 8. Suggested build sequence (refine in planning)

Layered to match the dependency direction; each step independently testable:

1. **core** — `SKU_AMBIGUOUS` code + `resolveSku`/`listSkuCandidates` + retry classification + tests.
2. **fred resolution** — `deployManifest` + `DeployAppInput` use `resolveSku`; `byName` selector carries `providerUuid`; `deploy_app` schema gains `provider_uuid`/`sku_uuid`.
3. **fred readiness + catalog** — `checkDeploymentReadiness` candidates; `browseCatalog` flat `skus[]`; schemas + `register-resources` + `register-prompts`.
4. **agent-core** — delete dup resolver; resolve-pin-early + `onResolveSku`; thread pin into `estimateFees`/`buildFredDeployInput`/`renderDeploymentPlan`; `evaluate-readiness` candidate gate + translator.
5. **agent** — `buildSkuPickSchema`/`parseSkuChoice`; wire `onResolveSku`; `deploy_app_orchestrated` inputs.
6. **e2e** — pin helpers by uuid/provider; duplicate-name scenario.

Final PR slicing (one PR vs. layered sub-PRs) to be decided in the implementation plan.

## 9. Open items — resolved

- **API-evolution policy — RESOLVED: (b) clean break.** Apply one consistent policy to both read tools: `browse_catalog` removes `tiers`; `check_deployment_readiness` removes `available_sku_names`. Justified pre-1.0 (`0.x` — [SemVer permits breaking changes](https://semver.org/), repo bumps the minor for them) with known, internal, coordinated consumers (ENG-257 barney, ENG-260 plugin), and because the removed shapes *are* the anti-pattern this issue retires. `readiness.sku` **stays** — it's the determinate single pick, not a back-compat crutch. Sequencing: `tiers` removal lands in Phase 3 (no agent-core consumer); `available_sku_names` removal lands in Phase 4 with the translator update (agent-core reads it), so no release has a half-built monorepo.
- **`storageSkuUuid` escape hatch — RESOLVED: defer.** Storage resolves by name on the compute provider; same-provider storage dupes fail safe with `SKU_AMBIGUOUS` (no wrong lease). Adding the pin later is purely additive. Tracked as a follow-up (see §11).
- **Typed `SkuIntent` — RESOLVED: defer.** Keep the existing `size`-smuggling convention (`(spec as { size? }).size`); thread `providerUuid`/`skuUuid` the same way. Promoting to a typed `SkuIntent { size, providerUuid?, skuUuid? }` touches `validateSpec` / `spec-normalize` / the agent passthrough — an orthogonal refactor. Tracked as a follow-up (see §11).

## 11. Follow-ups (deferred work)

Filed against the deferred decisions above:

- **[ENG-295](https://linear.app/liftedinit/issue/ENG-295) — `storage_sku_uuid` pin** — let callers disambiguate a same-provider storage-SKU name collision (the compute path is covered; storage is the remaining gap). Purely additive: one optional input + one resolver arg.
- **[ENG-296](https://linear.app/liftedinit/issue/ENG-296) — typed `SkuIntent`** — promote `{ size, providerUuid?, skuUuid? }` off the loose spec cast into a typed field; clean up the pre-existing `size`-smuggling in `requestedSize`/`buildFredDeployInput`.

## 10. Industry-practice review (benchmarks)

The key design choices were checked against current API / MCP guidance:

| Choice | Verdict | Reference |
|--------|---------|-----------|
| `browse_catalog` → flat `skus[]` array of self-identified resources (not an object keyed by non-unique name) | **Idiomatic.** Collections are repeated/array fields of resources each with a stable id; never key a collection by a value. | [AIP-132](https://google.aip.dev/132), [JSON:API](https://jsonapi.org/format/), [apisyouwonthate](https://apisyouwonthate.com/blog/understanding-resources-and-collections-in-restful-apis/) |
| Ambiguity → error with stable `reason` + structured `candidates` in `details` | **Idiomatic.** Errors carry `ErrorInfo`-style `(reason, domain)` + request-specific metadata in `details`. | [AIP-193](https://google.aip.dev/193) |
| Surface the error as a tool result with `isError: true` (model self-corrects) rather than a JSON-RPC protocol error | **Idiomatic & already implemented** in `withErrorHandling`. Tool-execution errors are fed back to the model; protocol errors are not. | [MCP tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) |
| Agent path: elicit the pick in-band (`onResolveSku`) instead of failing the whole flow | **Idiomatic.** Elicitation gathers exactly the missing/ambiguous input mid-tool-call, minimizing round trips and avoiding a separate agent loop. | [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), [GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-smarter-interactions-with-mcp-elicitation-from-clunky-tool-calls-to-seamless-user-experiences/) |
| One outcome-oriented `deploy_app` that resolves + broadcasts internally; `check_deployment_readiness` is an advisory pre-flight | **Idiomatic.** Design tools around the user's goal; don't force 1:1 REST→tool round-trips. | [philschmid](https://www.philschmid.de/mcp-best-practices), [The New Stack](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/) |
| Resolve-early / pin-by-UUID / commit-on-chain across the elicitation window | **Sound.** The mutation and its check are made atomic at the chain (the commit point); a stale immutable pin → clean rejection, not a wrong lease. | TOCTOU guidance ([Wikipedia](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use)) — atomicity at state mutation |
| Error on ambiguity (`SKU_AMBIGUOUS`) instead of silently picking a default (cheapest/first) | **Idiomatic & correct for a money path.** Fail-safe defaults / fail-closed: when a decision is uncertain, deny / take the safest observable action rather than continue under ambiguity. Validates rejecting the issue's alternative (B). | [OWASP secure-design principles](https://devguide.owasp.org/en/02-foundations/03-security-principles/) — fail-safe defaults |
| API evolution of the read-tool output shapes (`tiers` + `available_sku_names` removal) | **Resolved: clean break** (§9) — defensible pre-1.0 with known/internal/coordinated consumers; removal is sequenced so no release has a half-built monorepo. Additive fields (`skus[]`, `sku_candidates`, `available_skus`) are non-breaking. | [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html); [Speakeasy versioning](https://www.speakeasy.com/api-design/versioning); [SemVer 0.x](https://semver.org/) |
