# Coverage and TypeScript checks (ENG-805)

## Coverage gate

After building workspace dependencies, run the complete workspace Vitest suite
under the checked-in V8 coverage provider:

```sh
npm run build
npm run check:coverage-config
npm run test:coverage
```

The instrumented command uses two workers and a larger per-test timeout; ordinary
unit-test deadlines remain unchanged. The review's initial coverage run hit two browser-build test
timeouts under instrumentation even though those tests passed normally. Failures
still fail the command: a coverage report written after a failure is diagnostic
evidence, not a passing test run.

`vitest.config.mts` owns aggregate coverage. Its explicit
`packages/*/src/**/*.ts` inclusion counts production modules that no test imports,
as required by [Vitest's coverage configuration](https://vitest.dev/guide/coverage.html#including-and-excluding-files-from-coverage-report).
It excludes tests, declaration-only files, fixture/test helpers, and machine
generated code. Runtime implementations such as query/transaction handlers and
the CLI remain included. Example tests execute through the workspace projects,
but example implementation code is outside the package coverage denominator.
This measures local tests; it does not claim live Docker/devnet acceptance coverage.

Reports appear in the ignored `coverage/` directory:

- `coverage-summary.json`: file and aggregate line, statement, branch, and function counts.
- `coverage-final.json`: individual statement/function/branch execution records.
- `index.html`: navigable annotated source.

The thresholds ratchet from the 2026-09-08 remediation measurement. Separate
query and transaction thresholds prevent their gaps from being hidden by better
covered orchestration modules:

| Scope | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| All included production code | 84% | 84% | 83% | 87% |
| Core queries | 38% | 38% | 44% | 84% |
| Core transactions | 61% | 61% | 65% | 66% |

The latest local report includes all 185 production source files selected by the
coverage configuration. Metrics from `coverage-summary.json` and directory
aggregates from `coverage-final.json` using Istanbul's coverage map give:

| Scope | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| All included production code | 84.36% | 84.05% | 83.56% | 87.95% |
| Core queries (17 files) | 38.19% | 38.24% | 44.67% | 84.00% |
| Core transactions (17 files) | 61.49% | 61.00% | 65.88% | 66.31% |

The final run on Node 24.15.0 passed all 170 test files: 3,635 tests passed and
17 pre-existing cases were skipped. All configured thresholds passed. An earlier
run hit the architecture subprocess's 30-second deadline; its bounded limit is
now 60 seconds, and both its focused V8 rerun and this complete run passed.
Test failures and coverage thresholds remain separate checks.

These are regression floors, not an assertion that query/transaction coverage is
adequate. The review baseline was 82.84% lines overall, 34.66% for queries and
56.93% for transactions. Increase the floors as focused tests improve coverage;
do not exclude an untested production module or lower a floor to make a failure
green. Distribution and group query dispatchers remain at zero coverage; auth,
staking, and Wasm queries are also sparsely exercised. Transaction gaps include
distribution, governance, group, manifest, SKU, and Wasm dispatch. Codec round
trips, CLI interactive key management, and side-effect recovery boundaries also
remain priorities. The five Node CLI entry modules appear with zero coverage;
consumer subprocess smoke checks do not instrument those modules in this report.

`scripts/check-coverage.test.mjs` runs the real provider and checked-in thresholds
against independent temporary query and transaction packages. Each keeps global
coverage at least 99% while a never-imported module must appear with zero covered
lines and fail its directory's threshold. Exercising that module must make the
same gate pass. Removing either directory's threshold therefore fails this guard
even when global coverage is healthy. A third fixture places its uncovered module
outside both directories to independently verify the global floor. These checks
are independent of the long workspace run. Existing type-tripwire and
live-acceptance checks remain separate requirements.

## TypeScript strictness

The shared compiler configuration now enables `verbatimModuleSyntax` and
`noImplicitOverride`. Type imports must be explicit, and a subclass member that
overrides a base-class member must declare that relationship. The initial probe
needed four override modifiers on Fred readiness error context members; existing
type-only imports already satisfied the first flag. These checks apply through
`tsconfig.base.json` to the workspace compiler projects.

The Node CLI package uses ES2022 library declarations for standard error causes
and `AggregateError`, supported by its Node.js 22.19 minimum runtime.

The next flags, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, remain
staged work under ENG-806. The review's simultaneous four-flag probe reported 407
production diagnostics; those are migration sites, not 407 demonstrated bugs.
Apply the remaining flags one package at a time, distinguish omitted fields from
explicit `undefined`, and validate array/indexed lookups at the boundary. Fix the
underlying contract rather than adding broad casts or non-null assertions. Keep
test fixtures subject to the same contracts where their package config includes
them.

## Compiler migration

Registry metadata on 2026-09-08 reports TypeScript 7.0.2 as latest. The repository
retains TypeScript 5.9.3 while its tooling migration is assessed. TypeScript 7 is
the native compiler and does not ship the earlier JavaScript compiler API;
[Microsoft documents the transition and a side-by-side TypeScript 6 API alias](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

The downloaded 7.0.2 tarball lacks `lib/typescript.js`; importing that legacy API
fails with `ERR_MODULE_NOT_FOUND`. Its root export exposes version information,
while its new unstable API exports use different entry points. This project uses
the earlier API directly in `scripts/check-type-tests.test.mjs` and
`tools/package-integrity.mjs`. Dependency-cruiser 18.2.0's supported TypeScript
range is `>=2.0.0 <7.0.0` (`src/meta.cjs`). The type-test harness also invokes
`typescript/bin/tsc` directly, so an API/native-compiler alias setup must specify
which compiler that path runs. Replacing the compiler package is therefore a
tooling migration, not just a version change.
Before upgrading:

1. Validate a supported JavaScript API compatibility package/alias for existing
   AST consumers and a separately pinned native compiler. Update any direct
   executable paths and preserve meaningful `.test-d.ts` execution.
2. Check dependency-cruiser, tsdown declaration emission, Vitest type checking,
   publint/AreTheTypesWrong, and every local AST-based guard with that combination.
3. Run the known-bad type-test control, package integrity controls, complete
   workspace/E2E type checks, package/browser builds, and architecture rules.
   A passing application-only `tsc` run is insufficient.

No compiler-major dependency upgrade is included in this change. The stricter
source checks are active now; the native compiler and remaining strictness flags
remain explicit follow-up work.

The coverage command allows a 30-second default test deadline because instrumented
browser/build meta-tests need more time than ordinary unit tests. Explicit
per-test deadlines still apply. The normal test command retains its usual limits.
