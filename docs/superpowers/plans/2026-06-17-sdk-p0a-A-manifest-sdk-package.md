# SDK P0a — Plan A: the `@manifest-network/manifest-sdk` package (aggregating barrel + scoped subpaths)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Stand up a NEW additive `@manifest-network/manifest-sdk` package — a PURE re-export aggregator (a thin root barrel + scoped subpaths `/reads`,`/catalog`,`/deploy`,`/orchestration`,`/node`) over the browser-safe `core`/`fred`/`agent-core` barrels — governed by `publint` + `attw` + `dependency-cruiser` + a real browser-resolution check, so any consumer composes the whole SDK from one package. (Plan B then writes the SDK-direct e2e acceptance app that imports it.)

**Architecture:** The SDK adds ZERO new SDK-source logic — every symbol the spec §9 flow touches is already barrel-exported. The package is an `exports` map + `sideEffects:false` + re-export modules + governance config. ONE prerequisite refactor is required first: **fence `agent-core`'s barrel** (move its `createGuardedFetch` re-export to a node-gated subpath, exactly as ENG-281/287 did for core/fred) so `/orchestration` is browser-safe. Subpaths are scoped (a `/reads`-only import pulls no tx/node code); the ROOT carries factories + types + brands + ports + wallet + errors + config (no free fns — those live on subpaths, which also structurally resolves the `deployApp` name clash: fred's on `/deploy`, agent-core's on `/orchestration`). Spec §4 Option A + §8 + §13.

**Tech Stack:** TypeScript ESM, tsdown (`unbundle:true`, `platform:neutral`), `tsc --noEmit` lint, Biome, vitest, `rolldown` (already installed — the browser-resolution check), `publint` + `@arethetypeswrong/core`, `dependency-cruiser`. Issue: ENG-309. Builds on the COMPLETE 4a→4d keystone.

