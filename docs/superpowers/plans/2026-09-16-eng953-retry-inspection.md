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

Connection catches receiving the preserved error also need guarded SDK-error
discrimination and message extraction. Normalize other failures to the existing
`RPC_CONNECTION_FAILED` envelope with endpoint details, using a fixed fallback
when diagnostics cannot be read. SDK errors retain identity only with readable string code/message, shallow details (including named consumer fields) and successful retry inspection. Incidental detail failures preserve readable code/message, safe evidence and an existing cause whose retry inspection succeeds; unreadable named fields retain the endpoint-only fallback unless an independently terminal repaired verdict survives. Non-string Error messages use the fixed fallback rather than transient string coercion.
Cover REST/RPC initialization and signing connection with the real retry helper,
and wallet signer acquisition separately before retry. Pin the outer-verdict short-circuit with zero cause
accesses so a conservative catch cannot hide an ordering regression.

Review also requires following preserved rejections through all downstream catches.
Guard MCP tool and resource responses, all four Cosmos attribution paths, post-lease deploy
diagnostics, restore pre-POST/compensation formatting, and orchestration diagnostics. Preserve known submission,
partial-success and lease evidence; never authorize replay because diagnostics
are unreadable. Pin exact connection error classes/details/no-cause, non-string
message fallback, and all outer-verdict branches with executable regressions. Readable
orchestration wrappers retain a cause only when needed to preserve a retry veto;
do not expose new transient signals through an otherwise unchanged wrapper.
Recover safe own-data receipt fields without invoking accessors; malformed tx
diagnostics retain TX_FAILED. Preserve independently established terminal verdicts.

Later restore POST/poll discrimination and terminal withContext remain in ENG-996;
producer-side executeTx diagnostic replay joins timeout/faucet/LCD work in ENG-983.

Further review requires retaining cancellation names and independently terminal
connection verdicts despite failed detail/cause reads, while preserving readable
detail fields and caller endpoint precedence. Failed-inspection Cosmos envelopes
must remain non-retryable even when copied facts or causes contain transient
signals; use a private identity marker rather than a new public error code.
Malformed-code-only read normalization must not gain a retry-enabling cause; malformed SDK codes remain terminal to prevent fallback-code status promotion.
Agent paid recovery uses its terminal fallback when a message is non-string or
unreadable. Apply the existing mnemonic heuristic before Cosmos prefixes, keep
resource function/class source out of responses (including non-string Error messages), and pin data omission and each
readiness diagnostic guard. Broader log hygiene remains ENG-271; readable paid
outcome-veto preservation is ENG-1000, and cross-realm NotFound joins ENG-983.

Retain veto provenance through connection repair and Cosmos rebuilding, and
preserve an estimate failure's veto through agent contextual attribution. Keep
the internal classification/formatting distinction off the public barrel.
Mnemonic detection checks both raw whitespace tokenization and a control-free
candidate; model formatting must redact before removing word separators. Retain
lexical retry decisions privately when presentation redacts text, without storing
the original secret or inventing status metadata. Redaction coverage is limited
to Cosmos/owned-broadcast attribution and agent contextualError; other prefixes,
MCP response/notification sinks and embedded-secret handling remain ENG-271.

Separate failed-inspection permanence from repaired readable context. Preserve a
non-retryable repair's cancellation name and existing cause through attribution using
standard cause traversal: ordinary non-transient text is not a permanent veto on an
enclosing error, and an outer owned deadline can still own a nested cancellation.
Keep actual failed-inspection provenance conservative, but do not treat an unreadable
attribution-only field as a classifier failure. Already-retryable repairs retain
their prior cause omission at Cosmos attribution. Test own-data status
salvage when a proxy rejects reads but exposes a data descriptor. Optimize
mnemonic checks without broadening the detection set or rescanning unchanged
text; control stripping only deletes text, so fewer than twelve original words
cannot become a mnemonic candidate. Non-Error causes and duplicate core copies
do not carry the same guarantees; keep those limits explicit in the guide.

Preserve an independently readable existing cause before deciding which repaired
connection envelope to return, provided retry inspection succeeded. Pair
unreadable attribution-only fields with submitted/partial/permanent causes and
transient outer messages: the cause must retain its veto and recovery facts
through Cosmos attribution instead of being discarded by the endpoint fallback.
Keep genuine inspection failures and already-retryable cause omission unchanged.
Reuse the control-free mnemonic candidate for model formatting so each string
needs at most one control-stripping pass. Pin the printable-ASCII fast path with
individual DEL, NEL, C1 CSI and soft-hyphen fixtures as well as broad corpora.

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

ENG-805's other open criteria retain their existing scope and owners.
