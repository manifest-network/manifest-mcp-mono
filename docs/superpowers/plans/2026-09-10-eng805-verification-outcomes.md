# ENG-805: preserve mutation receipts on verification failure

Status: implemented and locally validated; ready for PR review.
Base: `7cc796a` (PR #226).

## Problem and scope

`manageDomain` set/clear and `closeLease` discard their successful core mutation
result. A later retryable verification error can make a caller's `withRetry`
repeat the entire orchestration. Regressions reproduce a second mutation-helper
invocation for HTTP 408, HTTP 503 and raw transient transport errors. This proves
unsafe replay authorization, not two accepted transactions or fees. Confidence:
100% in the observed behavior, 99% in the conditional SDK-composition finding.

## Design

- Retain the typed `SetItemCustomDomainResult` / `StopAppResult` and guard the
  complete subsequent verification and result-handling boundary with an internal
  agent-core helper.
- Fresh errors preserve existing SDK code/message/details and the original error
  in a non-enumerable cause chain. Never mutate upstream errors or details.
- Actual transaction receipts add `sent: true`, `transaction_hash`,
  `transaction_confirmed`, optional `transaction_code`, and `lease_uuid`.
  Domain receipts retain `service_name` / `custom_domain`; close receipts retain
  `stop_outcome` / `lease_state`. Receipt evidence overrides conflicting query
  details and precedes them for bounded MCP projection. Omit canonical receipt
  fields that this receipt does not supply; preserve foreign submission/partial
  evidence in the original cause, where it still vetoes retry.
- `already_inactive` preserves its outcome/state but adds no inferred sent/hash.
  It can also follow reconciliation after a broadcast error; it does not prove
  that no submission was attempted. Add no submission-based retry veto when
  that result supplies no receipt; normal classification still applies to
  preserved causes.
- Preserve successful public result types, callback reasons/isolation, read-only
  lookup and pre-mutation failures. No global retry changes or dependencies.

## Verification and completion

1. Establish red public-orchestration regressions with real `withRetry`, typed
   receipts and sealed query/mutation mocks.
2. Verify one mutation after submitted-receipt read failures; cover mismatches,
   missing/undecodable state, invariant/decoder failures, frozen/conflicting
   details, confirmed false, original causes and bounded MCP output.
3. Retain lookup and no-receipt retry controls, callbacks and success shapes.
4. Run focused tests, workspace build/types, E2E types, architecture/package/size
   gates, full coverage, and required Biome checks. Live acceptance runs in PR CI.
5. Synchronize consumer docs and changelog, obtain independent review, open a
   focused PR and update the two retained Linear criteria with concrete evidence.

AggregateError policy, broad coverage/compiler migration and other retained
ENG-805 work remain separate. Preserve pre-existing untracked review artifacts.

Validation: 3,845 tests pass, 17 skip, no type errors; 45 new regressions. All
coverage floors, workspace/E2E types, builds, Biome, architecture, package/size,
MCP metadata and harness gates pass. No high/critical dependency audit findings.
The [implementation record](../../eng805-remediation.md#follow-up-mutation-receipts-across-verification-failures)
contains coverage values, review confidence scores and validation limitations.
Live acceptance requires PR CI because the local XFS quota mount is absent.
