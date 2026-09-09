# ENG-805 remediation plan

Baseline: `38b57b81602b7243aada778ef675118d4783f94c` (v0.22.0). Working branch: `codex/eng-805-remediation`.

The user authorized planning and implementation of ENG-805. The September 8 review remains the historical evidence record; this plan records remediation and validation separately. Existing canonical Linear issues remain the owners of their scopes. No new review sweep is needed.

## Decisions

- Support independently configured clients without changing another client's wallet or transaction policy. Share transport resources only when compatible, and coordinate broadcasts by chain/account across client instances.
- Verify each RPC signing connection and REST query identity before signing. A mismatched or unverifiable endpoint must not silently become a signing destination.
- Treat every exception after the restore POST begins as an unknown outcome, including 4xx and malformed 2xx replies. Preserve both lease identifiers and reconcile. Automatic compensation is limited to locally proven pre-POST failures; HTTP status, error prose, and PENDING chain state do not prove non-adoption.
- Reject provider redirects before forwarding credentials or deployment bodies. Preserve existing connect-time SSRF guards.
- Keep public API and runtime compatibility explicit. Dependency/TypeScript migrations must prove compatibility, and a locally clean root audit is not a clean published consumer graph.
- Implement and validate source changes before considering any release. Publishing upstream forks/packages or deployment changes is a separate action requiring a concrete reviewable result and any necessary authorization.

## Work sequence

1. **Signing and external side-effect safety:** F02/F04 client ownership and chain identity; F03 unknown restore outcomes; F08 redirect protection. Public factory, lifecycle, and actual transport regressions accompany the changes.
2. **Published dependency security:** F01 isolated packed-consumer audit/smoke tooling and durable dependency remediation; F16/ENG-808 matched crypto migration assessment. Prepare concrete upstream changes when no compatible package is available; keep unresolved advisories visible.
3. **Transaction correctness:** F05 width-aware integer validation and real codec round trips; F06/ENG-674 converter through shared execution; F07 pre-send cancellation through queue/rate-limit/simulation and honest post-send uncertainty; F09/ENG-756 bounded model-facing error projection.
4. **Lifecycle and data contracts:** F10 wallet initialization/disconnect; F11 atomic keyfile replacement; F12 correct smart/raw LCD encoding; F13/ENG-671 honest terminal-state diagnostics.
5. **Regression protection and maintainability:** F14/ENG-751 quantitative coverage with targeted regression tests; F15/ENG-753 complete dependency graph and cycles; O01/O02 typed registry and validation reuse; O03 atomic-write package evaluation; O04 property testing; O05/ENG-389 orchestration extraction; O06/ENG-663 Fred contract fixtures; O07 explicit retry-mechanics decision; O08/ENG-390 public API baseline; O09/ENG-626 signing-bundle profiling coordinated with ENG-808/912.
6. **Documentation and TypeScript:** F17 accurate deployment partial-outcome wording; F18 supported XFS E2E setup and read-only preflight; F19 synchronize security/browser/package/linter contracts; F20/ENG-806 staged strictness/compiler migration with tooling compatibility.

## Validation and closure

Run focused behavioral tests for each change, then the complete relevant package suites. Build once changes are integrated before cross-package type, browser, package-integrity, and annotation checks. Run repository typechecking, Biome, generated-schema check, dependency-cruiser and positive controls, workflow/dependency/type-harness guards, package validation, and bundle budgets. Run the clean consumer gate independently and report any remaining upstream advisories honestly. Full devnet E2E requires its documented privileged XFS environment; no real provider/chain mutation is part of local regression testing.

Update the tracker with implementation evidence and remaining work. A checkbox is complete only when its acceptance criteria are met; distinguish implemented/unreleased changes from merged or published remediation. Keep the tracker open while required upstream migrations, integration validation, or other accepted scope remains.

## Progress

- [x] Read current tracker, repository instructions, review evidence, and working-tree state.
- [x] Create implementation branch and assign independent client, provider, and dependency tracks.
- [x] Integrate safety fixes and their regression tests.
- [x] Implement local correctness fixes, architecture guards, coverage instrumentation, and synchronized documentation.
- [x] Record concrete external dependencies and migration decisions.
- [ ] Complete the broader registry, handler-coverage, API-baseline, contract-generation, orchestration, and compiler migrations identified below with their canonical owners.
- [x] Run integrated verification and update ENG-805 with results, marking 25 locally satisfied acceptance items while preserving open external and broader migration work.

## Simplification decisions and follow-up boundaries

| Review item | Decision / concrete progress | Remaining acceptance work |
| --- | --- | --- |
| O01 typed command registry | Separate static command metadata from executable registration to remove import cycles; enforce matching registration keys with `satisfies`. | Deriving argument parsing and help from the same schema remains a separate registry migration. Preserve existing aliases and error contracts when prototyping one module. |
| O02 shared validation | Reuse core's canonical UUID parser in close-lease, manage-domain, troubleshooting and domain verification while preserving caller error categories. | FQDN normalization and environment validation have boundary-specific rules; merge only after equivalence tests establish identical contracts. |
| O03 atomic-write package | Evaluate `write-file-atomic@7.0.1`; reject adoption after an injected short write replaced the previous file with truncated output while resolving successfully. Use Node's complete-write loop with an exclusive same-directory temporary file, fsync and rename. | Keep short-write, ENOSPC, permission and replacement regressions. This decision does not change accepted key-derivation parameters. |
| O04 property testing | Actual protobuf round trips now pin integer boundaries and LCD JSON/byte semantics; deterministic async tests cover transaction and wallet schedules. | A `fast-check` pilot and broader zero-coverage query/transaction handlers remain with ENG-751; these example-based regressions do not close that whole issue. |
| O05 deployment decomposition | Preserve orchestration behavior while fixing the shared transaction and restore primitives it consumes; correct its approval/recovery descriptions. | ENG-389 still owns extraction of outcome classification, recovery decisions and persistence from the large deployment module. Do not combine that refactor with an unreviewed workflow framework change. |
| O06 provider contracts | Fred transport already validates known response fields using Zod; added real transport/converter regressions cover redirects, terminal diagnostics and smart/raw LCD data. | Fred-owned generated HTTP response contracts and drift fixtures remain with ENG-663. The generated deployment-manifest schema is not a complete response contract. |
| O07 generic retry package | Retain the existing shared retry loop. Non-idempotent transaction/restore exclusions and the new preparation/submission cancellation boundary are the consequential policy; replacing the loop with another dependency does not simplify those decisions. | Revisit a generic backoff package only if another use case demonstrably removes duplicated mechanics. No package addition is justified by the current review. |
| O08 public API baseline | Existing type, package-export and browser guards remain mandatory. | ENG-390 still needs a reviewed declaration/export baseline to catch accidental surface growth, including `export type *`. |
| O09 signing size | Keep current bundle budgets and profile after the matched crypto dependency migration. | ENG-626/808/912 own the upstream dependency and bundle work. Do not increase budgets silently to accommodate this patch. |

External dependency remediation is documented in `docs/dependency-consumers.md`.
The repository's release gate must continue to fail while an unmodified packed
consumer still resolves high/critical advisories. A safe application-root override
is an explicitly documented interim consumer action, not a published-library fix.
