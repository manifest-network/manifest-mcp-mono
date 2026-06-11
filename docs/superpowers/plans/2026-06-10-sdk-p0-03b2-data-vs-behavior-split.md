# SDK P0 — Plan 3b-2: Data-vs-behavior split (the signature break) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Complete the canonical-types work: **strip the 4 runtime-orchestration fields** (`gasMultiplier`, `onLeaseCreated`, `abortSignal`, `pollOptions`) off `DeployAppInput`/`DeployManifestInput` → relocate the now **data-only** `AppDeploySpec`/`ManifestDeploySpec` to `core/src/manifest-types.ts`, and move the 4 fields onto a fred-layer **`DeployCallOptions`** bag. Update the `deployApp`/`deployManifest` signatures and **every call site** in lockstep. This is the riskiest plan of the spine — the widest blast radius (the signature change breaks ~46 call sites simultaneously).

**Architecture:** Spec §5.1's data-vs-behavior split, the DAG-forced reason `core` can own only pure value shapes: keeping `pollOptions?: Omit<PollOptions,…>` on a canonical type would invert the DAG (`core → fred/http`, since `PollOptions` carries an `AbortSignal` + callbacks). So the canonical specs are data-only; the 4 runtime fields live on a fred-layer call-options bag. **Sequencing:** [Task 1] define the new types **additively** (nothing uses them → green); [Task 2] the **atomic** signature flip — change the function signatures + every call site in ONE commit (the build is red between the signature change and the last call-site fix, so they're one red→green transition). **Minimal split (OI-5):** keep `deployApp`'s 3 leading positional DI args and insert `callOptions` at index 4 — so `spec` stays at positional index 3 and agent-core's `mock.calls[0][3]` reads need NO change.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4, tsdown, `tsc --noEmit` lint, Biome. Spec: §5.1 (data-vs-behavior split), §5.7. Issue: ENG-309. Builds on Plans 1/2/3a/3b-1.

**Context from 3b-1 (done):** `core/manifest-types.ts` owns the relocated DTOs incl. branded `DeployResult` + `SkuIntent`; the `as*` trust-cast family exists; `DeployManifestInput.sku` is already `SkuIntent`; `deployApp.ts`'s `skuSelectorFromInput` already produces a branded `SkuIntent`. This plan does NOT re-touch branding — only the runtime-field split + signatures.

**⚠️ THE FULL-LINT LESSON (bit 3× already):** a signature/type change ripples to CONSUMER packages (agent-core, the `agent` server, tests). vitest passes (no type-check) while `tsc` fails. **Every task here MUST run the FULL-repo `npm run lint`, not just the touched package's lint.** This plan touches the widest surface yet — run `npm run lint` (all 8) + `npm run build` after Task 2.

**Scope boundaries (NOT in 3b-2):** ctx-ification of the positional DI (`CapabilityCtx`/`createManifestClient`) — that's the later ctx plan; the deferred MCP-boundary uuid validation; the logger→`ctx.logger` refactor. 3b-2 is ONLY the data-vs-behavior field split + the signature/call-site update.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/manifest-types.ts` (modify) | Add data-only `AppDeploySpec` + `ManifestDeploySpec` (the 4 runtime fields stripped; `sku: SkuIntent`). |
| `packages/core/src/manifest-types.test-d.ts` (modify) | Assert `AppDeploySpec`/`ManifestDeploySpec` have NO `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions`. |
| `packages/core/src/index.ts` (modify) | Re-export `AppDeploySpec`, `ManifestDeploySpec`. |
| `packages/fred/src/tools/deployManifest.ts` (modify) | Define `DeployCallOptions`; new `deployManifest(spec, callOptions, opts)` signature; `ManifestDeployInput` → data-only (alias `ManifestDeploySpec`); rewrite the 5 internal `input.X` → `callOptions.X` reads. |
| `packages/fred/src/tools/deployApp.ts` (modify) | New `deployApp(..3 DI.., spec, callOptions, fetchFn?)` signature; `DeployAppInput` → data-only (alias `AppDeploySpec`); forward `callOptions` to `deployManifest`. |
| `packages/fred/src/server/register-tools.ts` (modify) | Split the `deploy_app` handler's single object into `spec` (data) + `callOptions` (the 4 runtime fields) — **preserve the `emit`/`extra.signal` callback bodies verbatim**. |
| `packages/agent-core/src/deploy-app.ts` (modify) | The `fredDeployApp(...)` call gains an empty `{}` `callOptions` 5th arg; `fetchFn` shifts to 6th. |
| `packages/agent-core/src/internals/build-fred-input.ts` (modify) | Its return type re-aliases to the data-only `AppDeploySpec` (body already builds data-only — no runtime fields). |
| `packages/fred/src/tools/{deployApp,deployManifest}.test.ts` (modify) | Re-shape all `deployApp(...)`/`deployManifest(...)` call sites: data → `spec`, the runtime fields → the new `callOptions` arg. |

