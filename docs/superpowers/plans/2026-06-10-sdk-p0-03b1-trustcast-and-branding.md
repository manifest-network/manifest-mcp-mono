# SDK P0 — Plan 3b-1: Trust-cast `as*` family + `DeployResult`/`SkuIntent` branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the **trust-cast `as*` brand-producer family** to `core/src/brands.ts` (spec §5.0 family #2), then use it to **brand `DeployResult`'s id-fields** and to **unify `SkuSelector` → branded `SkuIntent`** — all **additively, with NO function-signature change and NO call-site churn**. This is the **low-risk, conceptually-tricky-but-fully-test-guarded** half of Plan 3b. The mechanically-wide **data-vs-behavior split** (stripping the 4 runtime fields → `AppDeploySpec`/`ManifestDeploySpec` + a fred call-options bag + new `deployApp`/`deployManifest` signatures + ~46 call sites) is the separate **Plan 3b-2**.

**Architecture:** The spec's branding model has **two producer families** (§5.0, v8): `parse*` validates untrusted input (throws `INVALID_ARGUMENT`); **`as*` trust-casts an already-trusted value with NO validation and never throws** — for chain/codegen reads where the chain is the source of truth (re-validating both wastes work and, critically, **throws on the non-canonical-UUID sentinels the fred tests use**). Plan 3a deliberately relocated `DeployResult` with plain `string` ids precisely because branding via the throwing `parse*` would redden ~15 tests. This plan adds `as*` and applies it. The single load-bearing correctness constraint: **every branding here is a trust-cast (`as*`), never a `parse*`** — proven by the non-UUID-sentinel tests staying green.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4 (+`--typecheck`), tsdown, `tsc --noEmit` lint, Biome. Spec: §5.0 (two families), §5.1 (`DeployResult` branding, `SkuIntent`), §8 (lone `as Brand` cast in brands.ts). Issue: ENG-309. Builds on Plans 1/2/3a.

**v8 / 3a context (already decided):** brands are the scoped 5 (Address/Tenant, Lease/Provider/Sku UUID, Fqdn) in `core/src/brands.ts`; `parse*` are the throwing untrusted-boundary constructors. `DeployResult` (in `core/src/manifest-types.ts`) currently has **plain `string`** ids (3a). The `as*` family + this branding is what spec §5.0/§5.1 + the Plan 3a "deferred to 3b" notes point to.

**Scope boundaries (NOT in 3b-1 → Plan 3b-2):** the data-vs-behavior split — stripping `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions` off `DeployAppInput`/`DeployManifestInput`, the data-only `AppDeploySpec`/`ManifestDeploySpec`, the `DeployCallOptions` bag, the new `deployApp`/`deployManifest` signatures, and the ~46 call-site updates (register-tools, agent-core, the test call-shapes). **Deferred to the guards plan:** the dependency-cruiser chokepoint enforcement.

