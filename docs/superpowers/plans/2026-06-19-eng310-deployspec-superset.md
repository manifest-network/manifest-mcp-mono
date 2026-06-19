# ENG-310 — agent-core DeploySpec superset (loss-free orchestration tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-core's deploy input the canonical `AppDeploySpec` (loss-free), delete the subtractive `build-fred-input.ts`, and add an idiomatic cancellation contract — so the orchestration tier loses no fields and can never re-diverge.

**Architecture:** Strict verbatim reuse — `deployApp(spec: AppDeploySpec, …)`; the broadcast payload is a loss-free spread that stamps the already-resolved SKU identity. Cancellation rides on the options type via the repo's existing `{signal?,timeout?}` + `resolveCallSignal`, forwarded into fred's `DeployCallOptions.abortSignal`; interactive callbacks are raced (not re-signatured). Validation is defense-in-depth: a Zod gate at the untrusted MCP edge + agent-core's `validateSpec` per entry path.

**Tech Stack:** TypeScript (ESM, `platform:neutral`), Vitest (+ `--typecheck` / `*.test-d.ts`), Zod 4 (agent package only), Biome, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-06-19-eng310-deployspec-superset-design.md` (decisions D1–D6). Read it first.

**Read before starting (current code):** `packages/agent-core/src/types.ts` (the `DeploySpec` union @172-222, `DeployAppOptions` @92-140, `ProgressEvent` @295-…, `PlanEdit` @263-265), `packages/agent-core/src/deploy-app.ts` (`deployApp` @137, `validateSpec` calls @144 + @396, the `buildFredDeployInput` broadcast site @546-559, `requestedSize` @873-883, the `spec as …` casts @870/906/1067), `packages/agent-core/src/internals/spec-normalize.ts`, `packages/agent-core/src/internals/build-fred-input.ts`, `packages/core/src/manifest-types.ts` (`AppDeploySpec` @250-279), `packages/core/src/options.ts` (`resolveCallSignal`), `packages/agent/src/index.ts` (`deploy_app_orchestrated` Zod @300-369).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/agent-core/vitest.config.ts` | test config | **Modify** — enable `typecheck` so `*.test-d.ts` + `types.test.ts` assertions actually run |
| `packages/agent-core/package.json` | scripts | **Modify** — `test` runs `--typecheck` |
| `packages/agent-core/src/types.ts` | agent-core public types | **Modify** — delete `ServiceDef`/`SingleServiceSpec`/`StackSpec`/`DeploySpec`; re-export `AppDeploySpec`; `PlanEdit.replace_spec.spec: AppDeploySpec`; add `signal?`/`timeout?` to `DeployAppOptions`+siblings; add `ProgressEvent` `'cancelled'` kind |
| `packages/agent-core/src/internals/spec-normalize.ts` | shape helpers + `validateSpec` | **Modify** — canonical shape (`'services' in spec`), both/neither gate |
| `packages/agent-core/src/deploy-app.ts` | the orchestrator | **Modify** — `AppDeploySpec` signature; remove casts + `requestedSize` default; broadcast spread; cancellation race + forwarding + `OPERATION_CANCELLED` |
| `packages/agent-core/src/internals/build-fred-input.ts` (+ `.test.ts`) | the lossy mapper | **Delete** |
| `packages/agent-core/src/types.test.ts` | frozen-surface type pin | **Modify** — drop deleted-type pins; pin `deployApp` input ≡ `AppDeploySpec`; add `'cancelled'` to the `ProgressEvent['kind']` exhaustiveness assertion |
| `packages/agent-core/src/deploy-app.test.ts` (+ a new `*.test-d.ts`) | behavior + type tests | **Modify/Create** — loss-free, key-coverage, cancellation tests; the `tsc`-enforced equivalence |
| `packages/agent/src/index.ts` | MCP boundary | **Modify** — Zod: `size` required + image-xor-services refine; fix describe text |
| `CHANGELOG.md` | release notes | **Modify** — `## [Unreleased]` → `### Upgrade notes` → `**BREAKING (…)**` |

---

## Task 1: Enable the agent-core type-test harness

