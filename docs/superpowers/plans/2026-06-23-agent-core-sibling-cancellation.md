# agent-core sibling-orchestrator cancellation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `signal?`/`timeout?` cancellation contract that `manageDomain`, `closeLease`, and `troubleshootDeployment` advertise actually work, by routing all four agent-core orchestrators through one shared cancellation seam.

**Architecture:** Extract `deployApp`'s inline cancellation seam (`raceAbort` + `cancelledError` + the per-call `signal`/`throwIfCancelled`/`race` closure) into a new `packages/agent-core/src/internals/cancellation.ts` as the single source of truth (`raceAbort(promise, signal, makeError)`, `cancelledError(reason, opLabel, broadcasts)`, `makeCancellationScope({...}) → { signal, throwIfCancelled, race }`). `deployApp` adopts it (message preserved byte-identical). The two broadcasting siblings race their pre-broadcast `onConfirm`; the two read-only flows race their single query for `withReadSignal` parity. D4.6 discipline: never race a post-broadcast await.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest (+ fake timers), biome, tsdown. Spec: `docs/superpowers/specs/2026-06-22-agent-core-sibling-cancellation-design.md` (ENG-374).

**Reference (read once before starting):** the current inline seam at `packages/agent-core/src/deploy-app.ts:160-199` and the two standalone fns `raceAbort`/`cancelledError` at `deploy-app.ts:~928-974`. The new module is a faithful move of those, with the error constructor injected and the message parameterized.

---

## File Structure

- **Create** `packages/agent-core/src/internals/cancellation.ts` — the shared seam (`raceAbort`, `cancelledError`, `makeCancellationScope`, `CancellationScope`). Imports `ManifestMCPError`/`ManifestMCPErrorCode`/`resolveCallSignal` from core and `ProgressEvent` from `../types.js`.
- **Create** `packages/agent-core/src/internals/cancellation.test.ts` — unit tests for the seam.
- **Modify** `packages/agent-core/src/deploy-app.ts` — adopt `makeCancellationScope`; delete the two standalone fns; drop the now-unused `resolveCallSignal` import.
- **Modify** `packages/agent-core/src/close-lease.ts` + `close-lease.test.ts` — wire + test.
- **Modify** `packages/agent-core/src/manage-domain.ts` + `manage-domain.test.ts` — wire set/clear (race onConfirm) + lookup (race query) + test.
- **Modify** `packages/agent-core/src/troubleshoot.ts` + `troubleshoot.test.ts` — wire (race query) + test.
- **Modify** `CHANGELOG.md` — `## [Unreleased]` bugfix note.

---

## Task 1: Shared cancellation seam (`internals/cancellation.ts`)

**Files:**
- Create: `packages/agent-core/src/internals/cancellation.ts`
- Test: `packages/agent-core/src/internals/cancellation.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/agent-core/src/internals/cancellation.test.ts`:

