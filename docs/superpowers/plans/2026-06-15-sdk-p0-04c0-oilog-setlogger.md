# SDK P0 — Plan 4c-0: OI-LOG `setLogger` rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Resolve the OI-LOG debt deferred from 4a/4b: route the 2 neutral-core global-singleton `logger.warn` sites (`client.ts:404` signing-client gasMultiplier fallback; `lcd-adapter.ts:139` wasm-patch missing-method) onto a **per-instance, injectable `Logger`** via a NON-key `CosmosClientManager.setLogger(logger)` setter, and have `createManifestClient` (4b) inject `ctx.logger`. **Tiny, infra-only, ~zero call-site ripple** — touches `core` only (`client.ts`, `lcd-adapter.ts`, `client-factory.ts` + tests). First of the 3-way **4c split** (4c-0 OI-LOG → 4c-reads → 4c-txs), ordered to de-risk: this lands FIRST and has no dependency on the read/tx ctx-ification.

**Architecture:** spec §5.3 — the per-instance `Logger` port (silent `noopLogger` by default; the global mutable `console`-backed singleton "stays an internal detail of the MCP servers/CLI only"; neutral core must reference only `ctx.logger`/the injected logger, never the singleton). The setter is **non-key**: it is NOT part of the `getInstance` key (`chainId:rpcUrl[:restUrl]`, `client.ts:172-174`) and does NOT enter the signing/query-client invalidation gate (`client.ts:182-185`, which keys on gasPrice/gasMultiplier/walletProvider) — a pure reference mutation, mirroring the existing non-key config/walletProvider mutation (`client.ts:191-193`). Both warn sites are **one-time, init-cached** diagnostics (gated behind the `signingClient`/`queryClient` + `*Promise` caches), so they never re-fire after the first build — the shared-key last-writer-wins exposure is at most one early init line routed to the previous ctx's sink, never a per-call leak.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4, tsdown, `tsc --noEmit` lint (`noUnusedLocals`), Biome. Spec §5.3. Issue: ENG-309. Builds on Plans 1/2/3/4a/4b.

**⚠️ FULL-LINT LESSON (bit 4×):** run the **full-repo `npm run lint`** at every task gate.

---

## OPEN ITEMS (resolved — defaults below)