**Why first:** the loss-free invariant's proof is a type-equivalence assertion, and a `toEqualTypeOf` mismatch runs under **neither** `vitest run` nor plain `tsc --noEmit` today. This also resurrects `types.test.ts`'s 145 currently-inert assertions (may surface real failures to fix).

**Files:**
- Modify: `packages/agent-core/vitest.config.ts`
- Modify: `packages/agent-core/package.json` (the `test` script)

- [ ] **Step 1: Enable typecheck in the vitest config** — mirror `packages/core/vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
```

- [ ] **Step 2: Point the `test` script at typecheck** — in `packages/agent-core/package.json`, change `"test": "vitest run"` to `"test": "vitest run --typecheck"` (mirrors `packages/sdk`). Leave `test:watch`/`lint` as-is.

- [ ] **Step 3: Run the suite incl. typecheck** —

Run: `npm run test -w @manifest-network/manifest-agent-core`
Expected: PASS. If the now-enforced `types.test.ts` surfaces a stale assertion (a previously-inert `toEqualTypeOf` that no longer matches the code), fix the **assertion** to match current types (do not weaken the code). Re-run to green.

- [ ] **Step 4: Commit** —

```bash
git add packages/agent-core/vitest.config.ts packages/agent-core/package.json
git commit -m "test(agent-core): enable vitest typecheck so type assertions actually run (ENG-310)"
```

---

## Task 2: Core type unification — `deployApp` input = `AppDeploySpec` (D1 + D2 + D3 + D5)