**Decisions locked (from the Plan 3b surface map + the OI-4 grep):**
- **Both `SkuIntent` arms use `as*`** (trust-cast), not `parse*`. The resolved arm trusts verbatim (non-UUID sentinels `'any-sku-uuid'`/`'prov-1'`); the byName arm's optional disambiguators are ALSO non-UUID in tests (`providerUuid:'p2'` at `deployManifest.test.ts:511`, `skuUuid:'b'` at `:591`) and are narrowing hints the chain (`resolveSku`) resolves authoritatively — format-validating them would be a stricter behavior change that breaks those tests. Trust-cast preserves the current "chain is authoritative" behavior.
- **`extractLeaseUuid` returns `LeaseUuid`** via `asLeaseUuid(raw)` AFTER its existing `requireUuid` validation (validate-once-then-trust-cast — do NOT add a second `parseLeaseUuid`).
- **`SkuSelector` keeps a deprecated alias** `export type SkuSelector = SkuIntent` (OI-3) so the fred public API stays byte-preserved.
- **Defer `asAddress`/`asFqdn`** (OI-2) — no chain-read in 3b-1 brands those; don't add dead exports.
- **Rewrite the `Brand<T,B>` invariant comment** (`brands.ts:14`, OI-1) — it currently says "every `as Brand` cast below is preceded by a throwing validator on all paths," which the `as*` family deliberately falsifies.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/brands.ts` (modify) | Add `asLeaseUuid`/`asProviderUuid`/`asSkuUuid` (trust-cast, no validation, never throws). Rewrite the `Brand` invariant comment for the two-family doctrine; add an `as*` doc block. |
| `packages/core/src/brands.test.ts` (modify) | `as*` round-trips the value unchanged + never throws on a non-UUID string. |
| `packages/core/src/brands.test-d.ts` (modify) | `asProviderUuid` returns `ProviderUuid` (distinct from `LeaseUuid`). |
| `packages/core/src/index.ts` (modify) | Re-export the three `as*` from the brands block. |
| `packages/core/src/manifest-types.ts` (modify) | `DeployResult.lease_uuid: LeaseUuid` / `provider_uuid: ProviderUuid` (was `string`); import `LeaseUuid`/`ProviderUuid`/`SkuUuid` from `./brands.js`; add `SkuIntent`. |
| `packages/core/src/manifest-types.test-d.ts` (modify) | Flip the `DeployResult` id assertions `string` → `LeaseUuid`/`ProviderUuid`; add a `SkuIntent` shape/brand assertion. |
| `packages/core/src/index.ts` (modify) | Re-export `SkuIntent` from the manifest-types block. |
| `packages/fred/src/tools/deployManifest.ts` (modify) | `extractLeaseUuid` → `LeaseUuid`; assembly `provider_uuid: asProviderUuid(providerUuid)`; `DeployManifestInput.sku: SkuIntent`; `export type SkuSelector = SkuIntent` alias. |
| `packages/fred/src/tools/deployApp.ts` (modify) | `skuSelectorFromInput` returns `SkuIntent` (both arms `as*`). |

---

## Task 0: Confirm baseline

- [ ] From the worktree root: `npm run build` (8 packages, exit 0) and `npm run lint` (exit 0) and `npx vitest run packages/` (all green — ~2021). Plan 3a is merged. If red, STOP.

---

## Task 1: The `as*` trust-cast family

**Files:** Modify `packages/core/src/brands.ts`, `packages/core/src/brands.test.ts`, `packages/core/src/brands.test-d.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing runtime test** — append to `packages/core/src/brands.test.ts` (add the three `as*` to the existing import from `./brands.js`):

```ts
describe('trust-cast as* family (no validation, never throws)', () => {
  it('round-trips the value unchanged', () => {
    expect(asLeaseUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(asProviderUuid('prov-1')).toBe('prov-1');
    expect(asSkuUuid('any-sku-uuid')).toBe('any-sku-uuid');
  });
  it('NEVER throws — even on a non-UUID string (it is a trust-cast for already-trusted chain values)', () => {
    expect(() => asLeaseUuid('not-a-uuid')).not.toThrow();
    expect(() => asProviderUuid('p2')).not.toThrow();
    expect(() => asSkuUuid('b')).not.toThrow();
    expect(asProviderUuid('')).toBe(''); // even empty — caller guarantees trust
  });
});
```

- [ ] **Step 2: Write the failing type test** — append to `packages/core/src/brands.test-d.ts` (add the `as*` + the relevant types to imports):

```ts
describe('as* return the correct branded type (type-level)', () => {
  it('asProviderUuid returns ProviderUuid, distinct from LeaseUuid', () => {
    expectTypeOf(asProviderUuid('x')).toEqualTypeOf<ProviderUuid>();
    expectTypeOf(asLeaseUuid('x')).toEqualTypeOf<LeaseUuid>();
    expectTypeOf(asProviderUuid('x')).not.toEqualTypeOf<LeaseUuid>();
  });
});
```

