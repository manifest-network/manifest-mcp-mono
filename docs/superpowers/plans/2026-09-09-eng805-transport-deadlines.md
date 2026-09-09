# ENG-805 transport-owned deadlines

Baseline: `0036f1823ee59126015c6cc4137f2453dc2f3a49`.
Branch: `codex/eng-805-transport-deadlines`.
Owner: [ENG-805](https://linear.app/liftedinit/issue/ENG-805).

## Problem and scope

An idempotent read with a fresh deadline per attempt can miss a configured retry
when a native `TimeoutError` is wrapped without preserving deadline ownership.
Broadening the timeout message matcher cannot distinguish that failure from a
caller cancellation or an expired budget for the entire operation. PR #224
already fixed identity-specific normalization; this follow-up preserves the
evidence structurally and covers the faucet status read. It does not change
faucet credit POSTs, introduce automatic faucet retries, or authorize replay of
transactions and recovery flows.

## Contract and design

- Export `TransportErrorDetails` with `transportCode?: 'ETIMEDOUT'`. Carry it on
  existing `ManifestMCPError` categories `QUERY_FAILED` and
  `RPC_CONNECTION_FAILED`; do not add an error category or classify by prose.
- Identity requests and faucet `GET /status` own a fresh per-attempt signal.
  Verify that their transport failed because that signal timed out before
  adding the marker, including during response-body reads. An elapsed signal
  alone cannot replace an unrelated failure or an established HTTP/validation
  verdict. Preserve causes when wrapping.
- Inspect the cause chain before authorizing retry. Permanent HTTP/gRPC verdicts,
  permanent errors, partial outcomes and submitted
  transactions veto a marker or transient outer message. A native
  `TimeoutError`/`AbortError` with unknown ownership is not automatically
  retryable, including when hidden behind transient prose.
- Add `RetryOptions.signal` and the optional `{ signal }` argument to
  `isRetryableError`. An aborted overall signal makes classification terminal,
  prevents later attempts and interrupts backoff. Preserve established
  operation outcomes. The callback must pass the signal to its transport;
  `withRetry` must not race opaque in-flight callbacks or discard success.
- Keep one retry owner per operation. The public example wraps only
  `fetchFaucetStatus`, combining its supplied attempt signal with the caller's
  overall signal in an injected fetch. The faucet helper gains no retry loop.
- Re-export `withRetry` and `isRetryableError` from the SDK root so applications
  use the SDK's pinned core dependency for both retry helpers and error producers.

Retain the existing backoff loop. A package such as `p-retry` could supply retry
mechanics but cannot determine who owns a deadline, whether a mutation was
submitted, or which wrapped verdict is authoritative. The required policy and
transport evidence would remain, so no dependency is justified for this scope.

## Implementation and validation

1. Add the public details type and shared internal cause/owned-timeout handling.
   Update retry classification and add abort-aware attempt/backoff boundaries.
2. Preserve owned deadline evidence in identity and faucet status transports,
   through both fetch and response consumption. Keep credit POST behavior and
   successful results unchanged.
3. Add no-network regressions for owned fetch/body timeouts, wrapped native
   aborts, unknown deadlines, nested permanent/status verdicts, partial/sent
   exclusions, unrelated late failures, and exhausted retry budgets. Prove that
   caller cancellation stops initial/later attempts and backoff while an
   opaque callback's successful result is retained. Keep PR #224 regressions
   green and test actual injected transport boundaries.
4. Verify public type exports and the documented faucet composition, then run
   focused tests and core TypeScript. After integration, run the relevant full
   suite, workspace checks, build/package and unchanged bundle guards. Record
   actual results in the [implementation record](../../eng805-remediation.md).

## Progress

- [x] Record the ownership contract, implementation boundaries and public example.
- [x] Complete runtime implementation and independent review.
- [x] Run focused regressions and compiler checks; record exact results.
- [x] Complete integrated local validation and record the results.

Local validation passes: 254 focused tests, 3,747 full-suite tests, all coverage
thresholds, workspace/E2E compiler checks, package integrity and unchanged bundle
budgets. The pre-fix classifier fails 15/19 ownership cases in the negative
control; independent review found no concrete blocker (98% confidence).
The initial PR #225 head `bf5a7e2` passed all CI checks, including live SDK
acceptance. The review amendment adds SDK value exports, producer type checks,
nested timeout regressions and precise status-precedence documentation; see the
implementation record for its validation and the retained HTTP 408/425 policy work.
Keep ENG-805's broader retained scope open; these changes are not a package release.
