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

## Follow-up: caller cancellation after accepted submission — 2026-09-16

[ENG-952](https://linear.app/liftedinit/issue/ENG-952) closes the separate caller
cancellation gap retained by PR #230. The
[implementation plan](superpowers/plans/2026-09-16-eng952-cancellation-evidence.md)
starts from its merged commit `032addd`. The earlier review rows describing a
missing cancellation hash are historical; this section supersedes that limitation.

`withTxExecution` now retains the first local accepted hash for its own operation
and closes observation when it settles. Actual caller cancellation still rejects
promptly with its original reason and conservative sent flag. It includes the
hash only if native acceptance was already observed; late acceptance cannot add
it to an earlier error. Inclusion, execution success, code and height remain unknown.

Both `cosmosTx` and `executeTx` pass an observer through the manager's broadcast
client into the existing sequencer. Each call owns its observer; shared signing
clients and sequence caches carry no mutable operation evidence. The native
blocking helper intercepts only its broadcast call, preserving the original
receiver for signing, simulation and lookup. Both direct and cached-sequence
paths notify from the existing guard after native CheckTx resolves, using its
local digest even when an RPC identifier mismatches. Observer failures cannot
change the transaction outcome or bypass native polling cleanup.

| Finding | Correction and evidence | Confidence |
| --- | --- | --- |
| Prompt caller cancellation loses the already-established transaction identity | Capture accepted local SHA-256 evidence in per-execution state before the cancellation listener builds its error; both public transaction entry points retain the original reason and sparse details. | 100% gap; 99% correction |
| Outer client wrappers discard context on the sequence fast/cached paths | Thread the observer explicitly through getBroadcastClient and sequencedSigningClient; native signing/query methods retain the raw or sequence receiver. Real-manager and cached-sequence regressions cover the path. | 100% mechanism; 99% correction |
| Late acceptance or concurrent operations could change cancellation diagnostics | Close evidence updates at settlement and retain only the first accepted hash. Test pending CheckTx, late success/failure, distinct concurrent signed bytes and unchanged returned details after late settlement. | 99% |
| Custom method overrides and observer exceptions need bounded behavior | Native method identity checks leave custom `signAndBroadcast` or broadcast methods and SYNC-only calls unchanged; thrown/rejected observer failures cannot alter the native outcome or timer cleanup. | 99% |

The change adds no public result schema. Custom `signAndBroadcast` or broadcast implementations,
SYNC-only calls and opaque confirmation callbacks do not gain acceptance evidence.
Current guides describe this boundary; MCP wrappers and orchestration paths still
have their existing signal-forwarding rules, and transport cancellation does not
guarantee delivery of a final MCP error response. ENG-953, grouped-error retry
policy and the parent's eleven unchecked criteria remain separate. Validation
and PR/merge status are recorded in Linear and the PR; work remains unreleased.

## PR #232 review: compatibility and regression safeguards — 2026-09-16

[Claude's review of `5c6a106`](https://github.com/manifest-network/manifest-mcp-mono/pull/232#issuecomment-5700223232)
identified two compatibility questions and six smaller improvements. The review
response preserves the native observation boundary and tightens its implementation,
tests and documentation.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| Eager SigningStargateClient prototype access breaks existing partial module mocks | Keep eager native-method capture with optional access. Restore the original plain-object connectWithSigner mock: it fails import before the correction and passes afterward. | 100% reproduction; 99% correction |
| Delegating custom signAndBroadcast wrappers retain timeout evidence but lack a cancellation hash | Retain the documented native-only observation policy. A receiver-sensitive wrapper backed by WeakMap state works with the original raw receiver and fails if observation changes it to a Proxy. The pre-existing cached-sequence view does not justify changing uncached calls. The module-local transaction fixture now preserves native identity by default, with explicit opt-in for an error-capturing wrapper. | 100% asymmetry; 99% compatibility decision |
| The sent marker can discard stronger native acceptance evidence | Native acceptance now establishes sent:true and the first local hash before settlement, independently of marker ordering. Both missing-marker and later-marker regressions fail before this correction. Late observations remain ignored. | 100% mechanism; 99% correction |
| Cancellation can omit the RPC-hash mismatch diagnostic | Retain the sparse cancellation contract and document the limitation. The local digest, original reason and retry veto remain correct. A structured mismatch flag on both failure paths would be an additive diagnostic extension, outside these acceptance criteria; it is not required for this fix. | 99% |
| Sequence-wrapper comments omit optional acceptance observation | Distinguish the getSequence adjustment from the blocking observation wrapper, and describe eligibility, direct/cached paths and unchanged SYNC behavior next to the observer parameter. | 99% |
| The fixture silently guards guarded:false with realManager:true | Reject the incompatible combination in both the option type and runtime fixture boundary. | 99% |
| Awaiting idle teardown under fake timers can leak a lock into later cases | Force manager cleanup in afterEach; retain explicit poll release/drain checks inside individual tests. A missing-drain negative control checks cleanup isolation. | 99% |
| Deferred promises repeat across test files | Share one resolve/reject helper through the existing test utility barrel and reuse it in core and the existing CosmWasm test seam. Keep the ES2020 library target. | 99% |

The proposed late-outcome matrix expansion remains unnecessary: existing tests
already catch the relevant error and sequence-cache mutations. The documented
SYNC boundary, terminal post-acceptance failures and native broadcast identity
checks remain unchanged. Validation, confidence scores and the retained diagnostic
limitation are recorded on the PR and ENG-952; ENG-805's other criteria stay open.

Local validation passes **4,143 tests / 17 existing skips / 186 files**, including
the rebuilt CosmWasm consumer, with no type errors and every coverage floor
passing: **84.93% lines / 84.65% statements / 84.51% branches / 88.47% functions**.
Fresh workspace builds, workspace/E2E TypeScript, Fred schema, Biome and diff
checks pass. The original constructor mock, both acceptance-order cases and all
three fixture-isolation probes fail before their respective corrections and pass
afterward. The receiver-changing observation mutation fails its compatibility
regression. Independent production/documentation review found no blocker
(99% confidence). Fresh CI and live acceptance results are recorded on the PR.

## Unreadable retry diagnostics (ENG-953, 2026-09-16)

Implementation plan: [preserve failures during retry inspection](superpowers/plans/2026-09-16-eng953-retry-inspection.md).

`isRetryableError` now catches exceptions encountered while inspecting its error
argument and standard causes, returning a conservative nonretryable verdict.
`withRetry` consequently rejects with the exact original failure, without another
attempt or `onRetry` call. This includes a zero retry budget and unreadable errors
that arrive after a previous readable transient failure has already retried.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| A throwing cause accessor replaces the original operation failure | Contain error inspection at the public classifier. At `4ce59ea`, 19 of the 21 core cases and three built-SDK identity cases fail with the original classifier; the readable and already-aborted-signal controls pass. | 100% reproduction; 99% correction |
| Catching only property access misses proxy reflection and other diagnostic reads | The boundary includes the initial instanceof check, cause membership/prototype inspection and classification fields. Root/nested proxy and accessor cases preserve rejection identity with zero and positive retry budgets. | 99% |
| Returning a partial chain could hide a permanent/submitted veto | A failed inspection returns false instead of classifying a prefix. Transient wrapper and owned-timeout controls prove unreadable causes cannot authorize replay. Shared errorChain and transport ownership helpers are unchanged. | 99% |
| A broad promise about all injected transport errors would exceed this boundary | Public docs scope the behavior to errors received by the retry helpers. Producer-side diagnostics and grouped/sibling errors retain their existing policy. | 99% |

The whole-operation signal remains the first check. Existing permanent/submitted
short-circuits still skip irrelevant causes; readable transient, HTTP/gRPC,
timeout-ownership, cancellation and cycle behavior is preserved. No dependency,
compiler-target or public type changes are required.

All 130 focused core and rebuilt SDK tests pass, with no type errors. Independent
production and test review found no blocker (99% confidence). Its documentation
precision note is addressed: a prior successful retry does not change the rule
that an unreadable failure stops further attempts.

Full local validation passes **4,168 tests / 17 existing skips / 187 files**, with
no type errors and all coverage floors passing: **84.93% lines / 84.65%
statements / 84.51% branches / 88.47% functions**. Fresh workspace builds,
workspace/E2E TypeScript, Fred schema, Biome, architecture, all nine package
integrity checks and all four SDK bundle budgets pass. CI and live acceptance
results are recorded on the PR and ENG-953.

## PR #233 review: connection envelopes and observable short-circuits (2026-09-16)

[Claude's execution-verified review of `4ce59ea`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5703102677)
found a downstream normalization regression and a test-ordering gap. The
connection catches must safely handle the unreadable value now preserved by
`withRetry`; they cannot assume the former secondary inspection error arrives.

| Finding | Disposition and evidence | Confidence |
| --- | --- | --- |
| Connection catches throw while discriminating or formatting the preserved error | A module-local normalizer guards SDK-error discrimination and message/string extraction. Other failures retain RPC_CONNECTION_FAILED and existing endpoint details; recognized SDK errors retained identity at this revision. Later review tightened identity pass-through to readable code/message/details and successful retry inspection, including errors surfaced by Fred client factories. Twelve hostile-input cases fail against `4ce59ea`; six restore main behavior (message/proxy × REST/RPC/signing), while wallet and throwing-coercion cases add normalization. All 83 client tests pass; the 16 added rows cover real retry for REST/RPC/signing and wallet acquisition before retry. | 100% reproduction; 99% correction |
| A false verdict alone no longer proves terminal errors skip cause inspection | Three tests assert zero cause reads for permanent, submitted and partial outer verdicts. An isolated mutation moving traversal first fails all three, while 21 controls pass. | 100% |
| The initial reproduction count omitted the last added regression | Correct the historical `4ce59ea` count to 19 failures / 2 controls out of 21 core cases. An archive copy with the original classifier reproduces it; the original three SDK failures remain accurate for that revision. | 100% |
| Producer and MCP diagnostic inspection can still replace original failures | Producer/direct-MCP failures were reproduced and initially grouped in [ENG-983](https://linear.app/liftedinit/issue/ENG-983). The next review established that retry-fed MCP failures are PR regressions; those are fixed here, and ENG-983 retains producer-side work. | 100% mechanism; 98% scope |
| A throwing onRetry callback replaces the operation failure | Independently reproduced; [ENG-984](https://linear.app/liftedinit/issue/ENG-984) owns explicit observer/control semantics, diagnostics and documentation. | 100% mechanism; 98% scope |
| Undefined or invalid retry limits skip operations or add unmatched backoff | Independently reproduced through withRetry and partial public getInstance configuration; [ENG-985](https://linear.app/liftedinit/issue/ENG-985) owns defaults and validation. | 100% mechanism; 99% scope |
| The classifier does not log inspection failures | Keep logging out of the classifier. Its contract requires a conservative verdict; logging would add another fallible diagnostic operation. Any future trace must avoid inspecting the error. | 98% |
| Non-string messages stop retry classification | Retain the conservative malformed-input behavior. String coercion would broaden retry policy and is not required for standard cause exception safety. | 100% mechanism; 98% scope |
| Core unit tests load the full barrel | Use direct retry/type imports for the core matrix. Built SDK consumer tests still exercise public exports through the SDK's core dependency. | 99% |
| The SDK assertion itself resolves a hostile rejection value | Compare identity inside the rejection handler and add a root revoked-proxy case. Restoring the prior catch-return pattern fails this case independently of the correct classifier. | 100% |
| The plan is unlinked and contains checkout-specific state | Link the plan from this section's implementation record and remove the local untracked-file count from the plan. | 100% |

The proposed caller-abort precedence change remains refuted: nonretryable
operation failures retain their established priority, including ordinary readable
errors. The review adds no grouped-error policy change. The callback and retry-configuration follow-ups are pre-existing. ENG-983 was
initially scoped too broadly: direct MCP injection was pre-existing, but preserved
retry rejections expose new downstream regressions, addressed below.

Validation passes **217 focused tests** and **4,188 full-suite tests / 17 existing
skips / 187 files**, with no type errors and all coverage floors: **84.95% lines /
84.67% statements / 84.55% branches / 88.48% functions**. Fresh workspace builds,
workspace/E2E TypeScript, schema, Biome, architecture, nine package-integrity checks
and four SDK bundle budgets pass. Independent review found no blocker (99%
confidence); removing reflection containment fails four cases, removing message
containment fails eight, and moving cause traversal before terminal verdicts fails
three. Fresh PR-head CI and live acceptance are recorded on PR #233 and ENG-953.


## PR #233 review: downstream retry consumers (2026-09-17)

[Claude's review of `3bf38f4`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5714166265)
correctly distinguishes direct hostile injections from errors arriving through a
retry loop. Returning the original unreadable rejection exposed downstream catches
that had previously received readable inspection exceptions. These are P3 custom
JavaScript-input regressions and belong in this PR, including the MCP portion
previously deferred to ENG-983.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| MCP tools lose their bounded JSON envelope | Cache safe SDK metadata, guard lazy stack formatting and never inspect a serialization failure. Real MCP/real-retry tests fail before the fix and retain sanitized bounded responses afterward. | 100% reproduction; 99% correction |
| Connection catches preserve unreadable SDK errors | Require string code/message and readable shallow details before identity pass-through. Exact error class/details/no-cause, hostile identity-fetch/signing/wallet, Symbol message and cleanup tests cover the boundary. | 100% reproduction; 99% correction |
| Transaction attribution lets hostile errors erase paid-lease recovery | Guard the entire tx attribution operation; unreadable diagnostics produce permanent TX_FAILED with operation context and a hidden original cause. Fred deploy catches and restore pre-POST/compensation message formatting protect known lease IDs, partial flags and orphan logs. Later restore POST/poll diagnostics and terminal `withContext` remain in ENG-996; this row does not claim complete restore coverage. Agent estimate/retry-set-domain formatting and deployment classification preserve their context. | 100% reproduction; 98% correction |
| Fred resource failures can leave requests unanswered | Fresh readable errors protect all three resource callbacks, including wallet failures. Messages are bounded and sanitized; readable numeric protocol codes survive, arbitrary diagnostic data is omitted. Real MCP requests cover retry failures and real manager identity failures. | 100% reproduction; 99% correction |
| Existing client assertions permit the wrong envelope | Assert ManifestMCPError class, exact details and absent cause. Mutations of class/details/cause and removal of String(message) fail the strengthened tests. | 100% |
| Outer verdict tests omit transport-message and HTTP-status branches | Add ENOTFOUND and HTTP 403 cases asserting zero cause access, one attempt and no retry callback. | 100% |
| Documentation and previous triage overstate scope | Correct the six-regression/twelve-case distinction, pre-retry wallet wording and 83-test claim. Re-scope ENG-983 to producer-side timeout/faucet/LCD handling; explain unreadable rejection handling for custom consumers. | 100% |

The pre-retry LCD adapter diagnostic pattern also exists on main and remains in
ENG-983 with the producer-side work. No dependency, public type, replay-policy or
grouped-error traversal change is included. Readability checks are shallow and do
not promise safety for arbitrary state-changing accessors or recursively hostile
diagnostic objects. Independent review of all nine production retry call sites and
the recovery changes found no further blocker (97% confidence).

Validation passes **672 focused tests / one existing skip** and **4,316 full-suite
tests / 17 existing skips / 190 files**, with no type errors. Coverage floors pass:
**85.08% lines / 84.80% statements / 84.78% branches / 88.55% functions**. Fresh
workspace builds (including publint/attw), workspace/E2E types, schema, Biome,
architecture, all nine package integrity checks and all four bundle budgets pass.
Final before/after checks reproduce 40 client failures, nine MCP-boundary failures
and 21 core/agent attribution failures. Reverting only the resource wrapper with
the fixed core fails 16 of 27 resource cases; traversal reordering fails all five
outer-verdict cases while 21 controls pass. Fresh CI/live acceptance is recorded
on PR #233 and ENG-953.


## PR #233 review: preserve readable verdicts and independent evidence (2026-09-17)

[Claude's review of `fece70b`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5715197207)
reproduced the prior validation claims, then exposed additional diagnostic-field
and retry-policy regressions. The preceding sections record those earlier revisions;
the contract below supersedes their broader recovery and replay claims.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| Adding a cause to readable orchestration errors authorizes whole-deployment replay | Attach the original only when code/reflection/message inspection throws. Real `withRetry` around `deployApp` asserts one orchestration attempt for HTTP 503 and gRPC 14/4, plus permanent controls. Paid deployment primitives are mocked; these are orchestration-attempt assertions, not live broadcast measurements. | 100% reproduction; 99% correction |
| Transaction fallback loses readable text and submission facts | Shared guarded readers preserve text independently and salvage validated own-data sent/hash/receipt/partial/lease fields without invoking evidence accessors. Malformed tx code/message and unreadable diagnostics retain permanent TX_FAILED, exact operation details and a hidden original cause. | 100% reproduction; 98% correction |
| Connection spread checks skip hidden consumer fields and lose readable verdicts on incidental failure | Validate module/partial/sent/HTTP/gRPC/transport fields by name; unreadable named fields retain the endpoint-only fallback. Incidental failures preserve code/message, safe facts and an existing readable cause, including terminal status/partial/submission vetoes. No original wrapper is added as a cause. | 100% reproduction; 98% correction |
| Direct query, estimate and build-context enrichers still throw while inspecting failures | Use one guarded enrichment helper across all four Cosmos paths. Exact envelopes and hidden causes survive; readable NOT_FOUND, SDK identity and transient retry controls remain covered. | 100% reproduction; 98% correction |
| Resource normalization loses plain-object/cross-realm message text | Prefer a safely read string message; preserve numeric protocol codes and exact bounded/sanitized text. Code getters throwing revoked proxies are exercised through actual MCP requests. | 100% reproduction; 99% correction |
| An unrelated diagnostic failure erases an established terminal deployment verdict | Read each deploy diagnostic independently. Terminal kind/details getter cases preserve terminal guidance; known later withContext failures are tracked separately. | 100% reproduction; 98% correction |
| Serialization fallback logging drops readable failure reasons | Safely extract and sanitize the serialization error message; unreadable secondary errors retain a fixed fallback. | 100% reproduction; 99% correction |
| New guards lacked observable regressions | Isolated mutations fail for resource code protection (2), exact resource messages (4), restore pre-POST message protection (1), terminal deploy discrimination (1), agent readiness/code guards (5), and serialization-reason guards (3). | 100% |
| executeTx still synthesizes retries from diagnostic failures | A sealed broadcast probe reproduces four calls with a three-retry budget. Runtime predates this PR; remove the inaccurate mirror comment and add explicit acceptance criteria to [ENG-983](https://linear.app/liftedinit/issue/ENG-983). | 100% mechanism; 98% scope |
| Restore/terminal documentation promises more than the guarded paths provide | Narrow docs to guarded deploy diagnostics and restore pre-POST/compensation formatting. [ENG-996](https://linear.app/liftedinit/issue/ENG-996) owns restore POST/poll discrimination and terminal withContext, with independently reproduced helper failures. | 100% mechanism; 97% scope |

Additional review controls catch evaluation of unrelated non-enumerable detail
getters and promotion of hidden/inherited transient fields into readable wrappers.
Only named consumer fields are read unconditionally; complete snapshots preserve
ordinary spread semantics. Safe existing cause/status/positive submission and
partial verdicts survive incidental detail failures. No dependency, public type or grouped-error policy changes are
needed. Arbitrary state-changing accessors and recursively hostile diagnostics
remain outside the shallow snapshot contract.

Final local validation passes **4,458 tests / 17 existing skips / 190 files**, with
no type errors and all coverage floors: **85.23% lines / 84.96% statements /
85.05% branches / 88.72% functions**. Fresh workspace builds (including
publint/attw), workspace/E2E types, schema, Biome, architecture, all nine package
integrity checks and all four unchanged bundle budgets pass. The final focused
core/client run passes 433 tests across eight files. All 215 client tests pass;
92 fail against the prior client implementation, with 123 controls passing.
Independent review reproduced and verified the hidden-status correction, with no
further blocker found (97% confidence). Fresh PR-head CI/live acceptance is
recorded on PR #233 and ENG-953.

## PR #233 review: malformed diagnostics and cancellation verdicts (2026-09-17)

[Claude's review of `232727d`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5716936392)
reproduced the prior validation and found no blocker, while identifying further
malformed-input retry differences, lost verdicts and unsafe resource/secret text.
These corrections supersede earlier broad claims about unchanged retry behavior:
readable controls retain their established behavior, and malformed diagnostics
receive explicitly conservative treatment.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| Non-string orchestration messages manufacture transient prose | Mark non-string messages as unreadable, retain String coercion and the hidden original, and use the caller's fallback code. Four paid recovery sites × two codes × four hostile message forms fail before correction and stop after one orchestration attempt afterward. | 100% reproduction; 99% correction |
| Failed orchestration inspection retains a retryable original code | The supplied fallback remains authoritative after inspection fails; paid recovery uses TX_FAILED. The 32-case matrix includes throwing coercion and a getter that becomes readable later. | 100% reproduction; 99% correction |
| Connection repair loses AbortError/TimeoutError names | Guard name reads and copy readable names on repair. Twelve before/after rows cover all four connection boundaries, including unreadable names. | 100% reproduction; 99% correction |
| Cosmos read normalization introduces retries from copied details/causes | Privately identify envelopes whose inspection failed and veto retry before examining their diagnostics. Non-string Error messages receive the same protection. A readable malformed code alone uses the operation fallback without introducing a new cause on read legs. | 100% reproduction; 98% correction |
| Connection repair downgrades permanent codes and drops readable metadata | Retain an independently non-retryable normalized code/message even when details, named fields, name or cause cannot be read. Preserve independently readable ordinary details and supplied endpoint precedence; otherwise retain the conservative endpoint fallback. | 100% reproduction; 99% correction |
| Resource messages expose function/class source and useless object coercion | Read string message fields on objects/functions; message-less non-Errors use Internal error. Eight cases fail before correction. Real MCP assertions now pin omitted data, including when the rejected object/function contains data. | 100% reproduction; 99% correction |
| Operation prefixes defeat whole-string mnemonic redaction | Share the existing mnemonic heuristic as a pure helper and apply it before Cosmos prefixes; agent contextual errors reuse the existing public sanitizer before their prefix. Inspect a control-free candidate so ANSI/bidi wrappers cannot hide the mnemonic until later model sanitization. General embedded-prose secret detection remains separate. | 100% reproduction; 98% correction |
| Readiness tests did not exercise individual guards | Replace the inert terminal-details row with four LeaseReadinessUnconfirmedError rows. They assert a paid lease, unconfirmed verdict and independently readable poll fields; removing reason/state/provision guards fails 1/2/2 cases. Forwarding resource data fails four cases; removing orchestration String coercion fails 16. | 100% |
| Evidence-validator branches lacked distinguishing tests | Add adversarial receipt/hash/flag fixtures at the Cosmos boundary, preserving valid evidence without accepting malformed or accessor-derived receipt claims. | 99% |

Remaining work is explicit and deduplicated:

- [ENG-1000](https://linear.app/liftedinit/issue/ENG-1000) owns readable paid-operation retry vetoes. Independent source-comparison probes confirm retry_set_domain loses known lease/inner partial context, and readable Cosmos spread loses hidden/inherited positive sent/partial flags. Both mechanisms predate this PR. The probes use real orchestration/retry with mocked paid/broadcast seams, not live transactions. Confidence: 100% mechanism, 99% pre-existing scope.
- [ENG-271](https://linear.app/liftedinit/issue/ENG-271) retains broader free-form secret scrubbing and stderr log hygiene. A built-module probe preserves embedded mnemonic text and a 20,018-character diagnostic with ANSI/newlines. Prefix redaction here does not provide general embedded-secret detection, bounded logs or control-safe log framing. Confidence: 100% mechanism, 98% scope.
- [ENG-983](https://linear.app/liftedinit/issue/ENG-983) additionally owns cross-realm NotFound recognition in its existing query-classification scope. The same RPC NotFound message classifies true on a local Error and false on a cross-realm Error. Completed ENG-536 is unchanged. Confidence: 100% mechanism, 99% scope.
- [ENG-996](https://linear.app/liftedinit/issue/ENG-996) retains later restore/terminal diagnostic recovery. State-changing custom accessors and general grouped-error traversal remain outside this change.

Final local validation passes **4,644 tests / 17 existing skips / 193 files**, with
no type errors. Coverage floors pass: **85.25% lines / 85.00% statements / 85.14%
branches / 88.76% functions**. Fresh workspace builds (including publint/attw), the
final core rebuild, workspace/E2E types, schema, Biome, architecture, all nine
package integrity checks and all four unchanged bundle budgets pass. Focused
core plus real chain MCP validation passes 304 tests across six files; all 279
client tests pass. Independent final review found and verified the additional
control-wrapped mnemonic and malformed-code HTTP 408 cases, with no remaining
blocker in the reviewed scope (98% confidence). PR-head CI/live acceptance results
are recorded on PR #233 and ENG-953.


## PR #233 review: redaction separators and retry veto propagation (2026-09-17)

[Claude's review of `e09f94b`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5718852563)
confirmed the previous corrections and identified six remaining findings. The
review also exposed text-policy and coverage gaps in the new normalization code.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| 1. Control stripping fuses mnemonic words | Check both the original whitespace-separated candidate and the control-free candidate; redact before model formatting removes separators. CR, VT, FF, line/paragraph separators and BOM now retain redaction through the helper, actual stderr and tool response. Space/tab/LF/ANSI/bidi controls stay covered. The new matrix has 18 failures before the fix. | 100% reproduction; 99% correction |
| 2. Connection retry vetoes disappear during Cosmos rebuilding | Require successful retry inspection for identity/cause preservation; retain private veto provenance on repaired errors and subsequent Cosmos attribution. Internal helpers stay off the public barrel. Boundary tests exercise real query/tx/estimate/custom-domain retry paths with injected REST/RPC identity and signer failures, before any handler, simulation or broadcast. | 100% reproduction; 99% correction |
| 3. Non-string connection Error messages introduce transient prose | Use `Error message unavailable` for non-string Error messages. Symbol/array/object fixtures and readable controls pin classifier results and end-to-end attempt counts. | 100% reproduction; 99% correction |
| 4. Agent fee-estimate context discards an existing veto | Retain a hidden original cause when a readable contextual wrapper would become retryable; otherwise preserve historical cause omission. Four real Cosmos-estimate/deploy paths now stop after one simulation rejection and no Fred deployment. Removing the condition fails ten cases; six controls still pass. | 100% reproduction; 99% correction |
| 5. Resource Error messages expose function/class/object coercions | Use `Internal error` for object/function messages even on Error instances; retain primitive formatting using the already-read message. Six new protocol rows fail before the fix; both numeric-message controls pass. All 49 resource tests pass after it. | 100% reproduction; 99% correction |
| 6. Redaction documentation overstates covered prefixes | Name the covered Cosmos/owned-broadcast/contextualError sites explicitly. Expand existing ENG-271 to remaining prefixes and MCP response/notification sinks. A built real troubleshoot/callback/tool-wrapper probe reproduces the complete mnemonic in the response and one failure notification; these paths are unchanged from main. | 100% demonstrated leak; 98% remaining scope |
| Redaction changes readable retry policy | Retain lexical retry decisions privately alongside the public redacted display, without retaining the original secret or inventing statuses. Copy provenance on rebuilding; explicit changes to the displayed message use its current policy. Cover transient and ENOTFOUND outcomes, readable reattribution and connection repair. | 100% reproduction; 99% correction |
| Control-heavy diagnostic performance | Replace per-character callbacks with a control-category regex. Exhaustive Unicode code-point comparison and ANSI/layout controls verify equivalent stripping. No timing assertion is added to the suite. | 100% equivalence; 98% performance mechanism |
| Evidence-validator and owner-coverage gaps | Distinguishing mutations fail for invalid transport/status types (12), repeated named getter reads (1), lost raw-error evidence (1), wrong SDK fallback code (4), Cosmos-prefix redaction (3), veto propagation (4) and lexical policy (8). | 100% mutation evidence |
| Thrown non-Error coercion | Keep the established policy in this PR and add the gap to ENG-983. Sealed main/current Cosmos probes each retry thrown Symbol/object transient text three times (four comparative rows), with no network or broadcasts. | 100% mechanism; 99% pre-existing scope |
| Historical restore guarantee | Narrow the earlier downstream-review row to pre-POST/compensation formatting and explicitly retain later POST/poll/terminal scope in ENG-996. | 100% |

The contextual cause fix also preserves readable inner sent/partial/permanent
vetoes; ENG-1000 still owns missing paid-lease context and hidden outcome fields
lost by readable spread. It does not establish that whole paid orchestrations are
safe to retry. A shared public rebuilding API was unnecessary: core keeps its
classification provenance private, and agent-core uses the existing public
classifier plus a hidden cause. Arbitrary state-changing accessors and grouped
error traversal remain outside this shallow-inspection contract.


Client validation passes **445 tests** (283 client / 162 operation-boundary cases).
The original 439-case matrix fails **136 cases** against the prior client source;
guard mutations fail **29 / 2 / 28 / 28 / 42** cases. Independent review then
identified lexical provenance loss during connection repair: four of six added
controls fail before copying the provenance and all six pass afterward. Cosmos
and retry validation passes **274 tests**, including displayed-message changes
and reattribution; redaction/contextual validation passes **359 tests / one
existing skip**. These focused counts overlap full-suite validation. Independent
final review found no remaining blocker in the reviewed scope (98% confidence).


Full validation passes **4,924 tests / 17 existing skips / 196 files**, with no
type errors. Coverage floors pass: **85.31% lines / 85.05% statements / 85.23%
branches / 88.80% functions**. Fresh workspace builds (publint/attw), workspace/E2E
TypeScript, schema, Biome, architecture, all nine package-integrity checks and all
four unchanged SDK bundle budgets pass. The initial sandbox run could not spawn
required subprocesses or bind the local WebSocket test server; the unrestricted
rerun passes. Fresh PR-head CI/live acceptance is recorded on PR #233 and ENG-953.


## PR #233 review: diagnostic performance and nested retry context (2026-09-17)

[Claude's review of `e4a7e8d`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5720548174)
reports no blockers and confirms the previous fixes. This follow-up addresses the
two recommended corrections and records the smaller contract/coverage notes.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| Large ordinary strings incur repeated redaction work | Reuse the raw tokenization; fewer than twelve words cannot gain words through deletion. Skip Unicode control scans for printable ASCII/layout and skip mnemonic rescanning when stripping changes nothing. Preserve raw-whitespace and control-stripped detection, including OSC removal that reduces more than 24 words to 12. A 3,038-case equivalence matrix, large ASCII/Unicode corpus, exhaustive control-category comparison and actual stderr/tool-response cases pass. | 100% reproduced overhead; 99% semantics; 98% measured performance |
| Merely non-retryable repairs become permanent causes | Separate readable repair context from failed-inspection provenance. Only non-retryable repairs enroll for cancellation-name/existing-cause transfer through Cosmos. Ordinary messages can inherit enclosing transient/owned-deadline context. The initial matrix covered permanent/submitted/partial causes separately from named-field failures; the paired cause-loss regression found in the next review is corrected below. Already-retryable repairs retain prior attribution cause omission. An unreadable attribution-only field does not imply a failed classifier inspection. | 100% reproduction; 99% correction |
| Fred factory identity wording is too broad | Document that both Fred factories delegate to the core connection contract, which preserves identity only after successful diagnostic/retry inspection. Correct the historical broad claim; no Fred runtime change is needed. | 100% delegation and wording |
| Own-data HTTP salvage is unpinned | Add one real identity-fetch → connection → Cosmos case with a throwing-get proxy over own HTTP 403. It retains QUERY_FAILED, the message, 403 and endpoint/operation context after one attempt. Removing only the descriptor fallback in an isolated copy fails those assertions. | 100% mutation evidence; 99% test adequacy |
| Non-Error contextual causes do not restore vetoes | Clarify that only the supported standard Error chain carries retry verdicts. Built probes confirm raw string/object false → contextual true despite a hidden cause. Extend existing ENG-983's thrown-value scope; do not change that pre-existing policy in one wrapper. | 100% mechanism; 99% scope |
| Non-whitespace controls used as mnemonic separators | Add the zero-width/bidi/NUL/NEL cases to existing ENG-271 and state the limit in the guide. Ten built-helper probes reproduce the gap; this optimization keeps the existing redaction set. A space-mapping candidate needs separate false-positive review. | 100% current mechanism; 98% pre-existing scope |
| Private provenance does not cross core copies | Document one shared resolved core instance and the limits of duplicate installations or cloning/serialization. An isolated second physical dist copy classifies a malformed-code query envelope as retryable while the producing copy rejects it. No public marker or type is added. | 100% reproduced duplicate-copy mechanism; 99% guidance |

Balanced local benchmarks use Node 24.15, source-transpiled sanitizer functions,
the same built dependencies, nine interleaved samples of ten calls, and GC
outside timed samples. For approximately 1 MiB inputs, `sanitizeForLogging`
median milliseconds per call are:

| Input | main `5a49cd4` | `e4a7e8d` | Current |
| --- | ---: | ---: | ---: |
| Base64 | 0.049 | 1.824 | 0.051 |
| Compact JSON | 0.051 | 2.147 | 0.052 |
| ASCII prose | 8.055 | 18.001 | 8.543 |
| Unicode prose | 8.219 | 27.540 | 22.807 |

These measurements establish the improvement on the sampled inputs, not a
universal latency guarantee. Unicode prose still pays for the control scan, and
control-bearing logging retains the cost of checking the control-free mnemonic
candidate. ASCII results do not establish parity for ANSI/bidi diagnostics. There
is no blanket main-parity claim and no timing threshold in unit tests.
ENG-271/983/996/1000 retain the documented remaining redaction, producer,
restore/terminal and paid-operation scope. Arbitrary state-changing accessors
and grouped-error traversal remain outside this shallow-inspection contract.


Retry validation passes **563 focused tests**, including **88 new cases**; the
exact prior `e4a7e8d` baseline fails **40** of the new cases. Isolated mutations
fail for enrollment (44), cancellation-name copying (24), existing-cause copying
(12), provenance transfer (36), genuine inspection failure (12), later transfer
failure (8), the already-retryable enrollment guard (4), and fallback permanence
(20). No existing assertions were weakened.

Independent sealed main/prior/current source comparisons use the same built
dependencies and real manager → Cosmos → `withRetry`, with injected transport
calls rather than network or broadcasts. Four transient-only cause shapes remain
at one outer attempt, ordinary errors under transient wrappers and native aborts
under owned deadlines recover the main three-attempt behavior, and permanent
cause/status controls stay at one. The descriptor-salvage regression also passes
normally and fails under its isolated mutation. Independent final review found
no further issue in these branches (98% scope confidence); redaction validation
passes **191 tests**. Focused counts overlap full-suite validation.


Full validation passes **5,022 tests / 17 existing skips / 197 files**, with no
type errors. Coverage floors pass: **85.36% lines / 85.10% statements / 85.29%
branches / 88.81% functions**. Workspace builds (publint/attw), final core rebuild,
workspace/E2E types, schema, Biome, architecture, all nine package-integrity checks
and all four unchanged SDK bundle budgets pass. The first full run identified
four ES2020 type incompatibilities; those are corrected and the complete rerun
passes without changing the compiler target. Fresh PR-head CI/live acceptance
results are recorded on PR #233 and ENG-953.


## PR #233 review: cause vetoes across incomplete attribution (2026-09-18)

[Claude's review of `ccc0665`](https://github.com/manifest-network/manifest-mcp-mono/pull/233#issuecomment-5729827065)
confirms the prior performance and permanence fixes but identifies a missing
combination: an unreadable attribution-only field with a veto on an existing
cause. The previous matrix tested those conditions separately.

| Finding | Resolution and evidence | Confidence |
| --- | --- | --- |
| The second repair branch drops a cause-only veto | Copy the already-read cause before selecting a repair branch, only when retry inspection succeeded and the cause read succeeded. An unreadable `details.module` can no longer erase submitted/partial/permanent causes. Keep the exact non-enumerable cause and its original hash/lease facts through repeated Cosmos attribution. | 100% reproduction; 99% correction |
| A transient-looking repair falls into the endpoint-only fallback despite a permanent cause | The same earlier copy lets the existing classifier see the veto before deciding whether an endpoint fallback is needed. This also corrects the related pre-existing cause-loss path. Genuine classifier failures retain their conservative behavior; already-retryable repairs retain historical cause omission at Cosmos attribution. | 100% mechanism; 99% correction |
| Model text strips a diagnostic twice | Reuse the control-free candidate from the mnemonic check for model projection. Keep raw-whitespace and control-free detection, raw non-secret logging text, short-string handling and code-point capping. The existing 3,038-case matrix now also compares model output; all 200 focused redaction/formatting tests pass. | 99% semantic preservation; 98% local performance |
| Control-bearing diagnostics remain more expensive than main | Explicitly record the remaining cost of control-free mnemonic detection. The optimization removes duplicate model scans; it does not establish main parity for Unicode or ANSI/bidi input. | 100% observed residual; 98% measured magnitude |
| Printable-ASCII fast-path boundaries lack direct tests | Add isolated DEL, NEL, C1 CSI and soft-hyphen fixtures in `text-controls.test.ts`, plus public model/log controls. Widening the guard to U+007F/U+0085/U+009F/U+00FF fails 1/2/3/4 targeted cases in isolated copies. | 100% mutation evidence |
| Hostile identity-abort diagnostics lose timeout attribution | Both real Fred factories reproduce the generic endpoint-only fallback. Exact-source comparisons show the current shape predates this correction and avoids main's diagnostic-inspection leak. Record this conservative fallback in the guide and existing ENG-983 timeout scope; no Fred runtime change. | 100% reproduction; 99% scope |

Independent injected manager/Cosmos probes retain all six checked submitted,
partial and permanent cause classes and stop after one attempt; transient and
no-cause controls still make three attempts. The baseline distinction matters:
main's manager kept these vetoes, but its malformed Cosmos attribution could
already discard the cause. This fix restores the manager behavior and preserves
it downstream; it does not claim universal parity with main's Cosmos path.

Local actual `withErrorHandling` benchmarks use Node 24.15, source-transpiled
main/prior/current sanitizers with identical built dependencies, nine interleaved
samples, five warmups and GC outside timing. The logger path runs with console
output uniformly discarded. Median milliseconds per call:

| Input | main `5a49cd4` | `ccc0665` | Current |
| --- | ---: | ---: | ---: |
| Unicode 4 KiB message | 0.105 | 0.230 | 0.159 |
| Unicode 60 × 16 KiB details | 0.909 | 1.750 | 1.312 |
| ANSI/bidi 4 KiB message | 0.113 | 0.322 | 0.241 |
| ANSI/bidi 60 × 16 KiB details | 0.945 | 2.426 | 1.543 |

The benchmark outputs match `ccc0665` byte-for-byte. A roughly 1 MiB ANSI/bidi
logging sample still takes 30.114 ms versus main's 8.813 ms (about 3.42×); its
prior value was 32.924 ms. These are local measurements, not universal latency
guarantees or timing assertions in the test suite.


Retry validation passes **744 focused tests**, including **180 new paired/control
cases** across REST/RPC identity, wallet acquisition and signing connection. The
new matrix combines ten cause kinds, neutral/transient messages and unreadable
attribution/incidental fields, then checks two Cosmos rebuilds and enclosing
retry counts. It asserts exact cause identity, non-enumerability and original
recovery facts; assertion failures inside retried operations cannot be mistaken
for the expected rejection. The exact `ccc0665` baseline fails **80** new cases;
100 new controls pass. No existing assertions were relaxed.

Isolated mutations fail for removing cause copying (176), removing the failed-
inspection gate (20), attaching the wrapper instead of its existing cause (160),
making the cause enumerable (160), removing repaired-context enrollment (196),
and removing the already-retryable enrollment guard (4). These runs include the
180 new cases and 80 previous matrix cases. Independent source probes compare
main, `e4a7e8d`, `ccc0665` and the fix without network or broadcasts.

Fred's hostile-timeout probe covers both real factories. Five exact-source
manager comparisons show main's inspection-exception leak, the more specific
`3bf38f4` timeout envelope, and the same endpoint-only fallback at `e4a7e8d`,
`ccc0665` and this correction. ENG-983 will evaluate safe timeout diagnostic
retention alongside its producer work; this does not authorize retries after
failed inspection. ENG-271/983/996/1000, state-changing accessors, grouped causes
and duplicate-core provenance retain their previously documented scope.


Full validation passes **5,211 tests / 17 existing skips / 197 files**, with no
type errors. Coverage floors pass: **85.35% lines / 85.09% statements / 85.29%
branches / 88.83% functions**. Fresh workspace builds (publint/attw), workspace/E2E
types, schema, Biome, architecture, all nine package-integrity checks and all four
unchanged SDK bundle budgets pass. Core's public entry-point declaration is
byte-identical to the prior build. Independent final review found no blocker in
scope (98% confidence). An initial overlapping E2E preparation rebuild invalidated
package imports; checks were rerun successfully after that build completed.
Fresh PR-head CI/live acceptance results are recorded on PR #233 and ENG-953.
