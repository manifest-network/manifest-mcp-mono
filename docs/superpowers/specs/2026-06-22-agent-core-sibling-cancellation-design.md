# agent-core sibling-orchestrator cancellation — design

**Status:** approved (2026-06-22)
**Branch:** `agent-core-sibling-cancellation` (off `main` @ 5fe7a0e)

## Goal

Make the `signal?`/`timeout?` cancellation contract that `manageDomain`, `closeLease`, and `troubleshootDeployment` *advertise* on their public Options types actually *work* — by routing all four agent-core orchestrators through one shared cancellation seam.

## Context — the finding

The post-P1 comprehensive review's single **important** finding: `ManageDomainOptions` / `CloseLeaseOptions` / `TroubleshootOptions` declare `signal?`/`timeout?` (`packages/agent-core/src/types.ts:170-198`, with `ENG-310 / D4` JSDoc promising the "core `CallOptions` convention"), but `manage-domain.ts` / `close-lease.ts` / `troubleshoot.ts` never read them (grep: zero `signal`/`resolveCallSignal`/`raceAbort` hits). All cancellation primitives live only in `deploy-app.ts`. So callers passing `signal`/`timeout` to those three get a **silent no-op** — a public-API over-promise. The design spec mandated this "for parity" (spec line 195) and §7 does **not** defer it. Not a hang risk (the bare `onConfirm` await is backstopped by `MANIFEST_AGENT_ELICIT_TIMEOUT_MS`), so it is important-on-API-honesty, not a primary-path defect.

## Idiom basis

- **Rule of Three / Single-Point-of-Truth.** With four consumers (deployApp + the three siblings) we are well past the rule-of-three threshold; the idiom is to "extract the common logic into a new function and replace **each** duplicated instance with a call to it." The abstraction is not premature — deployApp's seam is already battle-tested by the ENG-310 suite, so the shape is proven by four real uses. Leaving deployApp as a parallel copy would violate SPOT and recreate the divergence the review flagged.
- **Shared cancellation utility.** Factoring reusable abortable helpers into a shared module is standard (Azure SDK abort signals, ArcGIS `promiseUtils`, `abort-controller-x`: "build complex abortable functions without manually managing abort event listeners"; "reuse a single AbortSignal between many operations"). Our `raceAbort` is exactly that listener-lifecycle helper; the per-call scope is the "reuse one signal across the operation" pattern.

## Architecture

### New module: `packages/agent-core/src/internals/cancellation.ts`

The single source of truth, holding what is inline in `deploy-app.ts` today (moved, not copied):

- **`raceAbort<T>(promise, signal, makeError): Promise<T>`** — moved verbatim from `deploy-app.ts:941`. Swallows the losing branch's eventual rejection on both the already-aborted and racing paths; adds the `abort` listener `{ once: true }` and removes it in `.finally`. The only change from today: the error constructor is injected (`makeError(reason)`) instead of calling a module-private `cancelledError`, so the helper is operation-agnostic.
- **`cancelledError(reason, opLabel, broadcasts): ManifestMCPError`** — moved from `deploy-app.ts:963`, message parameterized:
  - `broadcasts === true` → `` `${opLabel} was cancelled before broadcast (${detail}); no transaction was sent.` ``
  - `broadcasts === false` → `` `${opLabel} was cancelled (${detail}).` `` (read-only flows — there is no broadcast to reference).
  - `detail = reason instanceof Error ? reason.message : String(reason)`. Code is `OPERATION_CANCELLED` (non-retryable), `details: { reason }`. **Invariant:** `cancelledError(r, 'Deployment', true)` is byte-identical to today's deployApp message, so the ENG-310 message assertions stay green.