- [ ] **Step 3: Run → fail.** `(cd packages/core && npx vitest run src/brands.test.ts && npx vitest --run --typecheck src/brands.test-d.ts)` → FAIL (`as*` not exported). Confirm the failure is the missing export.

- [ ] **Step 4: Implement.** In `packages/core/src/brands.ts`: (a) **rewrite the `Brand<T,B>` invariant comment** (currently ~line 10-16, ending "INVARIANT: every `as Brand` cast below is preceded by a throwing validator on all paths.") to:

```ts
/**
 * Nominal brand. STRING tag key (not a `unique symbol`) ON PURPOSE: a unique-symbol brand is
 * non-assignable across DUPLICATED package copies (each copy mints a distinct symbol), breaking
 * the incremental cross-copy adoption this monorepo needs (the worktree/dep-drift hazard in
 * CLAUDE.md). Never exported. A brand is structurally `string`: assignable TO string, not FROM it.
 *
 * TWO sanctioned producer families, one per boundary trust-model (spec §5.0):
 *   - parse*  — VALIDATE + brand at the UNTRUSTED boundary (stringly/MCP input, provider HTTP,
 *               wallet-in). Throwing, type-narrowing. Each `as Brand` cast here is preceded by a
 *               throwing validator on all paths.
 *   - as*     — TRUST-CAST at the TRUSTED boundary (chain/codegen reads, already-resolved ids).
 *               Brands WITHOUT validation and NEVER throws — the chain is the source of truth, and
 *               re-validating would both waste work and throw on non-canonical ids (ENG-258 parse-once).
 * BOTH families confine the lone `as Brand` cast to this file (§8).
 */
```

(b) Add the three trust-cast constructors (near the `parse*` constructors, e.g. after `parseSkuUuid`):

```ts
// ===== as* — trust-cast family (no validation, never throws); see the two-family note above. =====
export function asLeaseUuid(value: string): LeaseUuid {
  return value as LeaseUuid;
}
export function asProviderUuid(value: string): ProviderUuid {
  return value as ProviderUuid;
}
export function asSkuUuid(value: string): SkuUuid {
  return value as SkuUuid;
}
```

- [ ] **Step 5: Re-export from the barrel.** In `packages/core/src/index.ts`, add `asLeaseUuid`, `asProviderUuid`, `asSkuUuid` to the existing `export { … } from './brands.js'` block (Biome will sort).

- [ ] **Step 6: Run → pass.** `(cd packages/core && npx vitest run src/brands.test.ts && npx vitest --run --typecheck src/brands.test-d.ts && npm run lint)` → all green.

- [ ] **Step 7: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/brands.ts packages/core/src/brands.test.ts packages/core/src/brands.test-d.ts packages/core/src/index.ts
git add packages/core/src/brands.ts packages/core/src/brands.test.ts packages/core/src/brands.test-d.ts packages/core/src/index.ts
git commit -m "feat(core): add the as* trust-cast brand family for chain reads (ENG-309)"
```

---

## Task 2: Brand `DeployResult` id-fields (via `as*`)

**Files:** Modify `packages/core/src/manifest-types.ts`, `packages/core/src/manifest-types.test-d.ts`, `packages/fred/src/tools/deployManifest.ts`.

- [ ] **Step 1: Flip the type + its test.** In `packages/core/src/manifest-types.ts`: add `LeaseUuid`/`ProviderUuid` to the brands import (it currently imports only `type LeaseState`; add `import type { LeaseUuid, ProviderUuid } from './brands.js';`), and change `DeployResult`:

```ts
  readonly lease_uuid: LeaseUuid;     // was: string (3a). Branded via as* trust-cast at the producer.
  readonly provider_uuid: ProviderUuid; // was: string
