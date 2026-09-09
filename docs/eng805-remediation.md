# ENG-805 implementation record

Baseline: v0.22.0 at `38b57b8`. Branch: `codex/eng-805-remediation`.
The [implementation plan](superpowers/plans/2026-09-08-eng805-remediation.md)
contains design decisions and the remaining simplification work. The original
[confidence-scored review and archived evidence](https://linear.app/liftedinit/issue/ENG-805)
remain a historical record; the changes below are implemented in this batch and unreleased.

## Findings

| Finding | Review confidence | Implementation / remaining gap |
| --- | ---: | --- |
| F01 published dependencies | 100% | Added isolated packed SDK/CLI audits, package-tree validation and smoke tests; release gate blocks high/critical advisories. Published upstream dependency declarations remain vulnerable. |
| F02 client ownership | 100% | Freeze configuration, isolate wallet/policy/transport identities, share only compatible holders, coordinate chain/account broadcasts across managers. |
| F03 restore uncertainty | 99% | Compensate only locally proven pre-POST failures/cancellation. Every POST exception, including all 4xx/5xx, lost responses and malformed 2xx, preserves both IDs with unknown adoption and reconciliation guidance. No POST status/prose authorizes cleanup or replay. |
| F04 chain identity | 99% | Verify each new RPC signing connection and bounded REST node-info before exposing REST queries; reject mixed-endpoint disagreement before signing. Identity transport is separate from provider HTTP policy. |
| F05 integer widths | 100% | Validate unsigned/signed widths, uint32 JSON fields, Duration limits and governance status enums before encoding; retain arbitrary-precision coin amounts. Real codecs verify boundaries. |
| F06 converter locking | 100% | Converter uses the shared transaction executor; concurrent core/converter calls respect the real account lock. |
| F07 pre-send cancellation | 100% | Check one effective deadline through address lookup, queue, rate limit, client acquisition, simulation and retry waits. Submission-start cancellation remains an explicit uncertain outcome. |
| F08 redirects | 99% | Provider transport refuses all redirects, including same-origin and opaque browser redirects, before forwarding credentials or bodies. |
| F09 model output bounds | 100% | Bound complete MCP errors to 8,000 serialized characters, cap text, redact secrets, neutralize controls, preserve recovery fields, and mark truncation. Original SDK errors remain available. |
| F10 wallet shutdown race | 100% | Publish initialized keys only after complete derivation and a final disconnect check; failed initialization remains retryable while connected. |
| F11 keyfile replacement | 99% | Encrypt before filesystem mutation; write and flush an exclusive private temporary file, then rename. Short writes and persistence/cleanup failures are covered. Directory-entry durability across power loss is explicitly not guaranteed. |
| F12 LCD scalar fidelity | 100% | Smart-query JSON values round-trip as JSON bytes, including strings and null; raw-query data remains bytes. |
| F13 terminal diagnostics | 99% | Retrieve retained provider history for terminal leases, expose chain state separately, preserve provider 404/503 errors, and use terminal-specific guidance. |
| F14 coverage | 100% | Added real V8 instrumentation, uncovered-file inclusion, global/query/transaction floors and a positive/negative guard. Broader low-coverage handlers and property testing remain with ENG-751. |
| F15 dependency graph | 100% | Enforce all workspace directions and production cycles, remove metadata/handler and client/type cycles, and index every workspace TS project. Production probes cover all 72 directed package pairs. |
| F16 signing dependencies | 100% | Concrete matched CosmJS/fork/ManifestJS migration documented; upstream releases and signing compatibility validation remain necessary. |
| F17 deployment wording | 100% | Tool descriptions, approval recaps, fixtures and docs describe separate paid-chain/HTTP steps and partial outcomes. |
| F18 E2E environment | 100% | Document Linux/XFS project-quota setup/cleanup and add a read-only preflight before Compose in both live workflows. Local full devnet execution remains unavailable. |
| F19 stale docs | 100% | Synchronize wallet cleanup, browser imports versus filesystem calls, runtime package description, linter policy, restore outcomes and transport boundaries. |
| F20 TypeScript | 100% | Enable `verbatimModuleSyntax` and `noImplicitOverride`. Native compiler/API compatibility and the other stricter flags remain staged work under ENG-806. |

## Independent verification of the patch

A second review caught and corrected additional implementation edges:

- Governance filters still needed enum validation: the real int32 codec wrapped
  `4294967297` into status `1` (confidence 100%). Filters now accept only 0–5.
- The E2E preflight needed Docker context precedence and live-workflow wiring
  (confidence 99%/100%). An explicit `DOCKER_CONTEXT` now overrides `DOCKER_HOST`.
- Provider-controlled status text bypassed response bounds through progress
  notifications (confidence 99%). The shared emitter now caps messages at 1,024
  code points including the truncation marker, and both polling tools sanitize
  status text before interpolation so mnemonic-shaped values are redacted.
  Actual MCP notification regressions cover large/control/secret statuses,
  unchanged tokens and counters, and preserved timeout/interval options; all six
  focused progress and option tests pass.
- The initial coverage guard did not independently prove the directory floors
  (confidence 100%). Separate global, query and transaction fixtures now exercise
  the real V8 provider: each rejects an uncovered file and passes when covered;
  scoped failures occur while unrelated global coverage stays above 99%.

The final F03 acceptance audit found a concrete counterexample to treating 4xx as
proof of non-adoption (confidence 100%). In the pinned Fred checkout,
`submodules/fred/internal/backend/client_test.go:297` covers a backend 422 carrying
`code: "already_provisioned"`; `internal/backend/client.go:1424–1446` classifies it
as `ErrRestoreRefused`. `internal/api/handlers.go:1185–1191` relays HTTP 422 while
explicitly disclaiming a lease-state verdict. The API's `writeError` at line 1974
exposes error prose and the numeric HTTP code, not structured non-adoption evidence.
The SDK previously cancelled that target through its 422 allowlist.

That allowlist is now removed. Only local execution proving the POST was never
sent permits compensation. All POST exceptions preserve unknown adoption, including
malformed 2xx bodies that were previously assumed committed. HTTP status, error kind
and Retry-After remain diagnostics only; an actual retry-wrapper test verifies that
429 cannot replay the restore. The public `RESTORE_RETRYABLE` enum remains for
compatibility but is no longer emitted by `restoreApp`.

Upstream still provides no trustworthy, request-bound non-adoption verdict for
automatic cleanup after a rejected POST. Genuine rejections can therefore leave a
paid empty target lease until reconciliation. Adding that protocol support is a
future upstream capability; the client now preserves data without assuming it exists.

The final F03 delta passes all 37 focused restore tests through the real provider
HTTP wrapper, Fred's `tsc --noEmit`, the Fred package build, scoped Biome and diff
checks. A separate read-only review found no blocking issue (confidence 98%).

It also caught chain/provider fetch coupling (confidence 100%): the provider SSRF
guard must not govern an operator-configured local REST chain endpoint. The
identity transport is separated without weakening provider guards. Keyfile dual
failures now preserve both persistence and cleanup causes (confidence 100%).

The proposed `write-file-atomic@7.0.1` replacement was rejected after a real short
write caused successful replacement with two ciphertext bytes. The native writer
uses Node's complete-write loop. The [security guide](security.md#wallet-handling)
documents its durability limits and regression evidence.

A separate, pre-existing robustness observation remains: a throwing third-party
signing-client `disconnect()` can interrupt manager cleanup (confidence 95%). It
was not established as a new unsafe signing path; teardown should eventually
isolate each cleanup failure and still evict closed resources.

## Release and validation limits

ENG-805 remains **In Progress**. Do not mark F01/F16 or the broader coverage,
compiler, API-baseline and orchestration refactors complete from these source
changes. The [consumer dependency plan](dependency-consumers.md) identifies the
required upstream changes and tested interim application-root overrides.

The read-only E2E preflight confirms Docker is reachable but reports a missing
XFS project-quota mount at `/mnt/fred-xfs`. No privileged mount, live chain
transaction, provider deployment, package publication or production change was
performed. The documentation supplies the supported Linux setup.

## Integrated validation

Final local validation used Node 24.15.0. The complete V8 run passed after the last
restore correction; no tests were disabled or coverage floors lowered to pass.

| Check | Result |
| --- | --- |
| Complete workspace V8 suite | 170 files passed; 3,635 tests passed, 17 pre-existing skips, zero failures; 185.16 seconds. |
| Coverage | Lines 84.36%, statements 84.05%, branches 83.56%, functions 87.95%; all global and scoped floors pass. All 185 selected production files are included. |
| Sparse-handler coverage | Queries: 38.19% lines / 44.67% branches. Transactions: 61.49% lines / 65.88% branches. Broader coverage remains open. |
| Workspace and E2E TypeScript | Passed. Integration fixture/library errors were corrected and the affected Cosmwasm, Fred and Node compiler checks rerun successfully. |
| Build and packaging | Full workspace build and all nine packed-package checks passed; Fred was rebuilt after the final restore change. Browser build/import guards passed within the full suite. |
| Architecture | No violations across 458 modules / 1,726 dependencies; executable production probes cover all 72 package directions and all 15 rules. |
| Guard tests | Schema 30, workflows 62, dependency hygiene 17, review tooling 7, type harness 8, independent V8 coverage guards 3: all passed. |
| MCP annotations | Eight read-only contract tests passed against rebuilt CLI artifacts. |
| Bundle budgets | All four unchanged budgets pass: reads 26.07 kB gzip, catalog 26.38 kB; deploy and root-client retain 5.33 kB and 4.03 kB headroom. |
| Formatting | Biome checked 531 files with no errors; three existing informational suggestions remain. `git diff --check` passes. |
| Locked repository audit | High/critical gate passes; seven low affected entries remain through elliptic. |
| Isolated SDK/CLI consumers | Imports and all CLI smokes pass. Audits correctly fail the release threshold: SDK 1 critical / 9 high / 5 low; CLI 1 critical / 13 high / 5 low affected dependency entries. |
| Live devnet | Not run: Docker is reachable, but the required XFS project-quota mount is missing. |

The 17 skips are documented legacy cases: 16 subprocess concerns that do not apply
to the in-process TypeScript verifier, plus one unreachable defensive branch.
Consumer audit counts include advisory propagation through dependent packages,
not that many unique advisories. Their dependency graph is unchanged by the later
progress/restore fixes.

Original local-run evidence (not committed or downloadable artifacts) includes
`coverage/coverage-summary.json`, `coverage/coverage-final.json`,
`/tmp/eng805-coverage-complete.log`, and
`/var/tmp/manifest-eng805.cAl0Za/consumers/run-DGwzyZ/{sdk,node}/`
(`audit.json`, `dependency-tree.json`, `package-lock.json`, `smoke.log`) with the
parent `summary.json`.

An initial attempt was interrupted when `/tmp` filled; only this task's disposable
dependency installations/caches were removed, preserving reports and lockfiles.
Final runs use a disk-backed temporary directory outside the repository. An earlier
architecture probe also hit its 30-second subprocess limit; a bounded 60-second
limit passes both its isolated V8 test and the final full suite.
