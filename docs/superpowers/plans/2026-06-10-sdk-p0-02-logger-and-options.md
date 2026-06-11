# SDK P0 — Plan 2: Logger port + per-call options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the silent-by-default injectable **`Logger` port** (`noopLogger`) and the per-call **option-bag types** (`CallOptions`, `TxCallOptions`) + the `signal`+`timeout` merge helper (`resolveCallSignal`) to `@manifest-network/manifest-mcp-core` — the `ctx` ports + the options threaded through every typed building block in later plans.

**Architecture:** Add the `Logger` interface + frozen `noopLogger` to the existing `core/src/logger.ts` (the existing module-global `logger` singleton stays as the **internal** CLI/server logger; the new `Logger` port is the **public injectable** interface — structurally compatible, so the node bootstrap can adapt the singleton later). Add a new `core/src/options.ts` for `CallOptions`/`TxCallOptions` + `resolveCallSignal`. All dependency-light: `StdFee` is a **type-only** import (erased at build), so no `@cosmjs/stargate` runtime dep enters this foundational module.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest 4, `tsc --noEmit` lint, Biome. Node ≥20 (for `AbortSignal.any`). Spec: §5.2/§5.3. Issue: ENG-309. Builds on Plan 1.

**Re-scope note:** the original "Plan 2" bundled the canonical-types chokepoint; that is now **Plan 3** (it is a cross-package refactor — relocating `fred`'s `DeployAppInput`/`DeployAppResult`/etc. into `core` forces a decision about the `PollOptions`/`ConnectionDetails` supporting types those reference, plus a branding ripple into `fred`'s producers). This plan is the clean, dependency-free Logger + options work.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/logger.ts` (modify) | Add the public `Logger` interface + frozen `noopLogger`. Keep the existing `logger` singleton + `LogLevel` + `parseLogLevel` unchanged. |
| `packages/core/src/logger.test.ts` (create/append) | `noopLogger` emits nothing + is structurally a `Logger`; the existing `logger` singleton is assignable to `Logger`. |
| `packages/core/src/options.ts` (create) | `CallOptions`, `TxCallOptions`, and `resolveCallSignal(opts)` (merges `signal` + `timeout` via `AbortSignal.any`). |
| `packages/core/src/options.test.ts` (create) | `resolveCallSignal` cases (none/signal-only/timeout-only/both; TimeoutError vs AbortError). |
| `packages/core/src/index.ts` (modify) | Re-export `Logger`, `noopLogger`, `CallOptions`, `TxCallOptions`, `resolveCallSignal`. |

---

## Task 0: Confirm baseline

- [ ] Run (from the worktree root) `npm run build && npx vitest run packages/core` → green (Plan 1 already merged; ~799 tests). `node_modules` already installed.

---

## Task 1: The `Logger` port + `noopLogger`

**Files:** Modify `packages/core/src/logger.ts`. Test: `packages/core/src/logger.test.ts`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/logger.test.ts` (create; if it exists, append + reuse imports):

```ts
import { describe, expect, it, vi } from 'vitest';
import { logger, noopLogger, type Logger } from './logger.js';

describe('noopLogger', () => {
  it('emits nothing (silent by default) and never throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    noopLogger.debug('x');
    noopLogger.info('x');
    noopLogger.warn('x');
    noopLogger.error('x');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('is frozen', () => {
    expect(Object.isFrozen(noopLogger)).toBe(true);
  });
  it('satisfies the Logger interface structurally', () => {
    const l: Logger = noopLogger; // compile-time: noopLogger IS a Logger
    expect(typeof l.debug).toBe('function');
  });
  it('the existing logger singleton is assignable to Logger (adapter-free)', () => {
    const l: Logger = logger; // compile-time: the singleton has debug/info/warn/error
    expect(typeof l.warn).toBe('function');
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run packages/core/src/logger.test.ts` → FAIL (`noopLogger`/`Logger` not exported).

- [ ] **Step 3: Implement.** Append to `packages/core/src/logger.ts` (do NOT change the existing `logger`/`LogLevel`/`parseLogLevel`):

```ts
/**
 * Public, injectable logging port for SDK consumers. STRUCTURAL — compatible with
 * `console`, pino, winston, tslog, and `@smithy/types` Logger. `trace` is optional;
 * SDK code calls it only via `ctx.logger.trace?.(…)`. The SDK applies its own level
 * gate before dispatching; the sink is this injected logger. Per-instance, never
 * process-global (unlike the internal `logger` singleton above).
 */
export interface Logger {
  trace?(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Silent default: emits nothing, allocation-free, frozen, isomorphic (no console/process). */
export const noopLogger: Logger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
```

