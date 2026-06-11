# SDK P0 — Plan 3a: Canonical types chokepoint (relocation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Create the single canonical-types chokepoint `packages/core/src/manifest-types.ts` and relocate fred's **pure-data** value/DTO types into it (snake_case wire shapes preserved), flipping fred's definition sites to **type-only re-exports** so the public fred API is byte-preserved. Brand the `DeployResult` id-fields at the producer assembly. **This is the safe, mostly type-layer half of Plan 3** — the data-vs-behavior split (stripping runtime fields, `SkuSelector`→`SkuIntent`, signature changes) is the separate **Plan 3b**.

**Architecture:** Types erase at runtime, so a relocation is a pure type-layer move with zero behavior change — *provided* the order keeps every intermediate commit type-checking. Sequence: (1) create `core/src/manifest-types.ts` with the relocated definitions + the branded `DeployResult` + the net-new `PortConfig`, re-export from the core barrel — core now compiles standalone (it has **no** fred dependency, verified). (2) Flip each fred source module's interface bodies to `export type { … } from '@manifest-network/manifest-mcp-core'`, keeping the **same exported names** (and `DeployResult as DeployAppResult` to preserve the public fred name). (3) Brand `DeployResult.lease_uuid`/`provider_uuid` at the single assembly site in `deployManifest.ts` via the sanctioned `parseLeaseUuid`/`parseProviderUuid` constructors (the values are already chain-validated/resolved, so this is the parse-once wire boundary — no `as Brand` cast leaves `brands.ts`, honoring §8). The fred package barrel (`fred/src/index.ts`) re-exports these types *from their source modules*, so it needs **no change** once the source modules re-export the same names.

**Tech Stack:** TypeScript ESM (`.js` import extensions), vitest 4 (+`--typecheck` for `*.test-d.ts`), tsdown build, `tsc --noEmit` lint, Biome. Spec: §5.1 (data-vs-behavior split — Plan 3a does the relocation; 3b does the split), §5.7, §8. Issue: ENG-309. Builds on Plans 1 (brands) + 2 (logger/options).

**v7 context (already decided):** brands are the scoped set Address/Tenant, LeaseUuid/ProviderUuid/SkuUuid, Fqdn (in `core/src/brands.ts`). `DeployResult` KEEPS snake_case (it is the `deploy_app` MCP `outputSchema` wire DTO — camelCasing it breaks `register-tools.ts:647-657` + the pinned `fred/src/server.test.ts` snake_case assertions). agent-core keeps its OWN camelCase projection (a mapping test pins it — Task 5).