```ts
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../types.js';
import {
  cancelledError,
  makeCancellationScope,
  raceAbort,
} from './cancellation.js';

function recorder(): {
  events: ProgressEvent[];
  onProgress: (e: ProgressEvent) => void;
} {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}
const cancelledCount = (events: ProgressEvent[]): number =>
  events.filter((e) => e.kind === 'cancelled').length;

describe('cancelledError', () => {
  it('broadcasts:true is byte-identical to the deployApp pre-broadcast message', () => {
    const err = cancelledError(new Error('aborted by caller'), 'Deployment', true);
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expect(err.message).toBe(
      'Deployment was cancelled before broadcast (aborted by caller); no transaction was sent.',
    );
  });

  it('broadcasts:false drops the broadcast clause for read-only flows', () => {
    const err = cancelledError(new Error('timeout'), 'Troubleshoot', false);
    expect(err.message).toBe('Troubleshoot was cancelled (timeout).');
  });

  it('stringifies a non-Error reason', () => {
    expect(cancelledError('boom', 'Lease close', true).message).toBe(
      'Lease close was cancelled before broadcast (boom); no transaction was sent.',
    );
  });
});

describe('raceAbort', () => {
  const makeError = (r: unknown) => cancelledError(r, 'Op', true);

  it('rejects with the injected error on an already-aborted signal and swallows the loser', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    let resolveLoser: (v: string) => void = () => {};
    const loser = new Promise<string>((res) => {
      resolveLoser = res;
    });
    await expect(raceAbort(loser, ac.signal, makeError)).rejects.toThrow(/Op was cancelled/);
    resolveLoser('late'); // settles after — must not surface an unhandled rejection
  });

  it('rejects on a later abort', async () => {
    const ac = new AbortController();
    const never = new Promise<string>(() => {});
    const raced = raceAbort(never, ac.signal, makeError);
    ac.abort(new Error('mid-flight'));
    await expect(raced).rejects.toThrow(/mid-flight/);
  });

  it('resolves with the winner when the promise settles first', async () => {
    const ac = new AbortController();
    await expect(raceAbort(Promise.resolve('ok'), ac.signal, makeError)).resolves.toBe('ok');
  });
});

describe('makeCancellationScope', () => {
  it('throwIfCancelled on a pre-aborted signal throws and emits cancelled exactly once', () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({ opts: { signal: ac.signal }, onProgress, opLabel: 'Op', broadcasts: true });
    expect(() => cx.throwIfCancelled()).toThrow(ManifestMCPError);
    expect(() => cx.throwIfCancelled()).toThrow(ManifestMCPError); // 2nd call: no re-emit
    expect(cancelledCount(events)).toBe(1);
  });

  it('no signal → race is a passthrough and throwIfCancelled is a no-op', async () => {
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({ opts: {}, onProgress, opLabel: 'Op', broadcasts: false });
    expect(cx.signal).toBeUndefined();
    expect(() => cx.throwIfCancelled()).not.toThrow();
    await expect(cx.race(Promise.resolve(42))).resolves.toBe(42);
    expect(events).toHaveLength(0);
  });

  it('race rejects + emits cancelled once when the signal aborts mid-await (loser swallowed)', async () => {
    const ac = new AbortController();
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({ opts: { signal: ac.signal }, onProgress, opLabel: 'Op', broadcasts: false });
    let rejectLoser: (e: unknown) => void = () => {};
    const loser = new Promise<string>((_res, rej) => {
      rejectLoser = rej;
    });
    const raced = cx.race(loser);
    ac.abort(new Error('mid'));
    await expect(raced).rejects.toThrow(/Op was cancelled/);
    rejectLoser(new Error('late-loser')); // must be swallowed
    await Promise.resolve();
    expect(cancelledCount(events)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/agent-core/src/internals/cancellation.test.ts`
Expected: FAIL — `Failed to resolve import "./cancellation.js"` (module does not exist yet).

- [ ] **Step 3: Implement the module**

Create `packages/agent-core/src/internals/cancellation.ts`:

```ts
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  resolveCallSignal,
} from '@manifest-network/manifest-mcp-core';
import type { ProgressEvent } from '../types.js';

/**
 * Build the structured cancellation error for an aborted/timed-out PRE-broadcast
 * await (or a stopped-awaiting read). `OPERATION_CANCELLED` is non-retryable and
 * keeps the abort path consistent with the SDK error model; the original
 * `AbortError`/`TimeoutError` reason is preserved in the message + details.
 *
 * - `broadcasts: true`  → mutating flows (deploy / domain-set / lease-close):
 *   the abort happened before any tx was sent.
 * - `broadcasts: false` → read-only flows (troubleshoot / domain-lookup): there
 *   is no broadcast to reference; we merely stopped awaiting the query.
 */
export function cancelledError(
  reason: unknown,
  opLabel: string,
  broadcasts: boolean,
): ManifestMCPError {
  const detail = reason instanceof Error ? reason.message : String(reason);
  const message = broadcasts
    ? `${opLabel} was cancelled before broadcast (${detail}); no transaction was sent.`
    : `${opLabel} was cancelled (${detail}).`;
  return new ManifestMCPError(ManifestMCPErrorCode.OPERATION_CANCELLED, message, {
    reason,
  });
}

/**
 * Race a pending promise against an `AbortSignal`. Copies the executor + swallow
 * shape from core's `internals/tx-confirmation.ts:withTxConfirmation`: the losing
 * branch's eventual rejection is swallowed (no unhandled rejection) and the abort
 * listener is added `{ once: true }` and removed in `.finally`. The rejection
 * error is produced by the injected `makeError`, so the primitive stays
 * operation-agnostic. Manifestjs queries take no `AbortSignal`, so for read-only
 * callers this does NOT cancel the RPC — it only stops AWAITING it.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: (reason: unknown) => ManifestMCPError,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {}); // swallow the loser even on the already-aborted path
    return Promise.reject(makeError(signal.reason));
  }
  promise.catch(() => {}); // swallow the losing branch's eventual rejection
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(makeError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Per-call cancellation seam shared by all four agent-core orchestrators. */
export interface CancellationScope {
  /** Effective signal (caller `signal` composed with `timeout`), or `undefined`. */
  signal: AbortSignal | undefined;
  /** Throw `OPERATION_CANCELLED` (emitting `cancelled` once) if already aborted. */
  throwIfCancelled: () => void;
  /**
   * Race a pre-broadcast callback or a read query against the signal. A no-op
   * passthrough when no signal is present. On abort it emits `cancelled` once
   * and throws `OPERATION_CANCELLED`.
   */
  race: <T>(p: Promise<T>) => Promise<T>;
}

/**
 * Build the per-call cancellation seam: captures the resolved signal, a once-guard
 * for the terminal `cancelled` progress event, and the operation label /
 * broadcast-ness for the error message. PURE at construction — call
 * `throwIfCancelled()` explicitly for the already-aborted short-circuit.
 */
export function makeCancellationScope(args: {
  opts: { signal?: AbortSignal; timeout?: number };
  onProgress: ((event: ProgressEvent) => void) | undefined;
  opLabel: string;
  broadcasts: boolean;
}): CancellationScope {
  const { opts, onProgress, opLabel, broadcasts } = args;
  const signal = resolveCallSignal(opts);
  const makeError = (reason: unknown): ManifestMCPError =>
    cancelledError(reason, opLabel, broadcasts);
  let cancelledEmitted = false;
  const cancelOnAbort = (reason: unknown): never => {
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      onProgress?.({ kind: 'cancelled' });
    }
    throw makeError(reason);
  };
  const throwIfCancelled = (): void => {
    if (signal?.aborted) cancelOnAbort(signal.reason);
  };
  const race = async <T>(p: Promise<T>): Promise<T> => {
    if (signal === undefined) return p;
    try {
      return await raceAbort(p, signal, makeError);
    } catch (err) {
      if (
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.OPERATION_CANCELLED &&
        signal.aborted
      ) {
        cancelOnAbort(signal.reason);
      }
      throw err;
    }
  };
  return { signal, throwIfCancelled, race };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/agent-core/src/internals/cancellation.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Add a composed-timeout case mirroring the existing deployApp test**

`deploy-app.test.ts` already has a composed `timeout` cancellation test that drives `resolveCallSignal`'s `AbortSignal.timeout` path under fake timers. Open it, search for `timeout` / `TimeoutError`, and mirror its fake-timer setup in a new `cancellation.test.ts` case asserting that `makeCancellationScope({ opts: { timeout: N } }).race(neverSettlingPromise)` rejects with `code: OPERATION_CANCELLED` after the timer advances. (Mirroring the existing, known-working setup avoids fake-timer/`AbortSignal.timeout` flakiness.)

Run: `npx vitest run packages/agent-core/src/internals/cancellation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/internals/cancellation.ts packages/agent-core/src/internals/cancellation.test.ts
git commit -m "feat(agent-core): shared cancellation seam in internals/cancellation.ts (ENG-374)"
```

---

## Task 2: `deployApp` adopts the shared seam (refactor, behavior-identical)

**Files:**
- Modify: `packages/agent-core/src/deploy-app.ts` (seam `160-199`; standalone fns `~928-974`; import block `40-55`)
- Test: `packages/agent-core/src/deploy-app.test.ts` (existing ENG-310 cancellation tests are the regression proof — do NOT change them)

- [ ] **Step 1: Add the import**

In the `from '@manifest-network/manifest-mcp-core'` import block (lines ~40-55), **remove** `resolveCallSignal,` (it is now used only inside `cancellation.ts`). Then add a new import after that block:

```ts
import { makeCancellationScope } from './internals/cancellation.js';
```

- [ ] **Step 2: Replace the inline seam**

Replace the inline seam block at `deploy-app.ts:160-199` (the long `// Per D4.6 …` comment through `const signal = resolveCallSignal(opts);` … the `race` closure … ending at `throwIfCancelled();`) with:

```ts
  // Cancellation seam (ENG-310 / D4, shared via internals/cancellation.ts — ENG-374).
  // Race ONLY pre-broadcast interactive callbacks (onResolveSku/onPlan/onConfirm);
  // post-broadcast awaits route into recovery (D4.6), never cancel. `signal` is
  // also forwarded into fred's DeployCallOptions below.
  const { signal, throwIfCancelled, race } = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Deployment',
    broadcasts: true,
  });
  throwIfCancelled();
```

The downstream uses are unchanged: `race(callbacks.onResolveSku(...))` (~296), `race(callbacks.onPlan(...))` (~408), `race(callbacks.onConfirm(...))` (~546), `throwIfCancelled()` before broadcast (~594), and `{ abortSignal: signal }` forwarded to fred (~620).

- [ ] **Step 3: Delete the two standalone functions**

Delete the `raceAbort` function (and its JSDoc) and the `cancelledError` function (and its JSDoc) — currently `deploy-app.ts:~928-974`, immediately before `function primaryImage(...)`. They now live in `internals/cancellation.ts`. (Confirm with `grep -n "function raceAbort\|function cancelledError" packages/agent-core/src/deploy-app.ts` → no matches after deletion.)

- [ ] **Step 4: Run the existing deployApp tests (regression proof)**

Run: `npx vitest run packages/agent-core/src/deploy-app.test.ts`
Expected: PASS — all existing ENG-310 cancellation tests (pre-broadcast abort → `OPERATION_CANCELLED` + no lease + `cancelled` event; abort-during-pending-`onConfirm`; composed timeout) stay green. This proves the extraction preserved behavior. The message is now additionally pinned by `cancellation.test.ts` (Task 1).

- [ ] **Step 5: Lint the file**

