# ENG-310 — agent-core DeploySpec superset (loss-free orchestration tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-core's deploy input the canonical `AppDeploySpec` (loss-free), delete the subtractive `build-fred-input.ts`, and add an idiomatic cancellation contract — so the orchestration tier loses no fields and can never re-diverge.

**Architecture:** Strict verbatim reuse — `deployApp(spec: AppDeploySpec, …)`; the broadcast payload is a loss-free spread that stamps the already-resolved SKU identity. Cancellation rides on the options type via the repo's existing `{signal?,timeout?}` + `resolveCallSignal`, forwarded into fred's `DeployCallOptions.abortSignal`; **pre-broadcast** interactive callbacks are raced (not re-signatured). Validation is defense-in-depth: a Zod gate at the untrusted MCP edge + agent-core's `validateSpec` per entry path.

**Tech Stack:** TypeScript (ESM, `platform:neutral`), Vitest (+ `--typecheck` / `*.test-d.ts`), Zod 4 (agent package only), Biome, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-06-19-eng310-deployspec-superset-design.md` (decisions D1–D6). Read it first.

**Read before starting (current code):** `packages/agent-core/src/types.ts` (the `DeploySpec` union @172-222, `DeployAppOptions` @92-140, `ProgressEvent` @295-…, `PlanEdit` @263-265), `packages/agent-core/src/deploy-app.ts` (`deployApp` @137, `validateSpec` wrappers @144-150 + @395-404, the `buildFredDeployInput` broadcast site @546-559, the `buildManifestPreviewInput` preview sites @316 + @461, `requestedSize` @873-883, the `spec as …` casts @870/906/1067, the stale `estimateFees` storage comment @939-941), `packages/agent-core/src/internals/spec-normalize.ts` (`validateSpec` throws **TypeError** today; header comment @23-27), `packages/agent-core/src/internals/build-fred-input.ts` (+ `.test.ts` — note the preview-omits-fields pin @180/251-263 and the meta-hash regression @310-343), `packages/agent-core/src/internals/render-intent-recap.ts` (@82/91/92 cast `SingleServiceSpec`/`ServiceDef`), `packages/core/src/manifest-types.ts` (`AppDeploySpec` @250-279; `storage?` @274), `packages/core/src/internals/buildManifestPreview.ts` (`BuildManifestPreviewInput` omits size/customDomain/serviceName/pin — only manifest `STRUCTURED_FIELDS`), `packages/core/src/options.ts` (`resolveCallSignal`), `packages/agent/src/index.ts` (`deploy_app_orchestrated` Zod @300-369; the `as DeploySpec` cast @414), `packages/agent/src/elicitation.ts` (@33/336/349), `packages/agent/src/server.test.ts` (the `size`-not-required pin @409-411; size-less deploy fixtures).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/agent-core/vitest.config.ts` + `package.json` | test config / scripts | **Modify** — enable `typecheck`; `test` runs `--typecheck` |
| `packages/agent-core/src/types.ts` | agent-core public types | **Modify** — delete `ServiceDef`/`SingleServiceSpec`/`StackSpec`/`DeploySpec`; re-export `AppDeploySpec`; `PlanEdit.replace_spec.spec`; `signal?`/`timeout?` on the 4 options types; `ProgressEvent` `'cancelled'` kind |
| `packages/agent-core/src/internals/spec-normalize.ts` (+ `.test.ts`) | shape helpers + `validateSpec` | **Modify** — canonical `'services' in spec`; both/neither gate (keeps throwing **TypeError**); fix stale header comment |
| `packages/agent-core/src/internals/render-intent-recap.ts` (+ `.test.ts`) | plan-recap renderer | **Modify** — swap deleted types → `AppDeploySpec`; ports are now a map |
| `packages/agent-core/src/deploy-app.ts` | the orchestrator | **Modify** — `AppDeploySpec` signature; remove casts + `requestedSize` default; broadcast + preview spreads; cancellation race (pre-broadcast) + forwarding + `OPERATION_CANCELLED`; fix stale storage comment |
| `packages/agent-core/src/internals/build-fred-input.ts` (+ `.test.ts`) | the lossy mapper | **Delete** |
| `packages/agent-core/src/types.test.ts` | frozen-surface pin | **Modify** — drop deleted-type pins; pin `deployApp` input ≡ `AppDeploySpec`; add `'cancelled'`; update the 4 options-shape pins for `signal?`/`timeout?` |
| `packages/agent-core/src/deploy-app.test.ts` (+ a new `*.test-d.ts`) | behavior + type tests | **Modify/Create** — loss-free (single + stack), preview-vs-deploy meta-hash parity, cancellation tests; the `tsc`-enforced equivalence |
| `packages/agent/src/index.ts` | MCP boundary + handler | **Modify** — Zod: `size` required + image-xor-services; describe text; `as DeploySpec` cast @414 → `AppDeploySpec` |
| `packages/agent/src/elicitation.ts` | elicitation adapter | **Modify** — `DeploySpec` refs @33/336/349 → `AppDeploySpec` |
| `packages/agent/src/server.test.ts` | agent behavior pins | **Modify** — invert the `size`-not-required pin; add `size` to size-less deploy fixtures; boundary-reject tests |
| `CHANGELOG.md` | release notes | **Modify** — `## [Unreleased]` → `### Upgrade notes` → `**BREAKING (…)**` |