**Scope boundaries (NOT in 3a):**
- `DeployAppInput`/`DeployManifestInput` stay in fred unchanged (they carry the 4 runtime fields → relocating them needs the data-vs-behavior split = **Plan 3b**). `SkuSelector` stays in fred (→ `SkuIntent` in 3b). `PollOptions`/`TerminalChainStateError`/`DeployManifestOptions` stay in fred (runtime/behavior/class).
- The `TerminalChainLeaseState`/`TerminalChainState`/`TerminalChainStateContext` trio stays in fred (fred-only consumers; relocating adds a `fred→core` edge for nothing — YAGNI).
- The **dependency-cruiser chokepoint guard** (only `manifest-types.ts` imports manifestjs type-paths; `as Brand` only in `brands.ts`; no `parse*` in `lcd-adapter`) is a net-new dev-dependency + config + CI wiring → a **dedicated later "boundary guards" plan** (spec §8/§13 bundles all guards into one item). 3a leaves the chokepoint correct-but-unenforced (an acceptable interim per the v7 review). NOTE: the existing `core/src/index.ts:4-7` LeaseState **value** re-export stays as-is; 3a's `manifest-types.ts` only adds a `type LeaseState` import for the relocated types — full reconciliation of the LeaseState value re-export is part of the guards plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/manifest-types.ts` (create) | The chokepoint. All relocated pure-data types (verbatim, snake_case) + branded `DeployResult` + net-new `PortConfig`. Imports `type LeaseState` (manifestjs) + `LeaseUuid`/`ProviderUuid` (`./brands.js`). |
| `packages/core/src/manifest-types.test.ts` (create) | Runtime: the types are reachable via the barrel (smoke). |
| `packages/core/src/manifest-types.test-d.ts` (create) | Type-level: `DeployResult['lease_uuid']` is `LeaseUuid` (not bare `string`); `FredLeaseStatus['state']` is `LeaseState`. |
| `packages/core/src/index.ts` (modify) | Re-export the new types from `./manifest-types.js`. |
| `packages/fred/src/http/provider.ts` (modify) | Replace `InstanceInfo`/`ServiceConnectionDetails`/`ConnectionDetails`/`LeaseConnectionResponse` interface bodies with type-only re-exports from core. Keep all functions. |
| `packages/fred/src/http/fred.ts` (modify) | Replace `FredInstanceInfo`/`FredServiceStatus`/`FredLeaseStatus`/`FredLeaseLogs`/`FredLeaseProvision`/`FredActionResponse`/`FredLeaseRelease`/`FredLeaseReleases`/`FredLeaseInfo` bodies with re-exports. Keep `RawLeaseStatus` (private), `PollOptions`, the Terminal* trio, `TerminalChainStateError`, all functions/consts. |
| `packages/fred/src/manifest.ts` (modify) | Replace `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult` bodies with re-exports. Keep all functions. |
| `packages/fred/src/tools/deployApp.ts` (modify) | Replace the `ServiceConfig` body with a re-export. Keep `DeployAppInput` (3b) referencing the re-exported `ServiceConfig`. |
| `packages/fred/src/tools/deployManifest.ts` (modify) | Replace `DeployAppResult` body with `export type { DeployResult as DeployAppResult }` re-export; **brand the two id-fields at the assembly**. Keep `DeployManifestInput`/`SkuSelector` (3b), `extractLeaseUuid`, all logic. |
| `packages/agent-core/src/deploy-app.test.ts` (modify/append) | Add a field-by-field snake→camel `DeployResult` projection mapping test (Task 5). |

---

## Task 0: Confirm baseline

- [ ] From the worktree root run `npm run build` (expect all 8 packages, exit 0) and `npx vitest run packages/core packages/fred packages/agent-core` (expect green). Plans 1+2 are merged; `node_modules` is installed. If red, STOP and report.

---

## Task 1: Create `core/src/manifest-types.ts` + barrel re-export

**Files:** Create `packages/core/src/manifest-types.ts`, `packages/core/src/manifest-types.test.ts`, `packages/core/src/manifest-types.test-d.ts`. Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing type-level test** — `packages/core/src/manifest-types.test-d.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { LeaseUuid, ProviderUuid } from './brands.js';
import type { DeployResult, FredLeaseStatus, PortConfig } from './manifest-types.js';

describe('manifest-types branding + shape (type-level)', () => {
  it('DeployResult id-fields are branded, not bare string', () => {
    expectTypeOf<DeployResult['lease_uuid']>().toEqualTypeOf<LeaseUuid>();
    expectTypeOf<DeployResult['provider_uuid']>().toEqualTypeOf<ProviderUuid>();
    // erasure: a branded id is still assignable TO string (non-breaking in JSON)
    expectTypeOf<DeployResult['lease_uuid']>().toExtend<string>();
  });
  it('FredLeaseStatus.state keeps the manifestjs LeaseState enum (number), not string', () => {
    expectTypeOf<FredLeaseStatus['state']>().toExtend<number>();
  });
  it('PortConfig is the net-new ENG-282 shape', () => {
    expectTypeOf<PortConfig>().toEqualTypeOf<{ readonly host_port?: number; readonly ingress?: boolean }>();
  });
});
```