- [ ] **Step 4: Run → pass.** `npx vitest run packages/core/src/logger.test.ts` → PASS.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/logger.ts packages/core/src/logger.test.ts
git add packages/core/src/logger.ts packages/core/src/logger.test.ts
git commit -m "feat(core): add silent-by-default injectable Logger port (ENG-309)"
```

---

## Task 2: `CallOptions` / `TxCallOptions` + `resolveCallSignal`

**Files:** Create `packages/core/src/options.ts`. Test: `packages/core/src/options.test.ts`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveCallSignal } from './options.js';

describe('resolveCallSignal', () => {
  it('returns undefined when neither signal nor timeout is given', () => {
    expect(resolveCallSignal(undefined)).toBeUndefined();
    expect(resolveCallSignal({})).toBeUndefined();
  });
  it('returns the caller signal verbatim when only signal is given', () => {
    const ac = new AbortController();
    expect(resolveCallSignal({ signal: ac.signal })).toBe(ac.signal);
  });
  it('returns a signal that aborts with a TimeoutError after the timeout', async () => {
    const sig = resolveCallSignal({ timeout: 5 });
    expect(sig).toBeDefined();
    expect(sig!.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(sig!.aborted).toBe(true);
    expect((sig!.reason as DOMException).name).toBe('TimeoutError');
  });
  it('combines signal + timeout: aborts (with AbortError) when the caller signal fires first', () => {
    const ac = new AbortController();
    const sig = resolveCallSignal({ signal: ac.signal, timeout: 10_000 });
    expect(sig).toBeDefined();
    ac.abort(new DOMException('cancelled', 'AbortError'));
    expect(sig!.aborted).toBe(true);
    expect((sig!.reason as DOMException).name).toBe('AbortError');
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run packages/core/src/options.test.ts` → FAIL (`options.js` missing).

- [ ] **Step 3: Implement `packages/core/src/options.ts`.**