---

## Task 0: Confirm baseline

- [ ] From the worktree root: `npm run build` (8, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green, ~2023). Plan 3b-1 merged. If red, STOP.

---

## Task 1: Define the data-only specs + the call-options bag (ADDITIVE — green on its own)

**Files:** Modify `packages/core/src/manifest-types.ts`, `manifest-types.test-d.ts`, `index.ts`, `packages/fred/src/tools/deployManifest.ts`.

- [ ] **Step 1: Add `AppDeploySpec` + `ManifestDeploySpec` to `core/src/manifest-types.ts`** (data-only — the deploy-input shapes MINUS the 4 runtime fields). `ServiceConfig` + `SkuIntent` already live in this file:

```ts
// Data-only deploy specs (spec §5.1). The 4 runtime-orchestration fields (gasMultiplier/
// onLeaseCreated/abortSignal/pollOptions) are NOT here — they live on fred's DeployCallOptions
// (PollOptions carries an AbortSignal + callbacks, so keeping it here would invert the core→fred DAG).
export interface AppDeploySpec {
  image?: string;
  port?: number;
  size: string;
  /** Disambiguate a duplicate SKU name to one provider (ENG-258). Caller-stringly; branded in skuSelectorFromInput. */
  providerUuid?: string;
  /** Pin a specific SKU by uuid (ENG-258). Wins over size/providerUuid. */
  skuUuid?: string;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  storage?: string;
  depends_on?: Record<string, { condition: string }>;
  services?: Record<string, ServiceConfig>;
  customDomain?: string;
  serviceName?: string;
}

export interface ManifestDeploySpec {
  manifest: string;
  sku: SkuIntent;
  storage?: string;
  customDomain?: string;
  serviceName?: string;
}
```

> Cross-check against the CURRENT `DeployAppInput` (`fred/src/tools/deployApp.ts`) and `DeployManifestInput` (`fred/src/tools/deployManifest.ts`): `AppDeploySpec` must be `DeployAppInput` with EXACTLY `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions` removed and nothing else changed; `ManifestDeploySpec` must be `DeployManifestInput` with those 4 removed. Read both files first and diff field-by-field to be sure no data field is dropped or added.

- [ ] **Step 2: Re-export** `AppDeploySpec`, `ManifestDeploySpec` from the manifest-types block in `core/src/index.ts`.

- [ ] **Step 3: Type-d test** — append to `manifest-types.test-d.ts`:

```ts
  it('AppDeploySpec / ManifestDeploySpec are data-only (no runtime fields)', () => {
    type App = import('./manifest-types.js').AppDeploySpec;
    type Man = import('./manifest-types.js').ManifestDeploySpec;
    expectTypeOf<App>().not.toHaveProperty('gasMultiplier');
    expectTypeOf<App>().not.toHaveProperty('onLeaseCreated');
    expectTypeOf<App>().not.toHaveProperty('abortSignal');
    expectTypeOf<App>().not.toHaveProperty('pollOptions');
    expectTypeOf<Man>().not.toHaveProperty('pollOptions');
    expectTypeOf<Man['sku']>().toEqualTypeOf<import('./manifest-types.js').SkuIntent>();
  });
```

- [ ] **Step 4: Define `DeployCallOptions` in `fred/src/tools/deployManifest.ts`** (additive — exported, used in Task 2). Place it near `DeployManifestInput`:

```ts
/** Per-call runtime orchestration for a deploy (fred layer). Split off the data specs per §5.1. */
export interface DeployCallOptions {
  gasMultiplier?: number;
  onLeaseCreated?: (leaseUuid: string, providerUrl: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}
```

> **Do NOT extend `TxCallOptions` and do NOT try to merge the `gasMultiplier` field** (review-confirmed against spec §5.1 line 141, which keeps these axes deliberately distinct). Three `gasMultiplier`-bearing types coexist **by design**: core's internal `TxOverrides` (what the deploy path actually threads — `cosmosTx(…, overrides)` at `cosmos.ts:176/183`), Plan 2's public `TxCallOptions`, and this `DeployCallOptions`. `DeployCallOptions` is an **orthogonal, fred-layer** bag — extending `TxCallOptions` would wrongly inherit `fee`/`memo`/`signal`/`timeout` (a dead second abort channel beside `abortSignal`, plus unwired fee/memo). Orthogonal is correct.