- [ ] **Step 2: Write the failing runtime smoke test** — `packages/core/src/manifest-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('manifest-types are reachable + are pure types (no runtime emit)', () => {
  it('the barrel exposes the value exports it should and no accidental runtime value for the types', () => {
    // Types erase; this asserts the relocation did not accidentally export a runtime value
    // named like a type. The brand parse* + logger/options values remain present.
    expect(typeof barrel.parseLeaseUuid).toBe('function');
    expect((barrel as Record<string, unknown>).DeployResult).toBeUndefined();
    expect((barrel as Record<string, unknown>).FredLeaseStatus).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run → fail.** `(cd packages/core && npx vitest run src/manifest-types.test.ts && npx vitest --run --typecheck src/manifest-types.test-d.ts)` → FAIL (`./manifest-types.js` missing). Confirm the failure reason is the missing module, not a typo.

- [ ] **Step 4: Create `packages/core/src/manifest-types.ts`** with EXACTLY this content (every type is the verbatim current fred definition, snake_case preserved; `DeployResult` is the relocated `DeployAppResult` with its two id-fields branded):

```ts
// The SINGLE chokepoint for canonical Manifest/Fred value & wire DTO types (spec §5.1, §8).
// Only this file imports manifestjs generated TYPE paths. Pure DATA only — runtime/behavior
// types (PollOptions, TerminalChainStateError, the deploy *Input specs) stay in fred until
// the data-vs-behavior split (Plan 3b). Snake_case wire shapes are preserved verbatim: several
// of these are MCP `outputSchema` DTOs validated against `structuredContent` at runtime.
import type { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import type { LeaseUuid, ProviderUuid } from './brands.js';

// ===== Manifest build / validation (relocated from fred/src/manifest.ts) =====
export interface BuildManifestOptions {
  image: string;
  ports: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
}

export type ManifestFormat = 'single' | 'stack';

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly format: ManifestFormat | null;
}

// ===== Service config (relocated from fred/src/tools/deployApp.ts) =====
export interface ServiceConfig {
  image: string;
  ports?: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  depends_on?: Record<string, { condition: string }>;
  expose?: string[];
  labels?: Record<string, string>;
}

// ===== Net-new canonical port config (ENG-282). FORWARD-DECLARED: the chokepoint owns the
// canonical shape, but wiring it into `ServiceConfig.ports` (today `Record<string, never>`)
// is ENG-282 and has no P0a consumer — do not wire it here. =====
export interface PortConfig {
  readonly host_port?: number;
  readonly ingress?: boolean;
}

// ===== Provider connection wire types (relocated from fred/src/http/provider.ts) =====
export interface InstanceInfo {
  readonly instance_index: number;
  readonly container_id: string;
  readonly image: string;
  readonly status: string;
  readonly ports?: Record<string, unknown>;
  readonly fqdn?: string;
}

export interface ServiceConnectionDetails {
  readonly host?: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
}

export interface ConnectionDetails {
  readonly host: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
  readonly protocol?: string;
  readonly metadata?: Record<string, string>;
  readonly services?: Record<string, ServiceConnectionDetails>;
}

export interface LeaseConnectionResponse {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly connection: ConnectionDetails;
}

// ===== Fred lease-status / action / release wire types (relocated from fred/src/http/fred.ts) =====
export interface FredInstanceInfo {
  readonly name: string;
  readonly status: string;
  readonly ports?: Record<string, number>;
  readonly fqdn?: string;
}

export interface FredServiceStatus {
  readonly instances: readonly FredInstanceInfo[];
}

export interface FredLeaseStatus {
  readonly state: LeaseState;
  readonly provision_status?: string;
  readonly phase?: string;
  readonly steps?: Record<string, string>;
  readonly instances?: readonly FredInstanceInfo[];
  readonly endpoints?: Record<string, string>;
  readonly last_error?: string;
  readonly fail_count?: number;
  readonly created_at?: string;
  readonly services?: Record<string, FredServiceStatus>;
}

export interface FredLeaseLogs {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly logs: Record<string, string>;
}

export interface FredLeaseProvision {
  readonly status: string;
  readonly fail_count: number;
  /**
   * Set only when the most recent provisioning attempt failed. The Fred
   * provider omits the field on success, so the optional marker matches
   * the wire shape (and matches the same field on FredLeaseStatus above).
   */
  readonly last_error?: string;
}

