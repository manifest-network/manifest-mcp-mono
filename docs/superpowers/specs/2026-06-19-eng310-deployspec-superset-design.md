# ENG-310 — agent-core DeploySpec superset (loss-free orchestration tier) — Design

**Issue:** ENG-310 (SDK P1, parent ENG-308). **Status:** design approved, pre-implementation.
**Branch:** `eng-310-deployspec-superset`.

> Reviewed against industry best practice via three online research sweeps (type-reuse idiom; design
> soundness; an adversarial spec review). All five decisions survive the strongest opposition; the
> should-fix findings from the adversarial pass are folded in below.

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
(a wrapper re-declaring the wrapped shape is the Law-of-Leaky-Abstractions leak). The "sharing types is
harmful" caution targets *external* or *cross-concept* reuse — it does **not** apply to one operation across
our own governed layers (the output `DeployResult` DTO-vs-domain split is correctly preserved — see §3).

*Precondition (documented at the use site):* verbatim reuse is correct **only while** agent-core adds no
DATA field. If a future change genuinely needs an orchestration-only data field, the idiomatic escape hatch
is wagmi-style **derivation** (`AppDeploySpec & { newField }`), **never** a forked parallel type.

### D2 — `size` required (drop the silent `'small'` default)
`AppDeploySpec.size` is already required; agent-core's old auto-default-to-`'small'`
(`deploy-app.ts` `requestedSize()`, ~:873-882) and its `size?` optionality are **removed**. A caller must
name a tier (or pin `skuUuid`) explicitly.

*Why idiomatic:* `size` selects a **billing tier** that draws down finite funded credit at a per-SKU price —
a cost-bearing, hard-to-undo selector. API-design authority (Google AIP, Terraform required-variable practice,
Principle of Least Astonishment) says such selectors must be **required**, not silently defaulted. The old
`'small'` was the *worst* case: a **surprising** default — a name-resolved (string-equality against on-chain
SKUs), provider-ambiguous string, *not* a guaranteed cheapest floor — whose consequence is ongoing credit drain.

*Implementation hazard (must address together):* deleting the type-level optionality **without** deleting the
`requestedSize()` `'small'` fallback would silently re-introduce the default behind a required type — the same
class of divergence we are removing. Both go in the same change.

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
identical, and `ServiceConfig.ports`/single-`port` already arrive in fred's shape, so the old port *conversion*
was an artifact of agent-core's divergent representation). The override may be inlined into `deployApp`;
`internals/build-fred-input.ts` and `build-fred-input.test.ts` are removed.

> The current mapper's own header documents two silent data-loss bugs it caused (`port[]` truncation to
> `port[0]`; preview-vs-deploy shape drift corrupting the on-chain meta-hash). Eliminating the mapping surface
> removes that whole bug class.

*Type-safety trade-off (noted, accepted):* a spread (`{ ...spec, ... }`) does **not** trigger TypeScript's
excess-property check (it only runs on fresh object literals), so a stray/future-removed field on `spec` would
be copied through without a compile error. The inverse risk (dropping a field) is exactly what ENG-310 fixes,
so the spread is the right call; the standing guards are the loss-free value test + the key-coverage assertion
+ the `*.test-d.ts` equivalence (see §6) — not `tsc`.

### D4 — Cancellation contract (abort/timeout on options + the callback contract)
Add cancellation to **`DeployAppOptions`** (and the sibling options types), forwarded into fred's existing
`DeployCallOptions.abortSignal` — never onto the data spec.

