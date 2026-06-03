# deployApp / deployManifest Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `fred`'s `deployApp` orchestration into a `deployManifest(input, opts)` apply primitive that takes a pre-built, boundary-validated manifest string; make `deployApp` a thin wrapper; land ENG-258 #1/#2; harden the new user-supplied-string boundary; and give partial-failure a machine-readable error contract.

**Architecture:** `deployManifest` (new file `deployManifest.ts`) owns parse→validate→resolve-SKU→create-lease→set-domain→upload→poll. `deployApp` (existing file) keeps the typed-field build logic and delegates. Shared helpers `extractLeaseUuid`/`findSkuUuid` and the result type move to `deployManifest.ts`. One `agent-core` consumer (`classify-deploy-error.ts`) migrates to the new error discriminant. No `packages/core` change.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, biome. Reference spec: `docs/superpowers/specs/2026-06-03-eng-280-deploymanifest-split-design.md`.

**Working dir:** the worktree `.claude/worktrees/eng-280-deploymanifest-split` (already created; `npm install` already run). Run all commands from the repo root of that worktree.

---

## File Structure

- **Create `packages/fred/src/tools/deployManifest.ts`** — the apply primitive. Exports: `SkuSelector`, `DeployManifestInput`, `DeployManifestOptions`, `DeployAppResult` (moved here), `deployManifest`. Module-private: `extractLeaseUuid`, `findSkuUuid` (moved from `deployApp.ts`).
- **Create `packages/fred/src/tools/deployManifest.test.ts`** — the primitive's test suite.
- **Modify `packages/fred/src/tools/deployApp.ts`** — drop the moved helpers + orchestration; keep `ServiceConfig`/`DeployAppInput` + the build branches; `deployApp` becomes a wrapper calling `deployManifest`. Re-export `DeployAppResult` from `deployManifest.js` so existing imports keep working.
- **Modify `packages/fred/src/manifest.ts`** — add a case-folded top-level-key collision check inside `validateService` (covers single manifests + stack services).
- **Modify `packages/fred/src/index.ts`** — export `deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions`.
- **Modify `packages/agent-core/src/internals/classify-deploy-error.ts`** — branch on `details.partial === true` first, prefix as fallback.
- **Modify `CHANGELOG.md`** — `[Unreleased]` entries.

Existing `packages/fred/src/tools/deployApp.test.ts` (950 lines) is the **backward-compat contract** — it must stay green **unmodified**.

---

# Commit A — the split + ENG-258 (#1 pre-resolved SKU, #2 same-provider storage)

### Task A1: Move `findSkuUuid`/`extractLeaseUuid` + types into `deployManifest.ts`; add the provider filter

**Files:**
- Create: `packages/fred/src/tools/deployManifest.ts`
- Create: `packages/fred/src/tools/deployManifest.test.ts`
- Modify: `packages/fred/src/tools/deployApp.ts` (remove the moved helpers; import them)

- [ ] **Step 1: Write the failing test** — `packages/fred/src/tools/deployManifest.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { isRetryableError } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { findSkuUuid } from './deployManifest.js';

function qcWithTwoProviders() {
  return makeMockQueryClient({
    sku: {
      providers: [
        { uuid: 'prov-1', address: 'm1', apiUrl: 'http://p1', active: true },
        { uuid: 'prov-2', address: 'm2', apiUrl: 'http://p2', active: true },
      ],
      skus: [
        { uuid: 'sku-compute', name: 'docker-micro', providerUuid: 'prov-1', basePrice: { amount: '1', denom: 'umfx' } },
        { uuid: 'sku-store-p2', name: 'storage-10g', providerUuid: 'prov-2', basePrice: { amount: '1', denom: 'umfx' } },
      ],
      providerLookup: { 'prov-1': { provider: { apiUrl: 'http://p1' } } as any },
    },
  });
}

describe('findSkuUuid provider filter (ENG-258 #2)', () => {
  it('rejects a tier that exists only on a different provider with non-retryable INVALID_CONFIG', async () => {
    const qc = qcWithTwoProviders();
    let thrown: unknown;
    try {
      await findSkuUuid(qc as any, 'storage-10g', 'prov-1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestMCPError);
    expect((thrown as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
    expect((thrown as ManifestMCPError).message).toContain('prov-1');
    expect(isRetryableError(thrown)).toBe(false);
  });

  it('resolves a tier on the named provider', async () => {
    const qc = qcWithTwoProviders();
    const { skuUuid } = await findSkuUuid(qc as any, 'storage-10g', 'prov-2');
    expect(skuUuid).toBe('sku-store-p2');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './deployManifest.js'`)

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `deployManifest.ts` with the moved helpers + the filter.** Move `extractLeaseUuid` (deployApp.ts:34-64) verbatim and `findSkuUuid` (deployApp.ts:66-87) with the new `providerUuid?` param:

```ts
import type {
  CosmosClientManager,
  CosmosTxResult,
  LeaseState,
  ManifestQueryClient,
} from '@manifest-network/manifest-mcp-core';
import {
  cosmosTx,
  createPagination,
  logger,
  MAX_PAGE_LIMIT,
  ManifestMCPError,
  ManifestMCPErrorCode,
  requireUuid,
  sanitizeForLogging,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import type { PollOptions } from '../http/fred.js';
import { pollLeaseUntilReady, TerminalChainStateError } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
  uploadLeaseData,
} from '../http/provider.js';
import { getServiceNames, metaHashHex, validateManifest } from '../manifest.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export function extractLeaseUuid(txResult: CosmosTxResult): string {
  // ... lifted VERBATIM from deployApp.ts:34-64 ...
}

export async function findSkuUuid(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string,
): Promise<{ skuUuid: string; providerUuid: string }> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({ activeOnly: true, pagination });

  const named = result.skus.filter((s) => s.name === size);
  if (named.length > 0) {
    if (providerUuid === undefined) {
      return { skuUuid: named[0].uuid, providerUuid: named[0].providerUuid };
    }
    const onProvider = named.find((s) => s.providerUuid === providerUuid);
    if (onProvider) {
      return { skuUuid: onProvider.uuid, providerUuid: onProvider.providerUuid };
    }
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `SKU tier "${size}" is not offered by provider ${providerUuid} (the provider selected for the compute tier). ` +
        `Provider(s) offering "${size}": ${named.map((s) => s.providerUuid).join(', ')}.`,
    );
  }

  const available = result.skus.map((s) => s.name);
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    `SKU tier "${size}" not found on any provider. Available: ${available.join(', ')}`,
  );
}
```

> Note: the no-provider error path was `QUERY_FAILED` in the old code; it is now `INVALID_CONFIG` (non-retryable). Keep the unused imports (`cosmosTx`, `logger`, etc.) — they are consumed by `deployManifest` in Task A3.

- [ ] **Step 4: Remove `extractLeaseUuid` + `findSkuUuid` from `deployApp.ts`** and import them: add `import { extractLeaseUuid, findSkuUuid } from './deployManifest.js';` (temporary — `deployApp` still uses them until Task A4).

- [ ] **Step 5: Run the test — expect PASS**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the existing contract suite — expect still PASS**

Run: `npx vitest run packages/fred/src/tools/deployApp.test.ts`
Expected: PASS (unchanged behavior — `findSkuUuid` is called without the 3rd arg).

- [ ] **Step 7: Commit**

```bash
git add packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployManifest.test.ts packages/fred/src/tools/deployApp.ts
git commit -m "refactor(fred): move findSkuUuid/extractLeaseUuid to deployManifest.ts; add provider filter (ENG-258 #2)"
```

### Task A2: Define `SkuSelector` / `DeployManifestInput` / `DeployManifestOptions` and move `DeployAppResult`

**Files:**
- Modify: `packages/fred/src/tools/deployManifest.ts`
- Modify: `packages/fred/src/tools/deployApp.ts` (re-export `DeployAppResult`)

- [ ] **Step 1: Add the types to `deployManifest.ts`** (move the `DeployAppResult` interface verbatim from `deployApp.ts:161-173` into `deployManifest.ts`, then add):

```ts
export interface DeployAppResult {
  // ... lifted VERBATIM from deployApp.ts:161-173 ...
}

export type SkuSelector =
  | { kind: 'byName'; size: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };

export interface DeployManifestInput {
  manifest: string;
  sku: SkuSelector;
  storage?: string;
  customDomain?: string;
  serviceName?: string;
  gasMultiplier?: number;
  onLeaseCreated?: (leaseUuid: string, providerUrl: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

export interface DeployManifestOptions {
  clientManager: CosmosClientManager;
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  getLeaseDataAuthToken: (address: string, leaseUuid: string, metaHash: string) => Promise<string>;
  fetchFn?: typeof globalThis.fetch;
}
```

- [ ] **Step 2: In `deployApp.ts`, remove the local `DeployAppResult` interface and re-export it:** add `export type { DeployAppResult } from './deployManifest.js';` and update `deployApp`'s own usages to import it. Keep `ServiceConfig` and `DeployAppInput` in `deployApp.ts`.

- [ ] **Step 3: Run lint — expect PASS**

Run: `cd packages/fred && npx tsc --noEmit; cd ../..`
Expected: no errors (types resolve; `DeployAppResult` re-exported).

- [ ] **Step 4: Commit**