- [ ] **Step 5: Gate (green — all additive).** `(cd packages/core && npm run build)`; `npm run lint` (full, exit 0); `(cd packages/core && npx vitest --run --typecheck src/manifest-types.test-d.ts)` green. **Nothing consumes the new types yet** → no call-site impact.

- [ ] **Step 6: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts packages/fred/src/tools/deployManifest.ts
git add packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts packages/fred/src/tools/deployManifest.ts
git commit -m "feat(core,fred): add data-only AppDeploySpec/ManifestDeploySpec + DeployCallOptions (ENG-309)"
```

---

## Task 2: The atomic signature flip + ALL call sites (ONE commit — red between edits)

This is the load-bearing, widest-blast-radius change. The signature change breaks every call site at once; fix them all before the gate. **Do the edits in this order, then run the gate; do not commit until the full gate is green.**

**Files:** `deployManifest.ts`, `deployApp.ts`, `register-tools.ts`, `agent-core/deploy-app.ts`, `build-fred-input.ts`, `deployApp.test.ts`, `deployManifest.test.ts`.

- [ ] **Step 1: `deployManifest.ts` — strip runtime fields from the input type + new signature + internal reads.**
  1. Change `DeployManifestInput` to data-only: remove `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions`. Cleanest: replace the interface body with `export type DeployManifestInput = ManifestDeploySpec;` (import `ManifestDeploySpec` from core) — preserving the public name. (Confirm `DeployManifestInput` has no other field beyond the data + the 4 runtime; it should be exactly `ManifestDeploySpec` after stripping.)
  2. New signature: `export async function deployManifest(spec: ManifestDeploySpec, callOptions: DeployCallOptions, opts: DeployManifestOptions): Promise<DeployResult>`. (Rename the destructured local from `input` → `spec` OR keep `const input = spec;` for minimal body churn — prefer renaming the param to `spec` and threading.)
  3. **Rewrite the runtime-field reads** — every `input.gasMultiplier`/`input.onLeaseCreated`/`input.abortSignal`/`input.pollOptions` becomes `callOptions.X`; every data read (`input.manifest`/`input.sku`/`input.storage`/`input.customDomain`/`input.serviceName`) becomes `spec.X`. Grep `input\.` in the function to find them all. **Preserve the merge semantics EXACTLY:** the `overrides = callOptions.gasMultiplier !== undefined ? { gasMultiplier: callOptions.gasMultiplier } : undefined`; `await callOptions.onLeaseCreated?.(leaseUuid, providerUrl)`; `callOptions.abortSignal?.throwIfAborted()`; `uploadLeaseData(…, callOptions.abortSignal)`; the poll merge `{ ...callOptions.pollOptions, abortSignal: callOptions.abortSignal }`; `callOptions.abortSignal?.aborted` in the catch. The success assembly's `service_name: spec.serviceName` (data). Nothing else changes.

- [ ] **Step 2: `deployApp.ts` — strip runtime fields + new signature + forward callOptions.**
  1. `DeployAppInput` → data-only: `export type DeployAppInput = AppDeploySpec;` (import `AppDeploySpec` from core), preserving the public name. (`skuSelectorFromInput` already takes the input and reads `size`/`providerUuid`/`skuUuid` — all data, unchanged.)
  2. New signature: `export async function deployApp(clientManager, getAuthToken, getLeaseDataAuthToken, spec: AppDeploySpec, callOptions: DeployCallOptions, fetchFn?): Promise<DeployAppResult>` (rename the `input` param → `spec`; `callOptions` is the new 5th param; `fetchFn` is 6th).
  3. The internal `deployManifest({ …data… }, { …runtime… })` forwarding call (currently one object): split into `deployManifest({ manifest: manifestJson, sku: skuSelectorFromInput(spec), storage: spec.storage, customDomain: spec.customDomain, serviceName: spec.serviceName }, callOptions, { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn })` — the runtime fields are no longer built here; `callOptions` passes straight through.

- [ ] **Step 3: `register-tools.ts` — split the `deploy_app` handler call (HIGHEST RISK).** The current call (lines ~675-723) passes ONE object as the 4th arg mixing data + the 4 runtime fields, then `fetchFn` as 5th. Split it: the data fields stay in the 4th-arg object; the 4 runtime fields move to a NEW 5th-arg object; `fetchFn` becomes 6th. **The `emit`/`extra.signal`/callback BODIES must be byte-identical** — only their location moves. Result:

```ts
        const result = await deployApp(
          clientManager,
          (addr, uuid) => authTokens.providerToken(addr, uuid),
          (addr, uuid, metaHashHex) =>
            authTokens.leaseDataToken(addr, uuid, metaHashHex),
          {
            image: args.image,
            port: args.port,
            size: args.size,
            env: args.env,
            command: args.command,
            args: args.args,
            user: args.user,
            tmpfs: args.tmpfs,
            health_check: args.health_check,
            stop_grace_period: args.stop_grace_period,
            init: args.init,
            expose: args.expose,
            labels: args.labels,
            storage: args.storage,
            depends_on: args.depends_on,
            services: args.services,
            providerUuid: args.provider_uuid,
            skuUuid: args.sku_uuid,
            customDomain: args.custom_domain,
            serviceName: args.service_name,
          },
          {
            gasMultiplier: args.gas_multiplier,
            abortSignal: extra.signal,
            onLeaseCreated: emit
              ? (leaseUuid, providerUrl) => {
                  emit(
                    `Lease ${leaseUuid} created on chain at ${providerUrl}; uploading manifest`,
                  );
                }
              : undefined,
            pollOptions: emit
              ? {
                  onProgress: (status) => {
                    const state = leaseStateToJSON(status.state);
                    const provision = status.provision_status
                      ? `, provision=${status.provision_status}`
                      : '';
                    emit(`Polling lease: state=${state}${provision}`);
                  },
                }
              : undefined,
          },
          fetchFn,
        );