export interface FredActionResponse {
  readonly status: string;
}

export interface FredLeaseRelease {
  readonly version: number;
  readonly image: string;
  readonly status: string;
  readonly created_at: string;
  readonly error?: string;
  readonly manifest?: string;
}

export interface FredLeaseReleases {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly releases: readonly FredLeaseRelease[];
}

export interface FredLeaseInfo {
  readonly host: string;
  readonly ports?: Record<string, unknown>;
}

// ===== Deploy result wire DTO (relocated from fred/src/tools/deployManifest.ts). KEEPS
// snake_case (it is the `deploy_app` MCP outputSchema validated against structuredContent).
// id-fields are BRANDED — non-breaking, since a brand erases to `string` in JSON. =====
export interface DeployResult {
  readonly lease_uuid: LeaseUuid;
  readonly provider_uuid: ProviderUuid;
  readonly provider_url: string;
  readonly state: LeaseState;
  readonly url?: string;
  readonly connection?: ConnectionDetails;
  readonly connectionError?: string;
  /** Set when a `customDomain` was supplied AND the set-domain tx succeeded. */
  readonly custom_domain?: string;
  /** Set when a `serviceName` was supplied alongside a successful `customDomain` set. */
  readonly service_name?: string;
}
```

- [ ] **Step 5: Re-export from the core barrel.** In `packages/core/src/index.ts`, add a new `export type { … } from './manifest-types.js';` block (place it so Biome can sort; the existing alphabetical-by-source ordering puts it near the `./manifest-types.js` slot). All exports are TYPE-ONLY (these are all `interface`/`type`):

```ts
export type {
  BuildManifestOptions,
  ConnectionDetails,
  DeployResult,
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseInfo,
  FredLeaseLogs,
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseReleases,
  FredLeaseStatus,
  FredServiceStatus,
  InstanceInfo,
  LeaseConnectionResponse,
  ManifestFormat,
  ManifestValidationResult,
  PortConfig,
  ServiceConfig,
  ServiceConnectionDetails,
} from './manifest-types.js';
```

- [ ] **Step 6: Run → pass.** `(cd packages/core && npx vitest run src/manifest-types.test.ts && npx vitest --run --typecheck src/manifest-types.test-d.ts)` → PASS. Then `(cd packages/core && npm run lint)` → exit 0 (core compiles standalone — it has no fred dependency).

- [ ] **Step 7: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/manifest-types.ts packages/core/src/manifest-types.test.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts
git add packages/core/src/manifest-types.ts packages/core/src/manifest-types.test.ts packages/core/src/manifest-types.test-d.ts packages/core/src/index.ts
git commit -m "feat(core): add manifest-types chokepoint with relocated canonical DTOs (ENG-309)"
```

---

## Task 2: Flip fred http + manifest types to re-export from core

**Files:** Modify `packages/fred/src/http/provider.ts`, `packages/fred/src/http/fred.ts`, `packages/fred/src/manifest.ts`. No behavior change — pure type-source flip.

- [ ] **Step 1: `provider.ts`.** Delete the four interface bodies (`InstanceInfo`, `ServiceConnectionDetails`, `ConnectionDetails`, `LeaseConnectionResponse`, currently at lines 152-183) and replace them with an **import-and-re-export** pair near the top of the file's type region. These types are used locally (e.g. `getLeaseConnectionInfo` returns a shape containing `ConnectionDetails`/`LeaseConnectionResponse`), so a bare `export … from` would NOT bring them into local scope — import them AND re-export them:

```ts
import type {
  ConnectionDetails,
  InstanceInfo,
  LeaseConnectionResponse,
  ServiceConnectionDetails,
} from '@manifest-network/manifest-mcp-core';

export type {
  ConnectionDetails,
  InstanceInfo,
  LeaseConnectionResponse,
  ServiceConnectionDetails,
};
```

