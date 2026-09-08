# ENG-768 dependency hygiene

## Scope and decisions

Close the remaining build-resolution and CI gaps from ENG-748, and reduce SDK
bundle cost where compatible changes are available. Existing root validator
dependencies are a partial mitigation; explicit module injection removes the
SDK validation step's dependence on tsdown's install location.

The audit contract is the complete locked dependency graph, including development
dependencies, with high and critical advisories blocking CI and release validation.
Low and moderate findings remain visible. No advisory allowlist or override-specific
filter will hide vulnerabilities. The existing low-severity elliptic migration is
tracked separately by ENG-808.

Release recovery is documented in `docs/dependency-hygiene.md`: transient failures
can be retried; an urgent exception requires a maintainer-reviewed workflow change
scoped to one new tag, retains the full audit output and CI failure, and is removed
afterward. The normal release workflow has no bypass toggle.

Deploy-relevant PRs require a successful live acceptance result. A skipped
Dependabot/fork run must fail the summary gate and explain the missing coverage;
the workflow keeps its existing secret boundary.

## Implementation sequence

1. Record baseline SDK sizes and audit results. Inspect pinned tsdown and generated
   ManifestJS APIs before changing imports.
2. Inject publint, publint/utils, and AreTheTypesWrong modules from the SDK config.
   Verify package validation still runs when validators are available only from
   the SDK's module-resolution context.
3. Add a named full-tree audit command and CI/release gates. Make the E2E summary
   distinguish an irrelevant change from a missing required acceptance run, with
   regression coverage for the gate's decision table.
4. Replace unnecessary ManifestJS namespace barrels with narrower generated
   imports where signatures and runtime behavior are preserved. Measure gzip
   savings and ratchet budgets downward rather than widening them. Document the
   remaining libsodium cost: CosmJS 0.32.4 calls sumo-only crypto_pwhash, so a plain
   libsodium alias is not compatible and requires the separate upstream migration.
5. Run workspace builds, package checks, type checks, unit tests, workflow guards,
   dependency-cruiser, browser bundle checks, and size budgets. Run live E2E for
   changed chain paths when the local devnet is available. Record actual results
   and any environmental limits below.

## Validation and results

- Implemented validator injection, the named full-graph audit command and CI/release
  gates, and the deploy-sensitive E2E summary. The 17 dependency-hygiene regression
  tests pass on Node 24.15.0 and the minimum supported Node 22.19.0. The validator
  fixture proves both success with injection and failure when either fallback is
  restored.
- Replaced production ManifestJS root imports with the existing namespace bundle
  and signing-client exports. Added a browser module-graph check for the root
  barrel, with a direct-root-import positive control. Gzip savings are 1,471 bytes
  for `/deploy` and 1,455 for the root client; both budgets decreased by the same
  amounts. `/reads` and `/catalog` sizes stayed identical.
- Further narrowing is constrained by generated global decoder registration, and
  non-sumo libsodium lacks the Argon2 API CosmJS calls. The measured findings and
  upstream work are documented in `docs/dependency-hygiene.md`.
- Passed: workspace build (including SDK publint/attw), workspace lint, E2E lint,
  Biome/schema checks, package integrity, workflow policy (62 tests),
  dependency-cruiser (446 modules / 1,636 edges), and all four size budgets.
- Workspace unit/type suites total 3,424 passed and 17 pre-existing skips. The
  first full run hit the existing five-second deadline on seven dependency-cruiser
  probes; serial execution still timed out on one 5.6-second scan. Those scans now
  have a 30-second subprocess deadline and a 45-second test deadline, retaining all
  rule/exit-code assertions. The final SDK rerun passed all 71 tests.
- Passed 119 live tests across chain tools/routing, REST mode/not-found, billing/SKU
  lifecycle, and CosmWasm, plus all eight live CLI metadata tests. The isolated
  chain was built from the pinned submodule; host networking worked around the
  host's unavailable Docker DNAT support. All ENG-768 containers, volumes, and
  networks were removed afterward. The provider deployment/retention suite was
  not run; this host has no Fred XFS quota mount.
- The final full audit passed with seven low findings and no high/critical
  findings against the unchanged v0.22.0 lockfile.
- `main` still has no required status checks. The exact `test`, `audit`, and
  `e2e-gate` settings needed for merge enforcement are documented; the repository
  ruleset was inspected without changing it.
- Root type-test harness: all eight tests passed, including the deliberately
  invalid type-assertion probe and collection/tsconfig coverage checks.