```

Update the `// ===== Deploy result wire DTO ... ids stay plain string in 3a ... =====` comment to note branding is now applied (3b-1) via the `as*` trust-cast at the deployManifest producer (still non-breaking: brands erase to `string` in JSON; the MCP `outputSchema` is unchanged). In `packages/core/src/manifest-types.test-d.ts`, flip the deferred-branding assertions:

```ts
  it('DeployResult id-fields are branded (3b-1)', () => {
    expectTypeOf<DeployResult['lease_uuid']>().toEqualTypeOf<import('./brands.js').LeaseUuid>();
    expectTypeOf<DeployResult['provider_uuid']>().toEqualTypeOf<import('./brands.js').ProviderUuid>();
    expectTypeOf<DeployResult['lease_uuid']>().toExtend<string>(); // still erases to string (non-breaking)
  });
```

(Replace the old `it('DeployResult ids are plain string in 3a ...')` block.)

- [ ] **Step 2: Run → fail** (the producer now type-errors). `(cd packages/core && npx vitest --run --typecheck src/manifest-types.test-d.ts)` → PASS (core only). Then `(cd packages/fred && npm run lint)` → FAIL: `deployManifest.ts`'s assembly returns `lease_uuid: string`/`provider_uuid: string` which no longer satisfy the branded `DeployResult`. (Run `(cd packages/core && npm run build)` first so fred sees the new `.d.ts`.) This red is expected — Step 3 fixes it.

- [ ] **Step 3: Apply the producer trust-casts in `deployManifest.ts`.**
  1. Add `asLeaseUuid`, `asProviderUuid` to the existing value import from core (the block with `cosmosTx`, `requireUuid`, etc.).
  2. **`extractLeaseUuid`** (the function at ~line 26): change its return type `string` → `LeaseUuid`, and its `return raw;` (after the existing `requireUuid(...)` validation) → `return asLeaseUuid(raw);`. **Do NOT** change the `requireUuid` call (it keeps validating + preserves its `TX_FAILED` code) — `asLeaseUuid` just brands the already-validated value (validate-once-then-trust-cast). Its callers (`leaseUuid`, the error-context `{ lease_uuid: leaseUuid }`, the `onLeaseCreated` callback) keep working — `LeaseUuid` erases to `string`.
  3. **The success assembly** (`return { … }`): `provider_uuid: providerUuid` → `provider_uuid: asProviderUuid(providerUuid)` (the `providerUuid` local is plain `string`). **`lease_uuid: leaseUuid` needs NO cast** — `leaseUuid` is already `LeaseUuid` (from `extractLeaseUuid`). Change ONLY the `provider_uuid` line.

- [ ] **Step 4: Run → green.** `(cd packages/core && npm run build)` then `(cd packages/fred && npm run lint)` → exit 0; `npx vitest run packages/fred` → all pass. **Critical:** the non-UUID-sentinel tests (`deployManifest.test.ts:161-201` `kind:'resolved'` with `'any-sku-uuid'`/`'prov-1'`) MUST stay green — proves `as*` (not `parse*`) was used (no validation throws).

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/fred/src/tools/deployManifest.ts
git add packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/fred/src/tools/deployManifest.ts
git commit -m "feat(core,fred): brand DeployResult id-fields via as* trust-cast (ENG-309)"
```

---

## Task 3: Unify `SkuSelector` → branded `SkuIntent`

**Files:** Modify `packages/core/src/manifest-types.ts`, `packages/core/src/manifest-types.test-d.ts`, `packages/core/src/index.ts`, `packages/fred/src/tools/deployManifest.ts`, `packages/fred/src/tools/deployApp.ts`.

- [ ] **Step 1: Define `SkuIntent` in core + test.** In `packages/core/src/manifest-types.ts` add `SkuUuid` to the brands import and define:

```ts
// Unified SKU selector (was fred's `SkuSelector`). byName = resolve/disambiguate by name;
// resolved = caller pre-resolved both ids. uuids are branded; `size` stays plain string (post-v7 scope-down).
// NOTE (trust-cast): the byName `providerUuid`/`skuUuid` are OPTIONAL NARROWING HINTS that `resolveSku`
// resolves authoritatively against chain SKUs by STRING EQUALITY (not UUID-format validation, ENG-258
// "chain is authoritative") — so they are branded via the `as*` TRUST-CAST, never `parse*`. A re-validating
// `parse*` would reject non-canonical-but-chain-valid ids and is NOT the boundary: §5.0's "stringly/MCP face
// → parse+validate" obligation lives at the MCP boundary (register-tools.ts), not at this downstream transform.
export type SkuIntent =
  | { kind: 'byName'; size: string; providerUuid?: ProviderUuid; skuUuid?: SkuUuid }
  | { kind: 'resolved'; skuUuid: SkuUuid; providerUuid: ProviderUuid };
