# ENG-129 PR 4 — Replace agent-core stubs with `manageDomain`, `closeLease`, `troubleshootDeployment`

Final slice of the manifest-agent-core extraction. Drops the three `NotImplemented`-throwing stubs in favor of typed orchestrators that compose existing internals (`verify-recover`, `verify-domain-state`, `lease-items`, `lease-state`) with the chain primitives `setItemCustomDomain` and `stopApp` already exported from `manifest-mcp-core`. The frozen public type contract from ENG-128 is preserved verbatim.

Branch: `worktree-eng-129-pr-4`
Linear: <https://linear.app/liftedinit/issue/ENG-129>

## Summary

- **`manageDomain(args, callbacks, opts)`** — dispatches on `args.action` to `set` / `clear` / `lookup`. Set + clear render a confirm block, broadcast `setItemCustomDomain`, then verify the post-broadcast on-chain state via `verifyAndRecover` driving `verify-domain-state` over a direct `billing.v1.lease({ leaseUuid })` query (single-lease lookup; no pagination edge cases). Lookup is a read-only `leaseByCustomDomain` query that returns `{ lease: null }` on NotFound rather than throwing.
- **`closeLease(args, callbacks, opts)`** — validates UUID, renders a confirm block (image-unknown placeholder per blueprint §2.8 #2 deferral), broadcasts `stopApp`, then verifies via a direct `billing.v1.lease({ leaseUuid })` query + `lease-state.decode` + `isTerminal`. Terminal states are success; PENDING / ACTIVE flow through the `pending_drift` inform-only failure branch; lease-not-visible flows through the catch-all branch.
- **`troubleshootDeployment(args, callbacks, opts)`** — chain-only (per blueprint §3.3 #3 option b — no `walletProvider` in `TroubleshootOptions`). Single `billing.lease(leaseUuid)` query feeds an inline markdown renderer with `## Chain state`, `## Items`, and `## Guidance` sections.
- **Public surface**: `stubs.ts` deleted; `index.ts` re-exports the three real functions. `BranchId` union (internal, not part of the frozen public surface) extended with `domain_not_found` only (`manage-domain.ts:not_found` uses it). Close-lease's `not_found` branch keeps the catch-all `'unclassified'` per minimal-diff principle — no behavioral impact since the failure reason strings are independent of the branchId.
- **15 committed fixture scenarios** across `manage-domain` (6), `close-lease` (3), and `troubleshoot` (4) — registered in `__fixtures__/scenarios.json`. Each scenario's `expected-*.{txt,md,json}` files are byte-baselines locked by replay assertions.

## Files changed

```
M  packages/agent-core/__fixtures__/scenarios.json           +13 scenarios registered
M  packages/agent-core/src/index.ts                          stubs imports → real exports
M  packages/agent-core/src/internals/verify-recover.ts       BranchId += domain_not_found
D  packages/agent-core/src/stubs.ts                          replaced by the three real modules

A  packages/agent-core/src/manage-domain.ts                  (280 LOC)
A  packages/agent-core/src/close-lease.ts                    (~200 LOC)
A  packages/agent-core/src/troubleshoot.ts                   (~200 LOC)

A  packages/agent-core/src/manage-domain.test.ts             (24 tests)
A  packages/agent-core/src/close-lease.test.ts               (8 tests)
A  packages/agent-core/src/troubleshoot.test.ts              (9 tests)

A  packages/agent-core/__fixtures__/skills/manage-domain/    6 scenarios
A  packages/agent-core/__fixtures__/skills/close-lease/      3 scenarios
A  packages/agent-core/__fixtures__/skills/troubleshoot/     4 scenarios
A  packages/agent-core/PR4_DESCRIPTION.md                    this file
```

## Test plan

Run from the worktree root (`/home/fmorency/dev/manifest-mcp-mono/.claude/worktrees/eng-129-pr-4/`).

| Command | Result |
|---|---|
| `npm run lint` | exit 0 — all 7 packages clean (`tsc --noEmit`) |
| `npm run test` | exit 0 — agent-core: 594 passed / 16 skipped (24 tests in `manage-domain.test.ts` + 8 in `close-lease.test.ts` + 9 in `troubleshoot.test.ts` = 41 PR-4-specific). Whole repo: 1700+ passed across 7 packages. |
| `npm run build` | exit 0 — `tsdown` produces `dist/` for every package; pre-existing `node:*` unresolved-import warnings come from intentional `await import('node:fs' \| 'node:crypto' \| 'node:dns/promises' \| 'node:net')` dynamic-imports in `save-manifest.ts` + `guarded-fetch.ts` (platform-neutral build pattern) |
| `npm run check` | exit 0 — biome formatter + linter clean; 2 pre-existing `Suggested (unsafe) fix` infos in `internals/inspect-image.ts` are unchanged from `main` |

PR-4-specific run:

```
$ npx vitest run src/manage-domain.test.ts src/close-lease.test.ts src/troubleshoot.test.ts
 Test Files  3 passed (3)
      Tests  41 passed (41)
   Duration  804ms
```

Coverage breakdown (per module):

- **manage-domain.test.ts** — 24 tests:
  - 6 fixture replays (`01-set-success`, `02-set-mismatch`, `03-clear-success`, `04-lookup-found`, `05-lookup-not-found`, `06-stack-set-success`)
  - Validation: unknown action / invalid UUID / empty FQDN on set / empty FQDN on lookup
  - FQDN-shape validation (8 negative cases): leading/trailing whitespace, `http://` / `https://` scheme prefix, free-text `not a domain`, leading-hyphen label, trailing-hyphen label, single-label hostname, >253-char overflow — each rejected with a distinct `INVALID_CONFIG` message before any chain call
  - Recovery: verifier `not_found` → onFailure → throw; verifier `mismatch` → onFailure → throw
  - Control-flow: user-declined-confirm; broadcast failure short-circuits verify; lookup trims whitespace before chain query; clear-on-stack threads `{clear:true, serviceName}` through broadcast
- **close-lease.test.ts** — 8 tests:
  - 3 fixture replays (`01-close-success`, `02-close-pending-verify-fail`, `03-close-not-found`)
  - Validation: invalid UUID; user-declined-confirm; broadcast-failure short-circuits verify
  - Verifier branches: terminal REJECTED → success; non-terminal ACTIVE → `pending_drift` inform-only
- **troubleshoot.test.ts** — 9 tests:
  - 4 fixture replays (`01-active-healthy`, `02-pending`, `03-closed-terminal`, `04-lease-not-found`)
  - Validation: invalid UUID
  - Chain-query failure surfaces as wrapped QUERY_FAILED with onFailure
  - Unknown state int → `UNKNOWN(<raw>)` placeholder + degraded guidance
  - Missing providerUuid → `(unknown)` placeholder
  - snake_case payload shapes (`provider_uuid` / `created_at` / `service_name` / `custom_domain`) normalize correctly

## Parity evidence

The fixture trees are committed byte-baselines per the post-decoupling stance (`22b6e5d` — "Fixtures remain committed artifacts; no re-baseline tool ships with this package"). Each scenario locks one specific orchestration path:

### `__fixtures__/skills/manage-domain/`

| Scenario | Locks |
|---|---|
| `01-set-success` | Single-item lease set; happy verify; canonical confirm-block text + typed `{action:'set', verified:true, finalCustomDomain}` |
| `02-set-mismatch` | Verifier `mismatch` reason string: `Chain shows custom_domain="<actual>" for lease <uuid>; expected "<expected>".` |
| `03-clear-success` | Clear-mode confirm-block text (no FQDN line); typed `{action:'clear', verified:true, finalCustomDomain:null}` |
| `04-lookup-found` | Read-only chain query → typed `{action:'lookup', fqdn, lease:{leaseUuid}}` |
| `05-lookup-not-found` | NotFound rejection → typed `{action:'lookup', fqdn, lease:null}` (no throw) |
| `06-stack-set-success` | Stack lease (2 items: web/db); serviceName threads through broadcast + verify; confirm block carries `Service: web` line |

### `__fixtures__/skills/close-lease/`

| Scenario | Locks |
|---|---|
| `01-close-success` | Terminal CLOSED state → success; confirm-block text (UUID + permanence note + image-unknown placeholder); typed `{leaseUuid, finalState:'LEASE_STATE_CLOSED'}` |
| `02-close-pending-verify-fail` | `pending_drift` failure reason: `close_lease tx accepted but state is still LEASE_STATE_PENDING.` |
| `03-close-not-found` | Catch-all failure reason: `lease <uuid> not in tenant leases after close` |

### `__fixtures__/skills/troubleshoot/`

| Scenario | Locks |
|---|---|
| `01-active-healthy` | ACTIVE single-item with customDomain → 12-line markdown report; ACTIVE guidance bullet |
| `02-pending` | PENDING + no items → `_No items found_` placeholder + pending guidance bullets |
| `03-closed-terminal` | CLOSED + Created/Closed timestamps + 2-item body with empty domains → terminal guidance bullets + `(no custom domain)` placeholders |
| `04-lease-not-found` | `{lease:null}` → `Lease <uuid> not found on chain.` failure reason; QUERY_FAILED throw |

Replay assertions:

- `expect(result).toEqual(<expected-result.json>)` for typed result shapes
- `expect(confirms[0]?.text).toBe(<expected-confirm-block.txt>)` for byte-level confirm-block text
- `expect(result.markdown).toBe(<expected-report.md>)` for byte-level troubleshoot reports
- `expect(failures).toEqual([<expected-failure.json>])` for `onFailure({reason})` callback payloads

Any deliberate orchestrator output change going forward MUST update the matching `expected-*` file in the same commit; otherwise replay fails loudly.

## Scope reductions vs blueprint

The shipped implementations are leaner than `packages/agent-core/PR4_BLUEPRINT.md` §1–§3 specified. Every reduction was signed off by the orchestrator after the architect surfaced the divergence; each item below has a one-line rationale and a deferral target. **Reviewer should treat this section as the surprise-prevention contract** — if a deferred feature lands later, it does so via a focused follow-up PR, not silently.

| Reduction | Blueprint § | Rationale | Deferral |
|---|---|---|---|
| **No `internals/validate-domain.ts`** (FQDN-shape validation done inline in `manage-domain.ts:validateArgs`) | §1.6 | Inline `FQDN_RE` regex + the explicit whitespace / scheme-prefix gates cover the same surface area in <20 LOC; extracting an internal would add an indirection without test gain (8 negative cases inline-tested) | Optional refactor; no functional gap |
| **No `internals/dns-precheck.ts`** (5 s `node:dns` A/AAAA/CNAME pre-flight) | §1.6 | Adds 5 s user-visible latency per `set` call + drags `node:dns` dynamic-import surface into agent-core for cosmetic value; chain enforces FQDN format authoritatively | Surface-layer concern — hosts can run DNS pre-checks before calling `manageDomain` |
| **No `internals/remove-manifest.ts`** (idempotent `${dataDir}/manifests/${leaseUuid}.json` unlink on successful close-lease) | §2.6 | `CloseLeaseOptions` doesn't yet carry `dataDir`; saved-manifest persistence in deploy-app is itself best-effort | Land alongside an extension of `CloseLeaseOptions.dataDir?` in a follow-up |
| **No fee estimation** in `manage-domain` / `close-lease` (confirm blocks omit `Estimated tx fee: <FEE_HUMAN>` line) | §1.3.5 / §2.3.3 | Both confirm blocks already convey the destructive / permanent nature of the action; fee humanization requires the same denom-map plumbing deploy-app uses, expanding the options surface | Surface-layer concern — hosts can run `cosmos_estimate_fee` separately before calling these |
| **No mainnet warning banner** in `manage-domain` confirm block | §1.3.7 | `deploy-app.ts` carries the mainnet warning already; manage-domain's effect is reversible (re-call with new FQDN) so the same gravity isn't warranted | Surface-layer concern |
| **No chain-data denom-map humanization** (`chainDataFile` / `denomMap` plumbing) for `ManageDomainOptions` / `CloseLeaseOptions` / `TroubleshootOptions` | §1.3.6 + §2.3.4 + §3.3.5 | Coupled to fee-estimation deferral above; nothing in PR 4 renders a coin amount | Land with the fee-estimation follow-up |
| **`closeLease` confirm block uses `Image: (image not recorded)` placeholder** | §2.3.5 + §2.8 #2 | `summarize-manifest.cjs` not ported — would require reading + redacting saved-manifest JSON, and `CloseLeaseArgs.image?` is a public-contract change | Land with a `summarize-manifest.ts` port (separate follow-up) |
| **`troubleshootDeployment` chain-only** (no `appStatus` / `getAppLogs` / `appDiagnostics` provider-HTTP triplet; no `walletProvider?` on `TroubleshootOptions`; no `tail?` on `TroubleshootArgs`) | §3.3 #3 + §3.8 #4 | Provider-side path requires ADR-036 auth-token plumbing + 2 new internals (`summarize-app-status`, `render-troubleshoot-report`) + 2 additive public-contract fields; the chain-only renderer's ACTIVE-state guidance bullet self-documents the gap ("App-level status / logs require a provider HTTP call with an ADR-036 auth token — out of scope for this chain-only diagnostic") | [ENG-201](https://linear.app/liftedinit/issue/ENG-201) |
| **No `internals/summarize-app-status.ts` / `internals/render-troubleshoot-report.ts`** | §3.6 | Both are part of the deferred troubleshoot-provider-side path above | [ENG-201](https://linear.app/liftedinit/issue/ENG-201) |
| **No new-internals unit tests** (validate-domain, dns-precheck, remove-manifest, summarize-app-status, render-troubleshoot-report) | §1.8 / §2.7 / §3.7 | The internals themselves are deferred; nothing to test yet | Lands with each respective deferral PR |

> **Follow-up Linear ticket:** [ENG-201 — agent-core troubleshootDeployment — provider-side diagnostics](https://linear.app/liftedinit/issue/ENG-201). Captures the deferred provider-side design (parallel-gather composition over `appStatus` / `appDiagnostics` / `getAppLogs`), the two additive public-contract fields (`walletProvider?` + `tail?`), the two missing internals (`summarize-app-status`, `render-troubleshoot-report`), and a 5-step suggested follow-up scope.

## Risks / open questions

1. **`BranchId` extension landed asymmetrically.** `domain_not_found` was added to the union and `manage-domain.ts`'s `not_found` branch wired to it. Close-lease's `not_found` branch retains `'unclassified'` per minimal-diff (failure reason strings are independent of branchId). A future PR may add a named `close_not_visible` member if journal-tag specificity becomes useful.

Scope-reduction deferrals are tracked in the "Scope reductions vs blueprint" section above, not duplicated here.