Run: `npx tsc --noEmit -p packages/agent-core/tsconfig.json` and `npx biome check packages/agent-core/src/deploy-app.ts`
Expected: both clean (no unused `resolveCallSignal`, no dangling references).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/deploy-app.ts
git commit -m "refactor(agent-core): deployApp adopts the shared cancellation seam (ENG-374)"
```

---

## Task 3: Wire `closeLease`

**Files:**
- Modify: `packages/agent-core/src/close-lease.ts` (entry `~86`; `onConfirm` `~91-92`; `stopApp` `~104`)
- Test: `packages/agent-core/src/close-lease.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `close-lease.test.ts` (reuse the file's existing helpers: the `vi.mock(...core...)` with `stopApp: vi.fn()`, `makeMockClientManager`, `makeMockQueryClient`, and `import * as core` or `vi.mocked(core.stopApp)`). Add a `describe('cancellation (ENG-374)', ...)`:

```ts
it('a pre-aborted signal throws OPERATION_CANCELLED and never broadcasts', async () => {
  const ac = new AbortController();
  ac.abort(new Error('user aborted'));
  const events: ProgressEvent[] = [];
  const onConfirm = vi.fn(async () => 'yes' as const);
  const clientManager = makeMockClientManager(makeMockQueryClient());
  await expect(
    closeLease(
      { leaseUuid: VALID_LEASE_UUID },
      { onConfirm, onProgress: (e) => events.push(e) },
      { clientManager: clientManager as never, signal: ac.signal },
    ),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
  expect(core.stopApp).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
});

it('aborting while onConfirm is pending rejects with OPERATION_CANCELLED and never broadcasts', async () => {
  const ac = new AbortController();
  let rejectConfirm: (e: unknown) => void = () => {};
  const onConfirm = vi.fn(
    () => new Promise<'yes' | 'no'>((_res, rej) => {
      rejectConfirm = rej;
    }),
  );
  const clientManager = makeMockClientManager(makeMockQueryClient());
  const p = closeLease(
    { leaseUuid: VALID_LEASE_UUID },
    { onConfirm },
    { clientManager: clientManager as never, signal: ac.signal },
  );
  ac.abort(new Error('mid-confirm'));
  await expect(p).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
  rejectConfirm(new Error('late-decline')); // swallowed, no unhandled rejection
  expect(core.stopApp).not.toHaveBeenCalled();
});
```

(If the file lacks a `VALID_LEASE_UUID` constant or a bare `import * as core`, add them next to the existing imports; reuse the file's own UUID fixture string if one exists.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/agent-core/src/close-lease.test.ts -t cancellation`
Expected: FAIL — today `closeLease` ignores `signal`, so `onConfirm` IS called (or `stopApp` runs), contradicting the assertions.

- [ ] **Step 3: Wire `closeLease`**

In `close-lease.ts`, add the import:

```ts
import { makeCancellationScope } from './internals/cancellation.js';
```

After `validateArgs(args);` (~line 89), build the scope and gate:

```ts
  const cx = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Lease close',
    broadcasts: true,
  });
  cx.throwIfCancelled();
```

Change the `onConfirm` await (~92) from `const yesNo = await callbacks.onConfirm(block);` to:

```ts
    const yesNo = await cx.race(callbacks.onConfirm(block));
```

Immediately before the `await stopApp(` broadcast (~104) add:

```ts
  cx.throwIfCancelled();
```

The post-broadcast verifier (`verifyAndRecover`) is left untouched (D4.6 — not raced).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/agent-core/src/close-lease.test.ts`
Expected: PASS (new cancellation cases + all existing close-lease tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/close-lease.ts packages/agent-core/src/close-lease.test.ts
git commit -m "feat(agent-core): closeLease honors signal/timeout (race pre-broadcast onConfirm) (ENG-374)"
```

---

## Task 4: Wire `manageDomain` (set/clear races `onConfirm`; lookup races the query)

**Files:**
- Modify: `packages/agent-core/src/manage-domain.ts` (set/clear: entry `~123`, `onConfirm` `~143-144`, `setItemCustomDomain` `~159`; `lookupDomain` helper: query `~378-382`, catch `~383+`)
- Test: `packages/agent-core/src/manage-domain.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a `describe('cancellation (ENG-374)', ...)` to `manage-domain.test.ts` (reuse the file's existing mock harness — `setItemCustomDomain: vi.fn()` in the core `vi.mock`, the mock clientManager/queryClient helpers, and `vi.mocked(core.setItemCustomDomain)`). The query mock for lookup is `queryClient.liftedinit.billing.v1.leaseByCustomDomain`:

```ts
it('set: a pre-aborted signal throws OPERATION_CANCELLED and never broadcasts', async () => {
  const ac = new AbortController();
  ac.abort(new Error('user aborted'));
  const onConfirm = vi.fn(async () => 'yes' as const);
  const clientManager = makeMockClientManager(makeMockQueryClient());
  await expect(
    manageDomain(
      { action: 'set', leaseUuid: VALID_LEASE_UUID, fqdn: 'app.example.com', serviceName: 'web' },
      { onConfirm },
      { clientManager: clientManager as never, signal: ac.signal },
    ),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
  expect(core.setItemCustomDomain).not.toHaveBeenCalled();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('lookup positive control: with no signal the query IS invoked and the result returns', async () => {
  const queryClient = makeMockQueryClient();
  queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockResolvedValue({ lease: null });
  const clientManager = makeMockClientManager(queryClient);
  const res = await manageDomain(
    { action: 'lookup', fqdn: 'app.example.com' },
    {},
    { clientManager: clientManager as never },
  );
  expect(queryClient.liftedinit.billing.v1.leaseByCustomDomain).toHaveBeenCalledTimes(1);
  expect(res).toMatchObject({ action: 'lookup', lease: null });
});

it('lookup: a pre-aborted signal throws OPERATION_CANCELLED and the query is NOT called', async () => {
  const ac = new AbortController();
  ac.abort(new Error('user aborted'));
  const queryClient = makeMockQueryClient();
  const onFailure = vi.fn(async () => {});
  const clientManager = makeMockClientManager(queryClient);
  await expect(
    manageDomain(
      { action: 'lookup', fqdn: 'app.example.com' },
      { onFailure },
      { clientManager: clientManager as never, signal: ac.signal },
    ),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
  expect(queryClient.liftedinit.billing.v1.leaseByCustomDomain).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled(); // cancellation is NOT a query failure
});
```

(Use the file's existing valid-UUID fixture and `makeMockQueryClient` shape; if the mock query client lacks `leaseByCustomDomain`, add it as a `vi.fn()` alongside `lease`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts -t cancellation`
Expected: FAIL — today `manageDomain`/`lookupDomain` ignore `signal` (set calls `onConfirm`; lookup calls the query and, on a thrown abort, `onFailure`).

- [ ] **Step 3: Wire the set/clear path**

In `manage-domain.ts`, add:

```ts
import { makeCancellationScope } from './internals/cancellation.js';
```

In the `manageDomain` body, AFTER the `if (args.action === 'lookup') return await lookupDomain(...)` dispatch and before/around the confirmation block (~line 140), build the scope and gate:

```ts
  const cx = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Domain update',
    broadcasts: true,
  });
  cx.throwIfCancelled();
```

Change the `onConfirm` await (~144) to:

```ts
    const yesNo = await cx.race(callbacks.onConfirm(block));
```

Immediately before `await setItemCustomDomain(` (~159) add:

```ts
  cx.throwIfCancelled();
```

The post-broadcast verifier closure is left untouched (D4.6).

- [ ] **Step 4: Wire the `lookupDomain` read-only path**

`lookupDomain(fqdn, callbacks, opts)` builds the scope and races the single query. At the top of `lookupDomain` (before the `try`), add:

```ts
  const cx = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Domain lookup',
    broadcasts: false,
  });
  cx.throwIfCancelled();
```

Wrap the query call (~380) with `cx.race(...)`:

```ts
    result = await cx.race(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain({ customDomain }),
    );
```

In the `catch (err)` block, short-circuit cancellation BEFORE the not-found / `onFailure` handling (cancellation is neither a "not found" nor a failure). Add as the first lines of the catch:

```ts
    if (
      err instanceof ManifestMCPError &&
      err.code === ManifestMCPErrorCode.OPERATION_CANCELLED
    ) {
      throw err;
    }
```

(`ManifestMCPError`/`ManifestMCPErrorCode` are already imported in `manage-domain.ts`.)

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts`
Expected: PASS (new cancellation cases + all existing manage-domain tests, including the existing lookup not-found/failure paths which still reach `onFailure`).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/manage-domain.ts packages/agent-core/src/manage-domain.test.ts
git commit -m "feat(agent-core): manageDomain honors signal/timeout (race onConfirm + lookup query) (ENG-374)"
```

---

## Task 5: Wire `troubleshootDeployment` (read-only — race the query)

**Files:**
- Modify: `packages/agent-core/src/troubleshoot.ts` (entry `~70`; query `~80-83`; catch `~85+`)
- Test: `packages/agent-core/src/troubleshoot.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a `describe('cancellation (ENG-374)', ...)` to `troubleshoot.test.ts` (reuse its mock harness — the mock clientManager/queryClient; the diagnostic query mock is `queryClient.liftedinit.billing.v1.lease`):

```ts
it('positive control: with no signal the diagnostic query IS invoked and a report returns', async () => {
  const queryClient = makeMockQueryClient();
  queryClient.liftedinit.billing.v1.lease.mockResolvedValue({ lease: SOME_LEASE_PAYLOAD });
  const clientManager = makeMockClientManager(queryClient);
  const report = await troubleshootDeployment(
    { leaseUuid: VALID_LEASE_UUID },
    {},
    { clientManager: clientManager as never },
  );
  expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(1);
  expect(report.markdown).toContain(VALID_LEASE_UUID);
});

it('a pre-aborted signal throws OPERATION_CANCELLED and the query is NOT called', async () => {
  const ac = new AbortController();
  ac.abort(new Error('user aborted'));
  const queryClient = makeMockQueryClient();
  const onFailure = vi.fn(async () => {});
  const clientManager = makeMockClientManager(queryClient);
  await expect(
    troubleshootDeployment(
      { leaseUuid: VALID_LEASE_UUID },
      { onFailure },
      { clientManager: clientManager as never, signal: ac.signal },
    ),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
  expect(queryClient.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled(); // cancellation is NOT a query failure
});
```

(Use the file's existing valid-UUID fixture and a realistic `lease` payload fixture for the positive control — reuse whatever the existing success-path test already uses.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/agent-core/src/troubleshoot.test.ts -t cancellation`
Expected: FAIL — today `troubleshootDeployment` ignores `signal`; on a thrown abort it would route through `onFailure` + `QUERY_FAILED`.

- [ ] **Step 3: Wire `troubleshootDeployment`**

In `troubleshoot.ts`, add:

```ts
import { makeCancellationScope } from './internals/cancellation.js';
```

After `validateArgs(args);` (~line 70), build the scope and gate:

```ts
  const cx = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Troubleshoot',
    broadcasts: false,
  });
  cx.throwIfCancelled();
```

Wrap the diagnostic query (~82) with `cx.race(...)`:

```ts
    const result = await cx.race(
      queryClient.liftedinit.billing.v1.lease({ leaseUuid: args.leaseUuid }),
    );
```

In the `catch (err)` block, short-circuit cancellation BEFORE the `onFailure` + `QUERY_FAILED` handling. Add as the first lines of the catch:

```ts
    if (
      err instanceof ManifestMCPError &&
      err.code === ManifestMCPErrorCode.OPERATION_CANCELLED
    ) {
      throw err;
    }
```

(`ManifestMCPError`/`ManifestMCPErrorCode` are already imported in `troubleshoot.ts`.)

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/agent-core/src/troubleshoot.test.ts`
Expected: PASS (new cancellation cases + all existing troubleshoot tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/troubleshoot.ts packages/agent-core/src/troubleshoot.test.ts
git commit -m "feat(agent-core): troubleshootDeployment honors signal/timeout (race the query) (ENG-374)"
```

---

## Task 6: CHANGELOG + full-repo gate

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the CHANGELOG note**

Under `## [Unreleased]` (add the heading if absent), add a Fixed entry:

```markdown
### Fixed

- **agent-core:** `manageDomain`, `closeLease`, and `troubleshootDeployment` now honor the `signal`/`timeout` options they already declared (previously silently ignored). Cancellation races the pre-broadcast `onConfirm` for the mutating flows and the single read query for the read-only flows; post-broadcast awaits are never cancelled (D4.6). (ENG-374)
```

- [ ] **Step 2: Commit the CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(agent-core): CHANGELOG — siblings honor signal/timeout (ENG-374)"
```

- [ ] **Step 3: Run the full-repo gate**

```bash
npm run build && npm run lint && npm run test && npm run check && npm run depcruise
```

Expected: all exit 0. (`npm run test` includes agent-core's `vitest --typecheck`.) If `npm run size` is part of the standard gate in this repo, run it too. Fix any failure in the relevant task's file and re-run before proceeding.

- [ ] **Step 4: Hand off**

Do NOT push or open a PR here — the controller runs `superpowers:finishing-a-development-branch` (push `agent-core-sibling-cancellation` + open the PR for the user to merge).

---

## Self-Review

**Spec coverage:**
- Shared `internals/cancellation.ts` (`raceAbort` + parameterized `cancelledError` + `makeCancellationScope`) → Task 1. ✓
- deployApp adopts (message byte-identical; ENG-310 tests are the regression proof) → Task 2. ✓
- closeLease + manageDomain set/clear race pre-broadcast `onConfirm` → Tasks 3, 4. ✓
- troubleshoot + manageDomain lookup race the single query (withReadSignal parity) → Tasks 4, 5. ✓
- D4.6: post-broadcast verifiers untouched → Tasks 2-4. ✓
- Message pin (both variants) + once-guard + makeError injection in `cancellation.test.ts` → Task 1. ✓
- Read-only test non-vacuity (positive control + query-NOT-called) → Tasks 4, 5. ✓
- Cancellation must not invoke `onFailure` in read-only flows (the catch short-circuit) → Tasks 4, 5. ✓
- CHANGELOG + full gate → Task 6. ✓
- ENG-374 traceability → commit scopes + CHANGELOG. ✓

**Type consistency:** `makeCancellationScope({ opts, onProgress, opLabel, broadcasts }) → { signal, throwIfCancelled, race }`, `raceAbort(promise, signal, makeError)`, `cancelledError(reason, opLabel, broadcasts)` — used identically in every task. All four callbacks expose `onProgress?: (e: ProgressEvent) => void`; `ProgressEvent` includes `{ kind: 'cancelled' }`. `resolveCallSignal` is imported into `cancellation.ts` and removed from `deploy-app.ts`.

**Deferred (out of scope, per spec):** the ~790-line `deployApp` decomposition; threading `TxCallOptions.signal` into the broadcast tx; elicitation-requestId cancellation.
