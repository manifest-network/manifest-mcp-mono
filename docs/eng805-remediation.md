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

## RPC-only query identity follow-up (2026-09-09)

Baseline: `83424ee`; branch: `codex/eng-805-rpc-query-identity`. The original F04
finding concerned identity before signing; the first batch also verified REST
queries. This follow-up adds verification to RPC-only query initialization.

Before each RPC query construction attempt, including retries and replacements,
the manager sends a JSON-RPC `status` POST to the exact configured `rpcUrl`,
preserving its path and query string. It validates the response envelope and ID,
then requires `result.node_info.network` to match `chainId`. The existing
`chainIdentityFetch` supplies this request independently from provider HTTP;
responses are limited to 64 KiB and 10 seconds, with redirects rejected. Cached
query reuse adds no request. REST remains preferred when configured, and the
existing signing connection checks remain active.

Independent review caught a timeout retry gap (confidence 99%): native
`TimeoutError` prose did not match the connection retry classifier. The shared
helper now normalizes its own deadline failures during both fetch and response
streaming to a retryable connection error. Focused regressions cover both phases
without changing the global retry policy.

The [CometBFT RPC specification](https://docs.cosmos.network/cometbft/v0.38/spec/rpc/Rpc-Spe)
documents the JSON-RPC POST form of `status`; its
[status response](https://docs.cosmos.network/cometbft/v0.38/api-reference/rpc/info/status)
includes `node_info.network`. Installed CosmJS `rpcclients/httpclient.js` likewise
POSTs JSON-RPC requests to the supplied URL. Generated query factories hide their
Comet clients, so this separate preflight detects configuration mistakes; it does
not guarantee the identity of later requests through a dishonest endpoint or a
load balancer that routes requests to different chains.

Follow-up validation on September 9:

- The public RPC mismatch regression failed before the guard was inserted.
- All 108 focused client, lifecycle and identity-bound tests pass. Independent
  review confirmed the timeout correction and found no remaining actionable
  issue in this scope (confidence 99%).
- The complete V8 suite passes: 3,672 tests, 17 existing skips, 171 files, no type
  errors. Coverage is 84.4% lines, 84.09% statements, 83.6% branches and 87.99%
  functions; all global and scoped thresholds pass.
- Workspace builds, workspace/E2E TypeScript checks, Biome and all nine package
  integrity checks pass. All four unchanged bundle budgets pass; the root client
  retains 3.79 kB of headroom.

Live validation of this follow-up is left to the PR acceptance workflow, whose
public SDK flow uses an RPC-only query configuration. The original batch's
successful live checks do not validate this additional change. The tracker stays
open for its broader dependency, coverage, compiler and simplification work.

### PR 224 review amendment

Further review confirmed two error-preservation bugs (confidence 100% each).
A deadline that elapsed before an identity verdict could replace a permanent
mismatch or response-size error with a retryable timeout. Separately, a rejecting
response-body cancellation could replace the HTTP-status or response-size error.
Both paths now preserve the established verdict and its retry classification.

The review also confirmed intentional compatibility policies: configure canonical
RPC URLs because identity requests reject redirects; JSON-RPC success must omit
`error`; the fixed ID checks correspondence, without freshness or authentication;
and initialization is outside the operation token bucket, with retries bounded by
configuration. The [client guide](library-usage.md) documents these decisions and
recommends client reuse.

Validation for this amendment: all 129 focused tests pass, including 21 new
regressions; eight direct cases were confirmed failing before the fix. Full V8
coverage passes 3,693 tests with 17 existing skips across 171 files and no type
errors: 84.41% lines, 84.1% statements, 83.62% branches and 88% functions, above all
configured thresholds. Workspace builds, workspace/E2E TypeScript, Biome, all
nine package-integrity checks and all four unchanged bundle budgets pass.
Independent review found no remaining blocker in these fixes (confidence 98%).

The initial PR acceptance run failed during the Docker build because a Go
checksum-database download returned an HTTP/2 internal error; acceptance tests
never started. Live acceptance of the updated PR remains pending.

## Transport-owned deadline follow-up (2026-09-09)

Baseline: `0036f18`; branch: `codex/eng-805-transport-deadlines`.
PR #224 subsequently passed all CI checks on reviewed head `30df49b` and merged
as this baseline; the pending acceptance note above records the earlier state.
The retained retry finding is a separate scope: native deadline prose loses its
ownership when wrapped, so an idempotent read can miss an intended retry
(finding confidence 99%). See the
[implementation plan](superpowers/plans/2026-09-09-eng805-transport-deadlines.md).

The contract adds exported `TransportErrorDetails` with optional
`transportCode: 'ETIMEDOUT'` on existing `QUERY_FAILED`/`RPC_CONNECTION_FAILED`
errors. Only identity requests and faucet `GET /status` mark a timeout verified
against their own fresh per-attempt signal, including response-body failures.
Cause inspection preserves known status verdicts and permanent, partial or
submitted outcomes over transient wrappers. An unknown native abort/deadline is
not sufficient evidence for retry. Faucet credit POST behavior stays unchanged.

`RetryOptions.signal` and `isRetryableError(error, { signal })` carry the separate
overall cancellation boundary. They stop backoff and later attempts; the
operation must pass that signal to its transport to cancel in-flight work.
The wrapper does not race opaque callbacks or discard successful results. The
[client guide](library-usage.md#errors) shows this composition around the
idempotent faucet status read, which has no internal retry loop. Retain the
existing backoff implementation: adding `p-retry` would not establish ownership
or replace the operation-specific exclusions.

Validation for this follow-up:

- All 254 focused runtime/type tests pass, including the previous PR's identity
  regressions and the documented cancellation composition. A negative control
  against the pre-fix retry classifier fails 15 of the 19 ownership cases; the
  current implementation was restored before integrated validation.
- The full V8 suite passes 3,747 tests with 17 existing skips across 172 files,
  with no type errors. Coverage is 84.43% lines, 84.15% statements, 83.71%
  branches and 88.09% functions; all thresholds pass.
- Workspace builds, workspace/E2E TypeScript, Biome and all nine package
  integrity checks pass. All four unchanged bundle budgets pass; reads/catalog
  remain 26.07/26.38 kB, with 5.2 kB deploy and 3.59 kB root-client headroom.
- Independent review found no concrete blocker in the ownership, cancellation
  or cause-precedence changes (confidence 98%). No dependencies changed.

CI for this follow-up remains pending; the earlier PR's live acceptance does not
validate these new changes. Broader ENG-805 dependency, coverage, compiler and
simplification work remains open.