This is one atomic refactor (TypeScript won't compile between the old and new type). Drive it with the loss-free test: RED first, then the swap makes it GREEN.

**Files:**
- Test: `packages/agent-core/src/deploy-app.test.ts` (add tests)
- Create: `packages/agent-core/src/deploy-app.test-d.ts` (type equivalence)
- Modify: `packages/agent-core/src/types.ts`, `packages/agent-core/src/internals/spec-normalize.ts`, `packages/agent-core/src/deploy-app.ts`, `packages/agent-core/src/types.test.ts`
- Delete: `packages/agent-core/src/internals/build-fred-input.ts`, `packages/agent-core/src/internals/build-fred-input.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the failing loss-free test (RED).** Add to `deploy-app.test.ts`. Construct a spec carrying all 9 formerly-dropped rich fields (typed as core's `AppDeploySpec`; the `as never` bridges the *current* union signature and is removed in Step 9), mock the fred broadcast to capture its input, and assert every rich field survives. Follow the existing mock setup in `deploy-app.test.ts` for `clientManager`/`walletProvider`/the fred `deployApp` mock — reuse those helpers; the assertion is the new part:

```ts
import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';

it('loss-free: every AppDeploySpec field survives to the fred broadcast (ENG-310)', async () => {
  const spec: AppDeploySpec = {
    image: 'nginx:latest',
    size: 'small',
    port: 8080,
    env: { A: '1' },
    command: ['/bin/sh'],
    args: ['-c', 'true'],
    user: '1000:1000',
    tmpfs: ['/tmp'],
    health_check: { test: ['CMD', 'true'], interval: '10s', retries: 3 },
    stop_grace_period: '30s',
    init: true,
    expose: ['9090'],
    labels: { tier: 'web' },
    storage: '10Gi',
    depends_on: { db: { condition: 'service_started' } },
    customDomain: 'app.example.com',
  };
  // captureFredInput / mockFredDeploy: reuse the file's existing fred deployApp mock
  // (it already returns a successful DeployResult); add a capture of its input arg.
  const captured = await runDeployAndCaptureFredInput(spec as never);
  for (const k of Object.keys(spec) as (keyof AppDeploySpec)[]) {
    if (k === 'size') continue; // size is overwritten with the resolved SKU name (asserted below)
    expect(captured[k]).toEqual(spec[k]);
  }
  // Resolved-identity: size/skuUuid/providerUuid are the RESOLVED pin, not raw input.
  expect(captured.size).toBe(resolvedSkuFixture.name);
  expect(captured.skuUuid).toBe(resolvedSkuFixture.skuUuid);
  expect(captured.providerUuid).toBe(resolvedSkuFixture.providerUuid);
});
```

- [ ] **Step 2: Run it — verify RED.**

Run: `npx vitest run packages/agent-core/src/deploy-app.test.ts -t "loss-free"`
Expected: FAIL — `captured.user` / `tmpfs` / `health_check` / … are `undefined` (the current `build-fred-input.ts` `convertServiceDef`/single-arm copies only `image`/`ports`/`env`/`args`/`command`, dropping the 9 rich fields).

- [ ] **Step 3: Delete the narrow types; re-export the canonical one.** In `types.ts`, delete `ServiceDef`, `SingleServiceSpec`, `StackSpec`, and `export type DeploySpec = …` (@172-222). Add a re-export with the no-data-delta precondition comment:

```ts
// agent-core's deploy input IS the canonical core type — verbatim reuse (ENG-310 / D1).
// Precondition: agent-core adds NO data field to the deploy spec (its only additions are
// runtime concerns, which live on DeployAppOptions). If a future change needs an
// orchestration-only DATA field, DERIVE it (`AppDeploySpec & { newField }`) — never fork a
// parallel type (that is the divergence ENG-310 removes).
export type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
```

Update `PlanEdit` (@263-265): `replace_spec`'s `spec: DeploySpec` → `spec: AppDeploySpec`.

- [ ] **Step 4: Update `spec-normalize.ts` to the canonical shape.** Replace the `image`-vs-`services` discrimination: `isStackSpec(spec)` becomes `'services' in spec && spec.services !== undefined`. `validateSpec(spec)` must throw `ManifestMCPError(INVALID_CONFIG)` for **both** (`image` AND `services` present) **and** **neither** (re-use the existing INVALID_CONFIG messages; consolidate the both/neither check here). `summarizeSpec`/`normalizeServices` read the canonical `services: Record<string, ServiceConfig>` (port-map, not `number[]`).

- [ ] **Step 5: Update `deploy-app.ts` internals to the canonical shape (D1 + D2).** Remove the `spec as SingleServiceSpec` / `spec as StackSpec` casts (@870/906/1067) — the helpers (`primaryImage`, `customDomainOf`, `customDomainServiceOf`, `estimateFees`, `applyPlanEdit`, `handleBroadcastFailure`) now read `AppDeploySpec` directly (`spec.image`, `'services' in spec`, etc.). **Delete `requestedSize()`'s `'small'` fallback (@873-883)** — `size` is required on `AppDeploySpec`, so `requestedSize(spec)` returns `spec.size` (or inline `spec.size`). Update the `deployApp` signature (@137) to `(spec: AppDeploySpec, callbacks, opts)`.

- [ ] **Step 6: Replace `buildFredDeployInput` with the loss-free pin-override (D3).** At the broadcast site (@546-559), replace `const fredInput = buildFredDeployInput(confirmedSpec, pinned.name, { skuUuid, providerUuid })` with the inline spread:

```ts
const fredInput: AppDeploySpec = {
  ...confirmedSpec,                  // loss-free — all 9 rich fields survive
  size: pinned.name,                 // resolved SKU name (thread resolved identity)
  skuUuid: pinned.skuUuid,           // authoritative resolved pin (overwrites raw hints)
  providerUuid: pinned.providerUuid,
};
```

Do the same for the preview path (was `buildManifestPreviewInput(spec, requestedSize(spec))` @315/@461): the preview input is the spec with `size` set to the resolved name (no field drops). Then **delete** `internals/build-fred-input.ts` and `internals/build-fred-input.test.ts`, and remove their imports.

- [ ] **Step 7: Update the frozen-surface type test + add the `'cancelled'` ProgressEvent kind.** In `types.ts`, add `| { kind: 'cancelled' }` to the `ProgressEvent` union now (Task 3 emits it). In `types.test.ts`, delete the `SingleServiceSpec`/`StackSpec`/`ServiceDef`/`DeploySpec` shape pins and add `'cancelled'` to the `ProgressEvent['kind']` exhaustiveness assertion — so the type and the assertion stay consistent within this task.

- [ ] **Step 8: Add the `tsc`-enforced equivalence + key-coverage guard.** Create `packages/agent-core/src/deploy-app.test-d.ts`:

```ts
import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
import { describe, expectTypeOf, it } from 'vitest';
import { deployApp } from './deploy-app.js';

// Belt-and-suspenders that fails under plain `tsc --noEmit` too (not only vitest --typecheck):
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _DeployInputIsCanonical = Expect<Equals<Parameters<typeof deployApp>[0], AppDeploySpec>>;

describe('deployApp input type (ENG-310)', () => {
  it('is exactly AppDeploySpec', () => {
    expectTypeOf<Parameters<typeof deployApp>[0]>().toEqualTypeOf<AppDeploySpec>();
  });
});
```

- [ ] **Step 9: Make the loss-free test GREEN.** Remove the `as never` bridge from Step 1 (`deployApp` now accepts `AppDeploySpec`). Run:

Run: `npm run test -w @manifest-network/manifest-agent-core`
Expected: PASS — the loss-free test, the new `*.test-d.ts` (equivalence), and the existing suite all green. Fix any consumer/test that referenced the deleted types.

- [ ] **Step 10: Add the validateSpec both/neither matrix.** In `deploy-app.test.ts`, assert all four combos on **both** entry paths (initial call + a `replace_spec` `onPlan` edit): image-only ✓, services-only ✓, both → `INVALID_CONFIG`, neither → `INVALID_CONFIG`. Run that file green.

- [ ] **Step 11: CHANGELOG.** In `CHANGELOG.md`, add (matching the 0.12.0/0.13.0 idiom):

```markdown
## [Unreleased]

### Upgrade notes

**BREAKING (agent-core / headless `deployApp` callers):**
- `deployApp`'s input is now the canonical `AppDeploySpec` (from `@manifest-network/manifest-mcp-core`); the `SingleServiceSpec | StackSpec` union (and `ServiceDef`) is removed. Migrate by importing `AppDeploySpec` and using its shape (`services` is a `Record<string, ServiceConfig>` with map-shaped `ports`).
- `size` is now **required** (it was silently defaulted to `'small'`). Pass an explicit tier name (or pin `skuUuid`); discover tiers via the lease server's `get_skus`.
```

- [ ] **Step 12: Lint + depcruise, then commit.**

Run: `npm run lint && npm run depcruise`
Expected: exit 0 (the §8 chokepoint stays green — agent-core still routes manifestjs types through core; no exemption existed, so none to remove).

```bash
git add packages/agent-core CHANGELOG.md
git rm packages/agent-core/src/internals/build-fred-input.ts packages/agent-core/src/internals/build-fred-input.test.ts
git commit -F - <<'MSG'
feat(agent-core): deployApp input = canonical AppDeploySpec; delete the lossy build-fred-input (ENG-310)

Loss-free: all 9 formerly-dropped rich fields survive to the broadcast via a
resolved-identity spread; size is now required (no surprise 'small' default);
validateSpec gates image-xor-services at each entry path.
MSG
```

---

## Task 3: Cancellation contract (D4)

Built on the unified `deployApp`. Add `{signal?,timeout?}` to the options, forward into fred's `DeployCallOptions.abortSignal`, race the interactive callbacks, and surface one `OPERATION_CANCELLED` outcome + a `'cancelled'` progress event.

**Files:**
- Modify: `packages/agent-core/src/types.ts` (`DeployAppOptions`+siblings; `ProgressEvent`)
- Modify: `packages/agent-core/src/deploy-app.ts`
- Test: `packages/agent-core/src/deploy-app.test.ts`

- [ ] **Step 1: Write the failing cancellation tests (RED).** Mirror `packages/core/src/internals/read-signal.test.ts` (fake timers + reason). Add to `deploy-app.test.ts`:

```ts
import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';

it('pre-broadcast abort → OPERATION_CANCELLED, no lease created', async () => {
  const ac = new AbortController();
  ac.abort(); // already aborted before broadcast
  const err = await runDeploy({ signal: ac.signal }).catch((e) => e);
  expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
  expect(fredDeployMock).not.toHaveBeenCalled();
});

it('abort during a pending onConfirm rejects promptly with no unhandled rejection', async () => {
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const ac = new AbortController();
    const p = runDeploy({ signal: ac.signal, onConfirm: () => new Promise(() => {}) /* never settles */ });
    ac.abort();
    const err = await p.catch((e) => e);
    expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    await Promise.resolve();
  } finally {
    process.off('unhandledRejection', onRej);
  }
  expect(rejections).toEqual([]); // the losing onConfirm branch is swallowed
});