---

## Task 1: Enable the agent-core type-test harness

**Why first:** the loss-free invariant's proof is a type-equivalence assertion, and a `toEqualTypeOf` mismatch runs under **neither** `vitest run` nor plain `tsc --noEmit` today. This also resurrects `types.test.ts`'s currently-inert assertions.

**Files:** Modify `packages/agent-core/vitest.config.ts` + `packages/agent-core/package.json`.

- [ ] **Step 1: Enable typecheck** — mirror `packages/core/vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    typecheck: { enabled: true, include: ['**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
```

- [ ] **Step 2: Point the `test` script at typecheck** — change `"test": "vitest run"` → `"test": "vitest run --typecheck"` (mirrors `packages/sdk`). Leave `test:watch`/`lint`.

- [ ] **Step 3: Run** — `npm run test -w @manifest-network/manifest-agent-core`. Expected: PASS. If a now-enforced `types.test.ts` assertion surfaces stale, fix the **assertion** to match current types (do not weaken code). Re-run green.

- [ ] **Step 4: Commit** — `git add packages/agent-core/vitest.config.ts packages/agent-core/package.json && git commit -m "test(agent-core): enable vitest typecheck so type assertions run (ENG-310)"`.

---

## Task 2: Core type unification — `deployApp` input = `AppDeploySpec` (D1 + D2 + D3 + D5)

One atomic refactor (TypeScript won't compile between the old/new type). Drive it with the loss-free tests: RED first, then the swap makes them GREEN.

**Files:** see the table rows for Task 2 (incl. `render-intent-recap.ts`/`.test.ts`, `spec-normalize.test.ts`). Delete `build-fred-input.ts` + `.test.ts`. Modify `CHANGELOG.md`.

> **Test-helper note:** the snippets below use illustrative names. Implement them atop `deploy-app.test.ts`'s **real** pattern — capture the fred input with `vi.mocked(fred.deployApp).mock.calls[0]?.[3]` (the spec is fred deployApp's 4th positional arg) and the module-level `vi.mock` setup already in that file (see the existing loss/preview tests ~@555/746/808). Reuse the file's existing `clientManager`/`walletProvider`/resolved-SKU fixtures.

- [ ] **Step 1: Write the failing loss-free tests (RED) — single AND stack.** Spec §6 requires both arms (the deleted `convertServiceDef` dropped per-service rich fields, so the **stack** arm is the one that most needs proving). The `as never` bridges the *current* union signature; removed in Step 9.