```bash
git add packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployApp.ts
git commit -m "feat(fred): add DeployManifestInput/Options + SkuSelector; relocate DeployAppResult"
```

### Task A3: Implement `deployManifest` (the orchestration extraction + ENG-258 #1/#2)

**Files:**
- Modify: `packages/fred/src/tools/deployManifest.ts`
- Modify: `packages/fred/src/tools/deployManifest.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `deployManifest.test.ts`). Add the mocks at the TOP of the file (above imports), mirroring `deployApp.test.ts:3-55`:

```ts
// --- add these vi.mock blocks at the very top of deployManifest.test.ts ---
import { beforeEach, vi } from 'vitest';
vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@manifest-network/manifest-mcp-core')>();
  return { ...actual, cosmosTx: vi.fn(), setItemCustomDomain: vi.fn() };
});
vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return { ...actual, uploadLeaseData: vi.fn(), getLeaseConnectionInfo: vi.fn() };
});
vi.mock('../http/fred.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/fred.js')>();
  return { ...actual, pollLeaseUntilReady: vi.fn() };
});
```

```ts
// --- append these tests; reuse the mock-wiring from deployApp.test.ts:36-132 ---
import { cosmosTx, LeaseState, setItemCustomDomain } from '@manifest-network/manifest-mcp-core';
import { makeMockClientManager } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { pollLeaseUntilReady } from '../http/fred.js';
import { getLeaseConnectionInfo, uploadLeaseData } from '../http/provider.js';
import { deployManifest } from './deployManifest.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockUpload = vi.mocked(uploadLeaseData);
const mockPoll = vi.mocked(pollLeaseUntilReady);
const getAuthToken = vi.fn(async () => 'auth');
const getLeaseDataAuthToken = vi.fn(async () => 'lease-data');

function deps(cm: unknown) {
  return { clientManager: cm as any, getAuthToken, getLeaseDataAuthToken };
}
function singleManifest() {
  return JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } });
}