1. **Reuse the repo's existing convention, not a new one.** `core/src/options.ts` already defines
   `CallOptions { signal?, timeout? }` + `resolveCallSignal()`, which composes them via
   `AbortSignal.any`/`AbortSignal.timeout` **internally** (the ENG-309 read/tx ctx blocks consume this). The
   orchestration options adopt the **same** `{ signal?: AbortSignal; timeout?: number }` shape and call
   `resolveCallSignal()` — so the tier matches the building blocks it calls, and the composition stays
   centralized where the Node `AbortSignal.any` footguns (timeout-misfire #57736; source-signal leak #54614)
   are already handled. **Do not** ask callers to hand-roll `AbortSignal.any([…])`.
2. **Three timeout concepts, kept distinct (do NOT collapse).** (a) the caller's optional overall-operation
   deadline = the new `{ signal?, timeout? }` on options (off by default); (b) the post-broadcast **poll**
   budget = existing `waitForReadyTimeoutMs` (default ~8 min); (c) the per-prompt **interactive-confirm**
   timeout = the agent server's `MANIFEST_AGENT_ELICIT_TIMEOUT_MS`. Folding (b)+(c) into one wall-clock budget
   would bill human deliberation against provisioning (MCP idle-vs-wall-clock guidance). The caller's (a)
   composes with the resolved signal; it does not replace (b) or (c).
3. **Callback-abort mechanism = the orchestrator races each pending callback against the signal** (a
   `Promise.race` / abort-event listener), so a pending interactive prompt rejects promptly on abort.
   **Callback signatures are unchanged** (`onConfirm?: (block) => Promise<…>`, etc.) — this is the
   non-breaking choice: no signature ripple to callback implementers or the `packages/agent` elicitation
   adapter. A losing (dangling) elicitation promise resolves/times out later and is ignored; its rejection is
   swallowed, never leaked as an unhandled rejection.
4. **One cancellation outcome.** Both signal-abort and callback-decline (`onConfirm:'no'`/`onPlan:'cancel'`)
   map to the **existing** `ManifestMCPErrorCode.OPERATION_CANCELLED`. Caller-abort vs deadline is
   distinguishable via `signal.reason` (`AbortError` vs `TimeoutError`, as `resolveCallSignal` already yields).
   No second "cancelled" error type.
5. **Observable via `onProgress`.** Emit a terminal `ProgressEvent` `kind: 'cancelled'` immediately before the
   `OPERATION_CANCELLED` throw (advisory UX only — the rejection stays the source of truth). Treat each
   existing `onProgress` site as a cooperative `signal.throwIfAborted()` checkpoint.
6. **Partial-side-effect contract, stated out loud.** A **pre-broadcast** abort sends nothing (safe, no lease).
   A **post-broadcast** abort may leave a created lease / committed tx the signal cannot undo — it routes to
   the existing partial-success / `close_lease` recovery path and **never auto-retries** (verbatim from the
   `tx-confirmation.ts` "tx MAY STILL COMMIT → re-query" seam).

*Why the signal lives on options, not the spec:* the spec is JSON-round-tripped through the MCP boundary
(`agent/elicitation.ts` parses user JSON `as AppDeploySpec`) and through the `replace_spec` plan-edit path; a
non-serializable `AbortSignal` must never be a data-spec field. (It is the spec *shape* that round-trips —
`saveManifest` itself persists the rendered `manifest_json` string, not the spec object.)

### D5 — Accept the canonical flat shape; runtime-guard the invalid combos; defer the discriminant
`AppDeploySpec` is flat (`image?` xor `services?`, no literal discriminant), so it *permits* the invalid
both/neither combos at the type level. We accept this (it is fred's existing shape) and guard it at runtime
via a single `validateSpec(spec)`. Tightening the **canonical type** with a real literal discriminant is a
*wider, breaking* change to `core`, **deferred to a separate issue** — tracked (§7), not hidden.

*Requirements:*
- `validateSpec` is the **mandatory single structural gate on every independently-callable entry path** (the
  initial call **and** the post-edit `replace_spec` re-plan — verified at `deploy-app.ts:144` and `:396`). The
  type is shared verbatim, so no layer may assume an upstream layer validated — each action validates at its
  entry (defense-in-depth).
- **Hard invariant:** the D3 spread is unreachable except *downstream of* a `validateSpec` call in the same
  function. The validateSpec matrix (§6) asserts the before-the-spread ordering on both paths — because the
  spread can now *construct* an invalid `AppDeploySpec` internally, not only accept one at the boundary.
- `validateSpec` remains a **void validator, not a parser** (the input stays typed as the permissive
  `AppDeploySpec` after the check) — a direct consequence of deferring the literal discriminant. The
  parser/refined-type ("parse, don't validate") form is the natural follow-up once the canonical type gains
  its discriminant. agent-core also cannot adopt a Zod parser at its own layer (it has no Zod dependency and
  builds `platform:'neutral'`); structural parsing belongs at the MCP boundary (D6).

### D6 — Parse-and-validate at the untrusted MCP boundary
The `packages/agent` `deploy_app_orchestrated` tool currently registers the spec as `z.looseObject({})` and
casts `as DeploySpec`, deferring **all** structural validation downstream. That contradicts the repo's own
stated rule (`manifest-types.ts:294-296`: parse+validate belongs at the MCP boundary; the `as*` trust-cast is
for downstream transforms) and the MCP best practice that LLM-produced JSON is validated at the edge.

**Decision:** tighten the agent boundary Zod schema to enforce the **load-bearing invariants** — `size`
required, and `image` xor `services` (reject both/neither) — so malformed LLM JSON is rejected at the SDK edge
with a structured `-32602` error before the handler runs. Keep it scoped to those invariants (not a full Zod
mirror of `AppDeploySpec`, which would drift from the canonical type and duplicate the deferred-discriminant
work); agent-core's `validateSpec` remains the downstream defense-in-depth gate. The `size`-missing error
points the caller at `get_skus`/`list_skus`.

## 3. Type surface (after)

- **Deploy input:** `AppDeploySpec` (core), re-exported from fred and agent-core **by name**.
  `DeployAppInput = AppDeploySpec` (and `DeployManifestInput`) are **kept as permanent re-exporting aliases —
  NOT `@deprecated`, no removal plan.** They are the *original* public names (shipped before `AppDeploySpec`,
  which is the newer canonical home); there is nothing to migrate away from. (Matches the existing
  `manifest-types.ts:247` "permanent compatibility aliases" comment. Contrast: the codebase reserves
  `@deprecated` for genuine rename-aways, e.g. `SkuSelector → SkuIntent` — the *absence* of `@deprecated` on
  `DeployAppInput` is a deliberate "keep" signal.)
- **`DeployAppOptions`** gains `{ signal?: AbortSignal; timeout?: number }` (resolved via `resolveCallSignal`)
  and keeps `waitForReadyTimeoutMs?`. The same `signal?`/`timeout?` is added to
  `ManageDomainOptions`/`CloseLeaseOptions`/`TroubleshootOptions` for parity.
- **Callback contract** (`DeployAppCallbacks` and siblings): **signatures unchanged** (D4.3); documented
  cancellation semantics per D4; add the `'cancelled'` `ProgressEvent` kind.
- **`DeployResult`** is **unchanged** — it stays a deliberate camelCase *domain projection*, distinct from
  fred's snake_case `DeployResult` DTO (pinned by a mapping test). **Only the INPUT spec is unified**; do not
  collapse the output DTO-vs-domain boundary.

## 4. Migration / consumer impact

- **`deploy-app.ts` internals** switch from the union to `AppDeploySpec`: remove the unsafe
  `spec as SingleServiceSpec` / `spec as StackSpec` casts (`~:870/906/1067`); replace the `isStackSpec` guard
  with the canonical `'services' in spec`; delete `requestedSize()`'s `'small'` default; helpers
  (`primaryImage`/`customDomainOf`/`estimateFees`/`applyPlanEdit`/…) read canonical fields.
- **`internals/spec-normalize.ts`** (`isStackSpec`/`summarizeSpec`/`validateSpec`/`normalizeServices`) updates
  to the canonical shape; `validateSpec` becomes the both/neither gate (D5).
- **Removed exported types — hard removal, no deprecation cycle:** `DeploySpec`, `SingleServiceSpec`,
  `StackSpec`, `ServiceDef` are deleted outright (the frozen-surface `types.test.ts` copy is replaced by the
  §6 equivalence assertion). Justified pre-1.0 by the `0.x` "anything may change" allowance **and** the issue's
  premise that these narrow types had no external consumer (Barney bypassed them). Called out in the CHANGELOG
  `Removed`/`Upgrade notes` block so any headless importer sees the break.
- **`agent/elicitation.ts` + `packages/agent` tool boundary** (D6): the `deploy_app_orchestrated` Zod schema
  marks `size` required and enforces image-xor-services; user JSON parses `as AppDeploySpec`.
- **`packages/sdk` `/orchestration` subpath** is a downstream public consumer via
  `export type * from '@manifest-network/manifest-agent-core'` + a named `deployApp` re-export: the additive
  changes (`signal?`/`timeout?` on `DeployAppOptions`, the `'cancelled'` ProgressEvent kind) and the type
  deletions flow into it. Verified the SDK surface pin (`sdk/src/index.test.ts`) is value-only and does not pin
  the deleted type names, so deletion is non-breaking at the SDK boundary; the full-repo gate covers it.
- **`examples/sdk-acceptance/src/flow.ts` is unaffected.** Its `deployApp` is **fred's** low-level action
  (imported via `manifest-sdk/deploy`, a 6-arg function whose input is param `[3]`), **not** agent-core's
  3-arg orchestrator — and fred's `DeployAppInput` is *already* `AppDeploySpec` today. ENG-310 changes nothing
  about that binding. (The `Parameters<typeof deployApp>[…]` derivation stays drift-proof; it is not an
  equivalence *proof* — see §6.)
- **Breaking-change record (CHANGELOG obligation):** add a `CHANGELOG.md` `## [Unreleased]` →
  `### Upgrade notes` block prefixed `**BREAKING (agent-core / headless deployApp callers):**`, matching the
  established repo idiom (0.12.0/ENG-281, 0.13.0/ENG-287), spelling out with a before/after snippet: (a) `size`
  is now required (was defaulted to `'small'`) → remediation pointer to `get_skus`/`list_skus`; (b) the
  agent-core deploy input is now `AppDeploySpec` (the `SingleServiceSpec|StackSpec` union is removed). Source-
  breaking handled via the `0.x` lockstep minor bump (no major owed — SemVer §4); repo is at `0.14.0`.

## 5. Governance / boundary housekeeping

- **§8 chokepoint — deliverable satisfied by construction.** Verified: there is **no** agent-core-specific
  exemption in `.dependency-cruiser.cjs`; the `manifestjs-types-chokepoint` rule already forbids agent-core
  from importing manifestjs codegen types (agent-core routes through `core`). So ENG-310's "remove the §8
  exemption" needs **no depcruise rule change** — it is satisfied once the narrow `DeploySpec` is gone.
- Add a one-line comment at the `AppDeploySpec` reuse site stating the **no-data-delta precondition** and the
  derive-don't-fork escape hatch (D1).

## 6. Testing strategy

**Type-equivalence enforcement (the linchpin — must actually run):**
- Enable the type-test harness in agent-core: add `typecheck: { enabled: true, include: ['**/*.test-d.ts'] }`
  to `packages/agent-core/vitest.config.ts` (mirroring `core`) **or** `--typecheck` to its `test` script
  (mirroring `sdk`), and add the agent-core typecheck job to the full-repo gate. *(This also closes a pre-existing
  hole: agent-core's existing `types.test.ts` `toEqualTypeOf` assertions run under neither `vitest run` nor
  plain `tsc --noEmit` today — a `toEqualTypeOf` mismatch is a runtime no-op and not a `tsc` error.)*
- Add a **`tsc`-enforced** equivalence as belt-and-suspenders (a hard compile error under `npm run lint` even
  if the Vitest typecheck wiring regresses): `type _ = Expect<Equals<Parameters<typeof deployApp>[0], AppDeploySpec>>`.

**Loss-free proof (the headline) + drift guard:**
- A value test deploys via agent-core `deployApp` with a spec populated with **all 9 formerly-dropped rich
  fields** + a stack `services` map, and asserts the fred broadcast payload carries every one unchanged.
- **Exhaustiveness guard** so a future 10th field can't silently lag the fixture: a key-coverage assertion
  (`expect(Object.keys(fredPayload).sort()).toEqual(Object.keys(spec).sort())` after the D3 spread, modulo the
  stamped `size`/pin) **plus** a `.test-d.ts` `expectTypeOf<keyof AppDeploySpec>().toEqualTypeOf<keyof typeof fixture>()`
  so a new optional field forces a fixture update.
- **Resolved-identity threading:** assert the broadcast `size`/`skuUuid`/`providerUuid` are the **resolved**
  values, overwriting any raw pre-resolution hints in the spread (D3).

**`validateSpec` matrix (D5):** all four image×services combos (image-only ✓, services-only ✓, both ✗,
neither ✗) on **both** the initial and post-`replace_spec` paths, asserting it runs **before** the spread.

**Cancellation paths (D4) — mirror `core/src/internals/read-signal.test.ts` (fake timers + reason):**
pre-broadcast abort → `OPERATION_CANCELLED`, no lease; post-broadcast abort → `OPERATION_CANCELLED` + routes
to partial-success/`close_lease`, **no** auto-retry; abort during a pending `onConfirm` rejects promptly
**and** asserts **no unhandled rejection** from the losing race branch; a **composed**
`AbortSignal.any([caller, AbortSignal.timeout(ms)])` still rejects with `TimeoutError` and routes correctly
(regression pin for Node #57736); `TimeoutError` vs `AbortError` distinguishable; terminal `'cancelled'`
ProgressEvent emitted before the throw; callback-decline and signal-abort share the one error code.

**Boundary / MCP:** the `DeployResult` camelCase-domain vs snake_case-DTO mapping test stays green; the D6
agent-boundary Zod rejects `size`-missing and both/neither with `-32602`. Full-repo gate
(`build`/`lint`/`vitest`+typecheck/`check`/`depcruise`/size) green — **edits land on the `eng-310` branch.**

## 7. Out of scope / deferred (tracked, not hidden)

- A **real literal discriminant** on the canonical `AppDeploySpec` (single-vs-stack) — a wider breaking change
  to `core`; it is the natural follow-up that lets `validateSpec` become a refining parser (D5) and removes the
  remaining internal casts. File as a separate issue.
- `PortConfig` (ENG-282) wiring into `ServiceConfig.ports` — forward-declared, not part of ENG-310.
- ctx-ification of the remaining positional fred functions (a later phase).

## 8. Open questions

None blocking. The judgment calls the user blessed: the three distinct timeouts (D4.2), the single
`OPERATION_CANCELLED` outcome (D4.4), the non-breaking race mechanism for callback abort (D4.3), and the
post-broadcast-abort → `close_lease` recovery contract (D4.6).

## 9. Idiom sources (research-backed)

- **Verbatim reuse** as the zero-delta limit of wagmi derivation: wevm/wagmi `readContract`/`writeContract`/
  `getBalance` (intersect an added `chainId` data field onto viem params); single-source-of-truth for types
  (Total TypeScript; TS monorepo type-sharing). "Sharing is harmful" applies to *external*/*cross-concept*
  reuse only (DEV `pyjac`; CodeOpinion).
- **Delete the lossy mapper:** CodeOpinion "DTOs & Mapping: The Good, The Bad, And The Excessive".
- **`size` required:** Google AIP-149/203; Terraform required-variables practice; Principle of Least Astonishment.
- **Cancellation on options + cooperative cancellation:** core's own `options.ts`/`resolveCallSignal`; OpenJS
  "Using AbortSignal in Node.js"; MDN `throwIfAborted`/`AbortSignal.any`/`timeout`; NearForm/AppSignal. Node
  `AbortSignal.any` footguns (compose internally, not caller-side): nodejs/node #57736 (timeout misfire),
  #54614 (leak).
- **Orchestration/façade tier:** Wikipedia (Wrapper library; Hexagonal output-ports); AWS Prescriptive
  Guidance (Saga orchestration); event-driven.io ("keep orchestration optional").
- **MCP long-running cancellation** (idle-vs-wall-clock; cancelled call still resolves): MCP SEP-1539;
  anthropics/claude-code#58687; openai/codex#20925.
- **Validate at the (untrusted MCP) boundary; parse-don't-validate:** Fast.io / Stanza (validate LLM JSON with
  Zod at the edge); "Parse, Don't Validate" (cekrem / ITNEXT); defense-in-depth (Zuplo / InfoQ).
- **Versioning / breaking change:** SemVer §4 (`0.y.z`); Keep a Changelog 1.1.0 / Common Changelog; TS
  `@deprecated` (used in-repo only for genuine rename-aways).
- **Type-equivalence testing must run under `--typecheck`:** Vitest "Testing Types"; vitest-dev/vitest#7691;
  Charpentier "Testing TypeScript Types" (`tsc`-enforced `Equals`/`Expect`).
- **Flat-optional vs discriminant (deferred):** TS Handbook (Narrowing); Optique 1.0 case study;
  Convex/Stevekinney; "make illegal states unrepresentable" (Stemmler/Krycho).