```ts
import type { StdFee } from '@cosmjs/stargate'; // type-only: erased at build, no runtime dep

/** Per-call options for typed READ building blocks. */
export interface CallOptions {
  /** Caller cancellation. Composed with `timeout` via AbortSignal.any. */
  signal?: AbortSignal;
  /** Per-call deadline in ms. Surfaces as a TimeoutError (distinct from the caller's AbortError). */
  timeout?: number;
}

/**
 * Per-call options for typed TRANSACTION building blocks. Fee precedence: an explicit
 * `fee` WINS (skips simulation / `gasMultiplier` / configured gasPrice — and is the one
 * path valid WITHOUT a configured gasPrice). `gasMultiplier` applies only on the simulate
 * path. Passing both is a caller error. Per-call gasPrice is intentionally deferred
 * (cosmjs#1526 unresolved upstream) — use explicit `fee`.
 */
export interface TxCallOptions extends CallOptions {
  gasMultiplier?: number;
  fee?: StdFee;
  memo?: string;
}

/**
 * Merge a caller `signal` and a per-call `timeout` into one effective AbortSignal via
 * `AbortSignal.any`, so either source aborts the operation. A timeout abort reason is a
 * `TimeoutError` DOMException; a caller abort propagates the caller's reason — so callers
 * can distinguish "timed out" from "cancelled". Returns `undefined` when neither is set.
 */
export function resolveCallSignal(opts?: CallOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  if (opts?.timeout !== undefined) signals.push(AbortSignal.timeout(opts.timeout));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run packages/core/src/options.test.ts` → PASS. (If `AbortSignal.any`/`AbortSignal.timeout` are reported undefined, the Node version is < 20.3 — check `.nvmrc`; this is a hard requirement, report BLOCKED if the toolchain can't provide them.)

- [ ] **Step 5: Confirm `StdFee` import is type-only at build (no runtime dep leak).** After `npm run build`, run `grep -rn "stargate" packages/core/dist/options.js` → expected: EMPTY (a `import type` is erased, so the built JS has no `@cosmjs/stargate` import). If it is NOT empty, change the import to an explicit `import type { StdFee }` form and rebuild.

- [ ] **Step 6: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/options.ts packages/core/src/options.test.ts
git add packages/core/src/options.ts packages/core/src/options.test.ts
git commit -m "feat(core): add CallOptions/TxCallOptions + resolveCallSignal (ENG-309)"
```

---

## Task 3: Barrel export + full gate

**Files:** Modify `packages/core/src/index.ts`. Test: `packages/core/src/options.barrel.test.ts`.

- [ ] **Step 1: Failing test** — `packages/core/src/options.barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { noopLogger, resolveCallSignal } from './index.js';

describe('logger/options re-exported from the barrel', () => {
  it('exposes noopLogger + resolveCallSignal', () => {
    expect(typeof resolveCallSignal).toBe('function');
    expect(typeof noopLogger.debug).toBe('function');
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run packages/core/src/options.barrel.test.ts` → FAIL.

- [ ] **Step 3: Add re-exports to `packages/core/src/index.ts`.** The `logger`/`LogLevel`/`parseLogLevel` are likely already exported (check the existing `from './logger.js'` line and ADD `Logger`/`noopLogger` to it). Add a new export for options:

```ts
export { type CallOptions, type TxCallOptions, resolveCallSignal } from './options.js';
```

And ensure `Logger` (type) + `noopLogger` are exported from the existing `./logger.js` export (add them to that export list). Let Biome `--write` fix member ordering.

- [ ] **Step 4: Run → pass.** `npx vitest run packages/core/src/options.barrel.test.ts` → PASS.

- [ ] **Step 5: FULL GATE.**
  1. `npm run build` → "Build complete" (all 8 packages).
  2. `(cd packages/core && npm run lint)` → exit 0.
  3. `npx vitest run packages/core` → all pass (~807).
  4. `(cd packages/core && npx vitest --run --typecheck src/brands.test-d.ts)` → still 3 passed (regression check on Plan 1's type guard — run from `packages/core`, NOT root).
  5. `npx @biomejs/biome check packages/core/src/logger.ts packages/core/src/options.ts packages/core/src/index.ts` → exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/index.ts packages/core/src/options.barrel.test.ts
git commit -m "feat(core): export Logger port + option-bag types from the barrel (ENG-309)"
```

---

## Self-Review (completed)

- **Spec coverage (§5.2/§5.3):** `Logger` interface (trace optional + debug/info/warn/error) ✓; frozen silent `noopLogger` ✓; existing `logger` singleton kept as the internal CLI logger + shown assignable to `Logger` (adapter-free) ✓; `CallOptions { signal?, timeout? }` ✓; `TxCallOptions = CallOptions & { gasMultiplier?, fee?: StdFee, memo? }` with the fee-precedence + deferred-gasPrice contract in JSDoc ✓; `resolveCallSignal` doing the `AbortSignal.any([signal, AbortSignal.timeout(timeout)])` merge with TimeoutError-vs-AbortError distinction ✓; `StdFee` type-only (no runtime dep) ✓ (verified in Task 2 Step 5). The per-ctx wiring (`ctx.logger = opts.logger ?? noopLogger`) + the node-bootstrap adapter live in Plan 3 (`createManifestClient`).
- **Placeholders:** none.
- **Type/name consistency:** `Logger`/`noopLogger`/`CallOptions`/`TxCallOptions`/`resolveCallSignal` identical across modules, tests, and barrel.

## Next plan

→ **P0 Plan 3 (canonical types chokepoint):** relocate `fred`'s `DeployAppInput`/`ServiceConfig`/`BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult`/`DeployManifestInput`/`DeployAppResult` + the preview input + `FredLeaseStatus`/`ConnectionDetails`/`InstanceInfo` into `core/src/manifest-types.ts`; unify `SkuSelector` → `SkuIntent` (branded `SkuUuid`/`ProviderUuid`; **`size` is plain `string`** post-v7 scope-down, not `TierName`); brand the result id-fields via a producer trust-cast. **Fork RESOLVED (spec §5.1, commit `acebb27`): the data-vs-behavior split** — `core` owns DATA-ONLY canonical specs; the four runtime fields (`onLeaseCreated`/`abortSignal`/`pollOptions`/`gasMultiplier`) move to a fred-layer call-options bag so `PollOptions` (which carries an `AbortSignal`) stays in `fred` and the `core → fred/http` DAG inversion is avoided. `DeployResult` keeps snake_case (it is the MCP `outputSchema` wire DTO); `agent-core` keeps its camelCase projection with a mapping test.