it('composed signal: AbortSignal.any([caller, AbortSignal.timeout(ms)]) times out with TimeoutError', async () => {
  vi.useFakeTimers();
  try {
    const p = runDeploy({ timeout: 1000, onConfirm: () => new Promise(() => {}) });
    const assertion = expect(p).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally { vi.useRealTimers(); }
});
```

- [ ] **Step 2: Run — verify RED.**

Run: `npx vitest run packages/agent-core/src/deploy-app.test.ts -t "abort|cancel|timeout"`
Expected: FAIL — `DeployAppOptions` has no `signal`/`timeout`; cancellation is unwired (agent-core passes `{}` to fred today).

- [ ] **Step 3: Add `signal?`/`timeout?` to the options.** In `types.ts`, add to `DeployAppOptions` (and `ManageDomainOptions`/`CloseLeaseOptions`/`TroubleshootOptions`): `signal?: AbortSignal;` and `timeout?: number;` (same names/semantics as core's `CallOptions`). (The `'cancelled'` `ProgressEvent` kind was already added in Task 2 §7.)

- [ ] **Step 4: Resolve + forward the signal; race the callbacks; map the outcome.** In `deploy-app.ts`:
  - At the top of `deployApp`, `const signal = resolveCallSignal(opts);` (import from `@manifest-network/manifest-mcp-core`). Check `signal?.throwIfAborted()` at each step boundary and emit-site.
  - Forward into fred: the broadcast `DeployCallOptions` (was `{}` @557) becomes `{ abortSignal: signal }`.
  - **Race each pending interactive callback** (`onConfirm`/`onPlan`/`onResolveSku`/`onFailure`) against the signal — copy the proven executor+swallow shape from `core/src/internals/tx-confirmation.ts:46-54`: a `new Promise` that settles on the first of {callback resolves, abort listener rejects}; `.catch(() => {})` the dangling callback promise; abort listener `{ once: true }` + removed in `.finally`. Extract a small local helper `raceAbort(promise, signal)` to apply to each callback await. **Do not change the callback signatures.**
  - Map abort/decline to one outcome: on abort, throw `ManifestMCPError(OPERATION_CANCELLED, signal.reason?.message ?? 'cancelled')`; emit `onProgress?.({ kind: 'cancelled' })` immediately before the throw. (The existing `onConfirm:'no'`/`onPlan:'cancel'` paths already throw `OPERATION_CANCELLED` — leave them; they share the code.)
  - **Post-broadcast** abort keeps the existing partial-success/`onFailure`/`close_lease` routing — do NOT auto-retry (it's already non-retryable). Add a short comment pointing at the `tx-confirmation.ts` "tx MAY STILL COMMIT → re-query" contract.

- [ ] **Step 5: Run — verify GREEN.**

Run: `npm run test -w @manifest-network/manifest-agent-core`
Expected: PASS (the 3 cancellation tests + the existing suite).

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-core
git commit -m "feat(agent-core): cancellation contract on deployApp options + callbacks (signal/timeout, OPERATION_CANCELLED, cancelled event) (ENG-310)"
```

---

## Task 4: Parse-and-validate at the untrusted MCP boundary (D6)

**Files:**
- Modify: `packages/agent/src/index.ts` (the `deploy_app_orchestrated` Zod, @312-362)
- Test: `packages/agent/src/server.test.ts` (or the existing `deploy_app_orchestrated` test file)

- [ ] **Step 1: Write the failing boundary tests (RED).** Assert the tool rejects (with the MCP invalid-params error) a spec with **both** `image` and `services`, **neither**, and a missing `size`. Follow the existing `server.test.ts` tool-call harness:

```ts
it('deploy_app_orchestrated rejects a spec with both image and services', async () => {
  const res = await callTool('deploy_app_orchestrated', { spec: { image: 'x', services: {}, size: 'small' } });
  expect(res.isError).toBe(true); // -32602 invalid params at the Zod edge, before the handler
});
it('rejects a spec missing size', async () => {
  const res = await callTool('deploy_app_orchestrated', { spec: { image: 'x' } });
  expect(res.isError).toBe(true);
});
```

- [ ] **Step 2: Run — verify RED.** The current `z.looseObject({ size: z.string().optional(), … })` accepts all three.

- [ ] **Step 3: Tighten the Zod schema.** In `index.ts` @312-362, make `size` **required** (`z.string()` — drop `.optional()`), and wrap the object in `.refine(…)` enforcing exactly-one-of(`image`,`services`):

```ts
spec: z
  .looseObject({
    size: z.string().describe(
      "Compute-tier / SKU name (e.g. 'small', 'medium') — REQUIRED. Selects the on-chain " +
        "SKU for the lease item, fee estimate, and readiness check; list tiers via the lease " +
        "server's get_skus. An unknown tier is rejected at the readiness check before any broadcast.",
    ),
    providerUuid: z.string().optional().describe(/* unchanged */),
    skuUuid: z.string().optional().describe(/* unchanged */),
  })
  .refine(
    (s) => ('image' in s) !== ('services' in s),
    { message: 'Provide exactly one of `image` (single service) or `services` (stack), not both or neither.' },
  )
  .describe(/* update the top-level describe: drop "Defaults to small"; state size is required */),
```

- [ ] **Step 4: Run — verify GREEN + the full agent suite.**

Run: `npm run test -w @manifest-network/manifest-mcp-agent`
Expected: PASS. (If a snapshot of the `deploy_app_orchestrated` input schema is pinned, update it.)

- [ ] **Step 5: Commit.**

```bash
git add packages/agent
git commit -m "feat(agent): parse+validate the deploy spec at the MCP boundary (size required, image-xor-services) (ENG-310 D6)"
```

---

## Task 5: Full-repo gate + branch finish

- [ ] **Step 1: Run the whole gate.**

Run: `npm run build && npm run lint && npm run test && npm run check && npm run depcruise && npm run size`
Expected: all green (build incl. attw/publint; lint = full-repo tsc; test incl. agent-core `--typecheck`; biome; dependency-cruiser DAG/chokepoint; size budget).

- [ ] **Step 2: Verify the spec deliverables by grep** — `build-fred-input` is gone; agent-core has no `SingleServiceSpec`/`StackSpec`; `deployApp` signature is `AppDeploySpec`:

```bash
test ! -e packages/agent-core/src/internals/build-fred-input.ts && echo "mapper deleted"
! grep -rn "SingleServiceSpec\|StackSpec\|ServiceDef" packages/agent-core/src && echo "narrow types gone"
```

- [ ] **Step 3: Finish the branch** — use `superpowers:finishing-a-development-branch` (push `eng-310-deployspec-superset`, open the PR; the user merges). The PR description summarizes D1–D6 and links the spec + CHANGELOG entry.

---

## Self-Review (run by the plan author)

**Spec coverage:** D1 (Task 2 §3/§5/§8), D2 (Task 2 §5/§11 + Task 4), D3 (Task 2 §6 + the RED loss-free test), D4 (Task 3 + the `'cancelled'` kind in Task 2 §7), D5 (Task 2 §4/§10 — validateSpec both/neither at both paths), D6 (Task 4), §5 §8-chokepoint (Task 2 §12 + Task 5 §2), §6 testing — typecheck enablement (Task 1), equivalence + key-coverage (Task 2 §1/§8), cancellation matrix incl. composed-signal + no-unhandled-rejection (Task 3 §1), CHANGELOG (Task 2 §11). The coupled elicitation-`requestId` cancellation (spec §7) is deferred — not a task here.

**Placeholder scan:** none — every step has the concrete file/pointer, test code, command + expected result, and commit.

**Type consistency:** `AppDeploySpec` is the single input type throughout; `{signal?,timeout?}` matches core's `CallOptions`; `resolveCallSignal` import path is `@manifest-network/manifest-mcp-core`; `OPERATION_CANCELLED` is the one cancellation code; `'cancelled'` is added once (Task 2 §7 type-test + Task 3 §3 the type) and kept consistent.