```

  (i.e. `gasMultiplier`/`abortSignal`/`onLeaseCreated`/`pollOptions` moved out of the data object into the new 5th-arg `callOptions` object; the `emit`/`leaseStateToJSON`/`status.provision_status` bodies unchanged; `fetchFn` is now the 6th arg.)

  > **MANDATORY closure-preservation gate (this hunk has ZERO unit coverage — vitest only checks the field was passed, never that `emit()` fires inside the moved closure; a dropped `emit(` body silently kills MCP progress + cancellation).** BEFORE editing: `grep -c "emit(" packages/fred/src/server/register-tools.ts` and record the count. AFTER editing: the count MUST be identical, AND the new 5th-arg `callOptions` object must contain BOTH an `onLeaseCreated:` block with an `emit(` call (the lease-created message) AND a `pollOptions:` → `onProgress:` block with an `emit(` call (the polling message). Diff the hunk by eye against the current handler to confirm only the field LOCATION moved, not any body.

- [ ] **Step 4: `agent-core/src/deploy-app.ts` — insert empty `callOptions`.** Find the `fredDeployApp(opts.clientManager, getAuthToken, getLeaseDataAuthToken, fredInput, opts.fetchFn)` call (~line 542-548). agent-core threads NO runtime fields here, so insert `{}` as the new 5th arg: `fredDeployApp(opts.clientManager, getAuthToken, getLeaseDataAuthToken, fredInput, {}, opts.fetchFn)`. (`fredInput` is the **`spec` parameter — the 4th positional argument, zero-indexed slot [3]**; `callOptions` inserts at slot [4]; `fetchFn` shifts to slot [5]. Because `spec` stays at slot [3], agent-core's `mock.calls[0][3]` reads at `deploy-app.test.ts:553/744/806` need NO change — that's the whole point of the minimal split, OI-5.)

- [ ] **Step 5: `build-fred-input.ts` — re-alias the return type.** It returns a `DeployAppInput`-shaped object built from data only (no runtime fields). Since `DeployAppInput` is now `= AppDeploySpec` (data-only), its return type still resolves; confirm the body builds only data fields (it should — it never set gasMultiplier/onLeaseCreated/abortSignal/pollOptions). If its return-type annotation references `DeployAppInput`/`FredDeployAppInput`, it now means the data-only type — fine; no body change. (Read it to confirm no runtime field is built; if one is, that's a finding — report it.)

- [ ] **Step 6: Update ALL test call-shapes.**
  - `deployApp.test.ts` (~32 `deployApp(` calls): each currently passes `deployApp(cm, authFn, leaseFn, { …data + runtime… }[, fetchFn])`. For each: move any of `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions` out of the 4th-arg object into a new 5th-arg object; the data stays 4th; `fetchFn` (where present) → 6th. **The ~26 calls with no runtime field → pass `{}` as the 5th arg.** The **runtime-field behavior tests that MUST relocate fields and keep identical assertions** are (verify exact lines at impl time — drift is possible): **gasMultiplier @~175-197; onLeaseCreated @~356/391/416/443; abortSignal + pollOptions @~467/502/520.**
  - `deployManifest.test.ts` (~14 `deployManifest(` calls): each `deployManifest({ …data… }, deps)` becomes `deployManifest({ …data… }, {}, deps)` (insert `{}` as the new middle `callOptions` arg). **Only ONE deployManifest test carries a runtime field — the abort test @~336-343** — which moves `abortSignal: AbortSignal.abort()` out of the data object into the new MIDDLE arg.

- [ ] **Step 7: FULL gate (do NOT commit until green).**
  1. `npm run build` (worktree root) → 8 packages, exit 0.
  2. **`npm run lint` (ALL 8 packages — the critical gate; a signature change ripples to agent-core + the `agent` server + tests)** → exit 0.
  3. `npx vitest run packages/` → all pass. The runtime-field behavior tests (gasMultiplier→cosmosTx overrides, onLeaseCreated fires once before upload, abortSignal threads to upload+poll, pollOptions merge) must stay green — proving the fields still work after relocation to `callOptions`.
  4. `npm run check` → biome exit 0.
  - If any package beyond fred fails lint, fix the call site there too (the `agent` server may call deployApp indirectly — check).

- [ ] **Step 8: Commit (one atomic commit).**

```bash
git add -A
git commit -m "refactor(core,fred,agent-core): data-vs-behavior split — DeployCallOptions + new deployApp/deployManifest signatures (ENG-309)"
```

---

## Task 3: Final verification

- [ ] Re-run the full gate clean (build 8 / lint 8 / vitest packages/ / typecheck / biome). Confirm:
  - `register-tools.ts` MCP-progress + cancellation still wired: re-run the closure-preservation grep gate from Task 2 Step 3 — `grep -c "emit(" packages/fred/src/server/register-tools.ts` matches the pre-refactor count, and both the `onLeaseCreated:` and the `pollOptions:`→`onProgress:` blocks in the new `callOptions` object each still contain an `emit(` call. (Integration-level, NOT unit-tested — the grep is the only mechanical signal.)
  - `DeployResult` JSON unchanged (the split is input-side; the output DTO + outputSchema are untouched).
  - agent-core deploy tests + the snake→camel mapping test (Plan 3a) still green.

---

## Self-Review (completed)

- **Spec coverage (§5.1 data-vs-behavior split):** the 4 runtime fields stripped off the canonical specs ✓; `AppDeploySpec`/`ManifestDeploySpec` data-only in core ✓; `DeployCallOptions` fred-layer bag ✓; the `core → fred/http` DAG inversion avoided (`PollOptions` stays in fred, referenced only by `DeployCallOptions`) ✓; minimal split keeps `spec` at positional index 3 (OI-5) ✓. **Deferred:** ctx-ification (later ctx plan); MCP-boundary validation + logger refactor (guards/ctx plans).
- **Atomicity honesty:** Task 1 is additive (green alone); Task 2 is one atomic red→green commit (the signature change breaks all call sites at once — unavoidable). The register-tools binding is the one integration-risk hunk (preserve verbatim).
- **The full-lint lesson:** Task 1 Step 5, Task 2 Step 7, Task 3 all require the FULL-repo `npm run lint` — because this signature change ripples to agent-core + the `agent` server + every test call-shape (the widest surface in the spine). vitest will pass while `tsc` fails; lint is the real gate.
- **Type/name consistency:** `DeployAppInput = AppDeploySpec`, `DeployManifestInput = ManifestDeploySpec` (public names preserved); `DeployCallOptions` carries exactly the 4 stripped fields; the register-tools split moves exactly those 4.

## Next plan

→ **The `CapabilityCtx` + `createManifestClient` + bound-method `ManifestClient` + signer-port plan** (§5.2/§5.3): the single configured client + ports; ctx-ify the positional DI on deployApp/deployManifest/the typed fns; refactor `client.ts`/`lcd-adapter.ts` off the global `logger` singleton onto `ctx.logger` (§5.3); type-split `TxSigner`/`AuthSigner` + the `WalletProvider`→`Signer` `parseAddress`-once adapter (`parse*`'s first real production consumer); thread `CallOptions`/`TxCallOptions` into the typed reads/txs. Then: typed reads/txs + `executeTx` + per-signer mutex; `subscribeLeaseStatus`; fred/lease thin callers; the `manifest-sdk` barrel + e2e acceptance; the boundary-guards plan (dependency-cruiser + LeaseState value-re-export + the deferred MCP-boundary uuid/FQDN validation).
