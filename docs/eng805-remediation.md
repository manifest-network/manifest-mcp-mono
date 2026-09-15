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
Cause inspection preserves permanent HTTP/gRPC verdicts and permanent, partial
or submitted outcomes over transient wrappers. An unknown native abort/deadline
is not sufficient evidence for retry, even with a transient status in its cause
chain. Faucet credit POST behavior stays unchanged.

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

Initial PR #225 head `bf5a7e2` passed all CI checks, including live SDK acceptance
and the E2E gate. Broader ENG-805 dependency, coverage, compiler and simplification
work remains open.

### PR #225 review amendment

[Claude's review](https://github.com/manifest-network/manifest-mcp-mono/pull/225#issuecomment-5607995839)
identified one API gap and three smaller improvements:

| Finding | Confidence | Resolution |
| --- | --- | --- |
| SDK-only cookbook required a direct core import, risking error identity under version skew | 99% | Re-export `withRetry` and `isRetryableError` from the SDK root, using the same pinned core dependency as its error producers. Cover the public package imports, runtime faucet-error identity and typed cookbook composition. |
| Timeout producers were not checked against their exported metadata type | 100% | Bind all three literals with `satisfies TransportErrorDetails`, preserving their inferred types for the generic error-details record. |
| Nested, non-identical `TimeoutError` recognition lacked a regression | 100% | Exercise the helper and real RPC identity boundary, with cancellation, permanent-verdict and cycle controls. |
| Status-precedence wording was broader than the classifier's behavior | 100% | Document permanent status vetoes separately from transient statuses, which cannot override an unowned native abort. |

The nine refuted candidates remain refuted; they do not justify additional runtime
changes. The pre-existing HTTP 408/425 policy observation is retained as one P3
follow-up in ENG-805. Actual LCD/faucet read probes make one attempt on 408/425
and two on a 503 control (`maxRetries: 1`). Bounded 408 retries could improve read
availability (recommendation confidence 99%; [RFC 9110 §15.5.9](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.9)).
A 425 retry policy first needs evidence that supported transports avoid TLS early
data on replay; a production defect has not been established (assessment confidence
99%; [RFC 8470 §5.2](https://www.rfc-editor.org/rfc/rfc8470.html#section-5.2)).

Review validation:

- All 204 focused runtime/type tests pass against freshly built packages. Removing
  the two SDK value exports fails the runtime surface guard and produces
  TS1485/TS1362 in the SDK type tests. Removing only the `TimeoutError` disjunct
  through an isolated transform fails five new regressions; 43 controls pass.
- The full coverage run records 3,760 passing tests, 17 existing skips and five
  browser-bundle timeouts across 175 files, with no type errors. All coverage
  thresholds pass: 84.43% lines, 84.15% statements, 83.71% branches and 88.09%
  functions. The two affected browser files then pass all 16 tests sequentially
  with a temporary 120-second local timeout. Repository timeouts are unchanged;
  the initial run is not recorded as an unconditional pass.
- Workspace builds, workspace/E2E TypeScript, Biome, all nine package-integrity
  checks and all four unchanged bundle budgets pass. Independent review found
  no concrete blocker (confidence 98%). No dependencies changed.

CI subsequently passed on review commit `9fe0883`, including the dependency audit,
unit tests, live SDK acceptance and the E2E gate.

### PR #225 type-constraint correction (2026-09-10)

[Claude's re-review](https://github.com/manifest-network/manifest-mcp-mono/pull/225#issuecomment-5619159481)
corrected the recommendation to intersect the identity marker's constraint with
`Record<string, unknown>`. The spread does not need that index signature, which
lets an explicit misspelled `transportCoed` key compile. Use bare
`satisfies TransportErrorDetails`, matching the faucet producers (P3, confidence
100%). The existing key and runtime behavior were already correct.

Four compiler-host probes against the real core project confirm that both forms
accept the valid key, the old form accepts the typo, and the corrected form rejects
it with TS1360. Generated JavaScript is byte-identical. All 48 focused identity and
timeout tests pass; Biome fix/check and diff checks pass. Full coverage and package
builds were not repeated for this erased type-constraint change.

The three nonblocking residuals retain their existing scope:

- SDK script tests execute outside the compiler projects; the public API type
  tests remain gated. Add a scoped no-emit script gate under
  [ENG-806](https://linear.app/liftedinit/issue/ENG-806) (confidence 100%).
- The classifier's marker comparison is currently correct and runtime-tested but
  statically unbound to the metadata type. No production defect or additional
  change is established by this observation (assessment confidence 99%).
- Individual identity-check mutations expose optional coverage for arbitrary or
  polyfilled abort reasons. Normal production deadlines yield `TimeoutError`;
  no production failure was demonstrated. Retain compatibility cases under
  [ENG-751](https://linear.app/liftedinit/issue/ENG-751) (coverage distinction
  confidence 100%).

## HTTP read-status follow-up (2026-09-10)

Baseline: `a5db747` (merged PR #225); branch:
`codex/eng-805-http-read-retries`. All five PR #225 CI checks passed, including
live SDK acceptance, and its merge tree matches the reviewed head. The
[implementation plan](superpowers/plans/2026-09-10-eng805-http-read-retries.md)
addresses the retained HTTP 408/425 observation without closing the broader audit.

Numeric `details.httpStatus: 408` on `QUERY_FAILED` now permits another idempotent
LCD or faucet status read within the existing retry budget. gRPC verdicts remain
authoritative, and permanent errors/statuses, partial/submitted outcomes and
cancellation still veto retry throughout the cause chain. Client acquisition
remains outside the query ladder; faucet status remains caller-retried. The
allowance does not extend to other error categories or HTTP-like prose, including
identity-preflight HTTP failures. Credit POSTs retain their existing one-attempt
failure result.

HTTP-only 425 remains terminal. [RFC 8470 §5.2](https://www.rfc-editor.org/rfc/rfc8470.html#section-5.2)
requires replay without TLS early data; the SDK does not establish that guarantee
across native/injected fetch and LCD transports. This does not assert that native
Node fetch uses early data. Existing transient gRPC verdicts still take precedence
over HTTP 425. The 408 decision follows [RFC 9110 §15.5.9](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.9).

| Finding or decision | Confidence | Evidence |
| --- | --- | --- |
| Structured HTTP 408 stopped established LCD/faucet reads after one attempt | 100% | Before the classifier change, two LCD and five faucet regressions failed as expected; the thirteen negative controls passed. |
| Bounded 408 retry belongs on the existing query-error contract | 99% | Actual LCD conversion/routing and faucet responses recover and exhaust their budgets; other error categories and credit POSTs stay protected. |
| Keep HTTP-only 425 terminal until replay transport guarantees exist | 99% | The early-data requirement is explicit; this SDK exposes no universal replay control. Regression tests retain both terminal HTTP-only behavior and gRPC precedence. |

Focused validation passes all 156 tests in the classifier, LCD retry-isolation
and faucet suites, including 35 new cases. No dependencies or public types changed.

Integrated validation passes 3,800 tests with 17 existing skips across 175 files,
with no type errors. V8 coverage is 84.44% lines, 84.17% statements, 83.74% branches
and 88.09% functions; all thresholds pass. The browser checks pass with the normal
30-second test timeout and two-worker coverage configuration. Workspace builds,
workspace/E2E TypeScript, Biome, all nine package-integrity checks, all four bundle
budgets, architecture and coverage/type/workflow/dependency guards pass.
Workflow/dependency guard subprocesses initially failed without diagnostics under
the default temporary-directory setup; both pass using the task's writable cache.
The dependency audit passes its high/critical gate and reports seven low and four
moderate advisories in the unchanged dependency tree. Independent production/test
review found no concrete blocker (confidence 96%).

AggregateError policy, compiler tooling, optional reason-compatibility coverage
and the broader ENG-805 audit remain with their existing owners.

### PR #226 review clarification

[Claude's adversarial review](https://github.com/manifest-network/manifest-mcp-mono/pull/226#issuecomment-5620767563)
found no blocking regression and identified two optional clarifications:

| Finding | Confidence | Resolution |
| --- | --- | --- |
| The `TX_FAILED` table row does not distinguish a broadened 408 allowlist because the permanent-code veto independently protects it | 100% | Move the numeric-408 case beside the existing permanent transaction-error test. Keep `RPC_CONNECTION_FAILED` and `SIMULATION_FAILED` as the discriminating scope controls; retain the same number of tests. |
| Retry documentation could imply that typed SDK reads retry failed queries | 99% | Name `cosmosQuery` as the query-call retry owner and state that typed `/reads` helpers only apply rate limiting and cancellation. Distinguish connection retries, correct the blanket broadcast claim and its API comment, and align the 408 changelog entry. |

All 156 focused classifier/LCD/faucet tests, core TypeScript and Biome pass after
the test relocation. Independent review found no concrete blocker (confidence
98%). Runtime logic and public types are unchanged; removing comments yields
identical transpiled `cosmos.ts` JavaScript. The previous 3,800-test coverage
run remains applicable to that runtime; all five CI checks passed on `f2de246`,
including live SDK acceptance and the E2E gate. Full coverage and package builds
are not repeated for this documentation/test-organization correction.

One pre-existing hardening gap was retained under ENG-805 at PR #226 review
(P3, confidence 99%; addressed by the follow-up below):
`manageDomain` and `closeLease` can lose a successful mutation's hash/outcome when
the following verification read fails. Six isolated no-network probes (set,
clear and close, each with HTTP 503/408) confirm that a caller's whole-orchestration
`withRetry` can invoke a mocked successful mutation twice and receive the original
marker-free `QUERY_FAILED`. The 503 case predates this PR; numeric 408 adds a
trigger for the same gap. This proves orchestration re-entry, not two accepted
transactions or charged fees. No first-party whole-orchestration retry caller was
found, and real `stopApp` can return a no-op after reading a terminal lease.

The retained acceptance criteria are to preserve the actual submitted outcome,
transaction hash and verification cause, prevent whole-operation replay after
submission, and test both mutations and read-only lookup. A no-op close must not
invent submission evidence. Narrow deduplication found no dedicated owner;
completed related work and ENG-267's adjacent scope remain unchanged.


## Follow-up: mutation receipts across verification failures

The [focused plan](superpowers/plans/2026-09-10-eng805-verification-outcomes.md)
implements the two retained post-mutation criteria on base `7cc796a`.
`manageDomain` set/clear and `closeLease` now retain their typed core result and
wrap every later verification/result-handling failure in a fresh SDK error.
Structured code/message and original causes survive without changing upstream
errors or their frozen details. Actual transaction receipts add `sent: true`,
hash, confirmation and optional code, plus lease/domain/stop context. This
prevents `withRetry` from replaying the whole orchestration after submission.

Read-only lookup, pre-receipt errors, callbacks and successful public result
shapes are unchanged. `already_inactive` preserves outcome/state without
inventing submission evidence; normal retry classification applies to the preserved cause chain. Keeping a
previously discarded abort/permanent transport cause can correctly veto retry.
That result can also follow terminal reconciliation after a caught broadcast
error, so missing receipt data cannot prove that no broadcast was attempted.
Unconfirmed receipts likewise do not establish committed execution.

| Finding | Confidence | Resolution |
| --- | --- | --- |
| Retrying verification failures could re-enter successful mutation helpers | 100% observed; 99% conditional SDK-composition impact | Public orchestration regressions cover set, clear, stopped and cancelled outcomes with 408, 503 and raw transient failures. Each now invokes the mutation once. |
| Query metadata could attach an unrelated transaction code to an unconfirmed stop receipt | 100% | Omit that field when the actual stop receipt supplies no code; preserve the upstream details in the cause. Two red regressions now pass. |
| Oversized query diagnostics could displace receipt confirmation/domain fields in MCP output | 99% | Prioritize the four additional receipt fields in the existing bounded projection; exercise both receipt types through real `withErrorHandling`. Existing sent/hash/lease protections remain intact. |

No new dependency, public success type, retry option or global classification
rule is introduced. SDK error object identity changes only after a successful
core result. Consumer documentation lists exact fields and reconciliation
semantics; MCP retains bounded sanitized details without serializing the cause.
AggregateError and the other retained ENG-805 work remain separate.

Validation passes: **3,840 tests**, 17 skipped, across 176 files with no type
errors; 40 cases are new. Coverage is 84.49% lines, 84.22% statements, 83.85%
branches and 88.15% functions, with all global/query/transaction floors passing.
The receipt helper has 100% coverage across all four measures. The integrated
focused run passed 317 cases before the final permanent-cause control, which is
included in the full run.

Workspace builds/types, E2E types, Biome, dependency architecture, package
integrity, bundle budgets, the eight local MCP metadata cases, and coverage/type
harness negative controls all pass. Package validation was repeated after the
E2E type gate completed rebuilding dist; an initial overlap had observed the
transiently empty cosmwasm output. The required dependency audit reports the
unchanged seven low/four moderate findings and no high/critical findings.
Independent review found no remaining blocker (confidence 98%); its projection
and no-receipt wording observations are resolved (confidence 99% each).

Local live acceptance is unavailable because the dedicated XFS project-quota
mount is absent. The PR's live acceptance/E2E gate remains required before merge.
The 72 pre-existing untracked artifacts and both submodule pins are preserved.
These changes are implemented and unreleased; ENG-805 remains In Progress.

## PR #227 review: receipt provenance and callback documentation

[Claude's review](https://github.com/manifest-network/manifest-mcp-mono/pull/227#issuecomment-5622587856)
reported no blocking defect and raised two observations. Both are addressed in
this PR:

| Finding | Confidence | Resolution |
| --- | --- | --- |
| Upstream details can supply canonical receipt fields absent from the actual receipt | 100% helper-level reproduction; 98% assessment that no current first-party verifier producer supplies them | Filter the helper's nine canonical receipt keys against its actual receipt fields. Preserve unrelated diagnostics and the immutable original cause. Four receipt-shape regressions verify SDK and real MCP output; separate sent-only and partial-only controls preserve retry vetoes. |
| `QUERY_FAILED` documentation omits unexpected verifier errors that bypass `onFailure` | 100% | Document acquisition/query failures, unexpected decoding/spec/result errors, and the close success-state invariant separately in both orchestrators and the consumer guide. The outer wrapper adds no callback invocation. |

This is conditional metadata hardening: current built-in query/acquisition paths
have not demonstrated these foreign receipt details, but custom client behavior
can supply them. Filtering covers the canonical keys owned by this helper;
unrelated fields, including `partial` and transport diagnostics, remain intact.
An inactive result never gains an inferred `sent: false`; upstream submission
and partial-outcome evidence remains in the cause and continues to veto retry.
The existing transient inactive-read control still permits retry.

Five new cases failed before the filter and pass afterward. All **323 focused
tests** pass, including the orchestration, retry and MCP projection controls.
The two orchestrator modules emit identical JavaScript with comments removed;
callback behavior is unchanged. Independent review found no remaining gap
(confidence 99%).

All five CI checks passed on the preceding `b509c17` head, including live SDK
acceptance and the E2E gate. The final review revision passes **3,845 tests**,
17 skipped, across 176 files with no type errors. Coverage is 84.51% lines,
84.23% statements, 83.87% branches and 88.15% functions; all thresholds pass,
and the receipt helper retains 100% across all four measures. Agent-core's
build/type check and repository Biome checks also pass. The own-property check
uses an ES2020-compatible descriptor lookup that survives formatter rewrites.
CI will validate the new commit separately; this review adds no retained item
or public success-type/callback change.

## PR #227 re-review: rejection reasons, field spellings and lookup scope

[Claude's re-review](https://github.com/manifest-network/manifest-mcp-mono/pull/227#issuecomment-5623316498)
confirmed the existing receipt filter and cause-based retry protection, then
identified one omitted field, equivalent spellings and lookup documentation
imprecision. The response keeps the receipt contract qualified and explicit:

| Finding | Confidence | Resolution |
| --- | --- | --- |
| A foreign `rejection_reason` can appear beside the current rejected lease's outcome | 100% helper-boundary reproduction; 98% assessment that no current first-party verifier produces it | Exclude this free-form field and its equivalent spellings from outer details. A native REJECTED receipt and a frozen query error carry different reasons; the new regression proves neither reason reaches SDK/MCP receipt details while read retry and original causes survive. |
| Equivalent receipt-key spellings bypass the exact-name filter | 100% reproduction; same conditional reachability | Match the MCP projection's lowercase/underscore/hyphen normalization against the closed reserved-name inventory. Only exact canonical fields supplied by the receipt remain; extend all four native receipt-shape cases through SDK and MCP boundaries. |
| The consumer guide's callback/cause statements could include read-only lookup | 100% | Scope them explicitly to post-mutation verification. Document lookup's cancellation and NotFound branches, structured-error passthrough and plain-error normalization without a mutation receipt or outer cause wrapper. |

At `550c06a`, `transactionHash` and `transaction_hash` normalize to the same
receipt name, and `txHash` is also reserved. The following generic-name policy
records that revision; the next review amendment narrows it further. Bare `code` is independently
prioritized by MCP; bare `confirmed` and `outcome`
are neither equivalent to the qualified receipt names nor recovery-priority
fields. Those generic names and bare `hash` remain query diagnostics, alongside ordinary
HTTP/gRPC/transport details. Tests assert that they coexist with authoritative
`transaction_code`, `transaction_confirmed` and `stop_outcome`. The filter does
not infer that arbitrary diagnostic names describe another receipt. SDK callers
use the documented qualified fields for the mutation result; the original error
and its safety evidence remain available through the cause.

The old no-evidence test remains a no-fabrication control. It does not claim to
suppress `partial`; separate injected-evidence tests retain that flag and prove
its retry veto. The new reason case and four strengthened alias cases failed
before the implementation, while the other nine helper controls passed.

A further independent review established two related conditional failures with
built-runtime probes (confidence 100% reproduction, no actual broadcasts):

- A zero-width field spelling became `transactionHash` or `rejection_reason`
  after MCP display cleanup. Reserved-name checks now consider the exact same
  sanitized display key as MCP, as well as the original spelling.
- An enumerable diagnostic getter threw a raw retryable error while the wrapper
  spread upstream details, losing the successful receipt. A three-attempt probe
  replayed the post-receipt operation. The wrapper now copies enumerable data
  descriptors without invoking getters and tolerates diagnostic reflection
  failures; the original SDK error stays in the cause. A public `closeLease`
  regression verifies one mutation and one verification call.

These are custom-object/detail-key hardening cases; no current first-party
verifier producer was found to supply them. They are fixed in this revision,
with no deferred tracker item.

The final revision passes **3,849 tests / 17 skipped across 176 files**, with no
type errors and all coverage thresholds met: 84.51% lines, 84.23% statements,
83.87% branches and 88.19% functions. The helper retains 100% across all four
measures. The PR now adds 49 regression cases in total. All 327 focused
orchestration/helper/retry/MCP tests, agent-core build/types and Biome pass.
Before the final metadata fix, six helper cases failed and ten controls passed;
the new public getter regression independently failed while the other 34 close
tests passed. These tests prove operation invocation counts at controlled
boundaries, without broadcasting transactions.

Independent code and documentation review found no remaining blocker
(confidence 98–99%). All five CI checks, including live acceptance and the E2E
gate, passed on preceding head `55b6162`; the new revision requires its own CI.
Local XFS project quotas remain unavailable. ENG-805 stays In Progress with
11 unchecked criteria; its two implemented post-mutation criteria remain
PR-open and unreleased. All 72 pre-existing untracked artifacts, both submodule
pins and the unrelated release branch are preserved.


## PR #227 review amendment: native receipt aliases and error inspection

[Claude's next review](https://github.com/manifest-network/manifest-mcp-mono/pull/227#issuecomment-5624326560)
confirmed the previous spelling/accessor regressions, then asked whether native
`confirmed` and `outcome` should remain query diagnostics and identified an
unguarded code/message read. The native-name argument changes the earlier
policy decision: these names are receipt aliases, even though MCP does not give
them recovery priority.

| Finding | Confidence | Resolution |
| --- | --- | --- |
| Foreign bare `confirmed` / `outcome` can contradict the qualified receipt fields | 100% helper/SDK/MCP reproduction; 99% rationale for the narrower policy | Reserve both native names and their normalized/display-cleaned forms. Four receipt-shape cases inject conflicting receipt-like values. Keep `code`, `hash`, `committed` and ordinary HTTP/gRPC details as diagnostics. |
| Throwing SDK code/message accessors can discard the receipt during error construction | 100% controlled reproduction | Guard reads independently, preserving the other readable field and original error. An unavailable code becomes `QUERY_FAILED`; an unavailable message becomes stable fallback prose. Ordinary raw-error prefixes remain. |
| Query callback message formatting can replace the original verification cause before wrapping | 100% public-orchestration reproduction | Reuse guarded message formatting in both post-mutation query catch paths. Existing notifications and readable callback reasons remain; accessor failures preserve the original query error in the cause. |

The helper also tolerates failed thrown-value string conversion and prototype
inspection at its construction boundary. These remain custom-error hardening
cases: no current first-party verifier was found to produce these native detail
keys or throwing accessors (98–99% assessment confidence). The pre-fix helper
run failed nine cases while twelve controls passed; the three new public close
cases failed while the other 35 tests passed. Probes measure operation
invocations without real broadcasts or claims about accepted transactions/fees.

`already_inactive` can follow terminal reconciliation after a broadcast error;
contrary to the review's premise, it does not establish that no broadcast was
attempted. The wrapper adds no inferred sent flag to that result. This revision
hardens post-mutation error construction; global retry cause traversal and
classification are unchanged and can still reject on pathological custom cause
accessors/proxies. Ordinary transaction-receipt errors still veto retries before
classification inspects their original code/message accessors. The revoked-proxy
regression deliberately asserts only the wrapper's construction boundary. No
new retained tracker item or broader hostile-object guarantee is introduced.

Final validation: **3,857 tests pass / 17 skip across 176 files**, no type
errors; all 335 focused orchestration/helper/retry/MCP checks pass. The PR now
adds 57 regression cases in total. Coverage meets every threshold: 84.54% lines,
84.27% statements, 83.91% branches and 88.22% functions; the helper remains 100%
across all four measures. Agent-core build/types and Biome pass. Independent
code/docs/test review found no remaining blocker (98–99% confidence).

All five CI checks, including live acceptance and the E2E gate, passed on
preceding head `550c06a`; the new revision requires its own CI. Local XFS quotas
remain unavailable. ENG-805 stays In Progress with 11 unchecked criteria; the
two post-mutation criteria remain implemented, PR open and unreleased. All 72
pre-existing artifacts, submodule pins and the unrelated release branch are
preserved. No new retained item was added.


## PR #227 final review: inactive-result type documentation

[Claude's final review](https://github.com/manifest-network/manifest-mcp-mono/pull/227#issuecomment-5624679553)
confirms that `df28fd7` closes both implementation items and reports no new
runtime finding. All five CI checks on that commit pass, including live SDK
acceptance and the E2E gate.

The review repeats that `already_inactive` implies no broadcast. Tracing that
wording exposed a remaining documentation gap: the exported `StopAppResult`
comment also made that claim, although the consumer guide already distinguishes
terminal pre-query results from reconciliation after a failed blocking
broadcast. The type comment now states that distinction and promises only that
no transaction receipt is returned. Confidence: 100% from control flow and the
existing ACTIVE-to-CLOSED and PENDING-to-REJECTED reconciliation tests.

This revision changes comments and the implementation record only. `stopApp`
emits byte-identical JavaScript with comments removed; Biome and diff checks
pass. Existing reconciliation regressions already cover the described behavior,
so no tests were added or rerun for this prose change. The previous validation
remains 3,857 pass / 17 skip, 335 focused checks and 57 new PR regressions, with
all coverage thresholds met. Independent review confirms the correction (100%
confidence). The documentation commit requires its own CI; the PR remains open
and unreleased. ENG-805 retains 11 unchecked criteria, unchanged owners/triage
and no new deferred item. All 72 pre-existing artifacts, submodule pins and the
unrelated release branch remain intact.


## PR #227 review: close teardown rejection documentation

[Claude's next review](https://github.com/manifest-network/manifest-mcp-mono/pull/227#issuecomment-5634520238)
accepts the inactive-result type correction and identifies a remaining
`closeLease` clause claiming only ACTIVE broadcast failures or the
PENDING-to-ACTIVE race propagate as-is. The rewritten teardown `@throws`
paragraph now covers the actual branches:

- Initial query, validation and cancellation failures can reject teardown.
- Either an ACTIVE close or a PENDING cancel attempt can fail. A non-cancellation
  failure in blocking mode can instead converge to `already_inactive` when the
  re-query finds a terminal lease, returning no transaction receipt.
- A PENDING cancellation whose re-query finds ACTIVE raises a new `TX_FAILED`;
  other unresolved attempt failures retain their original error.
- `closeLease` forwards whichever rejection `stopApp` produces unchanged,
  without notifying `onFailure`; that callback belongs to later verification.

Confidence: 100% from the control flow and existing close/cancel reconciliation,
unchanged-state, failed-query and callback regressions. The related wording
search found no second copy of the overstatement (99% confidence). This is a
comment-only source correction; `closeLease` emits byte-identical JavaScript
with comments removed. Existing tests already cover the described paths, so no
new tests or runtime retesting are needed for the prose change.

Independent review confirms the revised paragraph (100% confidence). Biome
and diff checks pass. The unchanged runtime remains backed by 3,857 passing
tests / 17 skipped, 335 focused checks and 57 new PR regressions, with all
coverage thresholds met. All five CI checks passed on `6f4000a`, including live
acceptance/E2E; the new documentation revision requires its own CI.

The review's pre-existing reconciliation-diagnostics observation is recorded
as an optional P3 core contract extension, not a blocker or a reopened criterion.
Confidence is 100% in the source-level evidence loss: first-party failed
DeliverTx errors can carry actual hash/code/height, but terminal reconciliation
returns only the inactive result and discards that error. A future design would
preserve those actual diagnostics separately from observed state and carry them
through later verification failures, while distinguishing pre-submission errors
from hash-bearing transaction failures. It must never infer submission from
terminal state alone. This PR preserves the result that core actually returns.

The claim that a retry never broadcasts again is conditional on its next
pre-query reporting terminal. There is no persistent guard across invocations;
a stale ACTIVE/PENDING response can reach another attempt (99% control-flow
confidence, not demonstrated duplicate execution or fees). Cancellation and
nonblocking errors bypass this reconciliation branch. The current no-receipt
contract is already documented, and a narrow tracker search found no dedicated
outstanding reconciliation-diagnostics criterion. The optional extension is
recorded in ENG-805's review comment; its 11 unchecked criteria and two checked
post-mutation criteria retain their existing scope. The PR remains open and
unreleased. All 72 pre-existing artifacts, submodule pins and the unrelated
release branch are preserved.

## Follow-up: failed teardown reconciliation diagnostics

The [focused plan](superpowers/plans/2026-09-11-eng805-reconciliation-diagnostics.md)
implements the optional P3 extension on merged PR #227 (`e1f3ca2`). It leaves
the two completed receipt criteria and the prior 11 ENG-805 criteria intact.
The review below retains two additional inclusion-timeout criteria separately.

`stopApp` attaches a frozen optional `reconciliation` snapshot when a caught
blocking failure is followed by a terminal re-query. The PENDING-to-ACTIVE cancel
race also retains the snapshot and known lease ID in its existing TX_FAILED error. It preserves the
original thrown value non-enumerably without mutation, copying only bounded
machine metadata from own data properties. Generic code/height/confirmation fields
require explicit sent:true before promotion; a qualified hash can survive without
that marker and does not prove inclusion. Both failed DeliverTx producers record
submission and inclusion explicitly. Terminal observation, failure
category and missing hash do not establish submission or non-submission.

Close-verification and completed teardown-recovery errors retain the snapshot.
Successful close verification also forwards it through the optional
CloseLeaseResult.reconciliation field and onComplete, mirrored by MCP outputSchema.
Explicit `reconciliation.sent: true` adds the existing outer submission retry
veto; failed-transaction metadata stays separate from successful receipts and
lease state. The later verification error remains the cause, with the earlier
teardown error available through `reconciliation.error`. Retry classification
does not traverse this sibling error or expand grouped-error policy. MCP keeps
the machine snapshot within its existing response budget; the earlier raw error
does not serialize through either successful JSON or error projection.

| Finding | Confidence | Regression evidence |
| --- | --- | --- |
| Terminal reconciliation discarded a real failed DeliverTx's evidence | 100% | Real `stopApp` → `cosmosTx` → billing handler with mocked signing/query wire reproduces missing metadata for ACTIVE and PENDING; preparation failure and no-receipt broadcast rejection remain distinct controls. |
| A transient later verifier could authorize another teardown invocation | 100% observed; 99% conditional submission impact | Public `closeLease` with real `withRetry` invokes `stopApp` twice before propagation; the patch carries explicit submission evidence as a retry veto. Whether a repeated invocation broadcasts depends on its next pre-query. No duplicate accepted execution or fees are demonstrated. |
| Large unrelated MCP diagnostics could crowd out the snapshot | 100% | A red bounded-projection regression loses `reconciliation`; prioritizing it preserves the machine fields while excluding the non-enumerable original error. |

Initial revision `d4076ca` validation: **3,903 tests**, 17 skipped, across 177 files with no type
errors; 46 cases are new. Coverage is 84.64% lines, 84.36% statements, 84.08%
branches and 88.26% functions, with all global/query/transaction floors passing.
`stopApp` has 100% line/function coverage and 97.36% branch coverage; the
verification-outcome helper has 100% across all four measures. The 495 focused
core/agent/MCP checks, workspace build/types, E2E types, eight type-harness checks,
architecture, package integrity, bundle size, eight live MCP metadata checks and
Biome pass. A type-only import mistake in the new SDK assertion was corrected
and the SDK type check rerun successfully.

Independent review caught and corrected a cancellation compatibility regression:
readable accessor/inherited cancellation codes retain the previous direct-read
behavior under a guard, while copied diagnostics remain descriptor-only. Both
forms have passthrough regressions (100% confidence). Final independent review
found no further blockers (99% confidence). Live chain acceptance requires PR CI;
no local broadcasts were made. Consumer docs and SDK type assertions cover the
additive contract. No dependency, submodule or release-version change is part of
this slice. The work remains unreleased.


## PR #228 review corrections — 2026-09-11

[Claude's execution-verified review](https://github.com/manifest-network/manifest-mcp-mono/pull/228#issuecomment-5636910930)
identified five gaps. The supplied patches were inspected and their relevant
source/test hunks reused, with current documentation merged by hand. Independent
regressions reproduce the core and public-result defects before correction.

| Finding | Disposition | Confidence |
| --- | --- | --- |
| Multi-message failed DeliverTx lacks sent/confirmation metadata | Align buildExecuteTxResult with buildTxResult and pin the public executeTx error details. | 100% |
| PENDING-to-ACTIVE cancel race discards its failed-attempt error | Preserve the frozen snapshot, known lease ID and explicit sent:true on the existing non-retryable TX_FAILED envelope. Preparation-failure controls retain unknown/false submission. | 100% |
| Successful close verification drops the snapshot | Include optional CloseLeaseResult.reconciliation and forward the same object to onComplete; expose machine fields in MCP structured content/outputSchema. This deliberately extends the earlier state-only success contract. | 100% evidence loss; 99% scope choice |
| Generic code/height/confirmed can be renamed to transaction facts before submission | Gate promotion on sent===true, retaining validated qualified transactionHash independently. Test real preparation failures plus false/unknown/truthy-marker controls. | 100% mechanism; 99% conditional consumer impact |
| Deploy tool description omits new recovery fields | Document nested diagnostics, explicit sent and transactionConfirmed semantics on the wire, and cover listTools. A hash alone does not establish inclusion; no model misinterpretation is claimed as observed. | 100% documentation gap |

The proposed descriptions were narrowed: a reconciled attempt need not have
consumed fees or been included, and a qualified hash alone does not establish
inclusion. Existing cancellation-accessor behavior remains intentional and
covered. Re-query failures still preserve the original transaction error, and
the two propagation sites retain their distinct surrounding receipt contracts.
No shared helper or cosmetic hash-regex change is needed.

The separate pinned CosmJS inclusion-timeout path loses **structured** evidence:
its real broadcastTx implementation receives a txId from broadcastTxSync, then
can throw TimeoutError(message, txId) while polling. A no-network producer probe
confirms one invocation of the mocked broadcastTxSync and one getTx poll,
without a network submission. The class retains Error as its name;
enrichTxError drops its txId property and original cause, though the hash may
remain in message prose. Evidence-loss confidence is 100%; conditional retry
impact is 99%, without demonstrated duplicate execution or fees. A narrow
tracker search found no dedicated owner (98%). Two new ENG-805 criteria retain
owned-boundary provenance, validated txId/cause preservation and downstream
retry/negative controls. They remain outside this correction; the tracker now
has 35 checked / 13 unchecked criteria. Arbitrary timeout objects never establish
submission or inclusion.

Combined review validation passes: **3,921 tests / 17 skipped / 177 files**, no
type errors; **18 new regressions**. Coverage is **84.65% lines / 84.37% statements /
84.14% branches / 88.26% functions**, with all configured floors passing. The
316 focused core/close/MCP regressions, workspace build/types, E2E types, package
integrity, architecture, bundle size, eight live MCP metadata checks and eight
type-harness checks pass. Biome and whitespace checks pass.
Independent final review found no blockers (99% confidence). Fresh PR CI is
required for the updated commit. All 78 current untracked artifacts, including
the six supplied review files, remain preserved.

## PR #228 documentation and test review — 2026-09-14

[Claude's second review](https://github.com/manifest-network/manifest-mcp-mono/pull/228#issuecomment-5664586148)
verified the five earlier corrections and identified two minor gaps. Neither
requires a runtime change.

| Finding | Correction and evidence | Confidence |
| --- | --- | --- |
| The generic transaction_hash assertion also matches the already_inactive sentence | Pin the distinguishing stopped/cancelled receipt clause. All 61 server tests pass; removing only that clause makes the targeted test fail while the inactive sentence still contains the generic substring. The temporary source edit was restored byte-for-byte. | 100% |
| README tables imply every close orchestration broadcasts close-lease | Align agent and node tables with the implemented flow: confirm, cancel PENDING or close ACTIVE, or observe an already terminal lease without broadcasting, then verify terminal state. | 100% |

The SDK README also lists the existing StopAppReconciliation type export from
/orchestration alongside the root and /deploy exports (100% confidence from the
re-export chain). Independent documentation review found no further gap (99%
confidence). Biome and whitespace checks pass. This correction strengthens an
existing test, so it adds no test cases; the full-suite figures above describe
the previous revision. Fresh CI will validate the pushed revision. All 79 current
user artifacts are preserved. ENG-805 remains In Progress with 35 checked / 13
unchecked criteria, including the separate inclusion-timeout follow-up.

PR #229 subsequently advanced the base to 9bfdade, preventing PR CI because of
adjacent CHANGELOG entries. Merging the base preserves both ENG-944 storage
pricing and ENG-805 reconciliation; independent review found no lost behavior
in the overlapping files (98% confidence). The combined revision passes a fresh
workspace build, TypeScript, Biome and full coverage: **3,983 passed / 17 skipped /
178 files**, no type errors, **84.76% lines / 84.47% statements / 84.27% branches /
88.30% functions**, with all configured floors passing. The additional cases
come from the updated base; PR #228 still contributes 64 regressions. The live
acceptance result remains a separate PR CI check.

## Follow-up: evidence after accepted submission — 2026-09-14

The [focused plan](superpowers/plans/2026-09-14-eng805-inclusion-timeout-evidence.md)
addresses the two inclusion-timeout criteria retained from PR #228, starting from
its merged commit `12af628`.

SDK-created signing clients now observe their native CheckTx broadcast on a fresh
per-call receiver. Initially, a format-validated accepted hash established
submission independently of the later error's class, message or claimed txId. If blocking inclusion polling
then rejects, including the native inclusion timer or an RPC lookup failure, a
fresh error retains exactly sent:true and transactionHash plus a non-enumerable
cause. Raw failures use non-retryable TX_FAILED; readable structured cancellation
keeps OPERATION_CANCELLED. No confirmation, transaction code or height is inferred.
At this stage, custom broadcast implementations, pre-acceptance errors and invalid
hashes kept their existing behavior; the fifth review below binds accepted evidence
to the signed bytes and rejects mismatched RPC hashes. The wrapper reuses CosmJS
signing/polling and preserves sequence views and concurrent-call isolation.

Cosmos and multi-message transaction entry points retain their operation context
and the owned error's cause chain. Existing teardown reconciliation forwards the
sparse snapshot through success, callbacks, later verification and recovery.
Explicit submission evidence prevents whole-orchestration retry without claiming
that the transaction was included or that the teardown succeeded.

| Finding | Evidence and correction | Confidence |
| --- | --- | --- |
| Native inclusion timeouts lose structured txId and original cause | Real pinned signing/broadcast/poll methods with isolated signing and Comet seams reach the native timer. Disabling manager guard installation makes the integration test fail; restoring it passes. | 100% |
| A later RPC lookup rejection loses the same observed submission facts | Preserve the accepted native hash regardless of the later exception type; conflicting error metadata cannot supply hash/code/height/confirmation. | 100% event ordering; 99% scope choice |
| Hostile retained causes can replace the submitted error during retry classification | Four public transaction regressions reproduce replacement by revoked-proxy or cause-getter exceptions. Honor an already-decisive outer verdict before traversing irrelevant causes; all four pass after correction. | 100% conditional mechanism |

The pathological-cause cases are injected controls, not observed native RPC
payloads. The retry correction protects decisive outer verdicts; it does not
establish a universal exception-safe contract for arbitrary custom retry inputs.
The existing cause-only boundary and separate grouped-error policy remain intact.
Caller cancellation retains its existing precedence and conservative sent flag;
its prompt response does not wait for the later inclusion result to acquire a hash.

Initial boundary and test review found no remaining blocker in this slice
(98–99% confidence). Validation caught and corrected an untyped test receiver.
The bare disconnect mock inferred Vitest's `Procedure`, creating an undeclared
`@vitest/spy` reference; an explicit callable type removed that reference without
adding a dependency. The separately vendored Comet/protobuf declarations remained
until the PR #230 review correction below. The shared transaction test helper
also uses a consistent promise return type. A
legacy total Stargate mock was updated to preserve native exports; its then-59 tests
pass again. Documentation review narrowed the SDK's raw-error exclusion to
failures before observed acceptance (99% confidence in that documentation gap).

Initial local validation: **4,039 passed / 17 skipped / 181 files**, no type errors;
**56 new regressions**. Coverage is **84.85% lines / 84.57% statements / 84.38%
branches / 88.49% functions**, with all configured floors passing. Workspace
build/types, E2E types, Biome, whitespace, architecture, package integrity, bundle
budgets, eight MCP metadata checks and eight type-harness checks pass. The two
criteria are implemented and locally validated; PR CI and merge status are
recorded in Linear. The other eleven criteria remain separate, and this work is
unreleased. All 80 pre-existing user artifacts are preserved.

### PR #230 review corrections — 2026-09-14

[Claude's review](https://github.com/manifest-network/manifest-mcp-mono/pull/230#issuecomment-5668357367)
identified two regressions, three small improvements and two separate existing
gaps. Each finding was checked against the implementation before correction.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| Parameterized reconciliation tests dropped hidden-property guards | Restore both `not.toHaveProperty` assertions. Injecting non-enumerable `sent` or `transactionConfirmed` makes all three unowned-error controls fail; structural equality alone misses them. | 100% |
| Exported fixture signatures vendor transitive declarations | Use local callable/result contracts for both RPC mocks and the signing spy. The original disconnect correction did not cover these additional inferred types. Fresh core declarations import only declared dependencies; its 359-file tarball contains zero vendored `node_modules` files, without adding dependencies or exemptions. | 100% mechanism and artifact result |
| Unsupported native broadcast methods silently skip protection | Return installation status and warn through the existing client logger. Both customized-method warning regressions fail before correction; native initialization remains silent. | 100% missing warning; 99% correction |
| Exact transaction-hash validation is duplicated | Share one internal validator between observed acceptance and reconciliation. Boundary tests cover case, length, non-hex, trailing line terminators and non-string values. | 100% duplication; 99% equivalence |
| Attribution is split from its provenance module | Move the unchanged helper into `broadcast-failure.ts`; remove the forwarding module. Existing public attribution/cause tests verify the consolidation. | 100% import coupling; 98% simplification choice |
| Caller cancellation after acceptance loses the known hash | Track [ENG-952](https://linear.app/liftedinit/issue/ENG-952). Prompt cancellation settles before the guard's failure; preserve its current terminal behavior in this PR. The follow-up must share already-observed per-call evidence without delaying cancellation. | 100% mechanism |
| Unreadable causes on custom nonterminal retry inputs replace original errors | Track [ENG-953](https://linear.app/liftedinit/issue/ENG-953). The decisive outer verdict protects this PR's submitted errors; exception-safe standard cause inspection remains separate from grouped-error policy. | 100% mechanism |

A new public `cosmosTx` regression combines an active caller signal, the cached
sequence wrapper and the owned broadcast guard. It proves cached sequence use,
one submission/poll, sparse attributed evidence, original causes, cache
invalidation and no retry. The six refuted review claims remain refuted; the
wrapper interaction had a coverage gap, with no demonstrated runtime defect.

Focused validation passes 200 boundary/client/hash/transaction tests and 21
public timeout tests. Both hidden-property mutations fail all three unowned-error
controls; missing-warning mutations fail both customized-method controls.
Workspace build and type checks, E2E types, Biome, architecture, package integrity
and bundle budgets pass. The E2E type-check prerequisite rebuild initially
overlapped lint and package inspection; both checks pass when run against the
completed build. Full coverage and fresh PR CI results are recorded on the PR
and in Linear. Independent review of the corrections found no further issue
(98–99% confidence).

ENG-952 and ENG-953 are separate Backlog child issues with acceptance criteria.
The existing tracker remains In Progress with 37 checked / 11 unchecked criteria;
these two additional child issues remain open alongside those eleven criteria.
PR #230 remains open and unreleased.

### PR #230 second review — 2026-09-14

[The re-review](https://github.com/manifest-network/manifest-mcp-mono/pull/230#issuecomment-5669869001)
verified the prior five fixes and identified the following remaining details.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| Manager warnings are silent in MCP servers | All five server constructors now attach their existing leveled stderr logger before client initialization. A real-manager regression fails for all five warning cases before the wiring; silent-level controls remain silent. The README also qualifies behavior for SDK consumers without a logger. | 100% missing wiring; 99% correction |
| Fixture attribute types span incompatible protocol generations | Use Comet38 string attributes and privately check `broadcastTxSync` and `txSearchAll` against the accepted Comet client union with `satisfies`; `status` and `disconnect` remain partial. An in-memory compiler mutation restoring the broader attribute union fails at that check. The next review narrows the check to one protocol generation. | 100% |
| Initialization comments contain stale diagnostic counts | Describe their purpose without brittle numeric counts. | 100% |
| Signal-state assertion cannot detect a production regression | Remove it; retain the assertion that the actual rate-limit acquisition receives the caller's signal. | 100% |
| Historical declaration fixes remain ambiguous | Separate the earlier `@vitest/spy` reference from later vendored Comet/protobuf files. Original logs show the former disappearing while the 375-file tarball remains unchanged, so the claim that disconnect was never involved is incorrect. | 99% historical attribution |
| Owned/public tests miss hidden inclusion fields | Explicitly assert absence of generic and qualified inclusion fields on both error layers. Separate hidden `confirmed` and `transactionHeight` mutations each fail the selected owned, `cosmosTx` and `executeTx` controls. | 100% demonstrated coverage gap |

The constructor regression uses the real manager and native signing client with
its connection replaced and a `broadcastTx` spy that makes guard installation
unsupported; it checks warning delivery, silent-level behavior,
single initialization and absence of signing/broadcasting. Public error tests
continue to check the original cause and sparse submission evidence. Full
validation and PR CI results are recorded on the PR and in Linear. ENG-952 and
ENG-953 remain separate; no cancellation or retry policy changes are included.

Focused validation passes 261 server/logger tests and 35 owned/public error
tests. Fresh declarations retain Comet38 string attributes, import only declared
dependencies and contain no vendored `node_modules` files. Workspace build,
E2E types, formatting, architecture, package integrity and bundle gates pass;
the full coverage and fresh CI results are recorded with the review response.

### PR #230 third review — 2026-09-15

[Claude's latest review](https://github.com/manifest-network/manifest-mcp-mono/pull/230#issuecomment-5684358143)
verified the preceding corrections and found one default CLI startup defect and
five smaller runtime or test-contract gaps.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| dotenv's default startup banner writes to MCP stdout | Load environment configuration with `quiet: true`. An isolated child process using real dotenv reproduces the pre-fix banner; regressions cover environment loading and all five built CLI startup paths. At this revision, explicit dotenv debug/banner environment overrides retained upstream behavior. **Superseded by the fourth review below:** the final loader uses parse/populate and never activates dotenv diagnostics. | 100% reproduction; 99% correction |
| Logger test watches `console.log` but misses direct stdout writes | Also guard `process.stdout.write`, the actual protocol stream. Retain the console guard because Vitest intercepts console output separately. | 100% |
| Hidden details outside a six-name denylist survive | Share an exhaustive top-level own-key and strict-value assertion through the existing test utilities. Owned errors permit only `sent` and `transactionHash`; attributed errors additionally permit their specific operation context. Top-level hidden `deliverTx` objects, undefined-valued keys and symbol keys are rejected; nested values use Vitest strict equality. | 100% |
| `Pick` over a client union accepts mixed protocol generations | Privately select the concrete Comet 0.38 member through Stargate's declared parameter type, then check `broadcastTxSync` and `txSearchAll`. All-TM34 and both mixed-generation mutations fail compilation; `status` and `disconnect` remain intentionally partial. | 99% |
| Silent logging tests cannot prove the manager reached the configured sink | Both warning and silent cases now assert the actual shared `logger.warn` invocation with passthrough. Stderr presence or absence then proves the level decision on that sink. | 100% |
| Compatible holders overwrite a shared initialization logger | Ignore the exact default `noopLogger`; document and test that the last other sink wins and holder disconnect does not restore a prior sink. A server can still replace a compatible SDK holder's custom initialization sink by this explicit policy; distinct wallet-provider adapters provide isolation. Per-client SDK logging is unchanged. | 100% mechanism; 98% bounded policy |

The proposed separate dotenv exact-pin issue was not a general policy violation:
`CLAUDE.md` and `scripts/version.mjs` constrain internal workspace siblings, while
[ENG-538](https://linear.app/liftedinit/issue/ENG-538) explicitly distinguishes
external dependency ranges from those lockstep pins. That review left the range
unchanged (99% confidence in the policy distinction); the next review revisits
the narrower case of a terminal CLI dependency that crosses no consumer API.

The earlier constructor-test wording now includes the unsupported `broadcastTx`
override, the RPC check names its two covered methods, and the historical test
count is explicitly historical. Logger API documentation also distinguishes
immutable wallet/configuration ownership from shared initialization diagnostics
and no longer claims the placeholder SDK `logLevel` applies a level gate.

Validation evidence and the final head are recorded in the PR response and
Linear. ENG-805 remains In Progress with its eleven unchecked tracker criteria
and the two Backlog children added during this PR, ENG-952 and ENG-953; this
revision adds no deferred finding. Those two are a subset of the tracker's children.

### PR #230 fourth review — 2026-09-15

[The next review](https://github.com/manifest-network/manifest-mcp-mono/pull/230#issuecomment-5686002516)
verified the previous six fixes, including real JSON-RPC sessions through all
five CLIs, and identified these additional gaps.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| Child-process deadline exceeds the default test budget | Give the subprocess cases an explicit 30-second test budget around their 20-second child deadline, including plain workspace test runs. | 100% structural mismatch |
| Dotenv environment settings bypass `quiet: true` | Read the optional working-directory `.env`, then use dotenv's parser and non-overriding population without its logging wrapper. Process and file values cannot enable diagnostics; existing environment values and dotenv parsing semantics are preserved. Merely deleting flags before `config()` would not handle flags loaded from the file. | 100% reproduction; 99% correction |
| Built-only tests can pass against stale output | Exercise the current configuration source in isolated child processes. Before built CLI probes, compare embedded source-map content with current config, bootstrap and entrypoint source; report an actionable rebuild failure on drift. This protects the named startup paths, not every transitive workspace artifact. | 99% |
| Exact-details helper does not inspect nested hidden fields | Explicitly scope its JSDoc to all top-level own keys and Vitest strict value equality. Nested hidden-key traversal is not claimed; no production nested-field leak was identified. | 100% scope correction |
| A future Comet union can select multiple generations | Require exactly one selected member; zero or multiple matches become `never` and fail the fixture's existing `satisfies` check. A synthetic fourth-member mutation is accepted by the old selector and rejected by the corrected selector. | 99% |
| Logger default suppression depends on identity | Document that only the exact exported `noopLogger` instance is ignored. A custom silent logger is an explicit sink assignment. The existing last-writer policy is unchanged. | 100% |
| Terminal CLI dependency range permits unreviewed parser changes | Pin dotenv to the already locked 17.4.2; no installed dependency version changes. ENG-538's shared-library compatibility rationale does not require a range for this private CLI implementation detail. | 99% |
| Tracker wording implies only two Backlog children exist | Name the two added during this PR. The verified current total is seven children: six Backlog and ENG-807 Done. | 100% Linear verification |
| User-visible logging changes are absent from the changelog | Add Unreleased entries for CLI stdout protection and shared initialization logging behavior. Document plain `.env` loading and that dotenv control variables no longer activate vault loading. | 100% |

The parser is retained deliberately: native Node environment parsing differs
for escaped carriage returns and colon assignments, including byte-sensitive
password values. No new environment parser or global console interception is
introduced. Validation, mutation evidence and fresh PR checks are recorded in
the review response and Linear. ENG-805 stays In Progress with its eleven
unchecked tracker criteria; this round adds no deferred issue.

### PR #230 fifth review — 2026-09-15

[Claude's full-diff review](https://github.com/manifest-network/manifest-mcp-mono/pull/230#issuecomment-5687219033)
verified the previous corrections and identified these remaining gaps. This pass
also reviews the complete PR against its merged base, including the initial
feature tests.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| RPC hash format validation does not bind evidence to the submitted transaction | Snapshot signed bytes and calculate SHA-256 with the already installed CosmJS crypto package, now declared directly. After native CheckTx resolves, compare its returned hash to the local digest. Wrong length/value rejects before any real lookup and retains local sent/hash evidence. Rejection runs through native polling cleanup; no unrelated lookup or rebroadcast occurs. Undecodable responses that reject before observed acceptance keep their existing behavior. | 100% gap; 99% correction |
| Injected lookup cancellation is mistaken for real caller cancellation | Rename tests and narrow public documentation. Those controls preserve custom lookup error codes. Actual caller cancellation settles through the outer synchronous abort listener; forwarding accepted local hash evidence remains [ENG-952](https://linear.app/liftedinit/issue/ENG-952). | 100% |
| Initial integration tests still allow extra hidden details | Apply the shared exact top-level details assertion to both owned and attributed errors; preserve explicit cause descriptors. | 100% |
| Built startup checks omit keyfileWallet and discard JavaScript bytes | Traverse actual built static relative imports within node/dist, including keyfileWallet. Check nonempty code, source-map linkage and current embedded inputs. Workspace package imports retain the normal build prerequisite. This is a freshness guard, not an integrity verifier for arbitrary rewritten JavaScript/map pairs. | 100% gap; 99% correction |
| Built config loading lacks behavioral coverage | Restore a child-process assertion that reads .env values through dist/config.js. Omitting only the compiled loadDotEnv call fails even with the original map; source-only tests remain independent. | 100% |
| The dotenv caret can return without a policy failure | Enforce exact external runtime and optional dependency versions for published CLI packages. Mutation controls reject caret, tilde, comparator and tag declarations; library, peer and development ranges remain allowed. | 99% policy |
| Closed toJSON output does not prove cause non-enumerability | Remove redundant JSON assertions on ManifestMCPError; retain direct property-descriptor checks. The separate plain-object reconciliation JSON assertion remains useful. | 100% |
| The executeTx cancellation test does not guard internal catch ordering | Name the caller-observable cancellation behavior accurately. Keep catch checkpoint order consistent with cosmosTx; moving it cannot change the already-settled abort response or solve ENG-952. | 100% |
| Throwing initialization diagnostics leak a connected signing client | Extend cleanup across all post-connect initialization. Both warning branches release the transport and permit a fresh initialization even when cleanup also throws; existing error normalization remains unchanged. | 100% |
| Guard status conflates already-installed and unsupported methods | Recognize the one private wrapper function, with native SYNC still required. Reinstallation succeeds without another wrapper; customized SYNC still reports unsupported. | 100% |
| Fixture options and import paths imply unsupported variation | Remove unused chainId/timeout/poll options and use the existing shared test-utility barrel consistently. Derive normal fixture wire hashes from actual submitted bytes. | 100% |
| Historical dotenv row describes superseded behavior as current | Mark the third-review loader and override behavior explicitly superseded by the fourth review. | 100% |
| Cold subprocesses repeatedly compile the same dependencies | Share a suite-owned temporary Node compile cache and remove it afterward. | 99% |
| Source-map failures hide the diagnostic cause | Retain the original cause behind the rebuild guidance, including corrupt JSON and stale inputs. | 100% |
| Plain node tests require a build without command guidance | Document the root build prerequisite and source-map checks in CLAUDE.md, including workspace and targeted test commands. | 100% |

Hash mutation tests fail against the prior guard and pass with the correction.
They cover wrong-length and unrelated 32-byte hashes, caller byte mutation,
per-call concurrency, idempotence, native deadline cleanup and a mismatch arriving
after the deadline. CLI negative controls cover stale keyfile input, corrupt map,
empty built JavaScript and omitted built environment loading without modifying
tracked files or dist. Full validation and fresh CI/live results are recorded on
the PR and in Linear. This round adds no deferred issue; ENG-952/ENG-953 and the
existing eleven unchecked tracker criteria remain separate.

Local validation passes **4,107 tests / 17 skipped / 184 files**, with no type
errors and every coverage floor passing: **84.87% lines / 84.60% statements /
84.40% branches / 88.41% functions**. Build, workspace/E2E types, Biome,
architecture, package integrity, bundle budgets, twenty dependency-hygiene checks,
eight metadata checks and eight type-harness checks pass. Core still packs
359 files without vendored dependencies. This revision adds seven runtime tests;
the PR adds 124 relative to its merged base, plus three dependency-policy checks.