- **OI-LOG-DEFAULT — the manager's `logger` field defaults to `noopLogger` (SILENT), per spec §5.3 "silent by default".** The SDK path resolves cleanly: `createManifestClient`/`createManifestReadClient` (4b) call `chain.setLogger(opts.logger ?? noopLogger)` so the 2 warns route to the per-ctx logger. **Transitional consequence — an OBSERVABILITY-ONLY (operator-visible) regression on the un-migrated CLI/server path, accepted + follow-up-flagged (NOT a functional/behavior regression):** the MCP servers still construct via bare `CosmosClientManager.getInstance` (they have not adopted `createManifestClient`), so at the default `LOG_LEVEL=warn` their 2 init diagnostics now go **silent** until a follow-up wires the node bootstrap / server construction to inject a singleton-adapter logger (spec §5.3: "the node CLI bootstrap constructs each ctx with `{ logger: <adapter over the existing core singleton> }`"). Concretely the **cosmwasm server** exercises the `lcd-adapter.ts:139` wasm-LCD diagnostic, so that operator warning disappears until the follow-up. The diagnostics are init-time-rare and do not affect control flow, so behavior is unchanged — only CLI observability. **FOLLOW-UP (tracked here — must not be lost; file as a follow-up issue when 4c lands):** wire the server/bootstrap `getInstance` path to `setLogger(<adapter over the core singleton>)` so the bare-`getInstance` CLI path keeps its warn diagnostics; do this when the servers adopt ctxs, or sooner if the cosmwasm/LCD diagnostics are needed. Do NOT default the field to the singleton (that contradicts §5.3 "silent by default" and re-couples neutral core to `console`).
- **OI-LOG-SHARED-KEY — shared-key last-writer-wins is ACCEPTED + documented.** Two ctxs sharing a config key share one manager; the later `setLogger` wins. Acceptable: identical shape/blast-radius to the already-accepted config/walletProvider mutation, and both warns are one-time init-cached (never re-fire). The `setLogger` JSDoc states this.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/client.ts` (modify) | Add `private logger: Logger = noopLogger` field + `setLogger(logger)` non-key setter; switch the `./logger.js` import to `{ type Logger, noopLogger }`; rewire `:404` → `this.logger.warn`; pass `this.logger` to `createLCDQueryClient` at `:262`. |
| `packages/core/src/lcd-adapter.ts` (modify) | Thread `Logger` (optional, default `noopLogger`) through `createLCDQueryClient` + `patchWasmQueryData`; switch the import; the `:139` warn resolves to the param. |
| `packages/core/src/client-factory.ts` (modify) | `buildClient` calls `chain.setLogger(logger)` after resolving the logger (the SDK-path OI-LOG resolution). |
| `packages/core/src/client.test.ts` (modify) | Drop the `vi.mock('./logger.js')` global-warn mock + the `logger` import; the 2 gasMultiplier-warn tests inject a spy via `setLogger`; add a non-key/non-invalidating + a silent-by-default test; update the two LCD-call arity assertions (`:633`/`:646`) to include the `noopLogger` 2nd arg + import `noopLogger`. |
| `packages/core/src/lcd-adapter.test.ts` (modify) | REWRITE the existing global-singleton warn test (`:282-298`) to inject a spy logger as the 2nd `patchWasmQueryData` arg (it goes red otherwise). |
| `packages/core/src/client-factory.test.ts` (modify) | `fakeManager` gets `setLogger: vi.fn()`; assert `buildClient` calls `setLogger` with the resolved logger. |

---

## Task 0: Confirm baseline

- [ ] From the worktree root: `npm run build` (8, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green). HEAD has the 4b commits (`…f92d54b`). If red, STOP.

---

## Task 1: `setLogger` on `CosmosClientManager` + rewire `client.ts:404`

**Files:** Modify `packages/core/src/client.ts`, `packages/core/src/client.test.ts`.

- [ ] **Step 1: Update the failing tests first** — in `packages/core/src/client.test.ts`:
  - **Delete** the `vi.mock('./logger.js', …)` block (currently mocks `{ logger: { warn, … } }`) and the `import { logger } from './logger.js';` line (it exists only for the warn assertions). After this change `client.ts` no longer imports the global `logger`, so the mock is moot and `noopLogger` must resolve to the REAL frozen object.
  - Add a spy-logger helper near the other helpers:

```ts
function makeSpyLogger() {
  return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
}
```

  - Replace the two existing warn tests so they inject a spy via `setLogger` (the warn now goes to `this.logger`, not the global):

```ts
    it('warns when defaultGasMultiplier is absent', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect((mockSC as any).defaultGasMultiplier).toBeUndefined();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not be applied'),
      );
    });

    it('warns with custom multiplier when defaultGasMultiplier is absent', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.0 }),
        makeWallet(),
      );
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('gasMultiplier 2 could not be applied'),
      );
    });
```

  - Add a non-key / non-invalidating test:

```ts
    it('setLogger is non-key: re-getInstance with the same config/wallet returns the SAME instance', () => {
      // setLogger is a pure field assignment, NOT part of the getInstance key — so calling it between
      // two same-key getInstance calls must NOT fragment the singleton (the load-bearing non-key proof).
      // SAME wallet reference both calls — a fresh makeWallet() would trip the reference-equality
      // wallet-invalidation gate (client.ts:182-185). Non-invalidation is INHERENT (setLogger only does
      // `this.logger = logger`); the cached-signing-client / disconnect path is deliberately NOT asserted
      // here because a single getSigningClient() in this MOCKED harness always hits the supersede-promise
      // disconnect and never caches `this.signingClient` (a pre-existing timing quirk, documented in the
      // getSigningClient describe block's omission note ~client.test.ts:444-446) — so a disconnect/caching
      // assertion would fail for reasons unrelated to setLogger.
      const w = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig(), w);
      a.setLogger(makeSpyLogger());
      const b = CosmosClientManager.getInstance(makeConfig(), w);
      expect(b).toBe(a);
    });

    it('is SILENT by default when setLogger is never called (the warn goes to the frozen noopLogger)', async () => {
      const mockSC = { disconnect: vi.fn() }; // no defaultGasMultiplier → triggers the warn branch
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      // No setLogger → this.logger is the real frozen noopLogger; the warn must be swallowed, no throw.
      await expect(instance.getSigningClient()).resolves.toBeDefined();
    });