- **`makeCancellationScope({ opts, onProgress, opLabel, broadcasts }): CancellationScope`** — captures the per-call seam:
  - `signal = resolveCallSignal(opts)` (core's `CallOptions` composition of `signal` + `timeout`).
  - a `cancelledEmitted` once-guard + `cancelOnAbort(reason)` that fires `onProgress?.({ kind: 'cancelled' })` exactly once, then `throw makeError(reason)` where `makeError = (r) => cancelledError(r, opLabel, broadcasts)`.
  - returns `{ signal, throwIfCancelled, race }`:
    - `throwIfCancelled()` → `if (signal?.aborted) cancelOnAbort(signal.reason)`.
    - `race<T>(p)` → if no signal, returns `p`; else `raceAbort(p, signal, makeError)`, mapping a surfaced `OPERATION_CANCELLED` back through `cancelOnAbort` when `signal.aborted` (so the `cancelled` event fires on a raced abort too).
  - **Pure at construction** — it does NOT auto-call `throwIfCancelled()`; callers invoke it explicitly (matching deployApp's current entry check), so behavior is unchanged.

```ts
export interface CancellationScope {
  signal: AbortSignal | undefined;
  throwIfCancelled(): void;
  race<T>(p: Promise<T>): Promise<T>;
}
```

### Consumers — D4.6 discipline preserved (race only PRE-broadcast, never post-broadcast)

- **`deployApp`** (`deploy-app.ts`) — replace the inline seam (`172-198`) with `const { signal, throwIfCancelled, race } = makeCancellationScope({ opts, onProgress: callbacks.onProgress, opLabel: 'Deployment', broadcasts: true })`; delete the standalone `raceAbort`/`cancelledError` (`941`/`963`) and import them from `./internals/cancellation.js`. Every other line — the `race(...)` callback wraps, the `throwIfCancelled()` at entry/`:594`, the `signal` forwarded into fred at `:620` — is unchanged. Behavior-identical; the ENG-310 suite is the regression proof.
- **`closeLease`** (`close-lease.ts`) — scope `opLabel: 'Lease close', broadcasts: true`; `throwIfCancelled()` at entry; `const yesNo = await race(callbacks.onConfirm(block))` (`:92`); `throwIfCancelled()` immediately before `stopApp` (`:105`). Post-broadcast `verifyAndRecover` not raced.
- **`manageDomain`** (`manage-domain.ts`) — branch-scoped:
  - set/clear (broadcasting): scope `opLabel: 'Domain update', broadcasts: true`; `throwIfCancelled()` at entry; `await race(callbacks.onConfirm(block))` (`:144`); `throwIfCancelled()` before `setItemCustomDomain` (`:159`). Post-broadcast verify (`:195`) not raced.
  - lookup (read-only): scope `opLabel: 'Domain lookup', broadcasts: false`; `throwIfCancelled()` at entry + before the query (`:379`). No `onConfirm` to race.
- **`troubleshootDeployment`** (`troubleshoot.ts`) — read-only scope `opLabel: 'Troubleshoot', broadcasts: false`; `throwIfCancelled()` at entry + before the diagnostic query (`:81`).

Read-only flows cannot interrupt an in-flight manifestjs query (it takes no `AbortSignal` — the same fire-and-forget honesty as core's `withReadSignal`); they check the signal at each async boundary instead.

## Error handling

One terminal cancellation outcome per flow: `ManifestMCPError(OPERATION_CANCELLED)` (non-retryable) with a flow-appropriate message, preceded by exactly one `onProgress({ kind: 'cancelled' })` emit. Deliberate-decline paths (`onConfirm` → `'no'`) keep their existing `OPERATION_CANCELLED` and do **not** route through `cancelOnAbort` (they are not aborts → no `cancelled` event), matching deployApp's existing distinction.

## Testing (TDD, RED first)

- **`internals/cancellation.test.ts`** (new) — units: `throwIfCancelled` on a pre-aborted signal throws `OPERATION_CANCELLED` and emits `cancelled` exactly once; `race` rejects on abort and swallows the loser (fake timers; vitest's global unhandled-rejection guard proves no leak); `timeout` composes (TimeoutError → OPERATION_CANCELLED); both `broadcasts` message variants; `makeError` injection wired through `raceAbort`.
- **`manage-domain.test.ts` / `close-lease.test.ts` / `troubleshoot.test.ts`** (new cases) — abort pre-`onConfirm` → `OPERATION_CANCELLED` + **broadcast fn never called** + `cancelled` event; abort during a pending `onConfirm` (late rejection swallowed) for the two broadcasting siblings; abort before the query for the read-only flows (troubleshoot, manage-domain lookup). These fail today (signal ignored), pass after wiring.
- **`deploy-app.test.ts`** — the existing ENG-310 cancellation tests must stay green unchanged: the regression proof that the extraction preserved behavior.

## Out of scope (stays deferred)

- The ~790-line `deployApp` decomposition (review minor finding #1) — separate P2 work.
- Threading `TxCallOptions.signal` *into* the broadcast tx (`setItemCustomDomain`/`stopApp`). The pre-broadcast `throwIfCancelled()` gate is the honest cancellation point; once a tx is submitted, D4.6 forbids cancelling it. Forwarding a signal into the on-chain broadcast is a P2 concern coupled to the tx-options threading.
- Elicitation-requestId-level cancellation in `packages/agent` (the only thing spec §7 actually defers).

## Gate

Full-repo `npm run lint` (the change is additive — the Options types already declare the fields, no public signature changes), `npm run build`, `npm run test` (incl. agent-core `--typecheck`), `npm run check`, `npm run depcruise`. CHANGELOG `## [Unreleased]` note: bugfix — `manageDomain`/`closeLease`/`troubleshootDeployment` now honor `signal`/`timeout` (previously silently ignored). Then a PR off `main` for the user to merge.