```

Re-export `SkuIntent` from the manifest-types block in `packages/core/src/index.ts`. Add a type-level assertion to `manifest-types.test-d.ts`:

```ts
  it('SkuIntent uuids are branded; size is plain string', () => {
    type ByName = Extract<import('./manifest-types.js').SkuIntent, { kind: 'byName' }>;
    expectTypeOf<ByName['size']>().toEqualTypeOf<string>();
    expectTypeOf<ByName['providerUuid']>().toEqualTypeOf<import('./brands.js').ProviderUuid | undefined>();
  });
```

- [ ] **Step 2: Adopt `SkuIntent` in `deployManifest.ts`.** Replace the local `SkuSelector` definition (`export type SkuSelector = …`) with an import + a **deprecated alias** preserving the public name (OI-3):

```ts
import type { SkuIntent } from '@manifest-network/manifest-mcp-core';
/** @deprecated Use `SkuIntent`. Kept as a byte-compatible alias for the public fred API. */
export type SkuSelector = SkuIntent;
```

Change `DeployManifestInput.sku: SkuSelector` → `sku: SkuIntent`. The consumer `switch (input.sku.kind)` and the resolved-arm non-empty guard (the `skuUuid.trim() === '' || providerUuid.trim() === ''` check) stay **verbatim** — they read fields that exist on both, and branded values erase to string (the `${skuUuid}:1` lease-item strings still work). The `skuUuid`/`providerUuid` locals stay typed `string`.

- [ ] **Step 3: Adopt `SkuIntent` in `deployApp.ts` — `skuSelectorFromInput` (BOTH arms `as*`).** Change its return type to `SkuIntent` (import from core), and brand via the **trust-cast** family (NOT `parse*` — the byName disambiguators are non-UUID sentinels in tests, e.g. `providerUuid:'p2'`/`skuUuid:'b'`, and are chain-resolved narrowing hints, not validated ids):

```ts
import type { SkuIntent } from '@manifest-network/manifest-mcp-core';
import { asProviderUuid, asSkuUuid } from '@manifest-network/manifest-mcp-core'; // add to the existing core value import