```ts
import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';

const SINGLE: AppDeploySpec = {
  image: 'nginx:latest', size: 'small', port: 8080, env: { A: '1' },
  command: ['/bin/sh'], args: ['-c', 'true'], user: '1000:1000', tmpfs: ['/tmp'],
  health_check: { test: ['CMD', 'true'], interval: '10s', retries: 3 },
  stop_grace_period: '30s', init: true, expose: ['9090'], labels: { tier: 'web' },
  storage: '10Gi', depends_on: { db: { condition: 'service_started' } }, customDomain: 'app.example.com',
};
const STACK: AppDeploySpec = {
  size: 'small', serviceName: 'web', customDomain: 'app.example.com',
  services: {
    web: {
      image: 'nginx:latest', ports: { '80/tcp': {} }, env: { A: '1' }, command: ['/bin/sh'], args: ['-c', 'true'],
      user: '1000:1000', tmpfs: ['/tmp'], health_check: { test: ['CMD', 'true'] }, stop_grace_period: '30s',
      depends_on: { db: { condition: 'service_started' } }, expose: ['9090'], labels: { tier: 'web' },
    },
  },
};

for (const [name, spec] of [['single', SINGLE], ['stack', STACK]] as const) {
  it(`loss-free (${name}): every AppDeploySpec field survives to the fred broadcast (ENG-310)`, async () => {
    const captured = await runDeployAndCaptureFredInput(spec as never); // illustrative; see helper note
    for (const k of Object.keys(spec) as (keyof AppDeploySpec)[]) {
      if (k === 'size') continue; // size is overwritten with the resolved SKU name (asserted below)
      expect(captured[k]).toEqual(spec[k]);
    }
    // Top-level key parity (sound because the D3 broadcast spread is SHALLOW — it never rebuilds nested objects).
    expect(Object.keys(captured).sort()).toEqual([...new Set([...Object.keys(spec), 'skuUuid', 'providerUuid'])].sort());
    // Resolved-identity: size/skuUuid/providerUuid are the RESOLVED pin, not raw input.
    expect(captured.size).toBe(resolvedSkuFixture.name);
    expect(captured.skuUuid).toBe(resolvedSkuFixture.skuUuid);
    expect(captured.providerUuid).toBe(resolvedSkuFixture.providerUuid);
  });
}
```

