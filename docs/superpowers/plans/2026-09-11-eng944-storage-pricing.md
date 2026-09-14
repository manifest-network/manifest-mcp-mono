# ENG-944: storage pricing and fee fidelity

Issue: https://linear.app/liftedinit/issue/ENG-944

## Implementation

1. Preserve the chain's hourly/daily billing unit in resolved SKU candidates.
2. Before confirmation, resolve storage by name on the resolved compute provider.
   Let unresolved or ambiguous storage fail before estimation or confirmation;
   the compute selection callback cannot pin storage (ENG-295 is separate).
3. Build a typed list of planned lease items: one compute item per service,
   followed by one optional storage item. Use the same list for fee estimation
   and pricing, and rebuild it after a plan edit.
4. Render item identities, quantities, prices, and billing units. Sum integer
   amounts with BigInt, converting hourly costs to daily when necessary and
   keeping denominations separate. Explicitly mark incomplete recurring costs.
5. Add offline regressions through real SKU resolution, manifest preparation,
   transaction building, and plan rendering. Capture the simulator's actual
   MsgCreateLease, cancel before broadcast, and exercise Fred's create-lease
   boundary separately to check item parity.
6. Update the public orchestration documentation and Unreleased changelog.

## Validation

- Flat single-service, authored one-service stack, and multi-service stack with
  storage, plus matching no-storage controls.
- Same-provider lookup, cross-provider duplicate names, missing/inactive storage,
  same-provider ambiguity, edited storage/provider/service count, and removal.
- Hourly/daily/mixed units, multiple denominations, missing price or unit,
  amounts beyond Number.MAX_SAFE_INTEGER, and hostile display strings.
- Focused regressions, builds, type checks, workspace tests, coverage, formatting,
  and applicable repository checks. Live acceptance requires the documented
  local Docker/XFS environment or CI.

## Scope

The plugin stays pinned to its released dependency. No storage UUID selector,
SKU category inference, release, or deployment is part of this change. Planning
uses the current catalog; Fred still resolves storage by name at execution.

## Result

Implementation steps 1–6 are complete. The new regression file exercises the
real planning flow and compares its simulated MsgCreateLease with the message
Fred passes to an injected broadcast probe. Neither probe signs or sends a
transaction. Additional tests cover billing-unit mapping and renderer precision
and display sanitization.

Validation of the initial implementation (`1fd36c0`) on 2026-09-11:

- Workspace build, workspace TypeScript checks, E2E TypeScript checks, and Biome:
  passed.
- Full Vitest coverage run: 177 files passed; 3,891 tests passed, 17 skipped;
  no type errors. Statements 84.32%, branches 84.01%, functions 88.27%, lines
  84.60%; all configured thresholds passed.
- Dependency boundaries, bundle-size limits, package integrity, workflow policy,
  dependency-hygiene checks, and coverage-configuration controls: passed.
- Tests requiring local sockets or subprocesses were rerun successfully with
  the necessary execution permissions.
- Live acceptance was not run: the read-only environment preflight could not
  access Docker or find the required `/mnt/fred-xfs` project-quota mount.
- A separate registry audit awaits explicit approval: automatic approval review
  rejected sending dependency metadata to the public npm registry. No dependency
  manifests or lockfiles were changed.


## PR 229 review follow-up

Review: https://github.com/manifest-network/manifest-mcp-mono/pull/229#issuecomment-5636340721

All four main findings were reproduced and addressed:

1. Readiness and rendering now share recurring-cost aggregation over the exact
   planned lease items. Credit checks include every service, storage, and each
   denomination, normalize billing periods, and compare the 24-hour threshold
   with integer arithmetic. Unknown pricing warns while retaining known costs.
2. Every valid plan edit recomputes readiness, pricing, and fees, emits the new
   block, and invokes `onPlan` again. Only an explicit confirmation advances;
   edits can repeat and cancellation remains active throughout the loop.
3. Storage validates at the initial and post-edit input boundaries. Resolution
   errors identify storage and the planning phase; same-provider ambiguity
   explains the available remedies without suggesting a nonexistent storage
   UUID selector. The compute picker callback contract is explicit.
4. `Plan.leaseItems` is required. The obsolete renderer fallback is removed and
   both text baselines now use resolved item identities and the pinned provider.

The billing-unit labels and known-subtotal suggestions are also implemented.
Catalog-read deduplication is deferred: sharing one catalog read would require
coordinating core SKU resolution and Fred readiness and defining the shared
catalog lifetime across interactive selection. `listSkuCandidates` currently
fetches its own catalog and filters a single requested size. Readiness now uses the planned
prices even if its separate catalog query returns another price. Execution
still resolves storage by name, so this change does not promise a price lock.

Regressions cover all three reported readiness examples, confirmation and
cancellation of added storage, repeated edits, abort during the second plan,
invalid storage at both boundaries, contextual storage failures, exact large
credit thresholds, incomplete subtotals, and updated MCP picker/plan messages.


Review-fix validation on 2026-09-11:

- Full coverage: 177 files passed; 3,919 tests passed, 17 skipped; no type errors.
  Statements 84.38%, branches 84.07%, functions 88.27%, lines 84.66%; all
  configured coverage thresholds passed.
- Workspace build and TypeScript checks, E2E type checks, Biome, dependency
  boundaries, package integrity, size limits, workflow policy, dependency
  hygiene, and coverage-configuration checks passed.
- The E2E type build initially exhausted `/tmp`; rerunning with task-owned
  scratch space under `/var/tmp/manifest-eng-944` passed. Subprocess checks
  also passed with the required execution permissions.
- Live chain acceptance and the registry audit remain CI checks for the new
  commit. No dependency manifests or lockfiles changed.
