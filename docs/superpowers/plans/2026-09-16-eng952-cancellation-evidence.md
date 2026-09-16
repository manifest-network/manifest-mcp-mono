# ENG-952: retain accepted transaction identity on caller cancellation

Base: PR #230 merged at `032addd`. This is a child of ENG-805, separate from
the parent's eleven unchecked criteria and ENG-953's custom cause inspection.

## Contract

Actual caller cancellation remains prompt, with `OPERATION_CANCELLED`, the
original `details.reason`, and conservative `details.sent`. When the operation
has already observed native CheckTx acceptance, also retain the local SHA-256
hash of the submitted signed bytes. Neither an RPC identifier nor error metadata
can supply that hash. Submission does not establish inclusion or execution
success, and this change adds no confirmation, code or height fields.

Before observed acceptance, cancellation has no hash. Later acceptance or polling
completion must not change a settled cancellation. Concurrent operations retain
separate submission evidence; their signals remain caller-controlled. Mismatched RPC identifiers still allow
retaining the local digest once native acceptance was observed.

## Implementation

1. Give each cancellation-aware transaction execution an acceptance observer.
   It records the first local hash only after submission starts and before the
   outer operation settles. Cancellation constructs fresh details from that
   state; the losing operation remains observed.
2. Pass the optional observer explicitly through `getBroadcastClient` and
   `sequencedSigningClient`. Both blocking sequence paths route it to the native
   broadcast guard. Do not store operation state on a shared raw signing client.
3. For the supported native `signAndBroadcast`/broadcast path, use a per-call receiver that
   routes the blocking broadcast through the existing evidence guard. Other
   methods retain the original raw or sequence receiver. The guard notifies
   after native CheckTx resolves using its existing local digest. Notification
   failures cannot replace the transaction outcome.
4. Custom `signAndBroadcast` or broadcast methods, SYNC-only calls and opaque confirmation
   callbacks keep their prior behavior and supply no new acceptance observation.
   No new result schema is introduced. Public error details remain sparse.

## Validation and documentation

- Exercise real pinned native signing/broadcast/poll methods for `cosmosTx` and
  `executeTx`, including manager wiring and cached sequence composition.
- Cancel after acceptance while polling is pending; preserve prompt settlement,
  exact reason identity, local hash and sent flag, with one submission/no retry.
- Cover cancellation before acceptance, custom/forged errors, mismatched RPC
  identifiers, distinct concurrent identities, and late success/failure.
- Verify native bound-client teardown cancels without reconciliation, and bounded
  MCP error projection preserves the known hash without inventing a receipt.
- Update current consumer guides and add a superseding implementation record for
  the historical ENG-952 gap. Do not imply that every MCP/orchestration path
  forwards caller cancellation or guarantees delivery of a cancelled response.
- Run focused regressions, a fresh build, workspace/E2E type checks, coverage,
  architecture/package/bundle gates, and PR CI/live acceptance. Preserve all
  81 pre-existing user artifacts, the release branch and submodule pins.

Leave ENG-952 In Progress until review/merge; keep ENG-805 In Progress for its
remaining criteria and separate children. No release is part of this slice.
