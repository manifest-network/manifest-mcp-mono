# ENG-953: preserve failures during retry inspection

Base: merged PR #232 (`5a49cd4`). Scope: exception-safe classification of standard
error causes through the public core and SDK retry helpers.

## Decision

Keep the exception boundary inside `isRetryableError`, around all inspection of
the supplied error. If inspection throws, return `false`; `withRetry` then
rejects with the exact original value without another attempt or `onRetry` call.
The whole-operation signal remains the first check. Established outer permanent
or submitted outcomes still short-circuit without reading irrelevant causes.

Do not turn failed cause traversal into a partial successful traversal: a hidden
permanent or submitted cause could otherwise be lost and a transient wrapper
could authorize replay. Leave the shared `errorChain` and transport ownership
helpers unchanged. The boundary covers errors supplied to the retry helpers;
producer-side diagnostic inspection before those helpers remains separate.

No dependency, compiler-target, public type, or grouped-error policy change is
needed. AggregateError members remain outside the standard `.cause` traversal.

## Implementation and validation

1. Reproduce root/nested unreadable causes and proxy reflection failures through
   public core and built SDK exports, including a zero retry budget.
2. Add the classifier exception boundary and preserve positive transient retries,
   terminal/submitted vetoes, cancellation and cycle handling.
3. Update public retry documentation, the changelog and the remediation record.
4. Build workspaces; run focused and full coverage tests, workspace/E2E typechecks,
   formatting, architecture and package checks. Review independently, open a PR,
   and record its validation in ENG-953 and the compact ENG-805 status.

The 81 existing user artifacts, release branch and submodule pins are preserved.
ENG-805's other open criteria retain their existing scope and owners.