```

- [ ] **Step 2: Run → fail** (`setLogger` missing; the warn tests no longer see the global mock). `(cd packages/core && npx vitest run src/client.test.ts)`.

- [ ] **Step 3: Implement `client.ts`:**
  - Change the import at `client.ts:33`: `import { logger } from './logger.js';` → `import { type Logger, noopLogger } from './logger.js';`
  - Add the field after `private rateLimiter: RateLimiter;` (`:120`):

```ts
  /** Per-instance logger for the 2 init-time diagnostics. Defaults to noopLogger (silent); see setLogger. */
  private logger: Logger = noopLogger;
```

  - Rewire `client.ts:404`: `logger.warn(` → `this.logger.warn(` (the warn is in an async-arrow init closure assigned to `this.signingClientPromise`, so `this.logger` resolves lexically to the manager — do NOT refactor the closure to a `function` expression).
  - Add the setter alongside `getConfig()` (right after its closing brace, ~`:457`):

```ts
  /**
   * Inject a per-instance Logger for the 2 init-time diagnostics (signing-client gasMultiplier
   * fallback; LCD wasm-patch missing-method). NON-KEY + non-invalidating: NOT part of the getInstance
   * key (chainId:rpcUrl[:restUrl]) and NOT in the signing/query-client invalidation gate — a pure
   * reference mutation, mirroring the existing config/walletProvider mutation. Defaults to noopLogger
   * (silent, per spec §5.3). Shared-key last-writer-wins: if two ctxs share a config key the later
   * setLogger wins; acceptable because both diagnostics are one-time, init-cached, never re-firing.
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }
```

- [ ] **Step 4: Run → pass.** `(cd packages/core && npx vitest run src/client.test.ts && npm run lint)` green.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/client.ts packages/core/src/client.test.ts
git add packages/core/src/client.ts packages/core/src/client.test.ts
git commit -m "feat(core): add non-key CosmosClientManager.setLogger; route signing-client warn to it (ENG-309)"
```

---

## Task 2: Thread `Logger` through `lcd-adapter.ts` + the `client.ts:262` call

**Files:** Modify `packages/core/src/lcd-adapter.ts`, `packages/core/src/lcd-adapter.test.ts`, `packages/core/src/client.ts`.

- [ ] **Step 1: Update the EXISTING warn test (it goes red once the warn routes to the param).** REWRITE the pre-existing `it('warns and skips methods that do not exist on the module', …)` at `lcd-adapter.test.ts:282-298` — it currently does `const { logger } = await import('./logger.js'); vi.spyOn(logger, 'warn')`, but after this task `patchWasmQueryData` routes the warn to its `logger` PARAM (default `noopLogger`), so the global-singleton spy never fires. Replace it with an injected spy passed as the 2nd arg (do NOT spy on `noopLogger.warn` — it's `Object.freeze`d at `logger.ts:77`). The test is no longer `async`:

```ts
  it('warns and skips methods that do not exist on the module', () => {
    const spy = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    expect(() =>
      patchWasmQueryData({ otherMethod: vi.fn(), req: {} }, spy),
    ).not.toThrow();
    expect(spy.warn).toHaveBeenCalledTimes(2);
    expect(spy.warn).toHaveBeenCalledWith(
      expect.stringContaining('smartContractState'),
    );
    expect(spy.warn).toHaveBeenCalledWith(
      expect.stringContaining('rawContractState'),
    );
  });
```

  (`vi`/`patchWasmQueryData` are already imported; the existing 1-arg `patchWasmQueryData(...)` calls in the other tests stay valid via the optional default.)

- [ ] **Step 2: Run → fail** (`patchWasmQueryData` takes no `logger` arg yet, so the spy isn't wired). `(cd packages/core && npx vitest run src/lcd-adapter.test.ts)`.

- [ ] **Step 3: Implement `lcd-adapter.ts`:**
  - Change the import at `lcd-adapter.ts:11`: `import { logger } from './logger.js';` → `import { type Logger, noopLogger } from './logger.js';`
  - `patchWasmQueryData` signature (`:131`): `function patchWasmQueryData(wasmLcd: unknown): Record<string, unknown> {` → `function patchWasmQueryData(wasmLcd: unknown, logger: Logger = noopLogger): Record<string, unknown> {` (the `:139` `logger.warn` now resolves to the param; the optional default keeps existing `_patchWasmQueryData(mod)` test callers valid).
  - `createLCDQueryClient` signature (`:168`): add the trailing optional param (keeps the public barrel export + the 1-arg mock valid):

```ts
export async function createLCDQueryClient(
  restEndpoint: string,
  logger: Logger = noopLogger,
): Promise<ManifestQueryClient> {
```

  - The `patchWasmQueryData` call (`:274`): `patchWasmQueryData(cosmwasmLcd.cosmwasm.wasm.v1),` → `patchWasmQueryData(cosmwasmLcd.cosmwasm.wasm.v1, logger),`
  - In `client.ts`, the `createLCDQueryClient` call (`:262`): `() => createLCDQueryClient(this.config.restUrl!),` → `() => createLCDQueryClient(this.config.restUrl!, this.logger),`
  - In `client.test.ts`, update the two strict-arity LCD-call assertions at `:633` and `:646` — `:262` now passes a 2nd arg, and vitest 4's `toHaveBeenCalledWith` matches the FULL argument list. Change both `expect(mockCreateLCDQueryClient).toHaveBeenCalledWith('https://rest.example.com')` → `expect(mockCreateLCDQueryClient).toHaveBeenCalledWith('https://rest.example.com', noopLogger)` (the bare-`getInstance` path defaults to `noopLogger` — this also pins that the per-instance logger is threaded into the LCD client). Add `import { noopLogger } from './logger.js';` to `client.test.ts` (after Task 1 removed the `vi.mock('./logger.js')` block + the `logger` import, this resolves to the real frozen object).

- [ ] **Step 4: Run → pass.** `(cd packages/core && npx vitest run src/lcd-adapter.test.ts src/client.test.ts && npm run lint)` green.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/lcd-adapter.ts packages/core/src/lcd-adapter.test.ts packages/core/src/client.ts
git add packages/core/src/lcd-adapter.ts packages/core/src/lcd-adapter.test.ts packages/core/src/client.ts
git commit -m "feat(core): thread injectable Logger through createLCDQueryClient + patchWasmQueryData (ENG-309)"
```

---

## Task 3: Wire `createManifestClient` to inject `ctx.logger` (the SDK-path resolution)

**Files:** Modify `packages/core/src/client-factory.ts`, `packages/core/src/client-factory.test.ts`.

- [ ] **Step 1: Failing test** — in `packages/core/src/client-factory.test.ts`:
  - Add `setLogger: vi.fn()` to `fakeManager`'s returned object (so the factory's `chain.setLogger(...)` call doesn't hit `undefined`):

```ts
function fakeManager(
  over: Partial<CosmosClientManager> = {},
): CosmosClientManager {
  return {
    getQueryClient: vi.fn(async () => SENTINEL_QUERY),
    getSigningClient: vi.fn(),
    disconnect: vi.fn(),
    setLogger: vi.fn(),
    ...over,
  } as unknown as CosmosClientManager;
}
```

  - Add a test asserting the injection (and the default):

```ts
  it('injects the resolved logger into the manager via setLogger', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const myLogger = { debug() {}, info() {}, warn() {}, error() {} };
    await createManifestReadClient({ config: READ_CONFIG, logger: myLogger });
    expect(mgr.setLogger).toHaveBeenCalledWith(myLogger);
  });

  it('injects noopLogger by default', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    await createManifestReadClient({ config: READ_CONFIG });
    expect(mgr.setLogger).toHaveBeenCalledWith(noopLogger);
  });
```

  (`noopLogger` is already imported in `client-factory.test.ts`.)

- [ ] **Step 2: Run → fail** (`buildClient` doesn't call `setLogger` yet). `npx vitest run packages/core/src/client-factory.test.ts`.

- [ ] **Step 3: Implement** — in `client-factory.ts`'s `buildClient`, add the `setLogger` call right after the logger is resolved and before the `await chain.getQueryClient()` (so the first LCD build routes its warn through `ctx.logger`):

```ts
    const logger = opts.logger ?? noopLogger;
    chain.setLogger(logger); // route the manager's 2 init diagnostics to the per-ctx logger (OI-LOG)
    // Await the query client ONCE so ctx.query is concrete (the await-once-then-read Cosmos idiom).
    const query = await chain.getQueryClient();
```

- [ ] **Step 4: Run → pass.** `npx vitest run packages/core/src/client-factory.test.ts` (all green). `(cd packages/core && npm run lint)` exit 0.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/client-factory.ts packages/core/src/client-factory.test.ts
git add packages/core/src/client-factory.ts packages/core/src/client-factory.test.ts
git commit -m "feat(core): createManifestClient injects ctx.logger into the manager (OI-LOG SDK path) (ENG-309)"
```

---

## Task 4: Full gate

- [ ] From the worktree root:
  - `npm run build` (8 packages, exit 0)
  - **`npm run lint` (ALL packages, exit 0)** — confirm no ripple (the only signature change, `createLCDQueryClient`'s optional trailing param, is backward-compatible; the public barrel export is unchanged in arity for existing callers)
  - `npx vitest run packages/` (all pass — client/lcd-adapter/client-factory suites green)
  - `npm run check` (biome, exit 0)
- [ ] All green ⇒ 4c-0 done. The 2 neutral-core warns now route through a per-instance `Logger`; the SDK path (`createManifestClient`) injects `ctx.logger`; the bare-`getInstance` CLI path defaults to silent (OI-LOG-DEFAULT follow-up flagged).

---

## Self-Review (completed)

- **Spec coverage (§5.3):** the 2 singleton `logger.warn` sites now route through a per-instance injectable `Logger` (silent `noopLogger` default) ✓; `createManifestClient` injects `ctx.logger` ✓. The singleton stays CLI-internal (no neutral-core `console` reference on the SDK path).
- **Non-key / non-invalidating:** `setLogger` is a pure reference mutation, not in the `getInstance` key or the invalidation gate (pinned by the Task 1 test).
- **~Zero ripple:** only `client.ts`/`lcd-adapter.ts`/`client-factory.ts` + their tests; `createLCDQueryClient`'s new param is optional (barrel + 1-arg callers unaffected); no other package touched (confirmed by the full-repo lint gate).
- **Transitional CLI silence (OI-LOG-DEFAULT):** documented + follow-up flagged; **observability-only** regression on the un-migrated bare-`getInstance` CLI/server path (incl. the cosmwasm server's wasm-LCD diagnostic) — behavior unchanged (2 rare init diagnostics, no control-flow effect).

## Next plan

→ **Plan 4c-reads:** ctx-ify `getBalance`/`resolveSku`/`listSkuCandidates` + EXTRACT the ~7 new ctx-shaped read free fns (`getLease`/`getLeasesByTenant`/`getLeaseByCustomDomain`/`getSKUs`/`getProviders`/`getBillingParams`/`getWithdrawableAmount`) from the lease-server inline bodies; brand returned ids via `as*` (brand-on-extraction, locked); thread `CallOptions`; convert the lease-server read handlers + the fred/agent-core read call sites to thin callers. Then **4c-txs** (ctx-ify `fundCredits`/`setItemCustomDomain`/`stopApp` + `TxCallOptions` broadcast threading). `getLeaseConnectionInfo` + the other fred provider ops stay positional (P2) — the e2e connection step is stubbed (walking-skeleton).
