# ENG-805: retain owned inclusion-timeout evidence

Base: merged PR #228, `12af628`. This slice addresses the two retained
inclusion-timeout criteria. The other eleven ENG-805 criteria remain separate.

## Contract

The SDK-created signing client reuses the installed CosmJS blocking broadcast
implementation. A per-call observer records a validated hash returned by its
native CheckTx broadcast. That observed acceptance establishes submission even
if the subsequent inclusion timer or transaction lookup fails. A class, name,
message or txId supplied by an unrelated throw does not establish submission.
The observed hash is authoritative; a later error's claimed txId is ignored.

The owned failure becomes non-retryable TX_FAILED with exactly sent:true and
transactionHash in its initial details; a readable structured
OPERATION_CANCELLED retains its cancellation code. Its original error is retained as a
non-enumerable cause. Cosmos and multi-message entry points add their normal
operation attribution while preserving the cause chain. There is no inferred
transaction code, height, confirmation or successful receipt.

Existing stopApp and closeLease reconciliation can carry this sparse snapshot.
Explicit submission evidence vetoes later whole-orchestration retry even if a
verification read fails transiently. Terminal lease observation and transaction
inclusion remain independent facts.

## Implementation and validation

1. Install an internal guard on SDK-created clients after identity validation.
   Preserve dynamic receivers and existing sequence views, without rewriting
   CosmJS signing, fee calculation or polling. Leave custom implementations and
   asynchronous broadcasting unchanged.
2. Preserve owned error attribution and cause through cosmosTx and executeTx.
   Keep unrelated query and transaction error behavior unchanged.
3. Use the real pinned SigningStargateClient producer with isolated signing and
   Comet transport seams. Fake timers must reach its native inclusion timeout.
   Cover CheckTx rejection, malformed hashes, delegated/forged/pre-signing
   errors, caller cancellation, async mode, cached sequence use, concurrent
   call isolation, and a late successful inclusion result.
4. Exercise actual downstream reconciliation, successful callbacks, bounded MCP
   projection and retry counts. Submission evidence must not invent inclusion.
5. Update consumer documentation and remediation evidence. Run focused checks,
   a fresh workspace build, types, coverage, package/architecture/bundle gates,
   and required PR CI including live acceptance.

No new production result type or output-schema field is required. Preserve all user
artifacts, release branches and submodule pins. Keep the two acceptance criteria
unchecked until their implementation and validation are complete; ENG-805 stays
In Progress for the remaining work.