- [ ] **Step 2: Run — verify RED.** `npx vitest run packages/agent-core/src/deploy-app.test.ts -t "loss-free"`. Expected: FAIL — `captured.user`/`tmpfs`/`health_check`/… are `undefined` (the current mapper's single arm + `convertServiceDef` copy only `image`/`ports`/`env`/`args`/`command`).

- [ ] **Step 3: Delete the narrow types; re-export the canonical one.** In `types.ts` delete `ServiceDef`/`SingleServiceSpec`/`StackSpec`/`DeploySpec` (@172-222) and add, with the precondition comment:

```ts
// agent-core's deploy input IS the canonical core type — verbatim reuse (ENG-310 / D1).
// Precondition: agent-core adds NO data field to the deploy spec (its only additions are runtime
// concerns on DeployAppOptions). If a future change needs an orchestration-only DATA field, DERIVE it
// (`AppDeploySpec & { newField }`) — never fork a parallel type (the divergence ENG-310 removes).
export type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
```

Update `PlanEdit` (@263-265): `replace_spec`'s `spec: DeploySpec` → `spec: AppDeploySpec`. Add `'cancelled'` to the `ProgressEvent` union: `| { kind: 'cancelled' }` (Task 3 emits it).

- [ ] **Step 4: Update `spec-normalize.ts` to the canonical shape (keep TypeError).** `isStackSpec(spec)` → `'services' in spec && spec.services !== undefined`. Extend `validateSpec(spec)` to **also** reject **both** (`image` AND `services` present) and **neither** — keep it throwing **`TypeError`** as it does today (the two `deploy-app.ts` wrappers @144-150 / @395-404 already convert `TypeError → ManifestMCPError(INVALID_CONFIG)`; do not change the throw type — that keeps `spec-normalize.test.ts:197`'s `validateSpec(null) → TypeError` pin valid and avoids a double-wrap). `summarizeSpec`/`normalizeServices` read the canonical `services: Record<string, ServiceConfig>` (map-shaped `ports`). **Fix the stale header comment @23-27** (it claims `ManifestMCPError` "isn't available here" — `deploy-app.ts` already imports it from core; reword to "validateSpec stays a void TypeError-thrower; the entry wrappers map to ManifestMCPError").

- [ ] **Step 5: Update `deploy-app.ts` + `render-intent-recap.ts` to the canonical shape (D1 + D2).** In `deploy-app.ts`: remove the `spec as SingleServiceSpec`/`spec as StackSpec` casts (@870/906/1067) — helpers read `AppDeploySpec` directly (`spec.image`, `'services' in spec`); **delete `requestedSize()`'s `'small'` fallback (@873-883)** so it returns `spec.size`; update the `deployApp` signature (@137) to `(spec: AppDeploySpec, …)`. **Fix the stale `estimateFees` storage comment (@939-941)** — it claims "agent-core DeploySpec has no `storage` field"; it now does (`storage?`). State explicitly: **storage-SKU fee estimation is out of scope for ENG-310 (tracked separately)** — `estimateFees` still bills only the compute SKU item; the loss-free spread *does* forward `storage` to fred, but the agent-core fee estimate does not add a storage item (a pre-existing gap, now visible). In `render-intent-recap.ts` (@82/91/92): swap `SingleServiceSpec`/`ServiceDef`/`DeploySpec` casts → `AppDeploySpec`; the stack `extractPorts` now receives a port-**map** (`{'80/tcp':{}}`) not `number[]` — it already `Object.entries`-iterates, so the recap renders `'80/tcp'` instead of `'80'`; update `render-intent-recap.test.ts` expectations to the map-key string (cosmetic, acceptable).

- [ ] **Step 6: Replace the mapper with loss-free spreads (D3).** Broadcast site (@546-559):

```ts
const fredInput: AppDeploySpec = {
  ...confirmedSpec,                  // loss-free — all rich fields survive (shallow spread)
  size: pinned.name,                 // resolved SKU name (thread resolved identity)
  skuUuid: pinned.skuUuid,           // authoritative resolved pin (overwrites raw hints)
  providerUuid: pinned.providerUuid,
};
```

Preview sites (@316, @461): build `BuildManifestPreviewInput` from the spec. **`buildManifestPreview` reads only the manifest `STRUCTURED_FIELDS` and intentionally ignores `size`/`customDomain`/`serviceName`/`skuUuid`/`providerUuid`** — so passing the spec (via a variable, not a fresh literal, to avoid excess-property errors) is meta-hash-safe; the extra fields are ignored at render time, and because both preview and the fred deploy build the manifest from the **same** `STRUCTURED_FIELDS`, `preview.meta_hash` ≡ the deployed meta-hash by construction. Then **delete** `internals/build-fred-input.ts` + `internals/build-fred-input.test.ts` and remove their imports.

- [ ] **Step 7: Add the preview-vs-deploy meta-hash parity test** (replaces the deleted `build-fred-input.test.ts:310-343` regression). In `deploy-app.test.ts`, for both `SINGLE` and `STACK`, assert the `meta_hash_hex` the preview computes equals the meta-hash the deploy path commits (capture both via the existing mocks). This keeps the anti-drift guarantee the deleted mapper enforced.

- [ ] **Step 8: Update the frozen-surface type test + add the `tsc`-enforced equivalence.** In `types.test.ts`: delete the `SingleServiceSpec`/`StackSpec`/`ServiceDef`/`DeploySpec` shape pins (@485-526); add `'cancelled'` to the `ProgressEvent['kind']` exhaustiveness assertion. Create `packages/agent-core/src/deploy-app.test-d.ts`:

```ts
import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
import { describe, expectTypeOf, it } from 'vitest';
import { deployApp } from './deploy-app.js';

// Belt-and-suspenders: hard `tsc --noEmit` error too (not only vitest --typecheck).
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _DeployInputIsCanonical = Expect<Equals<Parameters<typeof deployApp>[0], AppDeploySpec>>;

describe('deployApp input type (ENG-310)', () => {
  it('is exactly AppDeploySpec', () => {
    expectTypeOf<Parameters<typeof deployApp>[0]>().toEqualTypeOf<AppDeploySpec>();
  });
});
```

- [ ] **Step 9: Make GREEN.** Remove the `as never` bridges from Step 1 (`deployApp` now accepts `AppDeploySpec`). Run `npm run test -w @manifest-network/manifest-agent-core`. Expected: PASS — loss-free (single+stack), the meta-hash parity test, the `*.test-d.ts` equivalence, and the existing suite. Fix any remaining consumer (`spec-normalize.test.ts`, `render-intent-recap.test.ts`) that referenced the deleted types.

- [ ] **Step 10: validateSpec both/neither matrix.** In `deploy-app.test.ts`, assert all four combos on **both** entry paths (initial call + a `replace_spec` `onPlan` edit): image-only ✓, services-only ✓, both → `INVALID_CONFIG`, neither → `INVALID_CONFIG`. Run that file green.

- [ ] **Step 11: CHANGELOG** (matching the 0.12.0/0.13.0 idiom):

```markdown
## [Unreleased]

### Upgrade notes

**BREAKING (agent-core / headless `deployApp` callers):**
- `deployApp`'s input is now the canonical `AppDeploySpec` (from `@manifest-network/manifest-mcp-core`); the `SingleServiceSpec | StackSpec` union (and `ServiceDef`) is removed. Migrate by importing `AppDeploySpec`; `services` is `Record<string, ServiceConfig>` with map-shaped `ports`.
- `size` is now **required** (it was silently defaulted to `'small'`). Pass an explicit tier (or pin `skuUuid`); discover tiers via the lease server's `get_skus`.
```

- [ ] **Step 12: Lint + depcruise, then commit.** `npm run lint && npm run depcruise` (exit 0; the §8 chokepoint stays green — agent-core still routes manifestjs types through core; no exemption existed, so none to remove).

```bash
git add packages/agent-core CHANGELOG.md
git rm packages/agent-core/src/internals/build-fred-input.ts packages/agent-core/src/internals/build-fred-input.test.ts
git commit -F - <<'MSG'
feat(agent-core): deployApp input = canonical AppDeploySpec; delete the lossy build-fred-input (ENG-310)

Loss-free (single + stack): all formerly-dropped rich fields survive to the broadcast
via a resolved-identity shallow spread; size required (no surprise 'small'); validateSpec
gates image-xor-services at each entry path; preview/deploy meta-hash parity pinned.
MSG
```

---

## Task 3: Cancellation contract (D4)

**Files:** Modify `packages/agent-core/src/types.ts` (+ `types.test.ts`), `packages/agent-core/src/deploy-app.ts`, `packages/agent-core/src/deploy-app.test.ts`.

- [ ] **Step 1: Write the failing cancellation tests (RED).** Mirror `packages/core/src/internals/read-signal.test.ts` (fake timers + reason). Note the **no-leak** test must use a *late-rejecting* (not never-settling) callback, else it is vacuous:

```ts
import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';

it('pre-broadcast abort → OPERATION_CANCELLED, no lease created', async () => {
  const ac = new AbortController(); ac.abort();
  const err = await runDeploy({ signal: ac.signal }).catch((e) => e);
  expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
  expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
});

it('abort during a pending onConfirm rejects promptly; the late callback rejection is swallowed (no unhandled rejection)', async () => {
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  onTestFinished(() => process.off('unhandledRejection', onRej));
  const ac = new AbortController();
  const onConfirm = () => new Promise<'yes' | 'no'>((_, reject) =>
    setTimeout(() => reject(new Error('host timeout')), 0)); // rejects AFTER the abort wins
  const p = runDeploy({ signal: ac.signal, onConfirm });
  ac.abort();
  const err = await p.catch((e) => e);
  expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
  await new Promise((r) => setImmediate(r)); // flush a full turn so a leaked rejection would surface
  await expect.poll(() => rejections.length).toBe(0);
});

it('composed signal: caller timeout aborts with TimeoutError → OPERATION_CANCELLED', async () => {
  vi.useFakeTimers();
  try {
    const onConfirm = () => new Promise<'yes' | 'no'>(() => {});
    const p = runDeploy({ timeout: 1000, onConfirm });
    const assertion = expect(p).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally { vi.useRealTimers(); }
});
```

> Note: vitest's own `unhandledRejection` listener fails the whole run on a leaked rejection — so this test passes **only** if `raceAbort`'s `.catch(() => {})` genuinely swallows the loser.

- [ ] **Step 2: Run — verify RED.** `npx vitest run packages/agent-core/src/deploy-app.test.ts -t "abort|cancel|timeout"`. Expected: FAIL — `DeployAppOptions` has no `signal`/`timeout`; cancellation is unwired (agent-core passes `{}` to fred today @557).

- [ ] **Step 3: Add `signal?`/`timeout?` to the options + update the type pins.** In `types.ts` add `signal?: AbortSignal;` and `timeout?: number;` to `DeployAppOptions` **and** `ManageDomainOptions`/`CloseLeaseOptions`/`TroubleshootOptions` (same names/semantics as core's `CallOptions`). **Update `types.test.ts`'s four options-shape `toEqualTypeOf` blocks** (`DeployAppOptions` @418-428, `ManageDomainOptions` @430-437, `CloseLeaseOptions` @439-446, `TroubleshootOptions` @448-455) to include `signal?: AbortSignal` + `timeout?: number` — these are hard compile errors now that Task 1 enabled `--typecheck`.

- [ ] **Step 4: Resolve + forward the signal; race the PRE-broadcast callbacks; map the outcome.** In `deploy-app.ts`:
  - Top of `deployApp`: `const signal = resolveCallSignal(opts);` (import from `@manifest-network/manifest-mcp-core`). `signal?.throwIfAborted()` at each pre-broadcast step boundary + emit-site.
  - Forward into fred: the broadcast `DeployCallOptions` (was `{}` @557) becomes `{ abortSignal: signal }`.
  - **Race only the PRE-broadcast interactive callbacks** — `onPlan`, `onConfirm`, `onResolveSku` — against the signal. Extract a local `raceAbort(promise, signal)` copying the executor+swallow shape from `core/src/internals/tx-confirmation.ts:46-54` (settle on first of {callback, abort listener reject}; `.catch(() => {})` the dangling promise; abort listener `{ once: true }` removed in `.finally`). **Do NOT race `onFailure`** (the post-broadcast recovery prompt) or any post-broadcast await — per D4.6 a post-broadcast abort routes *into* recovery, it must not cancel it. Callback signatures are unchanged.
  - On abort, `throw new ManifestMCPError(OPERATION_CANCELLED, signal.reason?.message ?? 'cancelled')`; emit `onProgress?.({ kind: 'cancelled' })` immediately before the throw. (The existing `onConfirm:'no'`/`onPlan:'cancel'` paths already throw `OPERATION_CANCELLED` — leave them; they share the code.)
  - Post-broadcast keeps the existing partial-success/`onFailure`/`close_lease` routing — no auto-retry. Add a one-line comment pointing at the `tx-confirmation.ts` "tx MAY STILL COMMIT → re-query" contract.

- [ ] **Step 5: Run — verify GREEN.** `npm run test -w @manifest-network/manifest-agent-core`. Expected: PASS.

- [ ] **Step 6: Commit.** `git add packages/agent-core && git commit -m "feat(agent-core): cancellation contract on deployApp options + pre-broadcast callbacks (signal/timeout, OPERATION_CANCELLED, cancelled event) (ENG-310)"`.

---

## Task 4: Parse-and-validate at the untrusted MCP boundary (D6) + retarget agent consumers

**Files:** Modify `packages/agent/src/index.ts` (Zod @312-362 + the `as DeploySpec` cast @414), `packages/agent/src/elicitation.ts` (@33/336/349), `packages/agent/src/server.test.ts`.

- [ ] **Step 1: Retarget the deleted-type consumers in `packages/agent`.** Swap `import type { DeploySpec }` → `AppDeploySpec` and the `as DeploySpec` casts → `as AppDeploySpec` in `index.ts` (@32, @414) and `elicitation.ts` (@33, @336, @349). (Required for the agent package to compile after Task 2.)

- [ ] **Step 2: Write the failing boundary tests (RED).** A Zod input-schema failure is thrown by the MCP SDK as `McpError(InvalidParams, …)`, so `client.callTool` **REJECTS** — it does **not** resolve with `{ isError: true }` (that shape is only for *handler*-returned errors on a valid schema). Assert the rejection:

```ts
it('deploy_app_orchestrated REJECTS a spec with both image and services (schema edge, not handler)', async () => {
  await expect(
    callTool('deploy_app_orchestrated', { spec: { image: 'x', services: {}, size: 'small' } }),
  ).rejects.toThrow(/invalid/i); // McpError(InvalidParams) === JSON-RPC -32602
});
it('REJECTS a spec missing size', async () => {
  await expect(callTool('deploy_app_orchestrated', { spec: { image: 'x' } })).rejects.toThrow(/invalid/i);
});
it('REJECTS a spec with neither image nor services', async () => {
  await expect(callTool('deploy_app_orchestrated', { spec: { size: 'small' } })).rejects.toThrow(/invalid/i);
});
```

- [ ] **Step 3: Run — verify RED.** The current `z.looseObject({ size: z.string().optional(), … })` accepts all three.

- [ ] **Step 4: Tighten the Zod schema.** In `index.ts` @312-362: make `size` **required** (`z.string()` — drop `.optional()`) and wrap the object in `.refine` enforcing exactly-one-of(`image`,`services`):

```ts
spec: z
  .looseObject({
    size: z.string().describe(
      "Compute-tier / SKU name (e.g. 'small', 'medium') — REQUIRED. Selects the on-chain SKU for the " +
        "lease item, fee estimate, and readiness check; list tiers via the lease server's get_skus.",
    ),
    providerUuid: z.string().optional().describe(/* unchanged */),
    skuUuid: z.string().optional().describe(/* unchanged */),
  })
  .refine((s) => ('image' in s) !== ('services' in s), {
    message: 'Provide exactly one of `image` (single service) or `services` (stack), not both or neither.',
  })
  .describe(/* update: drop "Defaults to small"; state size is required; keep the snake_case alias note — looseObject + refine preserve passthrough, so provider_uuid/sku_uuid still pass to the handler */),
```

(`z.looseObject(...).refine(...)` keeps unknown-key passthrough — verified against the package's Zod 4 — so the snake_case `provider_uuid`/`sku_uuid` aliases the handler normalizes still flow through.)

- [ ] **Step 5: Fix the pre-existing tests D2/D6 invalidate.** In `server.test.ts`: **invert** the `size`-not-required pin @409-411 — assert `expect(specSchema?.required ?? []).toContain('size')` and update the comment (drop "defaults to small"). **Add `size`** to every `deploy_app_orchestrated` fixture that omits it (e.g. @753 `{ image: 'nginx', port: 80 }` → add `size: 'small'`; and the call sites at ~@510/543/594/617/642/900/1016/1075 — grep `deploy_app_orchestrated` in the file to find them all).

- [ ] **Step 6: Run — verify GREEN + the full agent suite.** `npm run test -w @manifest-network/manifest-mcp-agent`. Expected: PASS (boundary rejects + the updated existing tests). Update any pinned input-schema snapshot.

- [ ] **Step 7: Commit.** `git add packages/agent && git commit -m "feat(agent): retarget to AppDeploySpec + parse/validate the deploy spec at the MCP boundary (size required, image-xor-services) (ENG-310 D6)"`.

---

## Task 5: Full-repo gate + branch finish

- [ ] **Step 1: Run the whole gate.** `npm run build && npm run lint && npm run test && npm run check && npm run depcruise && npm run size`. Expected: all green.

- [ ] **Step 2: Verify deliverables by grep.**

```bash
test ! -e packages/agent-core/src/internals/build-fred-input.ts && echo "mapper deleted"
! grep -rn "SingleServiceSpec\|StackSpec\|ServiceDef\|\bDeploySpec\b" packages/agent-core/src packages/agent/src && echo "narrow types gone (all consumers retargeted)"
```

- [ ] **Step 3: Finish the branch** — use `superpowers:finishing-a-development-branch` (push `eng-310-deployspec-superset`, open the PR; the user merges). The PR description summarizes D1–D6 and links the spec + CHANGELOG.

---

## Self-Review (run by the plan author)

**Spec coverage:** D1 (T2 §3/§5/§8), D2 (T2 §5/§11 + T4 §4/§5), D3 (T2 §6 + the RED loss-free single+stack), D4 (T3; `'cancelled'` kind T2 §3; race scoped to pre-broadcast per D4.6), D5 (T2 §4/§10 — validateSpec both/neither, both paths), D6 (T4). §5 §8-chokepoint (T2 §12 + T5 §2). §6 testing — typecheck (T1), equivalence + key-coverage drift guard + meta-hash parity (T2 §7/§8), cancellation matrix incl. composed-signal + **non-vacuous** no-leak (T3 §1), CHANGELOG (T2 §11). The coupled elicitation-`requestId` cancellation (spec §7) is the one tracked deferral. **Consumer completeness:** `render-intent-recap.ts`/`.test.ts`, `spec-normalize.test.ts` (T2), `agent/index.ts:414` cast + `elicitation.ts` + `server.test.ts` (T4) are all named. **Pinned-test conflicts called out:** the options-shape pins (T3 §3), the `size`-not-required pin + size-less fixtures (T4 §5), `validateSpec(null) → TypeError` preserved (T2 §4), the deleted-type shape pins (T2 §8).

**Placeholder scan:** none — every step has the concrete file/line, test code, command + expected, and commit.

**Type consistency:** `AppDeploySpec` is the single input type throughout; `{signal?,timeout?}` matches core's `CallOptions`; `resolveCallSignal` import path is `@manifest-network/manifest-mcp-core`; `OPERATION_CANCELLED` is the one cancellation code; `'cancelled'` is added once (T2 §3 type + T2 §8 pin) and emitted in T3; `validateSpec` keeps throwing `TypeError` (wrappers convert) — consistent across T2 §4 and the preserved `spec-normalize.test.ts:197`.