The `export type { … }` (re-export of the imported names) both preserves the public surface and counts as a use, so `noUnusedLocals` is satisfied even for any name not referenced elsewhere in the file. Keep every function (`getLeaseConnectionInfo`, `uploadLeaseData`, `validateProviderUrl`, `checkedFetch`, `parseJsonResponse`, `getProviderHealth`, etc.) and every other type untouched.

- [ ] **Step 2: `fred.ts`.** Delete the nine exported interface bodies (`FredInstanceInfo`, `FredServiceStatus`, `FredLeaseStatus`, `FredLeaseLogs`, `FredLeaseProvision`, `FredActionResponse`, `FredLeaseRelease`, `FredLeaseReleases`, `FredLeaseInfo`) and replace with an import-and-re-export pair (these are used locally — function return types, `RawLeaseStatus extends Omit<FredLeaseStatus,…>`, `PollOptions.onProgress`):

```ts
import type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseInfo,
  FredLeaseLogs,
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseReleases,
  FredLeaseStatus,
  FredServiceStatus,
} from '@manifest-network/manifest-mcp-core';

export type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseInfo,
  FredLeaseLogs,
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseReleases,
  FredLeaseStatus,
  FredServiceStatus,
};
```

(The existing `import { LeaseState, leaseStateFromJSON, logger } from 'core'` value import stays — these are runtime values `fred.ts` still uses; keep it as a separate statement from the new `import type`.) **KEEP in `fred.ts` (do NOT move):** the private `interface RawLeaseStatus extends Omit<FredLeaseStatus, 'state'>` (it now references the re-exported `FredLeaseStatus` — fine), `PollOptions`, `TerminalChainLeaseState`, `TerminalChainState`, `TerminalChainStateContext`, `TerminalChainStateError` (class), `CHAIN_STATE_TO_LEASE_STATE`, the `PROVISION_*` sets, and every function. The existing value imports (`LeaseState`, `leaseStateFromJSON`, `logger` from core) stay — `fred.ts` still uses `LeaseState`/`leaseStateFromJSON` as runtime values.

- [ ] **Step 3: `manifest.ts`.** Delete the three type bodies — `BuildManifestOptions` (lines 1-21, at the TOP of the file, BEFORE the `import {` at line 23) and `ManifestFormat`/`ManifestValidationResult` (lines 283-289). Add an import-and-re-export pair at the very top (these are used locally — `buildManifest` takes `BuildManifestOptions`, `validateManifest` returns `ManifestValidationResult`):

```ts
// at the top of manifest.ts, before the existing `import { … }` block
import type {
  BuildManifestOptions,
  ManifestFormat,
  ManifestValidationResult,
} from '@manifest-network/manifest-mcp-core';

export type {
  BuildManifestOptions,
  ManifestFormat,
  ManifestValidationResult,
};
```

Keep every function (`buildManifest`, `buildStackManifest`, `validateManifest`, `getServiceNames`, `metaHashHex`, `validateServiceName`, `normalizePorts`, etc.) and all consts. Let Biome `--write` order the import/export statements.