describe('deployManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // copy the mockCosmosTx/mockPoll/mockGetLeaseConnectionInfo defaults
    // VERBATIM from deployApp.test.ts:90-131 (lease_uuid event, ACTIVE state, connection).
  });

  it('deploys a single-service manifest and uploads the ORIGINAL bytes', async () => {
    const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
    const manifest = singleManifest();
    const res = await deployManifest({ manifest, sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm));
    expect(res.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    const uploaded = new TextDecoder().decode(mockUpload.mock.calls[0][2]);
    expect(uploaded).toBe(manifest); // byte-identical, not re-serialized
  });

  it('ENG-258 #1: kind:resolved skips the SKU query', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });
    await deployManifest(
      { manifest: singleManifest(), sku: { kind: 'resolved', skuUuid: 'sku-x', providerUuid: 'prov-1' } },
      deps(cm),
    );
    expect(spy).not.toHaveBeenCalled();
    // create-lease used the supplied skuUuid verbatim:
    expect(mockCosmosTx.mock.calls[0][3]).toContain('sku-x:1');
  });

  it('rejects an invalid manifest BEFORE create-lease', async () => {
    const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
    await expect(
      deployManifest({ manifest: '{"image":""}', sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });
});
```

> Reuse `makeQueryClient` from `deployApp.test.ts:60-84` (copy it into this file).

- [ ] **Step 2: Run — expect FAIL** (`deployManifest` not exported).

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `deployManifest`** in `deployManifest.ts`. This is the orchestration lifted from `deployApp.ts:272-498` with the manifest-build branch removed and the SKU selector + provider-pinned storage added:

```ts
export async function deployManifest(
  input: DeployManifestInput,
  opts: DeployManifestOptions,
): Promise<DeployAppResult> {
  const { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn } = opts;

  // Parse (Task B hardens this) + validate at the boundary, before any tx.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifest);
  } catch (err) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = validateManifest(parsed);
  if (!result.valid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Invalid manifest: ${result.errors.join('; ')}`,
      { errors: result.errors },
    );
  }
  const isStack = result.format === 'stack';
  const serviceNames = isStack ? getServiceNames(parsed) : [];

  // customDomain / serviceName coherence (manifest-derived).
  let normalizedCustomDomain: string | undefined;
  if (input.customDomain !== undefined) {
    normalizedCustomDomain = input.customDomain.trim();
    if (normalizedCustomDomain === '') {
      throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'customDomain cannot be empty or whitespace-only');
    }
    if (isStack) {
      if (!input.serviceName) {
        throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'serviceName is required when setting customDomain on a stack lease; pick one of the service keys');
      }
      if (!serviceNames.includes(input.serviceName)) {
        throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, `serviceName "${input.serviceName}" does not match any service. Available: ${serviceNames.join(', ')}`);
      }
    } else if (input.serviceName) {
      throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'serviceName must not be set on a single-service manifest');
    }
  } else if (input.serviceName !== undefined) {
    throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'serviceName is only meaningful when customDomain is set');
  }

  const address = await clientManager.getAddress();
  await clientManager.acquireRateLimit();
  const queryClient = await clientManager.getQueryClient();

  const manifestMetaHash = await metaHashHex(input.manifest);

  // SKU resolution (ENG-258 #1).
  let skuUuid: string;
  let providerUuid: string;
  switch (input.sku.kind) {
    case 'resolved':
      skuUuid = input.sku.skuUuid;
      providerUuid = input.sku.providerUuid;
      break;
    case 'byName': {
      const r = await findSkuUuid(queryClient, input.sku.size);
      skuUuid = r.skuUuid;
      providerUuid = r.providerUuid;
      break;
    }
    default: {
      const _exhaustive: never = input.sku;
      throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, `Unknown sku selector: ${JSON.stringify(_exhaustive)}`);
    }
  }

  const leaseItems: string[] = isStack
    ? serviceNames.map((n) => `${skuUuid}:1:${n}`)
    : [`${skuUuid}:1`];

  // Storage on the SAME provider (ENG-258 #2).
  if (input.storage) {
    const { skuUuid: storageSkuUuid } = await findSkuUuid(queryClient, input.storage, providerUuid);
    leaseItems.push(`${storageSkuUuid}:1`);
  }

  const providerUrl = await resolveProviderUrl(queryClient, providerUuid);

  const overrides = input.gasMultiplier !== undefined ? { gasMultiplier: input.gasMultiplier } : undefined;
  const txResult = await cosmosTx(clientManager, 'billing', 'create-lease', ['--meta-hash', manifestMetaHash, ...leaseItems], true, overrides);
  const leaseUuid = extractLeaseUuid(txResult);

  await input.onLeaseCreated?.(leaseUuid, providerUrl);

  let status;
  try {
    input.abortSignal?.throwIfAborted();
    if (normalizedCustomDomain !== undefined) {
      await setItemCustomDomain(clientManager, leaseUuid, normalizedCustomDomain, { serviceName: input.serviceName }, overrides);
    }
    const leaseDataToken = await getLeaseDataAuthToken(address, leaseUuid, manifestMetaHash);
    await uploadLeaseData(providerUrl, leaseUuid, new TextEncoder().encode(input.manifest), leaseDataToken, fetchFn, input.abortSignal);
    status = await pollLeaseUntilReady(providerUrl, leaseUuid, () => getAuthToken(address, leaseUuid), { ...input.pollOptions, abortSignal: input.abortSignal }, fetchFn);
  } catch (err) {
    // Partial-success wrap — lifted VERBATIM from deployApp.ts:420-453.
    // (Task C1/C2 add details.partial/failedStep + TerminalChainStateError lease_uuid.)
    if (err instanceof TerminalChainStateError) {
      throw err.withContext({ providerUuid, providerUrl });
    }
    const code = err instanceof ManifestMCPError ? err.code : ManifestMCPErrorCode.QUERY_FAILED;
    const details = err instanceof ManifestMCPError
      ? { ...err.details, lease_uuid: leaseUuid, provider_uuid: providerUuid, provider_url: providerUrl }
      : { lease_uuid: leaseUuid, provider_uuid: providerUuid, provider_url: providerUrl };
    throw new ManifestMCPError(code, `Deploy partially succeeded: lease ${leaseUuid} was created but subsequent steps failed. Close this lease with close_lease if needed. Error: ${err instanceof Error ? err.message : String(err)}`, details);
  }

  // Connection info (best-effort) + return — lifted VERBATIM from deployApp.ts:455-498,
  // substituting `input.manifest`/`normalizedCustomDomain`/`input.serviceName`.
  // ... (paste verbatim) ...
}
```

- [ ] **Step 4: Run the new tests — expect PASS**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployManifest.test.ts
git commit -m "feat(fred): implement deployManifest apply primitive (ENG-258 #1/#2)"
```

### Task A4: Make `deployApp` a thin wrapper

**Files:**
- Modify: `packages/fred/src/tools/deployApp.ts`

- [ ] **Step 1: Replace `deployApp`'s body** — keep the two typed-input checks (image XOR services at deployApp.ts:187-198; port-with-image at 199-204) and the manifest-build branches (272-327), then delegate. Remove the orchestration (now in `deployManifest`):

```ts
export async function deployApp(
  clientManager: CosmosClientManager,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  getLeaseDataAuthToken: (address: string, leaseUuid: string, metaHashHex: string) => Promise<string>,
  input: DeployAppInput,
  fetchFn?: typeof globalThis.fetch,
): Promise<DeployAppResult> {
  // ... keep the image/services XOR + port-required checks VERBATIM (deployApp.ts:187-204) ...
  // ... keep the manifest-string build (services branch + image branch) VERBATIM (deployApp.ts:276-327)
  //     producing `manifestJson` ...

  return deployManifest(
    {
      manifest: manifestJson,
      sku: { kind: 'byName', size: input.size },
      storage: input.storage,
      customDomain: input.customDomain,
      serviceName: input.serviceName,
      gasMultiplier: input.gasMultiplier,
      onLeaseCreated: input.onLeaseCreated,
      abortSignal: input.abortSignal,
      pollOptions: input.pollOptions,
    },
    { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn },
  );
}
```

Add `import { deployManifest } from './deployManifest.js';`. Remove the now-unused customDomain/serviceName coherence block (deployApp.ts:223-270) — that validation now lives in `deployManifest` and is exercised by the manifest it builds. Remove now-unused imports.

- [ ] **Step 2: Run the existing contract suite UNMODIFIED — expect PASS**

Run: `npx vitest run packages/fred/src/tools/deployApp.test.ts`
Expected: PASS (all 950 lines of contract tests still green — same behavior through the wrapper).

> If a test fails: the wrapper's behavior diverged. Fix the wrapper, NOT the test.

- [ ] **Step 3: Add a wrapper test that builder output always validates** (append to `deployApp.test.ts`? No — it must stay unmodified; add to `deployManifest.test.ts`):

```ts
it('wrapper: builder output passes validateManifest (no self-built manifest is rejected)', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  // a representative typed input that exercises many builder fields:
  await expect(
    deployApp(cm as any, getAuthToken, getLeaseDataAuthToken, {
      image: 'nginx:alpine', port: 80, size: 'docker-micro',
      env: { FOO: 'bar' }, command: ['sh'], labels: { a: 'b' },
    }),
  ).resolves.toMatchObject({ state: LeaseState.LEASE_STATE_ACTIVE });
});
```

Import `deployApp` in `deployManifest.test.ts`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts packages/fred/src/tools/deployApp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/tools/deployApp.ts packages/fred/src/tools/deployManifest.test.ts
git commit -m "refactor(fred): deployApp becomes a thin wrapper over buildManifest + deployManifest"
```

### Task A5: Export the new surface; full gate

**Files:**
- Modify: `packages/fred/src/index.ts`

- [ ] **Step 1: Add exports** — after the existing `deployApp` export block (index.ts:99-104):

```ts
export {
  type DeployManifestInput,
  type DeployManifestOptions,
  deployManifest,
  type SkuSelector,
} from './tools/deployManifest.js';
```

- [ ] **Step 2: Build + lint + test fred**

Run: `cd packages/fred && npm run build && npx tsc --noEmit && npm run test; cd ../..`
Expected: build OK, no type errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/fred/src/index.ts
git commit -m "feat(fred): export deployManifest + DeployManifestInput/Options + SkuSelector"
```

---

# Commit B — boundary hardening (size cap, __proto__, case-fold)

### Task B1: Manifest size cap before parse

**Files:** Modify `deployManifest.ts`, `deployManifest.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('rejects an oversized manifest before any tx', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  const huge = JSON.stringify({ image: 'x', ports: { '80/tcp': {} }, labels: { big: 'A'.repeat(300_000) } });
  await expect(
    deployManifest({ manifest: huge, sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)),
  ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  expect(mockCosmosTx).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL** (no size guard; manifest validates and proceeds).

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts -t oversized`

- [ ] **Step 3: Implement** — at the very top of `deployManifest`, before `JSON.parse`:

```ts
const MAX_MANIFEST_BYTES = 256 * 1024; // module-level const
const manifestBytes = new TextEncoder().encode(input.manifest);
if (manifestBytes.length > MAX_MANIFEST_BYTES) {
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    `Manifest is ${manifestBytes.length} bytes; the maximum is ${MAX_MANIFEST_BYTES}.`,
  );
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
- [ ] **Step 5: Commit** — `git commit -am "feat(fred): cap manifest size at the deployManifest boundary"`

### Task B2: Reject top-level `__proto__`/`constructor` own-keys

**Files:** Modify `deployManifest.ts`, `deployManifest.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('rejects a top-level __proto__ key', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  const manifest = '{"image":"nginx","ports":{"80/tcp":{}},"__proto__":{"polluted":true}}';
  await expect(
    deployManifest({ manifest, sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)),
  ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  expect(mockCosmosTx).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — immediately after `JSON.parse` succeeds (before `validateManifest`). Uses `Object.keys().includes()` not `Object.hasOwn` (base tsconfig targets ES2020; see deployApp.ts:246-254 for the same discipline):

```ts
if (parsed !== null && typeof parsed === 'object') {
  const topKeys = Object.keys(parsed as Record<string, unknown>);
  if (topKeys.includes('__proto__') || topKeys.includes('constructor')) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'Manifest must not contain a top-level "__proto__" or "constructor" key.',
    );
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(fred): reject __proto__/constructor at the manifest boundary (defense-in-depth)"`

### Task B3: Case-folded top-level-key collision check in `validateManifest`

**Files:** Modify `packages/fred/src/manifest.ts`, create assertions in `packages/fred/src/manifest.test.ts`

- [ ] **Step 1: Failing test** — append to `manifest.test.ts`:

```ts
import { validateManifest } from './manifest.js';
it('rejects keys that collide case-insensitively (Go field-matching differential)', () => {
  const parsed = JSON.parse('{"image":"a","IMAGE":"b","ports":{"80/tcp":{}}}');
  const r = validateManifest(parsed);
  expect(r.valid).toBe(false);
  expect(r.errors.join(' ')).toMatch(/case-insensitive/i);
});
```

- [ ] **Step 2: Run — expect FAIL** (currently `IMAGE` is flagged only as an unknown field, not a case collision; the test asserts the collision message).

Run: `npx vitest run packages/fred/src/manifest.test.ts -t case-insensitive`

- [ ] **Step 3: Implement** — in `validateService` (manifest.ts), replace the unknown-key loop (lines 353-358) with a version that also detects case-folded collisions:

```ts
// unknown keys + case-folded collisions (Go encoding/json matches fields
// case-insensitively; V8 keeps `image` and `IMAGE` as two keys).
const seenLower = new Map<string, string>();
for (const key of Object.keys(service)) {
  const lower = key.toLowerCase();
  const prev = seenLower.get(lower);
  if (prev !== undefined) {
    errors.push(`${scope}: keys "${prev}" and "${key}" collide case-insensitively (the provider matches fields case-insensitively)`);
  } else {
    seenLower.set(lower, key);
  }
  if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
    errors.push(`${scope}.${key}: unknown field`);
  }
}
```

- [ ] **Step 4: Run — expect PASS.** Also run the full manifest suite: `npx vitest run packages/fred/src/manifest.test.ts`
- [ ] **Step 5: Commit** — `git commit -am "feat(fred): validateManifest rejects case-folded top-level-key collisions (ENG-280 §7)"`

### Task B4: Security regression test — malformed service name rejected before create-lease

**Files:** Modify `deployManifest.test.ts`

- [ ] **Step 1: Write the test** (validate-before-build ordering is load-bearing):

```ts
it('rejects a stack manifest with an injection-y service name, with no create-lease', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  const manifest = JSON.stringify({ services: { 'evil:name': { image: 'nginx' } } });
  await expect(
    deployManifest({ manifest, sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)),
  ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  expect(mockCosmosTx).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect PASS already** (validateManifest's RFC-1123 check + step ordering already enforce this; this test pins the guarantee).

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts -t injection`
Expected: PASS. (If it FAILS — ordering regressed; fix `deployManifest` so validation precedes any `cosmosTx` call.)

- [ ] **Step 3: Commit** — `git commit -am "test(fred): pin validate-before-build ordering blocks service-name injection"`

---

# Commit C — structured errors + observability + consumer migration

### Task C1: `details.partial` + `failedStep` on the partial-success wrap

**Files:** Modify `deployManifest.ts`, `deployManifest.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('partial failure carries details.partial + failedStep + lease_uuid', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  mockUpload.mockRejectedValueOnce(new Error('provider 503'));
  let thrown: any;
  try {
    await deployManifest({ manifest: singleManifest(), sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm));
  } catch (e) { thrown = e; }
  expect(thrown.details).toMatchObject({
    partial: true,
    failedStep: 'upload',
    lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
  });
  expect(thrown.message).toContain('Deploy partially succeeded:'); // prefix retained
});
```

- [ ] **Step 2: Run — expect FAIL** (no `partial`/`failedStep`).

- [ ] **Step 3: Implement** — track the step and add the fields. In `deployManifest`'s try block, set a `let step` before each operation:

```ts
let step: 'set_domain' | 'upload' | 'poll' = 'poll';
let status;
try {
  input.abortSignal?.throwIfAborted();
  if (normalizedCustomDomain !== undefined) {
    step = 'set_domain';
    await setItemCustomDomain(/* ... */);
  }
  step = 'upload';
  const leaseDataToken = await getLeaseDataAuthToken(address, leaseUuid, manifestMetaHash);
  await uploadLeaseData(/* ... */);
  step = 'poll';
  status = await pollLeaseUntilReady(/* ... */);
} catch (err) {
  if (err instanceof TerminalChainStateError) {
    throw err.withContext({ lease_uuid: leaseUuid, providerUuid, providerUrl }); // Task C2
  }
  const code = err instanceof ManifestMCPError ? err.code : ManifestMCPErrorCode.QUERY_FAILED;
  const base = err instanceof ManifestMCPError ? err.details : undefined;
  throw new ManifestMCPError(
    code,
    `Deploy partially succeeded: lease ${leaseUuid} was created but subsequent steps failed. Close this lease with close_lease if needed. Error: ${err instanceof Error ? err.message : String(err)}`,
    { ...base, partial: true, failedStep: step, lease_uuid: leaseUuid, provider_uuid: providerUuid, provider_url: providerUrl },
  );
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(fred): partial-success errors carry details.partial/failedStep (ENG-280 §5)"`

### Task C2: `TerminalChainStateError` carries `lease_uuid`

**Files:** `deployManifest.ts` (done in C1 step 3), `deployManifest.test.ts`; verify `withContext` accepts the field.

- [ ] **Step 1: Check `withContext`** — `grep -n "withContext" packages/fred/src/http/fred.ts`. Confirm it merges arbitrary keys into `details`. If it has a fixed param shape, widen it to accept `lease_uuid?: string`.

- [ ] **Step 2: Failing test**

```ts
it('TerminalChainStateError surfaces lease_uuid', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  mockPoll.mockImplementationOnce(async () => { throw new TerminalChainStateError('550e8400-e29b-41d4-a716-446655440000', LeaseState.LEASE_STATE_CLOSED); });
  let thrown: any;
  try { await deployManifest({ manifest: singleManifest(), sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(TerminalChainStateError);
  expect(thrown.details?.lease_uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
});
```

- [ ] **Step 3: Run — expect PASS** (the `withContext({ lease_uuid, ... })` added in C1). If FAIL because `withContext` drops unknown keys, widen it.
- [ ] **Step 4: Commit** — `git commit -am "feat(fred): TerminalChainStateError includes lease_uuid in details"`

### Task C3: Observability around the spend (sanitized)

**Files:** `deployManifest.ts`, `deployManifest.test.ts`

- [ ] **Step 1: Failing test** (assert the security property — no raw manifest/token in logs — not exact levels):

```ts
import { logger } from '@manifest-network/manifest-mcp-core';
it('logs around create-lease without leaking the manifest body or tokens', async () => {
  const cm = makeMockClientManager({ queryClient: makeQueryClient(), address: 'manifest1tenant' });
  const lines: string[] = [];
  const spyInfo = vi.spyOn(logger, 'info').mockImplementation((m: string) => { lines.push(String(m)); });
  const spyWarn = vi.spyOn(logger, 'warn').mockImplementation((m: string) => { lines.push(String(m)); });
  const secret = 'TOPSECRETIMAGE';
  await deployManifest({ manifest: JSON.stringify({ image: secret, ports: { '80/tcp': {} } }), sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm));
  expect(lines.join('\n')).not.toContain(secret);
  expect(lines.some((l) => l.includes('lease'))).toBe(true);
  spyInfo.mockRestore(); spyWarn.mockRestore();
});
```

- [ ] **Step 2: Run — expect FAIL** (no logs yet).

- [ ] **Step 3: Implement** — add `logger.info` before create-lease and after (success path), and `logger.warn` in the catch. Never pass the manifest string or tokens; pass only ids/counts:

```ts
logger.info(`[deploy] creating lease (meta_hash=${manifestMetaHash}, items=${leaseItems.length})`);
const txResult = await cosmosTx(/* ... */);
const leaseUuid = extractLeaseUuid(txResult);
logger.info(`[deploy] lease ${leaseUuid} created on provider ${providerUuid}`);
// ... in the catch, before throwing:
logger.warn(`[deploy] lease ${leaseUuid} created but step '${step}' failed; close_lease to clean up`);
```

> These ids are non-sensitive (`meta_hash`, `lease_uuid`, `providerUuid`). Do not log `input.manifest` or any token. Default `LOG_LEVEL` is `warn`, so the failure-path `warn` is default-visible; the `info` lines are an audit aid (see spec §6).

- [ ] **Step 4: Run — expect PASS.** Full fred suite: `cd packages/fred && npm run test; cd ../..`
- [ ] **Step 5: Commit** — `git commit -am "feat(fred): sanitized observability logs around the create-lease spend"`

### Task C4: Migrate `agent-core/classify-deploy-error.ts` to the discriminant

**Files:** Modify `packages/agent-core/src/internals/classify-deploy-error.ts`; its test file.

- [ ] **Step 1: Failing test** — append to the classify-deploy-error test (find it: `ls packages/agent-core/src/internals/classify-deploy-error*test*`):

```ts
it('classifies via details.partial === true (no prefix needed)', () => {
  const r = classifyDeployError({ message: 'something failed', details: { partial: true, lease_uuid: 'abc' } });
  expect(r.outcome).toBe('partially_succeeded');
  expect(r.leaseUuid).toBe('abc');
});
it('still classifies via the legacy prefix when details.partial is absent', () => {
  const r = classifyDeployError({ message: 'Deploy partially succeeded: lease abc ...', details: {} });
  expect(r.outcome).toBe('partially_succeeded');
});
```

- [ ] **Step 2: Run — expect FAIL** on the first case (today only the prefix triggers `partially_succeeded`).

Run: `npx vitest run packages/agent-core/src/internals/classify-deploy-error.test.ts`

- [ ] **Step 3: Implement** — in `classifyDeployError`, before the `message.startsWith(PARTIAL_PREFIX)` block (classify-deploy-error.ts:84), add a strict discriminant check:

```ts
const partialFlag = (details as { partial?: unknown }).partial === true;
if (partialFlag || message.startsWith(PARTIAL_PREFIX)) {
  let leaseUuid: string | undefined;
  if (typeof details.lease_uuid === 'string') {
    leaseUuid = details.lease_uuid;
  } else {
    const m = message.match(UUID_PATTERN);
    if (m) leaseUuid = m[0];
  }
  return finalize({ outcome: 'partially_succeeded', ...(leaseUuid !== undefined && { leaseUuid }), reason: message }, expectedCustomDomain);
}
```

(Replace the existing `if (message.startsWith(PARTIAL_PREFIX)) {` block with this combined condition. `=== true` is strict to preserve the existing anti-false-positive discipline.)

- [ ] **Step 4: Run — expect PASS.** Full agent-core suite: `cd packages/agent-core && npm run test; cd ../..`
- [ ] **Step 5: Commit** — `git commit -am "feat(agent-core): classify-deploy-error branches on details.partial (prefix fallback)"`

### Task C5: CHANGELOG + full workspace gate

**Files:** Modify `CHANGELOG.md`

- [ ] **Step 1: Add `[Unreleased]` entries** under the existing headings (match the file's existing style):

```markdown
### Changed
- **fred:** new public exports `deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions`; `deployApp` is now a thin wrapper over `buildManifest`/`buildStackManifest` + `deployManifest` (behavior unchanged). `findSkuUuid` gains an optional `providerUuid` filter. Partial-success errors now carry `details.partial`/`details.failedStep`; the `Deploy partially succeeded:` message prefix is retained. (ENG-280)

### Security
- **fred:** `deployManifest` validates the manifest string at the boundary before any on-chain tx — manifest size cap, `__proto__`/`constructor` rejection, and a case-folded top-level-key collision check (the Go field-matching differential). (ENG-280)
```

- [ ] **Step 2: Full gate across the workspace**

Run: `npm run build && npm run lint 2>&1 | grep -iE "error|TS[0-9]{4}" || echo LINT_CLEAN; npm run test 2>&1 | grep -iE "FAIL|failed" || echo TESTS_CLEAN; npm run check`
Expected: build OK; `LINT_CLEAN`; `TESTS_CLEAN`; biome check exits 0.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(eng-280): CHANGELOG for deployManifest split + ENG-258 + hardening"
```

---

## Self-Review (run by me after writing — done)

**Spec coverage:** split → A3/A4; ENG-258 #1 → A3 (resolved arm) + test; #2 → A1 (provider filter) + A3 (storage pin) + test; `INVALID_CONFIG` → A1; exports → A5; size cap → B1; `__proto__` → B2; case-fold → B3; validate-before-build → B4; `details.partial`/`failedStep` → C1; `TerminalChainStateError` lease_uuid → C2; observability → C3; consumer migration → C4; CHANGELOG/gate → C5. `deployApp` backward-compat contract → A4 step 2 (unmodified suite). All spec sections map to a task.

**Type consistency:** `deployManifest(input, opts)`, `DeployManifestOptions` (not `DeployDeps`), `SkuSelector.kind` `'byName'|'resolved'`, `details.partial`/`failedStep` used identically in C1/C2/C4 and the tests.

**Placeholder note:** the three "lifted VERBATIM from deployApp.ts:NNN-NNN" spans (extractLeaseUuid, the connection-info tail, the build branches) are explicit copy instructions with exact line ranges — the source is in-repo; the engineer copies the named lines rather than re-deriving. Every NEW or CHANGED line is shown in full.