**⚠️ BROWSER-SAFETY is load-bearing and NOT caught by Node-run vitest.** `agent-core/src/index.ts:3-6` re-exports `createGuardedFetch`/`GuardedFetch` — a STATIC top-level re-export of a module whose browser resolution is `default:null` (core's `/guarded-fetch`). So `/orchestration` re-exporting *any* name from agent-core's `.` barrel HARD-FAILS at browser resolution (not a tree-shaking issue — it fails before tree-shaking). The vitest barrel-hygiene tests run under Node (where the `node` condition resolves), so they PASS while the browser build is broken; dependency-cruiser with `doNotFollow:node_modules` never sees the edge. **The only guard that catches this is an actual browser-condition bundle** (Task A3 Step 5). This is why the agent-core fence (A1) is a hard prerequisite.

---

## Decisions locked (surface-map `w22t2sarv` + review `wo1lb78z2`; Plan-A-relevant)

- **Q4 — TWO sequential plans.** This is Plan A (the package). Plan B (e2e acceptance + full browser build + size budget) DEPENDS on A and follows after A is built.
- **Q5 — thin ROOT + scoped subpaths.** ROOT = factories + types + brands + ports + wallet + errors + config (NO free fns) via `export type * from core` + curated value re-exports. Resolves the `deployApp` clash (fred→`/deploy`, agent-core→`/orchestration`). **(Confirmed by review: `export type *` + named value re-exports of the same symbols compiles clean — no TS2300/TS2308 — and emits only the curated values at runtime.)**
- **Q6 — wholesale query-result types at ROOT** via `export type * from core`.
- **Q7 — `/node` = core's guarded-fetch only**, single `src/node.ts`, `{types,node,default:null}`.
- **Q8 — caret `^0.14.0` on sibling `@manifest-network/*` deps** (matches the established convention; the exact-pin rule is for EXTERNAL/transitive deps via root `overrides`).
- **Q9 — publint + attw gate the SDK only for P0a**; attw profile `esm-only` AND `level:'error'` (default `'warn'` does NOT set exitCode → not a gate). publint/attw peers are NOT installed — add them as devDeps (A2).
- **B1/agent-core fence** — prerequisite Task A1 (browser-safety; the review's load-bearing blocker).
- **/orchestration uses `export type * from agent-core` + `export {5 fns}`** (agent-core's `export * from './types.js'` is type-only → `export type *` re-exports all contract types with zero runtime leak; the 5 value fns come via an explicit `export {}`). Complete-by-construction; still requires A1 (the value export imports the barrel module).
- lockstep version `0.14.0`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/agent-core/src/index.ts` (modify) | REMOVE the `createGuardedFetch`/`GuardedFetch` re-export (`:3-6`) — fence the barrel. |
| `packages/agent-core/src/guarded-fetch.ts` (create) | node-gated re-export of `createGuardedFetch`/`GuardedFetch`/`isBlocked` (from `internals/guarded-fetch.js`). |
| `packages/agent-core/package.json` (modify) | add the `./guarded-fetch` subpath `{types,node,default:null}`. |
| `packages/agent/src/runtime.ts` (modify) | repoint its `createGuardedFetch` import to `@manifest-network/manifest-agent-core/guarded-fetch`. |
| `packages/agent-core/src/index.test.ts` (modify/create) | barrel-hygiene: `createGuardedFetch` ABSENT from the `.` barrel. |
| `packages/sdk/package.json` (create) | name, `type:module`, `sideEffects:false`, 7-entry exports (types-first), caret sibling deps, publint+attw+typescript+vitest+@types/node devDeps. |
| `packages/sdk/tsconfig.json` (create) | extends base; refs core/fred/agent-core; `include:["src/**/*"]`. |
| `packages/sdk/tsdown.config.ts` (create) | esm/unbundle/dts/neutral + `publint:true` + `attw:{profile:'esm-only',level:'error'}`. |
| `packages/sdk/src/{index,reads,catalog,deploy,orchestration,node}.ts` (create) | the 6 re-export barrels. |
| `packages/sdk/src/index.test.ts` (create) | barrel-hygiene (export sets + no node-only leak into browser-safe barrels). |
| `packages/sdk/scripts/browser-resolve.test.ts` (create) | **rolldown bundle of each browser-safe subpath at `platform:'browser'` MUST succeed** (the real `default:null`-chain guard). |
| `.dependency-cruiser.cjs` (create, root) | DAG + manifestjs-TYPE-path chokepoint (scoped) + no-STATIC-node-in-browser-src rules + meta-test fixtures. |
| `<repo> grep/biome meta-test` | the brand-cast-only-in-brands.ts + no-`parse*`-in-lcd-adapter guards (NOT expressible as depcruise import rules). |
| `.github/workflows/{ci,release}.yml` (modify) | publint/attw + depcruise + browser-resolve CI steps; append SDK to the release train. **(gh-token cannot push these — commit locally, user merges.)** |

---

## Task A0: Confirm baseline

- [ ] Worktree root: `npm install` (fresh worktree — ENG-220), then `npm run build` (8 pkgs, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green), `npm run check` (exit 0). Gate on these being GREEN (do not hard-code a HEAD hash). Confirm no `packages/sdk` yet and `npm ls ipaddr.js` resolves a single `2.4.0`.

---

## Task A1: PREREQUISITE — fence `agent-core`'s barrel (browser-safety)

**Why:** re-exporting any orchestration name from agent-core's `.` barrel statically pulls `createGuardedFetch` → core's `/guarded-fetch` (`default:null`) → browser-resolution hard-fail. Fence it like core/fred (ENG-281/287). The ONLY barrel leak is `index.ts:3-6` (`inspect-image.ts` is not barrel-reachable — verified). Consumer to repoint: `packages/agent/src/runtime.ts`.

**Files:** `packages/agent-core/src/{index.ts,guarded-fetch.ts,index.test.ts}`, `packages/agent-core/package.json`, `packages/agent/src/runtime.ts`.

- [ ] **Step 1: Failing barrel-hygiene test** — add to `packages/agent-core/src/index.test.ts` (create if absent; mirror `packages/core/src/index.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('agent-core barrel hygiene', () => {
  it('does NOT re-export the node-only guarded fetch (browser-safety; ENG-281/287)', () => {
    expect(barrel).not.toHaveProperty('createGuardedFetch');
    expect(barrel).not.toHaveProperty('isBlocked');
  });
});
```

- [ ] **Step 2: Run → fail** (`(cd packages/agent-core && npx vitest run src/index.test.ts)`) — the barrel currently re-exports it.

- [ ] **Step 3: Create `packages/agent-core/src/guarded-fetch.ts`:**

```ts
/**
 * Node-only SSRF-guarded fetch, fenced off the package barrel (ENG-281/287 pattern) so the `.`
 * barrel stays browser-bundleable. Re-exported from the in-package internals re-export, which itself
 * pulls core's Node-gated `/guarded-fetch`. Consumers import this via
 * `@manifest-network/manifest-agent-core/guarded-fetch`.
 */
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from './internals/guarded-fetch.js';
```

- [ ] **Step 4: Remove the leak from the barrel** — delete lines 3-6 of `packages/agent-core/src/index.ts` (the `export { createGuardedFetch, type GuardedFetch } from './internals/guarded-fetch.js';` block). Leave the other barrel exports intact.

- [ ] **Step 5: Add the subpath** — `packages/agent-core/package.json` `exports` (mirror core's `/guarded-fetch`):

```json
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./guarded-fetch": { "types": "./dist/guarded-fetch.d.ts", "node": "./dist/guarded-fetch.js", "default": null }
  }
```

- [ ] **Step 6: Repoint the consumer** — `packages/agent/src/runtime.ts`: change the `createGuardedFetch` import from `@manifest-network/manifest-agent-core` to `@manifest-network/manifest-agent-core/guarded-fetch`. (Grep first to confirm runtime.ts is the only consumer; repoint any others.)

- [ ] **Step 7: Run → pass + full-repo lint + Biome + commit.** `(cd packages/agent-core && npx vitest run)` green; worktree-root `npm run build` + `npm run lint` (the agent ripple) green. `git commit -m "refactor(agent-core): fence createGuardedFetch off the barrel onto /guarded-fetch subpath (browser-safety; ENG-309)"`.

---

## Task A2: Scaffold the package

**Files:** `packages/sdk/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts}`.

- [ ] **Step 1: `package.json`** (types-FIRST exports; caret sibling deps; publint/attw peers as devDeps — B2; NO `tsdown`/`@biomejs/biome` devDeps, they are root-hoisted — N4):

```json
{
  "name": "@manifest-network/manifest-sdk",
  "version": "0.14.0",
  "description": "Aggregating SDK for building apps on Manifest + Fred (composes @manifest-network/* over manifestjs).",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "sideEffects": false,
  "files": ["dist"],
  "engines": { "node": ">=22.19.0" },
  "publishConfig": { "access": "public" },
  "exports": {
    ".":               { "types": "./dist/index.d.ts",         "import": "./dist/index.js" },
    "./reads":         { "types": "./dist/reads.d.ts",         "import": "./dist/reads.js" },
    "./catalog":       { "types": "./dist/catalog.d.ts",       "import": "./dist/catalog.js" },
    "./deploy":        { "types": "./dist/deploy.d.ts",        "import": "./dist/deploy.js" },
    "./orchestration": { "types": "./dist/orchestration.d.ts", "import": "./dist/orchestration.js" },
    "./node":          { "types": "./dist/node.d.ts", "node": "./dist/node.js", "default": null },
    "./package.json":  "./package.json"
  },
  "scripts": { "build": "tsdown", "lint": "tsc --noEmit", "test": "vitest run", "test:watch": "vitest" },
  "dependencies": {
    "@manifest-network/manifest-mcp-core": "^0.14.0",
    "@manifest-network/manifest-mcp-fred": "^0.14.0",
    "@manifest-network/manifest-agent-core": "^0.14.0"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "vitest": "4.1.8",
    "@types/node": "<copy fred's exact pin>",
    "publint": "<exact pin — latest installed>",
    "@arethetypeswrong/core": "<exact pin — latest installed>"
  }
}
```

  (Copy the EXACT `typescript`/`vitest`/`@types/node` versions from `packages/fred/package.json`. `publint` + `@arethetypeswrong/core` are tsdown's optional peers — install at exact pins; `@arethetypeswrong/core` NOT `/cli` (tsdown imports `/core`). `rolldown` is already a tree devDep for A3's browser check.)

- [ ] **Step 2: `tsconfig.json`** — extends `../../tsconfig.base.json`, `outDir:./dist`, `rootDir:./src`, `references:[{path:../core},{path:../fred},{path:../agent-core}]`, `include:["src/**/*"]`.

- [ ] **Step 3: `tsdown.config.ts`** (copy fred's + the publint/attw gate — B2):

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: 'esm', unbundle: true, dts: true, sourcemap: true, clean: true,
  target: 'es2020', platform: 'neutral', fixedExtension: false,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
});
```

- [ ] **Step 4: Minimal `src/index.ts`** (M1 — tsdown HARD-ERRORS if the entry glob matches zero files; create a buildable placeholder NOW, filled in A3):

```ts
export { VERSION } from '@manifest-network/manifest-mcp-core';
```

- [ ] **Step 5: `npm install`** (create the workspace symlinks + install publint/attw), then worktree-root `npm run build` (9 pkgs, exit 0 — confirm publint/attw run clean on the placeholder) + `npm run lint`. Commit. `git commit -m "feat(sdk): scaffold @manifest-network/manifest-sdk package (exports + tsdown + publint/attw) (ENG-309)"`.

---

## Task A3: The re-export barrels + the browser-resolution check (TDD)

**Files:** `packages/sdk/src/{index,reads,catalog,deploy,orchestration,node}.ts` + `packages/sdk/src/index.test.ts` + `packages/sdk/scripts/browser-resolve.test.ts`. Mirror the proven barrel-hygiene tests (`packages/core/src/index.test.ts:22-58`).

- [ ] **Step 1: Failing barrel-hygiene tests** — `packages/sdk/src/index.test.ts`: assert each subpath's EXPECTED export set + **no node-only symbol leaks** into the browser-safe barrels (`createGuardedFetch`/`GuardedFetch`/`isBlocked` ABSENT from index/reads/catalog/deploy/orchestration, PRESENT on `./node`) + ROOT exposes the 3 factories and NO free fns:

```ts
import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as reads from './reads.js';
import * as orchestration from './orchestration.js';
import * as node from './node.js';

describe('manifest-sdk barrels', () => {
  it('ROOT exposes the client factories, no free fns', () => {
    for (const k of ['createManifestClient', 'createManifestReadClient', 'createFredClient']) expect(root).toHaveProperty(k);
    for (const k of ['getBalance', 'deployApp', 'executeTx', 'subscribeLeaseStatus']) expect(root).not.toHaveProperty(k);
  });
  it('/reads exposes the 8 reads', () => {
    for (const k of ['getBalance', 'getBillingParams', 'getLease', 'getLeaseByCustomDomain',
      'getLeasesByTenant', 'getProviders', 'getSKUs', 'getWithdrawableAmount']) expect(reads).toHaveProperty(k);
  });
  it('node-only guarded fetch is ONLY on /node', () => {
    for (const b of [root, reads, orchestration]) expect(b).not.toHaveProperty('createGuardedFetch');
    expect(node).toHaveProperty('createGuardedFetch');
  });
});
```

- [ ] **Step 2: Run → fail.** `(cd packages/sdk && npx vitest run)`.

- [ ] **Step 3: Write the barrels.**

  **`src/index.ts`** (ROOT — wholesale TYPE surface + curated VALUE re-exports):

```ts
export type * from '@manifest-network/manifest-mcp-core';
export type { FredClient, FredActions } from '@manifest-network/manifest-mcp-fred';
export {
  createManifestClient, createManifestReadClient, CosmosClientManager,
  parseAddress, parseFqdn, parseLeaseUuid, parseProviderUuid, parseSkuUuid,
  asAddress, asFqdn, asLeaseUuid, asProviderUuid, asSkuUuid,
  createSignerAdapter, requireAuthSigner,
  MnemonicWalletProvider, signArbitraryWithAmino,
  ManifestMCPError, ManifestMCPErrorCode, INFRASTRUCTURE_ERROR_CODES,
  sanitizeForLogging, // @public — spec §7 M5: consumer-reachable redaction for ManifestMCPError.details before logging
  createConfig, validateConfig, createValidatedConfig, resolveCallSignal,
  VERSION,
} from '@manifest-network/manifest-mcp-core';
export { createFredClient, fredActions } from '@manifest-network/manifest-mcp-fred';
```

  **`src/reads.ts`:**

```ts
export {
  getBalance, getBillingParams, getLease, getLeaseByCustomDomain,
  getLeasesByTenant, getProviders, getSKUs, getWithdrawableAmount,
} from '@manifest-network/manifest-mcp-core';
```

  **`src/catalog.ts`:**

```ts
export { resolveSku, listSkuCandidates, type ResolveSkuInput, type SkuCandidate } from '@manifest-network/manifest-mcp-core';
export {
  browseCatalog, mapWithConcurrency,
  buildManifestPreview, type BuildManifestPreviewInput, type BuildManifestPreviewResult, type ManifestPreviewServiceInput,
  checkDeploymentReadiness, type CheckDeploymentReadinessInput, type CheckDeploymentReadinessResult, type SkuSummary,
} from '@manifest-network/manifest-mcp-fred';
```

  **`src/deploy.ts`** (+ `EncodeObject` type for `executeTx` ergonomics + the `LeaseState` runtime enum — N5):

```ts
import type { EncodeObject } from '@cosmjs/proto-signing';
export type { EncodeObject };
export { executeTx, type ExecuteTxResult, fundCredits, type FundCreditsResult, setItemCustomDomain, type SetItemCustomDomainInput, type SetItemCustomDomainResult, stopApp, type StopAppResult, LeaseState, leaseStateFromJSON, leaseStateToJSON } from '@manifest-network/manifest-mcp-core';
export {
  deployApp, type DeployAppInput, type DeployAppResult, type ServiceConfig,
  deployManifest, type DeployManifestInput, type DeployManifestOptions, type DeployCallOptions, type SkuSelector,
  buildManifest, buildStackManifest, mergeManifest, parseStackManifest, validateManifest, validateServiceName,
  normalizePorts, getServiceNames, isStackManifest, deriveAppNameFromImage, metaHashHex,
  getLeaseConnectionInfo, getProviderHealth, uploadLeaseData, validateProviderUrl, checkedFetch, ProviderApiError,
  type ConnectionDetails, type InstanceInfo, type LeaseConnectionResponse, type ServiceConnectionDetails, type ProviderHealthResponse,
  restartLease, updateLease, getLeaseStatus, getLeaseInfo, getLeaseLogs, getLeaseProvision, getLeaseReleases, pollLeaseUntilReady,
  TerminalChainStateError, type TerminalChainState, type TerminalChainLeaseState, type TerminalChainStateContext,
  type FredLeaseStatus, type FredLeaseLogs, type FredLeaseInfo, type FredLeaseProvision, type FredLeaseRelease, type FredLeaseReleases,
  type FredInstanceInfo, type FredServiceStatus, type FredActionResponse, type PollOptions, MAX_TAIL, PROVISION_FAILED, PROVISION_IN_PROGRESS,
  appStatus, restartApp, updateApp, getAppLogs, fetchActiveLease, resolveProviderUrl, waitForAppReady,
  type WaitForAppReadyOptions, type WaitForAppReadyResult,
  subscribeLeaseStatus, type SubscribeCtx, type SubscribeLeaseStatusOptions,
  createAuthTokens, createAuthToken, createSignMessage, createLeaseDataSignMessage, AuthTimestampTracker, type AuthTokenPayload,
} from '@manifest-network/manifest-mcp-fred';
```

  (`LeaseState`/`leaseStateFromJSON`/`leaseStateToJSON` are browser-safe runtime enums from core. The huge fred list is derived from `fred/src/index.ts` — `tsc` + the hygiene test are the gate; if a name doesn't resolve it isn't exported there, reconcile against the real barrel, do NOT invent. `PROVISION_FAILED`/`PROVISION_IN_PROGRESS` are exported by fred per Plan 4d Task 5.)

  **`src/orchestration.ts`** (N1 — `export type *` for the type-only contract surface + the 5 value fns; requires A1):

```ts
// agent-core's `export * from './types.js'` is type-only, so `export type *` re-exports ALL contract
// types (DeployAppOptions, ManageDomain*, Plan, Readiness, ProgressEvent, FailureEnvelope, the
// *Callbacks interfaces, …) with ZERO runtime leak (createGuardedFetch is a VALUE, dropped). The 5
// orchestration fns are the explicit value surface. Browser-safe ONLY because A1 fenced the barrel.
export type * from '@manifest-network/manifest-agent-core';
export {
  deployApp, manageDomain, troubleshootDeployment, closeLease, loadChainDenomMap,
} from '@manifest-network/manifest-agent-core';
```

  **`src/node.ts`:**

```ts
export { createGuardedFetch, isBlocked, type GuardedFetch } from '@manifest-network/manifest-mcp-core/guarded-fetch';
```

- [ ] **Step 4: Run hygiene tests → pass** + `npm run check:fix` (biome import-sort) before commit (N3).

- [ ] **Step 5: Browser-resolution check (the REAL `default:null`-chain guard, B1-secondary)** — `packages/sdk/scripts/browser-resolve.test.ts`: use `rolldown` (already installed) to bundle EACH browser-safe subpath entry (`dist/index.js`, `dist/reads.js`, `dist/catalog.js`, `dist/deploy.js`, `dist/orchestration.js`) with the `browser`/`import` conditions and assert the build SUCCEEDS (a `default:null` chain throws a resolution error). `/node` is EXCLUDED (it is intentionally node-only). Sketch:

```ts
import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

const BROWSER_SAFE = ['index', 'reads', 'catalog', 'deploy', 'orchestration'];
describe('manifest-sdk browser resolution', () => {
  for (const entry of BROWSER_SAFE) {
    it(`/${entry === 'index' ? '.' : entry} resolves under browser conditions (no default:null chain)`, async () => {
      const bundle = await rolldown({
        input: new URL(`../dist/${entry}.js`, import.meta.url).pathname,
        platform: 'browser',
        // resolve.conditionNames defaults include 'browser','import'; ensure 'node' is NOT applied
      });
      await expect(bundle.generate({ format: 'esm' })).resolves.toBeDefined();
      await bundle.close();
    });
  }
});
```

  (Tune rolldown's resolve options against the installed rolldown API so the `node` condition is NOT used — that is what makes the `/guarded-fetch` `default:null` chain throw if a browser-safe barrel ever pulls it. This catches B1-class leaks the Node-run hygiene test cannot. The full browser BUILD + node-builtin string-scan + size budget stay Plan B; this is the minimal fence-verification.) Requires `dist/` built first (`npm run build -w @manifest-network/manifest-sdk`).

- [ ] **Step 6: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(sdk): re-export barrels (thin root + scoped subpaths) + browser-resolution check (ENG-309)"`.

---

## Task A4: `publint` + `attw` confirmation

**Files:** `packages/sdk/tsdown.config.ts` (done in A2 Step 3), `.github/workflows/ci.yml`.

- [ ] **Step 1: Confirm publint+attw run via the SDK build** — `npm run build -w @manifest-network/manifest-sdk` runs publint + attw (`level:'error'`) as part of tsdown. Confirm both are GREEN on the real barrels. Deliberately break a subpath (e.g. point `./reads` at a missing file) and confirm the build FAILS (publint catches it); revert.
- [ ] **Step 2: Wire CI** — add a step to `.github/workflows/ci.yml` running the SDK build (which now includes publint+attw). **gh-token-no-workflow-scope (memory): commit the `ci.yml` edit locally and FLAG to the user that workflow files must be merged in the GitHub UI; do not push.**
- [ ] **Step 3: Commit.** `git commit -m "ci(sdk): gate manifest-sdk with publint + attw (esm-only, level=error) (ENG-309)"`.

---

## Task A5: `dependency-cruiser` boundary + DAG guard

**Files:** `.dependency-cruiser.cjs` (root, create), a fixtures dir, `package.json` (devDep + script), `.github/workflows/ci.yml`, + a grep/biome meta-test for the cast rules.

- [ ] **Step 1: Failing meta-test fixtures** — create known-bad fixtures (NOT compiled into any package) dependency-cruiser MUST flag: (a) a file importing a manifestjs generated-TYPE path from outside `core/src/manifest-types.ts`; (c) a browser-safe barrel STATICALLY importing a `node:` builtin / `undici`. **Do NOT add a "Brand cast outside brands.ts" fixture (M4) — a type assertion produces no import edge, so depcruise can never flag it.**

- [ ] **Step 2: Write `.dependency-cruiser.cjs`** (B3 + M2 corrections applied):

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-core-to-fred-or-agentcore', severity: 'error', from: { path: '^packages/core/src' }, to: { path: '^packages/(fred|agent-core)/src' } },
    { name: 'no-fred-to-agentcore', severity: 'error', from: { path: '^packages/fred/src' }, to: { path: '^packages/agent-core/src' } },
    // B3: scope to the GENERATED TYPE paths only — legit codec/value imports of manifestjs are allowed.
    { name: 'manifestjs-types-chokepoint', severity: 'error',
      from: { path: '^packages', pathNot: '^packages/core/src/manifest-types\\.ts$' },
      to: { path: '@manifest-network/manifestjs/dist/codegen/.+/types(\\.js)?$' } },
    // M2: match ONLY STATIC node imports — a dynamic `import('node:fs')` behind a runtime guard is browser-safe.
    { name: 'no-static-node-in-browser-src', severity: 'error',
      from: { path: '^packages/(core|fred|agent-core|sdk)/src', pathNot: '(guarded-fetch|/node\\.ts$|/server/)' },
      to: { dependencyTypes: ['core'], dependencyTypesNot: ['dynamic-import'], path: '^(node:|undici$|ws$)' } },
  ],
  options: { tsConfig: { fileName: 'tsconfig.base.json' }, tsPreCompilationDeps: true, doNotFollow: { path: 'node_modules' } },
};
```

  (`tsPreCompilationDeps:true` (B3) makes the `import type` edge in `manifest-types.ts` visible. Tune globs against the real tree; the fixtures from Step 1 are the proof. The brand-cast-only-in-brands.ts + no-`parse*`-in-lcd-adapter guards from spec §8 are NOT depcruise import rules — ship them as a grep/biome meta-test in Step 3, M4.)

- [ ] **Step 3: grep/biome meta-test for the cast rules (M4)** — a small test (or a `check`-time grep) asserting: `as Address`/`as LeaseUuid`/… brand casts appear ONLY in `core/src/brands.ts`, and `parse*` is not called in `core/src/lcd-adapter.ts`. (Spec §8 lists both as deliverables — encode them here since depcruise can't.)

- [ ] **Step 4: Add the devDep + script + CI** — `dependency-cruiser` EXACT-pinned root devDep; root script `"depcruise": "depcruise packages --config .dependency-cruiser.cjs"`; a `ci.yml` step (gh-token caveat — commit locally, flag). Run: Step-1 fixtures FAIL, the real tree PASSES (zero violations).

- [ ] **Step 5: Run → green on the real tree + fixtures-fail confirmed** + full-repo lint. Commit. `git commit -m "ci(sdk): dependency-cruiser DAG + manifestjs-type chokepoint + no-static-node guards (+ grep cast meta-tests) (ENG-309)"`.

---

## Task A6: Release wiring (+ `private:true` proposal — USER-GATED)

**Files:** `.github/workflows/release.yml`; (proposal only) the 7 internal `package.json`s.

- [ ] **Step 1: Append the SDK publish line LAST** in `release.yml` (after `packages/node`, line ~68 — SDK deps = core/fred/agent-core, all published earlier; nothing published later depends on it):

```bash
          publish packages/sdk       @manifest-network/manifest-sdk          "$VERSION"
