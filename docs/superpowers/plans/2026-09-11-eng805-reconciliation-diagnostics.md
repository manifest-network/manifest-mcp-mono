# ENG-805: preserve teardown reconciliation diagnostics

Status: PR #228 review corrections implemented and locally validated; unreleased.
Base: `e1f3ca2` (merged PR #227).

## Problem and scope

A failed blocking `stopApp` attempt can converge to an observed terminal lease.
That currently discards the caught error, including a failed DeliverTx's actual
hash, code and height. A later transient `closeLease` verification failure can
then authorize another orchestration invocation without that evidence. Whether
another broadcast occurs depends on its next pre-query; this finding does not
demonstrate duplicate accepted transactions or fees. Evidence-loss confidence:
100%; conditional retry impact: 99%.

This implements the optional P3 extension recorded on ENG-805. The two merged
receipt criteria remain complete and the prior 11 unchecked criteria retain
their scope. PR review retains two additional inclusion-timeout criteria for a
separate follow-up. No dependency or grouped-error retry policy change is needed.

## Contract

- Add optional `StopAppReconciliation` on `already_inactive` results only after
  a caught blocking attempt and a terminal re-query. Terminal pre-query results
  remain unchanged. Keep the existing outcome discriminant and top-level receipt
  fields; failed-attempt evidence is separate from terminal lease state. Also
  retain the snapshot and lease ID on the existing PENDING-to-ACTIVE race error.
- Preserve the original thrown value as non-enumerable `reconciliation.error`,
  without mutation. Freeze the new snapshot. Serialize only whitelisted bounded
  machine fields: error code, explicit sent/confirmation flags, transaction hash,
  code and height. Omit arbitrary details, rawLog, message and stack. Inspect only
  own data descriptors; invalid or inaccessible metadata is omitted. Promote
  generic code/height/confirmation only with explicit sent:true. A qualified hash
  can survive independently and does not prove inclusion.
- Record `sent: true` and `confirmed: true` where a failed DeliverTx is actually
  received, consistently across cosmosTx and executeTx. Neither terminal state,
  a failure category nor missing hash proves
  submission or non-submission. Preparation failures without explicit metadata
  retain their error while submission remains unknown.
- Carry the snapshot in close-verification and deploy-recovery error details,
  and on verified-terminal CloseLeaseResult/onComplete success. Mirror the optional
  machine snapshot in MCP outputSchema and describe it in close/deploy tools.
  Established `reconciliation.sent: true` adds the existing outer `sent: true`
  retry veto. Keep the later verification failure as cause; the earlier teardown
  error is a separate diagnostic, never a fabricated causal ancestor.
- Reserve reconciliation aliases against conflicting query details and prioritize
  this metadata in bounded MCP error output. The raw retained error does not
  serialize through either success JSON or MCP error projection.

## Validation

1. Exercise real `cosmosTx` behind mocked query/signing wire seams: preparation
   failure versus failed DeliverTx, ACTIVE/PENDING convergence and terminal
   pre-query controls. Preserve cancellation/nonblocking passthrough.
2. Exercise public close verification and deployment recovery with frozen errors,
   transient queries, receipt conflicts and actual retry invocation counts.
3. Check SDK exported types, bounded MCP output and JSON serialization.
4. Run focused tests, formatting, workspace build/types, E2E types, architecture,
   package/size checks and full coverage. Live acceptance is validated in PR CI;
   the local supported Linux/XFS quota mount is not available.
5. Synchronize current documentation, independently review, update the PR and
   ENG-805 with concrete validation and remaining limits. Preserve the 78 current
   untracked artifacts (including six supplied review files), submodule pins and
   unrelated release branch.

Pre-review baseline validation at `d4076ca`: 3,903 passed / 17 skipped across 177 files, no type errors; 46 new
regressions. All coverage floors and 495 focused checks pass. Workspace build/types,
E2E types, architecture/package/size/MCP metadata and type-harness checks pass.
Final independent review: no blockers, 99% confidence. See the
[implementation record](../../eng805-remediation.md#follow-up-failed-teardown-reconciliation-diagnostics)
for metrics, resolved review findings and the local live-acceptance limitation.

Review correction validation: 3,921 passed / 17 skipped, no type errors; 18 new
regressions. All coverage floors, 316 focused tests, build/type/E2E-type,
architecture/package/size, live MCP metadata and type-harness checks pass.
Biome and whitespace checks pass. Final review finds
no blockers (99% confidence). Updated commit requires fresh PR CI.