function skuSelectorFromInput(input: DeployAppInput): SkuIntent {
  const skuUuid = input.skuUuid?.trim();
  const providerUuid = input.providerUuid?.trim();
  if (skuUuid && providerUuid) {
    return { kind: 'resolved', skuUuid: asSkuUuid(skuUuid), providerUuid: asProviderUuid(providerUuid) };
  }
  return {
    kind: 'byName',
    size: input.size,
    ...(providerUuid ? { providerUuid: asProviderUuid(providerUuid) } : {}),
    ...(skuUuid ? { skuUuid: asSkuUuid(skuUuid) } : {}),
  };
}
```

(`deployApp.ts:13` imports `type { DeployAppResult, SkuSelector } from './deployManifest.js'`. After this change `skuSelectorFromInput` returns `SkuIntent` (imported from core), so `SkuSelector` becomes unused and would trip `noUnusedLocals` — **drop ONLY `SkuSelector` from that destructuring; KEEP `DeployAppResult`** (still used as `deployApp`'s return type at line ~104/121). I.e. `import type { DeployAppResult } from './deployManifest.js';`.)

- [ ] **Step 3b: Update the `deployManifest.test.ts` SkuIntent fixtures.** Because `DeployManifestInput.sku` is now `SkuIntent` (branded), test fixtures that construct a `sku: { kind:'resolved'|'byName', skuUuid/providerUuid: '<string>' }` literal **directly** (passing it to `deployManifest(...)`) will FAIL `tsc --noEmit` — a plain string is not assignable to `SkuUuid`/`ProviderUuid`. (vitest passes because brands erase at runtime; `tsc` does not — so you MUST run `(cd packages/fred && npm run lint)`, not just vitest.) Wrap those values with the **`as*` trust-casts** (the same way production builds a trusted `SkuIntent`; preserves the non-UUID sentinels): add `import { asProviderUuid, asSkuUuid } from '@manifest-network/manifest-mcp-core'` to the test, then e.g. `skuUuid: asSkuUuid('sku-micro-uuid'), providerUuid: asProviderUuid('prov-1')` and `providerUuid: asProviderUuid('p2')`. The bare `{ kind:'byName', size:'docker-micro' }` literals (no explicit ids) need no change. Do NOT use `parse*` (would throw on the sentinels). (`deployApp.test.ts` needs NO change — it passes plain-string disambiguators to `DeployAppInput`, which stays stringly; `skuSelectorFromInput` brands them.)

- [ ] **Step 4: Run → green.** `(cd packages/core && npm run build)`; **`(cd packages/core && npm run lint)` exit 0 AND `(cd packages/fred && npm run lint)` exit 0** (fred lint is the gate that catches the branded-fixture errors above — do not skip it); `npx vitest run packages/core packages/fred` → all pass. **Critical canaries — these three non-UUID-sentinel tests MUST stay green; they are the mechanical proof `as*` (not `parse*`) was used (a format-validating `parse*` would throw `INVALID_ARGUMENT` and redden them):**
  - `deployManifest.test.ts:161` — `kind:'resolved'` with `'any-sku-uuid'` / `'prov-1'`
  - `deployManifest.test.ts:511` — `kind:'byName'` with `providerUuid:'p2'`
  - `deployManifest.test.ts:591` — `kind:'byName'` with `skuUuid:'b'`

  Run them by name: `npx vitest run packages/fred/src/tools/deployManifest.test.ts -t "resolved|provider|sku"` (or just confirm the full `deployManifest.test.ts` suite is green). If ANY throws `INVALID_ARGUMENT`, a `parse*` leaked into `skuSelectorFromInput` — revert that branding to `as*`.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployApp.ts
git add packages/core/src/manifest-types.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployApp.ts
git commit -m "feat(core,fred): unify SkuSelector into branded SkuIntent via as* (ENG-309)"
```

---

## Task 4: Full gate