- [ ] **Step 4: Verify green (no behavior change).**
  1. `(cd packages/fred && npm run lint)` → exit 0.
  2. `npx vitest run packages/fred` → all pass (the wire shapes are byte-identical; provider/fred/manifest tests must stay green).

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/fred/src/http/provider.ts packages/fred/src/http/fred.ts packages/fred/src/manifest.ts
git add packages/fred/src/http/provider.ts packages/fred/src/http/fred.ts packages/fred/src/manifest.ts
git commit -m "refactor(fred): re-export http/manifest DTOs from the core chokepoint (ENG-309)"
```

---

## Task 3: Flip deploy types + brand `DeployResult` at the assembly

**Files:** Modify `packages/fred/src/tools/deployApp.ts`, `packages/fred/src/tools/deployManifest.ts`.

- [ ] **Step 1: `deployApp.ts` — relocate `ServiceConfig`.** Delete the `ServiceConfig` interface body (lines 18-37). `DeployAppInput.services?: Record<string, ServiceConfig>` uses `ServiceConfig` locally, so import-and-re-export it (a bare `export … from` would NOT put it in local scope):

```ts
import type { ServiceConfig } from '@manifest-network/manifest-mcp-core';
export type { ServiceConfig };
```

Leave `DeployAppInput`, `skuSelectorFromInput`, and `deployApp` otherwise untouched (they are Plan 3b). The existing `export type { DeployAppResult } from './deployManifest.js';` (line 16) stays as-is.

- [ ] **Step 2: `deployManifest.ts` — relocate `DeployAppResult` → `DeployResult` (aliased) and brand the assembly.**
  1. Delete the `DeployAppResult` interface body (lines 58-70). Import `DeployResult` for local use (the function return type) and re-export it under the public name `DeployAppResult`:

```ts
import type { DeployResult } from '@manifest-network/manifest-mcp-core';
export type { DeployResult as DeployAppResult };
```

  Then change the `deployManifest` return-type annotation from `Promise<DeployAppResult>` (line 107) to `Promise<DeployResult>` (the local name). `deployApp.ts` keeps importing `DeployAppResult` from `./deployManifest.js` — that alias is still exported, so `deployApp`'s `Promise<DeployAppResult>` resolves unchanged. (`ConnectionDetails` continues to come via `import { type ConnectionDetails, … } from '../http/provider.js'` — provider.js re-exports it from core now; no change needed there.)

  2. Add `parseLeaseUuid` and `parseProviderUuid` to the existing value import from core (the block at lines 6-15 that already imports `cosmosTx`, `requireUuid`, etc.):

```ts
import {
  cosmosTx,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  parseLeaseUuid,
  parseProviderUuid,
  requireUuid,
  resolveSku,
  sanitizeForLogging,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
```

  3. Brand the two id-fields at the SUCCESS assembly (the `return { … }` at lines 387-402). Change ONLY these two lines:

```ts
  return {
    lease_uuid: parseLeaseUuid(leaseUuid),
    provider_uuid: parseProviderUuid(providerUuid),
    provider_url: providerUrl,
    state: status.state,
    ...(url && { url }),
    ...(connection && { connection }),
    ...(connectionError && { connectionError }),
    ...(normalizedCustomDomain && { custom_domain: normalizedCustomDomain }),
    ...(normalizedCustomDomain &&
      input.serviceName && { service_name: input.serviceName }),
  };
```

  Rationale: `leaseUuid` is already validated by `extractLeaseUuid` (which keeps using `requireUuid` → preserves its `TX_FAILED` semantics on a malformed chain UUID); `providerUuid` is already chain-resolved. Branding here is the parse-once wire-DTO boundary; routing through `parse*` keeps the lone `as Brand` cast inside `brands.ts` (§8). **Do NOT** brand the partial-success error `details` object (lines 350-352) — error details are `Record<string, unknown>`; leave `lease_uuid: leaseUuid` etc. as plain strings there. **Do NOT** change `extractLeaseUuid`, the `onLeaseCreated` callback, or any `DeployManifestInput`/`SkuSelector` (Plan 3b).

- [ ] **Step 3: Verify green.**
  1. `(cd packages/fred && npm run lint)` → exit 0.
  2. `npx vitest run packages/fred` → all pass. In particular `fred/src/server.test.ts` (the snake_case `lease_uuid`/`provider_uuid` assertions at :451-456/:309-428/etc. and the `deploy_app` outputSchema + annotation matrix at :246-259) must stay green — branding erases to string in JSON, so `structuredContent` validation and the assertions are unaffected.

- [ ] **Step 4: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/fred/src/tools/deployApp.ts packages/fred/src/tools/deployManifest.ts
git add packages/fred/src/tools/deployApp.ts packages/fred/src/tools/deployManifest.ts
git commit -m "refactor(fred): re-export ServiceConfig/DeployResult from core + brand result id-fields (ENG-309)"
```

---

## Task 4: agent-core compiles + imports the relocated types cleanly

**Files:** none expected to change (verification + a possible one-line import-source tidy). `packages/agent-core/src/deploy-app.ts`.

- [ ] **Step 1:** Build agent-core and confirm green: `(cd packages/agent-core && npm run lint)` → exit 0; `npx vitest run packages/agent-core` → all pass. agent-core imports `ConnectionDetails`/`FredLeaseStatus`/`DeployAppResult` (e.g. `deploy-app.ts:49-65`) from the fred package; those names still resolve (fred re-exports them). Brands erase to string, so agent-core's projection (`fredResult.lease_uuid` → `leaseUuid`) still compiles unchanged.
- [ ] **Step 2 (optional tidy, only if it keeps the build green):** if any agent-core import of a relocated *type* reads more naturally from core, you MAY repoint it to `@manifest-network/manifest-mcp-core` to make the new DAG edge explicit — but this is cosmetic; if it adds churn or risk, skip it. Do NOT touch agent-core's own `DeployResult`/`DeploySpec` or `build-fred-input.ts`.
- [ ] **Step 3:** If anything changed, Biome + commit `refactor(agent-core): source relocated DTO types from core (ENG-309)`. Otherwise skip the commit.

---

## Task 5: Pin the agent-core snake→camel `DeployResult` projection (mapping test)

**Files:** Modify/append `packages/agent-core/src/deploy-app.test.ts`. The projection under test lives at `deploy-app.ts:828-842` and is deliberately **NOT** a 1:1 rename (so a future canonical-type adoption can't silently flatten it).

- [ ] **Step 1: Read the projection** at `agent-core/src/deploy-app.ts` ~lines 820-842 and the existing partial assertions at `deploy-app.test.ts:265,269`. Confirm the field map: `lease_uuid→leaseUuid` (direct), `provider_uuid→providerUuid` (direct), `custom_domain→customDomain` (conditional), `state→leaseState` (DECODED to the `LeaseStateName` union, not direct), `url/connection→urls: string[]` (DERIVED via `extractRunningEndpoints(...).map(formatEndpointAsUrl)` with the `fredResult.url` fallback), `manifestPath` (agent-core-only, no wire counterpart), and that `provider_url`/`connectionError`/`service_name` are NOT projected.

- [ ] **Step 2: Write the failing mapping test** — append to `packages/agent-core/src/deploy-app.test.ts` (adapt the construction of the agent-core result to however the existing tests obtain it — reuse the existing harness/mock that already drives a deploy in this file; do not stand up a new mock framework). The test must assert BOTH the direct projections AND that the non-trivial fields are intentionally transformed:

```ts
describe('DeployResult snake→camel projection (deliberate, not a 1:1 rename)', () => {
  it('maps the direct wire id/domain fields and transforms state/urls', async () => {
    // Arrange a successful deploy via the existing test harness so `result` is the
    // agent-core camelCase DeployResult projected from a known snake_case fred DeployResult.
    // (Reuse the same mock setup the surrounding tests use; assert against the known fred fixture.)
    // Direct renames:
    expect(result.leaseUuid).toBe(FRED.lease_uuid);
    expect(result.providerUuid).toBe(FRED.provider_uuid);
    if (FRED.custom_domain) expect(result.customDomain).toBe(FRED.custom_domain);
    // Deliberate transforms (NOT trivial renames) — pin so a future flatten is caught:
    expect(typeof result.leaseState).toBe('string'); // decoded LeaseStateName, not the numeric enum
    expect(Array.isArray(result.urls)).toBe(true);    // derived endpoint list, not `url`
    expect(result).toHaveProperty('manifestPath');     // agent-core-only field
    // Fields intentionally dropped from the projection:
    expect((result as Record<string, unknown>).provider_url).toBeUndefined();
    expect((result as Record<string, unknown>).service_name).toBeUndefined();
  });
});
```

- [ ] **Step 2b: Run → fail** for the right reason (the new assertions), then make it pass by binding `FRED`/`result` to the existing harness's fixture + invocation (NO production change — this test pins existing behavior). If the existing harness makes any of these assertions impossible to express without a production change, STOP and report (it would mean the projection differs from the mapped table — a finding, not a test to force).

- [ ] **Step 3: Run → pass.** `npx vitest run packages/agent-core/src/deploy-app.test.ts` → green.

- [ ] **Step 4: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/agent-core/src/deploy-app.test.ts
git add packages/agent-core/src/deploy-app.test.ts
git commit -m "test(agent-core): pin the snake→camel DeployResult projection (ENG-309)"
```

---

## Task 6: Full gate

- [ ] Run each and confirm the literal outcome of each:
  1. `npm run build` → all 8 packages, exit 0.
  2. `npm run lint` → exit 0 (every package's `tsc --noEmit`).
  3. `npx vitest run` (whole repo unit tests) → all pass.
  4. `(cd packages/core && npx vitest --run --typecheck src/brands.test-d.ts src/manifest-types.test-d.ts)` → all type tests pass (Plan-1 regression + the new branding fixture).
  5. `npm run check` (Biome format/lint/import-sort across the repo) → exit 0.
- [ ] If all green, the relocation is complete with zero behavior change (snake_case wire shapes + public fred API preserved; `DeployResult` id-fields now branded). No commit needed (Tasks 1-5 committed); if `npm run check` applied formatting, commit it as `style: biome formatting (ENG-309)`.

---

## Self-Review (completed)

- **Spec coverage (§5.1 relocation half):** chokepoint `manifest-types.ts` created (only file importing the manifestjs LeaseState type-path for the relocated types) ✓; all pure-data wire/DTO types relocated verbatim, snake_case preserved ✓; `DeployResult` relocated + id-fields branded via producer `parse*` (no `as Brand` outside brands.ts) ✓; `PortConfig` net-new forward-declared ✓; fred flipped to type-only re-exports, public API (incl. `DeployAppResult` name) byte-preserved ✓; agent-core projection pinned by a mapping test ✓. **Deferred to 3b:** the data-vs-behavior split (`AppDeploySpec`/`ManifestDeploySpec`, the call-options bag), `SkuSelector`→`SkuIntent`. **Deferred to the guards plan:** the dependency-cruiser chokepoint enforcement + LeaseState value-re-export reconciliation.
- **Placeholders:** the Task 5 test binds `FRED`/`result` to the existing `deploy-app.test.ts` harness — flagged explicitly because the harness shape must be read at implementation time; the assertions themselves are complete.
- **Type/name consistency:** `DeployResult` (core canonical) is re-exported as `DeployAppResult` (public fred name) everywhere; `parseLeaseUuid`/`parseProviderUuid` names match `brands.ts`/the barrel; the relocated type names are identical across core, the fred re-exports, and the fred barrel.
- **Order safety:** core compiles standalone after Task 1 (no fred dep); fred flips per-file after the core types exist; no intermediate commit references a not-yet-moved type.

## Next plan

→ **Plan 3b (data-vs-behavior split):** strip the 4 runtime fields (`gasMultiplier`/`onLeaseCreated`/`abortSignal`/`pollOptions`) off `DeployAppInput`/`DeployManifestInput` into a fred-layer call-options bag → relocate the now-data-only `AppDeploySpec`/`ManifestDeploySpec` to core; unify `SkuSelector` → branded `SkuIntent` (`size: string`, `providerUuid: ProviderUuid`, `skuUuid: SkuUuid`); update the `deployApp`/`deployManifest` signatures + `register-tools.ts:697-723` call site in lockstep (preserve the `{ ...pollOptions, abortSignal }` merge at deployManifest.ts:308 and the `gasMultiplier→overrides` at :251-254). The riskiest step — isolated per the v7 big-picture review.

→ **Later — boundary guards plan:** author the `dependency-cruiser` config (only `manifest-types.ts` imports manifestjs type-paths; `as Brand` only in `brands.ts`; no `parse*` in `lcd-adapter`) + reconcile the LeaseState value re-export + `publint`/`attw` (spec §8/§13, all guards in one plan).