```

  Commit (gh-token caveat — commit locally, flag for the user to merge). `git commit -m "ci(sdk): publish @manifest-network/manifest-sdk last on the release train (ENG-309)"`.

- [ ] **Step 2: `private:true` flip — PROPOSAL ONLY, do NOT execute (M3).** Privatizing the 7 internal `@manifest-network/manifest-mcp-*` packages to make the SDK the sole public entry is **out of scope for P0a and has two concrete breakages** the user must weigh before any flip:
  - (a) `release.yml:61-67` runs `npm publish --workspace` UNCONDITIONALLY per package; `npm publish` **errors on a `private:true` package** — so a flip without also removing that package's publish line breaks the release job.
  - (b) The published `manifest-sdk@0.14.0` has **caret deps** on `@manifest-network/manifest-mcp-{core,fred}` + `manifest-agent-core`; if those are privatized (unpublished), the SDK is **uninstallable** for external consumers. Privatization CANNOT coexist with publishing an SDK that depends on the privatized packages (would require bundling/inlining them).
  - **RECOMMENDATION: do NOT privatize.** Ship the SDK ADDITIVELY (the 7 packages stay public). Present this as a decision for the user; if they want a single public entry later, it needs a separate plan (bundle the deps, or republish the SDK with inlined sources).

- [ ] **Step 3: Full gate** — `npm run build` (9 pkgs, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green), `npm run check` (exit 0), SDK publint+attw green, the browser-resolution test green, `npm run depcruise` green (+ fixtures fail). All green ⇒ Plan A done.

---

## Self-Review (completed; review `wo1lb78z2` blockers folded in)

- **Spec §4 Option A:** aggregating `manifest-sdk` + scoped subpaths; `sideEffects:false`; thin root + free-fns-on-subpaths (resolves the `deployApp` clash); `export type *`+curated-values confirmed to compile clean.
- **Spec §8 browser-safety (the load-bearing fix):** A1 fences agent-core's barrel (the real B1 blocker) so `/orchestration` is browser-safe; the **rolldown browser-resolution check (A3 Step 5)** is the guard that actually catches a `default:null` chain (Node-run vitest + depcruise-doNotFollow do NOT). `/node` is the lone node-only subpath (`default:null`). Boundaries: depcruise DAG + manifestjs-TYPE-path chokepoint (scoped, B3) + no-STATIC-node-in-browser-src (M2) + grep cast meta-tests (M4); `tsPreCompilationDeps:true`.
- **Spec §13/§14:** publint + attw (`esm-only`, `level:'error'` so it actually gates — B2) as installed devDeps; caret sibling deps; release-train append; `private:true` left as a user-gated proposal with its breakages spelled out (M3).
- **Pure aggregator:** zero new SDK-source logic; every symbol verified to exist in the source barrels (review confirmed all ~120 resolve). `tsc` + hygiene + browser-resolution tests catch drift.
- **M1 fixed:** A2 ships a minimal `src/index.ts` so the first tsdown build doesn't hard-error on an empty entry glob.
- **Out of scope (Plan B):** the example app, the live-chain e2e, the FULL browser build + node-builtin string-scan, the per-subpath size budget, the example-imports-only-SDK depcruise rule.
- **User-gated / flagged:** the `private:true` flip (A6 Step 2); all `.github/workflows/*` edits (gh-token-no-workflow-scope — user merges).

## Next plan

→ **Plan B — the SDK-direct e2e acceptance** (depends on Plan A): a NEW `examples/<app>/` workspace whose deps are ONLY `@manifest-network/manifest-sdk` + `manifestjs`; the deploy→query→getLeaseConnectionInfo→setItemCustomDomain→restart/update/getLogs→executeTx-batch→subscribeLeaseStatus(poll)→stopApp flow (single + multi-service) against `e2e/docker-compose.yml` (resolving the in-process `NODE_EXTRA_CA_CERTS` TLS-trust timing); the executeTx batch hand-builds two `MsgFundCredit` from manifestjs codecs (caller sets `sender`/`authority`); the FULL browser build + no-node-builtins string-scan; the per-subpath size budget; + the dependency-cruiser rule that the example imports only the SDK + manifestjs. That e2e is the single tracked P0a metric.