- [ ] Run each, confirm the literal outcome:
  1. `npm run build` → 8 packages, exit 0.
  2. `npm run lint` → exit 0 (every package's `tsc --noEmit` — incl. agent-core; recall vitest does NOT type-check, so this is the real gate).
  3. `npx vitest run packages/` → all pass (unit; the `e2e/*` suite needs `docker-compose` + a key password and is out of scope).
  4. `(cd packages/core && npx vitest --run --typecheck src/brands.test-d.ts src/manifest-types.test-d.ts)` → all type tests pass (the new `as*` + the flipped `DeployResult`/`SkuIntent` assertions).
  5. `npm run check` → biome exit 0.
- [ ] All green ⇒ 3b-1 done. `DeployResult` ids + `SkuIntent` are branded via trust-cast, zero behavior change (every canary green). If `npm run check` reformatted, commit `style: biome formatting (ENG-309)`.

---

## Self-Review (completed)

- **Spec coverage (§5.0/§5.1):** `as*` trust-cast family added (the missing producer the v8 §5.0 two-family edit mandates) ✓; `Brand` invariant comment rewritten for the two families (OI-1) ✓; `DeployResult` id-fields branded via `as*` at the producer (extractLeaseUuid → LeaseUuid; assembly provider_uuid as-cast) ✓; `SkuSelector` unified into branded `SkuIntent` with a deprecated alias (OI-3) ✓; **both SkuIntent arms `as*`** (OI-4 — byName disambiguators are non-UUID in tests) ✓. **Deferred to 3b-2:** the data-vs-behavior split + signatures + call sites. **Deferred to guards plan:** dependency-cruiser.
- **Zero behavior change:** every brand is a trust-cast (`as*`, no validation, never throws); the non-UUID-sentinel canaries (`deployManifest.test.ts:161-201/511/591`) are the proof — they stay green. `asAddress`/`asFqdn` deferred (OI-2, no dead exports).
- **Type/name consistency:** `asLeaseUuid`/`asProviderUuid`/`asSkuUuid` names match across brands.ts, the barrel, deployManifest/deployApp; `SkuIntent` identical in core + the fred alias; `DeployResult` branded ids match the producer casts.
- **Order safety:** Task 1 (as*) is additive (nothing references it → green). Task 2 flips DeployResult + fixes the producer in the same commit (the only red-between-edits is within Task 2 Step 2→3). Task 3 defines SkuIntent then adopts it. Each commit gates green.
- **Pre-existing MCP-boundary validation gap (review-flagged, NOT introduced by 3b-1):** the actual stringly/MCP boundary `register-tools.ts:519-535` accepts `provider_uuid`/`sku_uuid` as bare `z.string().optional()` with **no UUID-format validation**. That is the surface §5.0's "stringly/MCP face → parse + validate" obligation governs — and it predates this work. 3b-1 correctly does NOT change it (trust-casting the downstream `skuSelectorFromInput` hints preserves the existing chain-authoritative contract). **Discharging that boundary validation (a `parseProviderUuid`/`parseSkuUuid` at the MCP arg-parse, if desired) is deferred to a later boundary-validation pass** — recorded here so it is not silently lost. (Note: tightening it there would be a deliberate behavior change requiring the affected fred tests to switch to real UUIDs.)

## Next plan

→ **Plan 3b-2 (data-vs-behavior split — the signature break):** strip `gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions` off `DeployAppInput`/`DeployManifestInput` → relocate the now-data-only `AppDeploySpec`/`ManifestDeploySpec` to core; add `DeployCallOptions` (fred layer); new `deployManifest(spec, callOptions, opts)` + `deployApp(..3 DI.., spec, callOptions, fetchFn?)` signatures (**minimal split — `spec` stays positional index 3 so agent-core's `mock.calls[0][3]` reads at `deploy-app.test.ts:553/744/806` need no change**, OI-5); update the ~46 call sites in lockstep: **register-tools.ts:675-723 (HIGHEST RISK — preserve the `emit`/`extra.signal` bindings for MCP progress + cancellation verbatim)**, `deployApp.ts:181-194`, the 5 internal `input.X`→`callOptions.X` reads in deployManifest, agent-core `deploy-app.ts:542-548` (insert empty `{}` callOptions as the new 5th arg) + `build-fred-input.ts` re-alias, and all 32+14 test call-shapes. D and E are one atomic red→green commit.

→ **Later — boundary guards plan:** author the `dependency-cruiser` config (only `manifest-types.ts` imports manifestjs type paths; `as Brand`/`as*`/`parse*` only in `brands.ts`; `lcd-adapter` brands via `as*` only) + reconcile the LeaseState value re-export + `publint`/`attw`.
