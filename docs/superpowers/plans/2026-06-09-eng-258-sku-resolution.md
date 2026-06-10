# ENG-258 — SKU Resolution with Duplicate Names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support duplicate SKU names across providers end-to-end by resolving a `size`/`storage` name to a single concrete `(skuUuid, providerUuid)` through one shared resolver, surfacing ambiguity as a structured error (and an in-band elicitation on the agent path), so the plan, fee estimate, and broadcast all reference the same pinned SKU.

**Architecture:** A new `core/sku-resolution.ts` (`resolveSku` / `listSkuCandidates`) is the single source of truth. `fred` consumes it (deploy + readiness + catalog) and exposes `provider_uuid`/`sku_uuid` inputs; `agent-core` resolves the pin once and threads it into fee-estimation, the fred broadcast (via the `resolved` selector), and the plan; `agent` elicits a pick when resolution is ambiguous. Pinning by immutable UUID makes the resolve-then-broadcast window safe — the chain re-validates at `create-lease`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), tsdown build, vitest, biome, zod, `@modelcontextprotocol/sdk`, `@manifest-network/manifestjs` query client.

**Design spec:** `docs/superpowers/specs/2026-06-09-eng-258-sku-resolution-design.md` (read it first — it has the rationale, decisions, and consistency model).

**Suggested PR mapping** (each phase is independently testable; final slicing is the implementer's call):
- Phase 1 → PR1 (core resolver + error code)
- Phase 2 → PR2 (fred deploy resolution + inputs)
- Phase 3 → PR3 (fred readiness + catalog + prompts)
- Phase 4 → PR4 (agent-core pin + readiness)
- Phase 5 → PR5 (agent elicitation)
- Phase 6 → PR6 (e2e)

---

## Shared contracts (referenced by all tasks — keep names exact)

```ts
// packages/core/src/sku-resolution.ts
export interface SkuCandidate {
  readonly skuUuid: string;
  readonly providerUuid: string;
  readonly name: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
}
export interface ResolveSkuInput {
  readonly size: string;            // always supplied (user-facing tier name); used in messages
  readonly providerUuid?: string;   // narrow name matches to one provider
  readonly skuUuid?: string;        // bypass name lookup; wins over size/providerUuid
}
export function resolveSku(qc: ManifestQueryClient, input: ResolveSkuInput): Promise<SkuCandidate>;
export function listSkuCandidates(qc: ManifestQueryClient, size: string, providerUuid?: string): Promise<SkuCandidate[]>;

// SKU_AMBIGUOUS error details shape:
//   { reason: 'AMBIGUOUS_SKU_NAME', size: string, candidates: SkuCandidate[] }
```

Conventions reused from the codebase:
- All resolution operates on a **single** `qc.liftedinit.sku.v1.sKUs({ activeOnly: true, pagination })` fetch (`createPagination(MAX_PAGE_LIMIT)`). The `skuUuid` path filters that active list by uuid (so an inactive/unknown uuid → not found).
- Errors are `ManifestMCPError(code, message, details?)`. Tool wrappers (`withErrorHandling`) serialize `{ code, message, details }` into an `isError: true` result, so `details.candidates` reach the model.
- Tests use `makeMockQueryClient` / `makeMockClientManager` from `@manifest-network/manifest-mcp-core/__test-utils__/mocks.js`.

---

# Phase 1 — core: shared resolver + error code

### Task 1: Add `SKU_AMBIGUOUS` error code (non-retryable)

**Files:**
- Modify: `packages/core/src/types.ts` (enum `ManifestMCPErrorCode`, ~line 366-377)
- Modify: `packages/core/src/retry.ts` (`NON_RETRYABLE_ERROR_CODES`, ~line 17-39)
- Test: `packages/core/src/retry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/retry.test.ts`:

```ts
it('treats SKU_AMBIGUOUS as non-retryable (needs caller disambiguation)', () => {
  const err = new ManifestMCPError(
    ManifestMCPErrorCode.SKU_AMBIGUOUS,
    'multiple SKUs named docker-micro',
  );
  expect(isRetryableError(err)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/retry.test.ts -t SKU_AMBIGUOUS`
Expected: FAIL — `SKU_AMBIGUOUS` does not exist on `ManifestMCPErrorCode`.

- [ ] **Step 3: Add the enum member**

In `packages/core/src/types.ts`, immediately before the closing `}` of `enum ManifestMCPErrorCode` (after `OPERATION_CANCELLED`):

```ts
  // SKU-resolution errors
  // A user-supplied SKU `size`/`storage` name matched more than one active
  // SKU and no disambiguator (provider_uuid / sku_uuid) was given. The error
  // carries `details = { reason: 'AMBIGUOUS_SKU_NAME', size, candidates }`.
  // Non-retryable: retrying without a disambiguator is pointless (ENG-258).
  SKU_AMBIGUOUS = 'SKU_AMBIGUOUS',
```

- [ ] **Step 4: Classify it non-retryable**

In `packages/core/src/retry.ts`, inside the `NON_RETRYABLE_ERROR_CODES` array (after `OPERATION_CANCELLED`):

```ts
  // SKU resolution - ambiguous name needs caller disambiguation, not retry
  ManifestMCPErrorCode.SKU_AMBIGUOUS,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/retry.test.ts -t SKU_AMBIGUOUS`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -m "feat(core): add non-retryable SKU_AMBIGUOUS error code (ENG-258)"
```

---

### Task 2: Create the shared `resolveSku` / `listSkuCandidates` resolver

**Files:**
- Create: `packages/core/src/sku-resolution.ts`
- Create: `packages/core/src/sku-resolution.test.ts`
- Modify: `packages/core/src/index.ts` (barrel; add export near line 33)
- Modify: `packages/core/src/__test-utils__/mocks.ts` (`SkuOverrides.skus` + default `active`)

- [ ] **Step 1: Extend the test mock to carry `active`**

In `packages/core/src/__test-utils__/mocks.ts`, add `active?` to the `skus` element type in `SkuOverrides` (~line 84-89):

```ts
  skus?: {
    uuid?: string;
    name: string;
    providerUuid: string;
    basePrice?: { amount: string; denom: string };
    active?: boolean;
  }[];
```

And default `active: true` where the SKU list is returned (~line 260). Replace:

```ts
          sKUs: vi.fn().mockResolvedValue({ skus }),
```
with:
```ts
          sKUs: vi
            .fn()
            .mockResolvedValue({ skus: skus.map((s) => ({ active: true, ...s })) }),
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/sku-resolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeMockQueryClient } from './__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { listSkuCandidates, resolveSku } from './sku-resolution.js';

function qc(skus: Array<{ uuid: string; name: string; providerUuid: string; basePrice?: { amount: string; denom: string } }>) {
  return makeMockQueryClient({ sku: { skus } }) as never;
}

const dup = [
  { uuid: 'sku-p1', name: 'docker-micro', providerUuid: 'prov-1', basePrice: { amount: '100', denom: 'umfx' } },
  { uuid: 'sku-p2', name: 'docker-micro', providerUuid: 'prov-2', basePrice: { amount: '120', denom: 'umfx' } },
];

describe('resolveSku', () => {
  it('resolves a unique name to its single candidate', async () => {
    const r = await resolveSku(qc([dup[0]]), { size: 'docker-micro' });
    expect(r).toMatchObject({ skuUuid: 'sku-p1', providerUuid: 'prov-1', name: 'docker-micro', active: true });
  });

  it('throws QUERY_FAILED listing available names when no name matches', async () => {
    await expect(resolveSku(qc([dup[0]]), { size: 'nope' })).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  it('throws SKU_AMBIGUOUS with candidates when a name matches >1 and no disambiguator', async () => {
    let thrown: unknown;
    try {
      await resolveSku(qc(dup), { size: 'docker-micro' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestMCPError);
    const err = thrown as ManifestMCPError;
    expect(err.code).toBe(ManifestMCPErrorCode.SKU_AMBIGUOUS);
    expect(err.details).toMatchObject({ reason: 'AMBIGUOUS_SKU_NAME', size: 'docker-micro' });
    expect((err.details as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('narrows by providerUuid', async () => {
    const r = await resolveSku(qc(dup), { size: 'docker-micro', providerUuid: 'prov-2' });
    expect(r.skuUuid).toBe('sku-p2');
  });

  it('throws QUERY_FAILED when the named SKU is not offered by the requested provider', async () => {
    await expect(
      resolveSku(qc(dup), { size: 'docker-micro', providerUuid: 'prov-9' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  it('throws SKU_AMBIGUOUS for same-provider duplicates even with providerUuid (needs sku_uuid)', async () => {
    const sameProv = [
      { uuid: 'a', name: 'docker-micro', providerUuid: 'prov-1' },
      { uuid: 'b', name: 'docker-micro', providerUuid: 'prov-1' },
    ];
    await expect(
      resolveSku(qc(sameProv), { size: 'docker-micro', providerUuid: 'prov-1' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.SKU_AMBIGUOUS });
  });

  it('skuUuid bypasses name lookup and wins', async () => {
    const r = await resolveSku(qc(dup), { size: 'ignored', skuUuid: 'sku-p2' });
    expect(r).toMatchObject({ skuUuid: 'sku-p2', providerUuid: 'prov-2' });
  });

  it('skuUuid not found among active SKUs throws QUERY_FAILED', async () => {
    await expect(
      resolveSku(qc(dup), { size: 'x', skuUuid: 'missing' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  it('skuUuid + mismatched providerUuid throws INVALID_CONFIG', async () => {
    await expect(
      resolveSku(qc(dup), { size: 'x', skuUuid: 'sku-p2', providerUuid: 'prov-1' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
  });
});

describe('listSkuCandidates', () => {
  it('returns all matches for a name (no throw on duplicates)', async () => {
    const list = await listSkuCandidates(qc(dup), 'docker-micro');
    expect(list.map((c) => c.skuUuid).sort()).toEqual(['sku-p1', 'sku-p2']);
  });
  it('filters by providerUuid when given', async () => {
    const list = await listSkuCandidates(qc(dup), 'docker-micro', 'prov-1');
    expect(list).toHaveLength(1);
    expect(list[0].skuUuid).toBe('sku-p1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/sku-resolution.test.ts`
Expected: FAIL — cannot find module `./sku-resolution.js`.

- [ ] **Step 4: Implement the resolver**

Create `packages/core/src/sku-resolution.ts`:

```ts
import type { ManifestQueryClient } from './client.js';
import { createPagination, MAX_PAGE_LIMIT } from './queries/utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * A single concrete SKU. `skuUuid` is the immutable identity; `name` is a
 * free-form, NON-unique label (the chain enforces no name uniqueness).
 */
export interface SkuCandidate {
  readonly skuUuid: string;
  readonly providerUuid: string;
  readonly name: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
}

export interface ResolveSkuInput {
  /** User-facing tier name. Always supplied; used for matching + error messages. */
  readonly size: string;
  /** Narrow name matches to one provider. */
  readonly providerUuid?: string;
  /** Bypass name lookup entirely; wins over size/providerUuid. */
  readonly skuUuid?: string;
}

function toCandidate(s: {
  uuid: string;
  name: string;
  providerUuid: string;
  basePrice?: { amount: string; denom: string };
  active?: boolean;
}): SkuCandidate {
  return {
    skuUuid: s.uuid,
    providerUuid: s.providerUuid,
    name: s.name,
    ...(s.basePrice
      ? { price: { amount: s.basePrice.amount, denom: s.basePrice.denom } }
      : {}),
    active: s.active ?? true,
  };
}

async function fetchActiveSkus(
  queryClient: ManifestQueryClient,
): Promise<SkuCandidate[]> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({
    activeOnly: true,
    pagination,
  });
  return result.skus.map(toCandidate);
}

/** List every active SKU matching `size` (optionally narrowed by provider). No throw on >1. */
export async function listSkuCandidates(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string,
): Promise<SkuCandidate[]> {
  const all = await fetchActiveSkus(queryClient);
  let named = all.filter((s) => s.name === size);
  if (providerUuid !== undefined) {
    named = named.filter((s) => s.providerUuid === providerUuid);
  }
  return named;
}

function ambiguous(size: string, candidates: SkuCandidate[]): ManifestMCPError {
  const lines = candidates
    .map(
      (c) =>
        `  - ${c.name} (sku_uuid=${c.skuUuid}, provider_uuid=${c.providerUuid}` +
        `${c.price ? `, price=${c.price.amount}${c.price.denom}` : ''})`,
    )
    .join('\n');
  return new ManifestMCPError(
    ManifestMCPErrorCode.SKU_AMBIGUOUS,
    `SKU name "${size}" matches ${candidates.length} active SKUs. ` +
      `Specify provider_uuid (or sku_uuid) to disambiguate:\n${lines}`,
    { reason: 'AMBIGUOUS_SKU_NAME', size, candidates },
  );
}

/**
 * Resolve a SKU intent to a single concrete SKU. See the design spec §4.1.
 *
 * - `skuUuid` given → find it among active SKUs; validate `providerUuid` if also given.
 * - else by name → 0 → QUERY_FAILED (lists names); 1 → return; >1 → SKU_AMBIGUOUS.
 *   With `providerUuid`, narrow first; same-provider duplicates → SKU_AMBIGUOUS (require sku_uuid).
 */
export async function resolveSku(
  queryClient: ManifestQueryClient,
  input: ResolveSkuInput,
): Promise<SkuCandidate> {
  const all = await fetchActiveSkus(queryClient);

  if (input.skuUuid !== undefined && input.skuUuid.trim() !== '') {
    const hit = all.find((s) => s.skuUuid === input.skuUuid);
    if (!hit) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `SKU uuid "${input.skuUuid}" not found among active SKUs.`,
      );
    }
    if (
      input.providerUuid !== undefined &&
      input.providerUuid !== hit.providerUuid
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `sku_uuid ${input.skuUuid} belongs to provider ${hit.providerUuid}, ` +
          `not the requested provider_uuid ${input.providerUuid}.`,
      );
    }
    return hit;
  }

  let named = all.filter((s) => s.name === input.size);
  if (named.length === 0) {
    const available = [...new Set(all.map((s) => s.name))].join(', ');
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `SKU tier "${input.size}" not found on any provider. Available: ${available}`,
    );
  }

  if (input.providerUuid !== undefined) {
    const onProvider = named.filter((s) => s.providerUuid === input.providerUuid);
    if (onProvider.length === 0) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `SKU tier "${input.size}" is not offered by provider ${input.providerUuid}. ` +
          `Offered by: ${named.map((s) => s.providerUuid).join(', ')}.`,
      );
    }
    if (onProvider.length > 1) throw ambiguous(input.size, onProvider);
    return onProvider[0];
  }

  if (named.length > 1) throw ambiguous(input.size, named);
  return named[0];
}
```

- [ ] **Step 5: Export from the barrel**

In `packages/core/src/index.ts`, after the `createPagination` export (~line 33):

```ts
export {
  type ResolveSkuInput,
  resolveSku,
  type SkuCandidate,
  listSkuCandidates,
} from './sku-resolution.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/sku-resolution.test.ts`
Expected: PASS (all cases)

- [ ] **Step 7: Type-check core**

Run: `cd packages/core && npm run lint && cd ../..`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/sku-resolution.ts packages/core/src/sku-resolution.test.ts packages/core/src/index.ts packages/core/src/__test-utils__/mocks.ts
git commit -m "feat(core): shared resolveSku/listSkuCandidates with AMBIGUOUS detection (ENG-258)"
```

---

# Phase 2 — fred: deploy resolution + disambiguator inputs

### Task 3: Route fred's deploy through core's `resolveSku`

**Files:**
- Modify: `packages/fred/src/tools/deployManifest.ts` (remove local `findSkuUuid`; use `resolveSku`; `byName` selector keeps `providerUuid`)
- Modify: `packages/fred/src/tools/deployManifest.test.ts` (drop `findSkuUuid` import; move the ENG-258 #2 tests to core coverage; add an AMBIGUOUS deploy case)

- [ ] **Step 1: Update the test file's imports + ambiguity case**

In `packages/fred/src/tools/deployManifest.test.ts`:
- Change the import on line 40 from `import { deployManifest, findSkuUuid } from './deployManifest.js';` to `import { deployManifest } from './deployManifest.js';`
- Delete the entire `describe('findSkuUuid provider filter (ENG-258 #2)', ...)` block (lines 110-132) — that behavior now lives in `core/sku-resolution.test.ts`.
- Add a deploy-level ambiguity test inside `describe('deployManifest', ...)`:

```ts
it('ENG-258 #1: throws SKU_AMBIGUOUS (no provider) for a duplicate name', async () => {
  const qc = makeMockQueryClient({
    sku: {
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '1', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '2', denom: 'umfx' } },
      ],
      providerLookup: { p1: { provider: { apiUrl: 'http://p1' } } as never },
    },
  });
  const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });
  await expect(
    deployManifest({ manifest: singleManifest(), sku: { kind: 'byName', size: 'docker-micro' } }, deps(cm)),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.SKU_AMBIGUOUS });
  expect(mockCosmosTx).not.toHaveBeenCalled(); // no broadcast on ambiguity
});

it('ENG-258 #1: resolves a duplicate name when providerUuid narrows it', async () => {
  const qc = makeMockQueryClient({
    sku: {
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '1', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '2', denom: 'umfx' } },
      ],
      providerLookup: { p2: { provider: { apiUrl: 'http://p2' } } as never },
    },
  });
  const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });
  await deployManifest(
    { manifest: singleManifest(), sku: { kind: 'byName', size: 'docker-micro', providerUuid: 'p2' } },
    deps(cm),
  );
  expect(mockCosmosTx.mock.calls[0][3]).toContain('b:1'); // used p2's sku
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts -t SKU_AMBIGUOUS`
Expected: FAIL — `deployManifest` currently picks `named[0]` and broadcasts (no throw).

- [ ] **Step 3: Replace fred's local `findSkuUuid` with `resolveSku`**

In `packages/fred/src/tools/deployManifest.ts`:
- Add `resolveSku` to the core import block (top of file).
- Delete the entire local `findSkuUuid` function (lines ~60-95).
- Extend the `byName` selector variant (~line 111-113):

```ts
export type SkuSelector =
  | { kind: 'byName'; size: string; providerUuid?: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };
```

- Replace the `byName` case in the SKU-resolution switch (~line 251-256):

```ts
    case 'byName': {
      const r = await resolveSku(queryClient, {
        size: input.sku.size,
        ...(input.sku.providerUuid !== undefined
          ? { providerUuid: input.sku.providerUuid }
          : {}),
      });
      skuUuid = r.skuUuid;
      providerUuid = r.providerUuid;
      break;
    }
```

- Replace the storage branch (~line 271-278) to use `resolveSku` against the compute provider:

```ts
  if (input.storage) {
    const storage = await resolveSku(queryClient, {
      size: input.storage,
      providerUuid,
    });
    leaseItems.push(`${storage.skuUuid}:1`);
  }
```

- [ ] **Step 4: Run the full deployManifest suite**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: PASS (existing single/stack/resolved cases + the two new ambiguity cases).

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployManifest.test.ts
git commit -m "refactor(fred): resolve SKUs via core.resolveSku; AMBIGUOUS on duplicate names (ENG-258)"
```

---

### Task 4: Accept `provider_uuid` / `sku_uuid` on fred's `DeployAppInput`

**Files:**
- Modify: `packages/fred/src/tools/deployApp.ts` (`DeployAppInput` + the `deployManifest` call's `sku` selector)
- Test: `packages/fred/src/tools/deployManifest.test.ts` (add a `deployApp` skuUuid pass-through case)

- [ ] **Step 1: Write the failing test**

Add to `packages/fred/src/tools/deployManifest.test.ts` (inside `describe('deployManifest', ...)` or a new `describe('deployApp sku selection', ...)`):

```ts
it('ENG-258: deployApp with sku_uuid resolves via the resolved selector (no name pick)', async () => {
  const qc = makeMockQueryClient({
    sku: {
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '1', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '2', denom: 'umfx' } },
      ],
      providerLookup: { p2: { provider: { apiUrl: 'http://p2' } } as never },
    },
  });
  const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });
  await deployApp(
    cm as never,
    getAuthToken,
    getLeaseDataAuthToken,
    { image: 'nginx:alpine', port: 80, size: 'docker-micro', skuUuid: 'b', providerUuid: 'p2' },
  );
  expect(mockCosmosTx.mock.calls[0][3]).toContain('b:1');
});
```

(Add `import { deployApp } from './deployApp.js';` if not already present — it is, line 39.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts -t "sku_uuid resolves"`
Expected: FAIL — `DeployAppInput` has no `skuUuid`/`providerUuid`.

- [ ] **Step 3: Implement the input fields + selector mapping**

In `packages/fred/src/tools/deployApp.ts`:

(a) Add `import type { SkuSelector } from './deployManifest.js';` to the imports.

(b) Add to `DeployAppInput` (after `size: string;`):

```ts
  /** Disambiguate a duplicate SKU name to one provider (ENG-258). */
  providerUuid?: string;
  /** Pin a specific SKU by uuid, bypassing name resolution (ENG-258). Wins over size/providerUuid. */
  skuUuid?: string;
```

(c) Add this helper above `deployApp` (it is the SINGLE place that builds the selector):

```ts
function skuSelectorFromInput(input: DeployAppInput): SkuSelector {
  const skuUuid = input.skuUuid?.trim();
  const providerUuid = input.providerUuid?.trim();
  // `resolved` requires BOTH ids — only then can fred skip the lookup.
  if (skuUuid && providerUuid) {
    return { kind: 'resolved', skuUuid, providerUuid };
  }
  // Otherwise resolve by name, carrying whichever disambiguator we have so
  // core.resolveSku can narrow (provider) or pin (skuUuid → learns provider).
  return {
    kind: 'byName',
    size: input.size,
    ...(providerUuid ? { providerUuid } : {}),
    ...(skuUuid ? { skuUuid } : {}),
  };
}
```

(d) Replace the `sku: { kind: 'byName', size: input.size }` line in the `deployManifest(...)` call (~line 180) with:

```ts
      sku: skuSelectorFromInput(input),
```

(e) Extend the `byName` selector variant and its switch case in `deployManifest.ts` to carry the optional `skuUuid`:

```ts
// deployManifest.ts — SkuSelector
  | { kind: 'byName'; size: string; providerUuid?: string; skuUuid?: string }
```
```ts
// deployManifest.ts — byName case (replaces Task 3's version)
    case 'byName': {
      const r = await resolveSku(queryClient, {
        size: input.sku.size,
        ...(input.sku.providerUuid !== undefined ? { providerUuid: input.sku.providerUuid } : {}),
        ...(input.sku.skuUuid !== undefined ? { skuUuid: input.sku.skuUuid } : {}),
      });
      skuUuid = r.skuUuid;
      providerUuid = r.providerUuid;
      break;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/fred/src/tools/deployManifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check fred**

Run: `cd packages/fred && npm run lint && cd ../..`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fred/src/tools/deployApp.ts packages/fred/src/tools/deployManifest.ts packages/fred/src/tools/deployManifest.test.ts
git commit -m "feat(fred): deploy_app accepts provider_uuid/sku_uuid disambiguators (ENG-258)"
```

---

### Task 5: Expose `provider_uuid` / `sku_uuid` in the `deploy_app` tool schema

**Files:**
- Modify: `packages/fred/src/server/register-tools.ts` (`deploy_app` inputSchema ~line 461-590 + the `deployApp(...)` call ~line 619-664)

- [ ] **Step 1: Add the schema fields**

In the `deploy_app` `inputSchema`, after the `size` field (~line 477-479):

```ts
        provider_uuid: z
          .string()
          .optional()
          .describe(
            'Disambiguate when multiple providers publish a SKU with the same `size` name. ' +
              'Get candidates from browse_catalog or check_deployment_readiness. If a name ' +
              'is ambiguous and this is omitted, deploy_app fails with a SKU_AMBIGUOUS error ' +
              'listing the candidates.',
          ),
        sku_uuid: z
          .string()
          .optional()
          .describe(
            'Pin a specific SKU by its uuid, bypassing name resolution. Wins over size/provider_uuid.',
          ),
```

- [ ] **Step 2: Thread them into the deployApp call**

In the `deployApp(...)` input object (~line 624-663), add:

```ts
            providerUuid: args.provider_uuid,
            skuUuid: args.sku_uuid,
```

- [ ] **Step 3: Verify build + existing server tests still pass**

Run: `cd packages/fred && npm run lint && npx vitest run src/server.test.ts && cd ../..`
Expected: PASS — the `deploy_app` annotation/`_meta` matrix is unchanged (only inputs added); structured response shape unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/fred/src/server/register-tools.ts
git commit -m "feat(fred): deploy_app tool schema exposes provider_uuid/sku_uuid (ENG-258)"
```

---

# Phase 3 — fred: readiness candidates + flat catalog + prompts

### Task 6: Return all SKU candidates from `check_deployment_readiness`

**Files:**
- Modify: `packages/fred/src/tools/checkDeploymentReadiness.ts`
- Modify: `packages/fred/src/tools/checkDeploymentReadiness.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace/extend the SKU cases in `checkDeploymentReadiness.test.ts` (the existing single-SKU + flat-name assertions ~lines 40-95, 169-192 must change). Add:

```ts
it('ENG-258: returns all candidates for a duplicate name with distinct provider/price', async () => {
  const qc = makeMockQueryClient({
    sku: {
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '120', denom: 'umfx' } },
      ],
    },
    billing: { creditAccount: 'acct', creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }] },
  });
  const res = await checkDeploymentReadiness(qc as never, 'manifest1tenant', { size: 'docker-micro' });
  expect(res.sku_candidates).toHaveLength(2);
  expect(res.sku).toBeNull(); // ambiguous → no determinate single pick
  expect(res.ready).toBe(false);
  expect(res.missing_steps.join(' ')).toMatch(/provider_uuid|sku_uuid/);
});

it('ENG-258: narrows to a single candidate with provider_uuid', async () => {
  const qc = makeMockQueryClient({
    sku: {
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '120', denom: 'umfx' } },
      ],
    },
    billing: { creditAccount: 'acct', creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }] },
  });
  const res = await checkDeploymentReadiness(qc as never, 'manifest1tenant', {
    size: 'docker-micro',
    providerUuid: 'p2',
  });
  expect(res.sku_candidates).toHaveLength(1);
  expect(res.sku?.uuid).toBe('b');
});

it('ENG-258: exposes available_skus with uuid + provider', async () => {
  const qc = makeMockQueryClient({
    sku: { skus: [{ uuid: 'a', name: 'docker-micro', providerUuid: 'p1' }] },
  });
  const res = await checkDeploymentReadiness(qc as never, 'manifest1tenant', {});
  expect(res.available_skus).toContainEqual({ name: 'docker-micro', uuid: 'a', provider_uuid: 'p1' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/fred/src/tools/checkDeploymentReadiness.test.ts -t ENG-258`
Expected: FAIL — `sku_candidates`/`available_skus` don't exist; `providerUuid` input ignored.

- [ ] **Step 3: Implement the candidate-based readiness**

In `packages/fred/src/tools/checkDeploymentReadiness.ts`:
- Import `listSkuCandidates`, `resolveSku`, and `ManifestMCPErrorCode` from core (alongside existing imports).
- Extend the input + result interfaces:

```ts
export interface CheckDeploymentReadinessInput {
  readonly size?: string;
  readonly image?: string;
  readonly providerUuid?: string;
  readonly skuUuid?: string;
}
```
```ts
export interface CheckDeploymentReadinessResult {
  // ...existing fields unchanged...
  readonly sku: SkuSummary | null;             // determinate pick (1 candidate) or null
  readonly sku_candidates: readonly SkuSummary[]; // all matches for `size` (post-narrowing)
  readonly available_skus: ReadonlyArray<{ name: string; uuid: string; provider_uuid: string }>;
  readonly available_sku_names: readonly string[]; // deprecated hint (kept for back-compat)
  // ...
}
```

- Replace the `skuByName` Map block (~lines 85-120) with candidate resolution. Keep the full active list for `available_skus`:

```ts
  const allActive = skusResult.skus;

  const toSummary = (s: (typeof allActive)[number]): SkuSummary => ({
    name: s.name,
    uuid: s.uuid,
    provider_uuid: s.providerUuid,
    ...(s.basePrice ? { price: { amount: s.basePrice.amount, denom: s.basePrice.denom } } : {}),
    active: s.active,
  });

  let candidates: SkuSummary[] = [];
  if (input.size) {
    candidates = allActive
      .filter((s) => s.name === input.size)
      .filter((s) => (input.providerUuid ? s.providerUuid === input.providerUuid : true))
      .filter((s) => (input.skuUuid ? s.uuid === input.skuUuid : true))
      .map(toSummary);
  }
  const sku = candidates.length === 1 ? candidates[0] : null;

  const missing: string[] = [];
  if (input.size && candidates.length === 0) {
    const available = [...new Set(allActive.map((s) => s.name))].slice(0, 10).join(', ');
    missing.push(`Requested SKU "${input.size}" is not available. Pick one of: ${available || '(none active)'}`);
  } else if (input.size && candidates.length > 1) {
    missing.push(
      `SKU "${input.size}" is offered by ${candidates.length} providers. ` +
        `Specify provider_uuid or sku_uuid (providers: ${candidates.map((c) => c.provider_uuid).join(', ')}).`,
    );
  }
  // ...keep the existing credit/wallet missing-step checks unchanged...
```

- Build the outputs (replace the old `skuSummary` + `available_sku_names` block):

```ts
  const available_skus = allActive
    .map((s) => ({ name: s.name, uuid: s.uuid, provider_uuid: s.providerUuid }))
    .slice(0, MAX_SKU_NAMES_RETURNED);
  // available_sku_names is KEPT for now and REMOVED in Phase 4 (Task 15),
  // together with agent-core's translator that reads it (clean-break sequencing
  // — see spec §9). Removing it here would break agent-core's build in PR3.
  const available_sku_names = [...new Set(allActive.map((s) => s.name))].slice(0, MAX_SKU_NAMES_RETURNED);

  return {
    // ...unchanged fields...
    sku,
    sku_candidates: candidates,
    available_skus,
    available_sku_names,
    ready: missing.length === 0,
    missing_steps: missing,
  };
```

Keep the credit/wallet checks exactly as they were (they don't depend on the SKU map).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/fred/src/tools/checkDeploymentReadiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/tools/checkDeploymentReadiness.ts packages/fred/src/tools/checkDeploymentReadiness.test.ts
git commit -m "feat(fred): check_deployment_readiness returns SKU candidates (ENG-258)"
```

---

### Task 7: Update the `check_deployment_readiness` tool schema

**Files:**
- Modify: `packages/fred/src/server/register-tools.ts` (`check_deployment_readiness` inputSchema ~267-280, outputSchema ~281-307, handler ~314-323)

- [ ] **Step 1: Add inputs**

After the `image` input (~line 274-279):

```ts
        provider_uuid: z.string().optional().describe('Narrow a duplicate SKU `size` to one provider.'),
        sku_uuid: z.string().optional().describe('Pin a specific SKU by uuid.'),
```

- [ ] **Step 2: Add outputs**

In the outputSchema, after `sku` (~line 293-303) add and keep `available_sku_names`:

```ts
        sku_candidates: z.array(
          z.object({
            name: z.string(),
            uuid: z.string(),
            provider_uuid: z.string(),
            price: z.object({ amount: z.string(), denom: z.string() }).optional(),
            active: z.boolean(),
          }),
        ),
        available_skus: z.array(
          z.object({ name: z.string(), uuid: z.string(), provider_uuid: z.string() }),
        ),
```

- [ ] **Step 3: Thread inputs into the handler**

In the `checkDeploymentReadiness(...)` call (~line 318-321):

```ts
      const result = await checkDeploymentReadiness(queryClient, address, {
        size: args.size,
        image: args.image,
        providerUuid: args.provider_uuid,
        skuUuid: args.sku_uuid,
      });
```

- [ ] **Step 4: Verify build + server tests**

Run: `cd packages/fred && npm run lint && npx vitest run src/server.test.ts && cd ../..`
Expected: PASS (annotation/`_meta` matrix unchanged; new output fields are additive).

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/server/register-tools.ts
git commit -m "feat(fred): check_deployment_readiness schema exposes candidates + disambiguators (ENG-258)"
```

---

### Task 8: Flat `skus[]` shape for `browse_catalog`

**Files:**
- Modify: `packages/fred/src/tools/browseCatalog.ts` (replace `tiers` with `skus`)
- Modify: `packages/fred/src/tools/browseCatalog.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the `tiers` assertions in `browseCatalog.test.ts` with:

```ts
it('ENG-258: returns a flat skus[] with uuid + provider + split provider fields', async () => {
  const qc = makeMockQueryClient({
    sku: {
      providers: [{ uuid: 'p1', address: 'm1', apiUrl: 'http://p1', active: true }],
      skus: [
        { uuid: 'a', name: 'docker-micro', providerUuid: 'p1', basePrice: { amount: '100', denom: 'umfx' } },
        { uuid: 'b', name: 'docker-micro', providerUuid: 'p2', basePrice: { amount: '120', denom: 'umfx' } },
      ],
    },
  });
  const res = await browseCatalog(qc as never, async () => new Response('{"status":"ok"}'));
  expect(res).not.toHaveProperty('tiers');
  expect(res.skus).toEqual(
    expect.arrayContaining([
      { name: 'docker-micro', sku_uuid: 'a', provider_uuid: 'p1', provider_url: 'http://p1', price: '100', unit: 'umfx', active: true },
      { name: 'docker-micro', sku_uuid: 'b', provider_uuid: 'p2', provider_url: null, price: '120', unit: 'umfx', active: true },
    ]),
  );
});
```

(`provider_url` is `null` for `p2` because no provider record exists for it — demonstrating the split that fixes the overloaded `provider` field.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/fred/src/tools/browseCatalog.test.ts -t "flat skus"`
Expected: FAIL — `res.skus` undefined; `res.tiers` present.

- [ ] **Step 3: Implement the flat shape**

In `packages/fred/src/tools/browseCatalog.ts`, replace the `tiers` construction (~lines 90-107) with:

```ts
  const skus = skusResult.skus.map((s) => ({
    name: s.name,
    sku_uuid: s.uuid,
    provider_uuid: s.providerUuid,
    provider_url: providerByUuid.get(s.providerUuid)?.apiUrl ?? null,
    price: s.basePrice?.amount ?? null,
    unit: s.basePrice?.denom ?? null,
    active: s.active,
  }));

  return { providers, skus };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/fred/src/tools/browseCatalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fred/src/tools/browseCatalog.ts packages/fred/src/tools/browseCatalog.test.ts
git commit -m "feat(fred): browse_catalog returns flat self-identified skus[] (ENG-258)"
```

---

### Task 9: Update `browse_catalog` tool + resource output schemas

**Files:**
- Modify: `packages/fred/src/server/register-tools.ts` (`browse_catalog` outputSchema ~63-66)
- Modify: `packages/fred/src/server/register-resources.ts` (the `manifest://catalog` resource builds the same payload ~144-147)
- Test: `packages/fred/src/server.test.ts` and any catalog-resource test

- [ ] **Step 1: Update the tool outputSchema**

Replace (~line 63-66):

```ts
      outputSchema: {
        providers: z.array(z.looseObject({})),
        skus: z.array(
          z.object({
            name: z.string(),
            sku_uuid: z.string(),
            provider_uuid: z.string(),
            provider_url: z.string().nullable(),
            price: z.string().nullable(),
            unit: z.string().nullable(),
            active: z.boolean(),
          }),
        ),
      },
```

- [ ] **Step 2: Align the catalog resource**

In `register-resources.ts`, the `manifest://catalog` handler calls `browseCatalog` (or builds its own grouping). If it builds its own `tiers`, switch it to return `{ providers, skus }` from `browseCatalog` directly. Read the handler at `register-resources.ts:140-170` and make its returned payload match the flat shape (reuse `browseCatalog(queryClient, fetchFn)`).

- [ ] **Step 3: Update tests + verify**

Update any `tiers` assertions in `server.test.ts` / resource tests to the flat `skus[]` shape, then:
Run: `cd packages/fred && npm run lint && npx vitest run && cd ../..`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/fred/src/server/register-tools.ts packages/fred/src/server/register-resources.ts packages/fred/src/server.test.ts
git commit -m "feat(fred): browse_catalog tool + resource schema use flat skus[] (ENG-258)"
```

---

### Task 10: Update the deploy prompt to disambiguate by provider

**Files:**
- Modify: `packages/fred/src/server/register-prompts.ts` (`deploy-containerized-app`, step 3 ~line 47)

- [ ] **Step 1: Rewrite the relevant workflow lines**

Replace the workflow step that reads `provider (from check_deployment_readiness.sku)` and the pre-flight step with:

```ts
              `1. Pre-flight: call \`check_deployment_readiness\` with { size, image }. If \`ready: false\`, surface the \`missing_steps\` list. If \`sku_candidates\` has more than one entry, the name is ambiguous — show the user each candidate (provider_uuid + price) and ask which provider to use; carry the chosen \`provider_uuid\` (or \`sku_uuid\`) into deploy_app.`,
```

and step 3:

```ts
              `3. Print a deployment plan: image, manifest summary, SKU (name + chosen provider_uuid), and the meta_hash. Wait for an explicit "yes" before continuing.`,
```

and step 4:

```ts
              `4. Call \`deploy_app\` (this broadcasts a chain TX and incurs fees), passing the chosen \`provider_uuid\`/\`sku_uuid\` when the size was ambiguous. If deploy_app returns a SKU_AMBIGUOUS error, surface the listed candidates and ask the user to pick, then retry with the disambiguator. Pass any progressToken the host provides.`,
```

- [ ] **Step 2: Verify build + prompt tests**

Run: `cd packages/fred && npm run lint && npx vitest run -t prompt && cd ../..`
Expected: PASS (or no prompt-specific test — then just lint/build).

- [ ] **Step 3: Commit**

```bash
git add packages/fred/src/server/register-prompts.ts
git commit -m "docs(fred): deploy prompt instructs provider disambiguation (ENG-258)"
```

---

# Phase 4 — agent-core: pin once, thread everywhere

### Task 11: Add `onResolveSku` callback, `sku_ambiguous` event, re-export `SkuCandidate`

**Files:**
- Modify: `packages/agent-core/src/types.ts` (`DeployAppCallbacks` ~324-333, `ProgressEvent` ~265-293, re-export `SkuCandidate`)
- Test: `packages/agent-core/src/types.test.ts` (compile-only contract check)

- [ ] **Step 1: Re-export the core type + add the callback + event**

In `packages/agent-core/src/types.ts`:
- Near the top type imports, re-export the core type:

```ts
export type { SkuCandidate } from '@manifest-network/manifest-mcp-core';
```

- Add to `DeployAppCallbacks` (after `onFailure`):

```ts
  /**
   * Resolve an ambiguous SKU name. Invoked when a requested `size` matches
   * more than one active SKU and no provider_uuid/sku_uuid was supplied.
   * Returns the user's pick; when absent, agent-core re-throws SKU_AMBIGUOUS.
   */
  onResolveSku?: (
    candidates: import('@manifest-network/manifest-mcp-core').SkuCandidate[],
  ) => Promise<{ skuUuid: string; providerUuid: string }>;
```

- Add a `ProgressEvent` variant (in the union, after `partial_success_prompt_rendered`):

```ts
  | {
      kind: 'sku_ambiguous';
      candidates: import('@manifest-network/manifest-mcp-core').SkuCandidate[];
    }
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd packages/agent-core && npm run lint && cd ../..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-core/src/types.ts
git commit -m "feat(agent-core): onResolveSku callback + sku_ambiguous event + SkuCandidate re-export (ENG-258)"
```

---

### Task 12: Resolve the SKU pin early and thread it (agent-core deploy)

**Files:**
- Modify: `packages/agent-core/src/deploy-app.ts` (early resolution; `estimateFees`; helpers; plan)
- Delete: `packages/agent-core/src/internals/find-sku-uuid.ts`
- Delete/retarget: `packages/agent-core/src/internals/find-sku-uuid.test.ts` (its behavior now lives in core's resolver test)
- Modify: `packages/agent-core/src/deploy-app.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agent-core/src/deploy-app.test.ts` (it already mocks fred; mirror the existing harness). A focused test for the ambiguity callback path:

```ts
it('ENG-258: invokes onResolveSku when the size is ambiguous, then pins the choice', async () => {
  // queryClient returns two docker-micro SKUs (p1, p2); onResolveSku picks p2.
  const onResolveSku = vi.fn(async () => ({ skuUuid: 'sku-p2', providerUuid: 'p2' }));
  // ...build opts.clientManager via makeMockClientManager with the dup SKUs,
  //    spec = { image: 'nginx', port: 80, size: 'docker-micro' }, callbacks include onResolveSku,
  //    onPlan/onConfirm auto-confirm, fred deployApp mock asserts it received
  //    { skuUuid: 'sku-p2', providerUuid: 'p2' } (resolved selector inputs)...
  // Assert: onResolveSku called once with 2 candidates; fred input carried sku_uuid 'sku-p2'.
  expect(onResolveSku).toHaveBeenCalledTimes(1);
});

it('ENG-258: re-throws SKU_AMBIGUOUS when no onResolveSku is provided', async () => {
  // same dup SKUs, callbacks WITHOUT onResolveSku → deployApp rejects SKU_AMBIGUOUS.
});
```

(Follow the file's existing mock setup for `fredDeployApp`, `checkDeploymentReadiness`, `buildManifestPreview`, and `cosmosEstimateFee`. The key new assertions are the two above.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent-core/src/deploy-app.test.ts -t ENG-258`
Expected: FAIL — no `onResolveSku` handling; `findSkuUuid` still used.

- [ ] **Step 3: Add intent helpers + early resolution**

In `packages/agent-core/src/deploy-app.ts`:
- Replace the `findSkuUuid` import with: `import { resolveSku, type SkuCandidate } from '@manifest-network/manifest-mcp-core';`
- Add intent helpers next to `requestedSize`:

```ts
function requestedProviderUuid(spec: DeploySpec): string | undefined {
  const v = (spec as unknown as { providerUuid?: string }).providerUuid;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function requestedSkuUuid(spec: DeploySpec): string | undefined {
  const v = (spec as unknown as { skuUuid?: string }).skuUuid;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
```

- Right after `queryClient` is bound (~line 200) and BEFORE readiness, resolve the pin:

```ts
  // SKU pin (ENG-258): resolve the size to a concrete (skuUuid, providerUuid)
  // ONCE so plan, fee, and broadcast reference the same SKU. Ambiguity routes
  // through onResolveSku (interactive) or re-throws SKU_AMBIGUOUS (headless).
  let pinned: SkuCandidate;
  try {
    pinned = await resolveSku(queryClient, {
      size: requestedSize(spec),
      ...(requestedProviderUuid(spec) !== undefined ? { providerUuid: requestedProviderUuid(spec) } : {}),
      ...(requestedSkuUuid(spec) !== undefined ? { skuUuid: requestedSkuUuid(spec) } : {}),
    });
  } catch (err) {
    if (
      err instanceof ManifestMCPError &&
      err.code === ManifestMCPErrorCode.SKU_AMBIGUOUS &&
      callbacks.onResolveSku
    ) {
      const candidates = (err.details?.candidates as SkuCandidate[]) ?? [];
      callbacks.onProgress?.({ kind: 'sku_ambiguous', candidates });
      const pick = await callbacks.onResolveSku(candidates);
      pinned = await resolveSku(queryClient, { size: requestedSize(spec), skuUuid: pick.skuUuid, providerUuid: pick.providerUuid });
    } else {
      throw err;
    }
  }
```

- Pass the pin to `estimateFees` and `buildFredDeployInput`. Change `estimateFees`'s signature to accept the pinned `skuUuid` instead of re-resolving:

```ts
async function estimateFees(
  opts: DeployAppOptions,
  spec: DeploySpec,
  metaHashHex: string,
  skuUuid: string, // ENG-258: pre-resolved; no second lookup
): Promise<Plan['fees']> {
  // delete: const size = requestedSize(spec);                       // now unused → remove (lint)
  // delete: const { skuUuid } = await findSkuUuid(opts.clientManager, size);
  // (skuUuid is now a parameter)
  const itemArgs: string[] = isStackSpec(spec)
    ? Object.keys(spec.services).map((name) => `${skuUuid}:1:${name}`)
    : [`${skuUuid}:1`];
  // ...rest unchanged...
}
```

Remove the now-unused `const size = requestedSize(spec);` at the top of `estimateFees` (biome will flag it). `requestedSize` is still used at the call sites.

Update both `estimateFees(opts, spec, preview.meta_hash_hex)` call sites (initial ~line 250 and post-edit ~line 351) to pass `pinned.skuUuid`. Note: the post-edit branch may change `size`; re-resolve the pin there too (call `resolveSku` again after `applyPlanEdit`, mirroring the early block — keep it simple: recompute `pinned` post-edit before `estimateFees`).

- Pass the pin to the fred input (Task 13 adds the param):

```ts
  const fredInput = buildFredDeployInput(confirmedSpec, requestedSize(confirmedSpec), {
    skuUuid: pinned.skuUuid,
    providerUuid: pinned.providerUuid,
  });
```

- Add the provider line to the plan render call (initial + post-edit), passing `providerUuid: pinned.providerUuid` (Task 17 consumes it).

- [ ] **Step 4: Delete the duplicate resolver**

```bash
git rm packages/agent-core/src/internals/find-sku-uuid.ts packages/agent-core/src/internals/find-sku-uuid.test.ts
```

(Its coverage is now in `packages/core/src/sku-resolution.test.ts`.)

- [ ] **Step 5: Run the deploy suite**

Run: `npx vitest run packages/agent-core/src/deploy-app.test.ts`
Expected: PASS (existing + the two ENG-258 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/deploy-app.ts packages/agent-core/src/deploy-app.test.ts
git rm packages/agent-core/src/internals/find-sku-uuid.ts packages/agent-core/src/internals/find-sku-uuid.test.ts
git commit -m "feat(agent-core): resolve SKU pin once via core, elicit on ambiguity (ENG-258)"
```

---

### Task 13: `buildFredDeployInput` emits the pinned SKU

**Files:**
- Modify: `packages/agent-core/src/internals/build-fred-input.ts`
- Modify: `packages/agent-core/src/internals/build-fred-input.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `build-fred-input.test.ts`:

```ts
it('ENG-258: threads the pinned skuUuid/providerUuid into the fred input', () => {
  const out = buildFredDeployInput({ image: 'nginx', port: 80 } as never, 'docker-micro', {
    skuUuid: 'sku-p2',
    providerUuid: 'p2',
  });
  expect(out).toMatchObject({ size: 'docker-micro', skuUuid: 'sku-p2', providerUuid: 'p2' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent-core/src/internals/build-fred-input.test.ts -t ENG-258`
Expected: FAIL — `buildFredDeployInput` takes only `(spec, size)`.

- [ ] **Step 3: Add the optional pin parameter**

In `build-fred-input.ts`, extend the signature and both return branches:

```ts
export function buildFredDeployInput(
  spec: DeploySpec,
  size: string,
  pin?: { skuUuid: string; providerUuid: string },
): FredDeployAppInput {
  // ...inside each `out` object, after `size`:
  //   ...(pin ? { skuUuid: pin.skuUuid, providerUuid: pin.providerUuid } : {}),
}
```

Apply `...(pin ? { skuUuid: pin.skuUuid, providerUuid: pin.providerUuid } : {})` to BOTH the stack `out` and the single-service `out`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/agent-core/src/internals/build-fred-input.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/internals/build-fred-input.ts packages/agent-core/src/internals/build-fred-input.test.ts
git commit -m "feat(agent-core): buildFredDeployInput threads pinned SKU (ENG-258)"
```

---

### Task 14: Candidate-based readiness gate

**Files:**
- Modify: `packages/agent-core/src/internals/evaluate-readiness.ts`
- Modify: `packages/agent-core/src/internals/evaluate-readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `evaluate-readiness.test.ts`:

```ts
it('ENG-258: blocks when no candidate matches the requested provider', () => {
  const r = evaluateReadiness({
    tenant: 't', image: null, size: 'docker-micro',
    walletBalances: [{ denom: 'umfx', amount: '100000' }],
    credits: null, sku: null, availableSkuNames: ['docker-micro'],
    skuCandidates: [{ name: 'docker-micro', providerUuid: 'p1' }],
    requestedProviderUuid: 'p2', gasPrice: '1umfx',
  });
  expect(r.status).toBe('block');
  expect(r.reasons.join(' ')).toMatch(/p2|provider/);
});

it('ENG-258: passes the SKU gate when a candidate matches', () => {
  const r = evaluateReadiness({
    tenant: 't', image: null, size: 'docker-micro',
    walletBalances: [{ denom: 'umfx', amount: '100000' }],
    credits: null, sku: null, availableSkuNames: ['docker-micro'],
    skuCandidates: [{ name: 'docker-micro', providerUuid: 'p1' }],
    gasPrice: '1umfx',
  });
  // SKU gate not the blocker (credits-null only warns); status is not 'block' for SKU reasons.
  expect(r.reasons.join(' ')).not.toMatch(/is not currently offered/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent-core/src/internals/evaluate-readiness.test.ts -t ENG-258`
Expected: FAIL — `skuCandidates`/`requestedProviderUuid` not on the input type.

- [ ] **Step 3: Implement the gate**

In `evaluate-readiness.ts`, add to `EvaluateReadinessInputs`:

```ts
  /** Structured candidates for `size` (name [+ provider]). Preferred over `availableSkuNames`. */
  skuCandidates?: { name: string; providerUuid: string; price?: Coin }[];
  /** Provider the caller pinned (if any) — gate requires a candidate on it. */
  requestedProviderUuid?: string;
```

Replace the SKU-availability rule (~lines 132-143) with:

```ts
  // 1. SKU availability — block when the chosen size (+ provider) has no candidate.
  if (inputs.size !== null) {
    const candidates = inputs.skuCandidates;
    let available: boolean;
    if (candidates !== undefined) {
      available = candidates.some(
        (c) =>
          c.name === inputs.size &&
          (inputs.requestedProviderUuid === undefined ||
            c.providerUuid === inputs.requestedProviderUuid),
      );
    } else {
      available = inputs.availableSkuNames.includes(inputs.size); // legacy fallback
    }
    if (!available) {
      status = 'block';
      const hint = inputs.requestedProviderUuid ? ` on provider ${inputs.requestedProviderUuid}` : '';
      reasons.push(`Requested SKU "${inputs.size}"${hint} is not currently offered.`);
      actions.add('pick_different_sku');
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/agent-core/src/internals/evaluate-readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/internals/evaluate-readiness.ts packages/agent-core/src/internals/evaluate-readiness.test.ts
git commit -m "feat(agent-core): readiness gate on SKU candidates not bare names (ENG-258)"
```

---

### Task 15: Map fred candidates in the translator + clean-break `available_sku_names`

This task does the **coordinated clean-break removal**: agent-core's translator is the only consumer of `available_sku_names`, so removing the field from fred and updating the translator must land in the SAME PR (spec §9 sequencing). This task therefore touches fred files too.

**Files:**
- Modify: `packages/agent-core/src/internals/evaluate-readiness-from-fred.ts` (+ test)
- Modify: `packages/fred/src/tools/checkDeploymentReadiness.ts` (remove `available_sku_names` from result interface + output)
- Modify: `packages/fred/src/tools/checkDeploymentReadiness.test.ts` (drop any `available_sku_names` assertions)
- Modify: `packages/fred/src/server/register-tools.ts` (remove `available_sku_names` from the `check_deployment_readiness` outputSchema, ~line 304)

- [ ] **Step 1: Write the failing test**

Add to `evaluate-readiness-from-fred.test.ts` (note: NO `available_sku_names` in the fixture — it's gone):

```ts
import { EMPTY_DENOM_MAP } from './humanize-denom.js';

it('ENG-258: forwards sku_candidates and derives availableSkuNames from available_skus', () => {
  const raw = {
    tenant: 't', image: null, size: 'docker-micro',
    wallet_balances: [{ denom: 'umfx', amount: '100000' }],
    credits: null, sku: null,
    sku_candidates: [
      { name: 'docker-micro', uuid: 'a', provider_uuid: 'p1', price: { amount: '100', denom: 'umfx' }, active: true },
    ],
    available_skus: [{ name: 'docker-micro', uuid: 'a', provider_uuid: 'p1' }],
    ready: true, missing_steps: [],
  } as never;
  const r = evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 't');
  // SKU gate passes because a candidate matches (not because of a name list).
  expect(r.reasons.join(' ')).not.toMatch(/not currently offered/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent-core/src/internals/evaluate-readiness-from-fred.test.ts -t ENG-258`
Expected: FAIL — translator still references `raw.available_sku_names` / doesn't forward `skuCandidates`.

- [ ] **Step 3: Update the translator (map candidates; derive names from available_skus)**

In `evaluate-readiness-from-fred.ts`, replace the `available_sku_names` fold (the `const skuNames = new Set(raw.available_sku_names); ...` block, ~lines 86-87) and the `availableSkuNames` argument with:

```ts
  // Names are only a fallback hint now; derive them from the structured list.
  const availableSkuNames = [...new Set((raw.available_skus ?? []).map((s) => s.name))];

  return evaluateReadiness({
    tenant: tenantAddress,
    image: raw.image,
    size: raw.size,
    walletBalances: toCoinArray(raw.wallet_balances),
    credits: translateCredits(raw),
    sku: translateSku(raw.sku),
    availableSkuNames,
    skuCandidates: Array.isArray(raw.sku_candidates)
      ? raw.sku_candidates.map((c) => ({
          name: c.name,
          providerUuid: c.provider_uuid,
          ...(c.price ? { price: { denom: c.price.denom, amount: c.price.amount } } : {}),
        }))
      : undefined,
    gasPrice,
    denomMap,
  });
```

- [ ] **Step 4: Remove `available_sku_names` from fred's readiness result**

In `packages/fred/src/tools/checkDeploymentReadiness.ts`:
- Delete the `readonly available_sku_names: readonly string[];` line from `CheckDeploymentReadinessResult`.
- Delete the `const available_sku_names = ...` line and the `available_sku_names,` field from the returned object.
- If `MAX_SKU_NAMES_RETURNED` is now used only by `available_skus`, keep it (it bounds `available_skus`).

In `packages/fred/src/tools/checkDeploymentReadiness.test.ts`: remove any assertion that reads `available_sku_names`.

In `packages/fred/src/server/register-tools.ts`: delete `available_sku_names: z.array(z.string()),` from the `check_deployment_readiness` outputSchema (~line 304).

- [ ] **Step 5: Run the affected suites + whole-repo build**

Run:
```bash
npx vitest run packages/agent-core/src/internals/evaluate-readiness-from-fred.test.ts packages/fred/src/tools/checkDeploymentReadiness.test.ts
npm run build && npm run lint
```
Expected: PASS — no dangling `available_sku_names` references anywhere (grep to confirm: `grep -rn "available_sku_names" packages/` → no results).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/internals/evaluate-readiness-from-fred.ts packages/agent-core/src/internals/evaluate-readiness-from-fred.test.ts packages/fred/src/tools/checkDeploymentReadiness.ts packages/fred/src/tools/checkDeploymentReadiness.test.ts packages/fred/src/server/register-tools.ts
git commit -m "feat(agent-core,fred): translate sku_candidates; clean-break remove available_sku_names (ENG-258)"
```

---

### Task 16: Render the provider in the deployment plan

**Files:**
- Modify: `packages/agent-core/src/internals/render-deployment-plan.ts`
- Modify: `packages/agent-core/src/internals/render-deployment-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `render-deployment-plan.test.ts`:

```ts
it('ENG-258: renders the pinned provider when supplied', () => {
  const block = renderDeploymentPlan({
    plan: basePlan, // reuse the file's existing fixture
    image: 'nginx', size: 'docker-micro', metaHash: 'abc',
    providerUuid: 'prov-2',
  });
  expect(block.text).toContain('Provider:');
  expect(block.text).toContain('prov-2');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent-core/src/internals/render-deployment-plan.test.ts -t ENG-258`
Expected: FAIL — no `providerUuid` field / no Provider line.

- [ ] **Step 3: Add the optional field + line**

In `render-deployment-plan.ts`, add to `RenderDeploymentPlanInput`:

```ts
  /** Pinned provider UUID (ENG-258); rendered so a paid lease shows its provider. */
  providerUuid?: string;
```

In `renderDeploymentPlan`, after the `Size:` line (~line 152):

```ts
  if (typeof input.providerUuid === 'string' && input.providerUuid.length > 0) {
    lines.push(`  Provider:                  ${input.providerUuid}`);
  }
```

(Insert as a `lines.splice`/`push`-aware edit — simplest: build the `Provider` line into the initial `lines` array right after `Size`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/agent-core/src/internals/render-deployment-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check agent-core + full suite**

Run: `cd packages/agent-core && npm run lint && npx vitest run && cd ../..`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/internals/render-deployment-plan.ts packages/agent-core/src/internals/render-deployment-plan.test.ts
git commit -m "feat(agent-core): deployment plan shows pinned provider (ENG-258)"
```

---

# Phase 5 — agent: elicit the SKU pick

### Task 17: SKU-pick elicitation schema + parser

**Files:**
- Modify: `packages/agent/src/elicitation.ts`
- Modify: `packages/agent/src/elicitation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/elicitation.test.ts`:

```ts
import type { SkuCandidate } from '@manifest-network/manifest-agent-core';
import { buildSkuPickSchema, parseSkuChoice } from './elicitation.js';

const cands: SkuCandidate[] = [
  { skuUuid: 'a', providerUuid: 'p1', name: 'docker-micro', price: { amount: '100', denom: 'umfx' }, active: true },
  { skuUuid: 'b', providerUuid: 'p2', name: 'docker-micro', price: { amount: '120', denom: 'umfx' }, active: true },
];

it('buildSkuPickSchema enumerates sku uuids with human labels', () => {
  const s = buildSkuPickSchema(cands) as { properties: { sku_uuid: { enum: string[]; enumNames: string[] } } };
  expect(s.properties.sku_uuid.enum).toEqual(['a', 'b']);
  expect(s.properties.sku_uuid.enumNames[0]).toContain('p1');
});

it('parseSkuChoice returns the chosen skuUuid + providerUuid', () => {
  const pick = parseSkuChoice({ action: 'accept', content: { sku_uuid: 'b' } }, cands);
  expect(pick).toEqual({ skuUuid: 'b', providerUuid: 'p2' });
});

it('parseSkuChoice throws OPERATION_CANCELLED on dismiss (no on-chain state yet)', () => {
  expect(() => parseSkuChoice({ action: 'cancel' }, cands)).toThrow();
});

it('parseSkuChoice rejects an unknown uuid', () => {
  expect(() => parseSkuChoice({ action: 'accept', content: { sku_uuid: 'zzz' } }, cands)).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent/src/elicitation.test.ts -t SkuPick`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the schema + parser**

In `packages/agent/src/elicitation.ts`:
- Add `SkuCandidate` to the agent-core type import.
- Add:

```ts
/** Build the SKU-pick elicitation schema. `enum` is sku uuids; `enumNames` are human labels. */
export function buildSkuPickSchema(
  candidates: readonly SkuCandidate[],
): RequestedSchema {
  return {
    type: 'object',
    properties: {
      sku_uuid: {
        type: 'string',
        enum: candidates.map((c) => c.skuUuid),
        enumNames: candidates.map(
          (c) =>
            `${c.name} @ ${c.providerUuid}` +
            (c.price ? ` (${c.price.amount}${c.price.denom})` : ''),
        ),
        description: 'Which SKU (and therefore which provider) to deploy to.',
      },
    },
    required: ['sku_uuid'],
  };
}

/**
 * Parse the SKU-pick elicitation result into the chosen pin. Dismiss/timeout →
 * OPERATION_CANCELLED: no on-chain state exists at resolution time, so cancelling
 * is the safe default (mirrors the onPlan reject path).
 */
export function parseSkuChoice(
  result: ElicitResult,
  candidates: readonly SkuCandidate[],
): { skuUuid: string; providerUuid: string } {
  if (result.action !== 'accept') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
      'User dismissed the SKU disambiguation prompt; deployment cancelled.',
    );
  }
  const skuUuid = readContentString(result, 'sku_uuid');
  const hit = candidates.find((c) => c.skuUuid === skuUuid);
  if (!hit) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `parseSkuChoice: "${skuUuid ?? '<none>'}" is not one of the offered SKU uuids.`,
    );
  }
  return { skuUuid: hit.skuUuid, providerUuid: hit.providerUuid };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/agent/src/elicitation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/elicitation.ts packages/agent/src/elicitation.test.ts
git commit -m "feat(agent): SKU-pick elicitation schema + parser (ENG-258)"
```

---

### Task 18: Wire `onResolveSku` into the deploy callbacks

**Files:**
- Modify: `packages/agent/src/callbacks.ts` (`makeDeployCallbacks`)
- Modify: `packages/agent/src/callbacks.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agent/src/callbacks.test.ts` (mirror the existing `onPlan`/`onFailure` elicitation tests — mock `server.elicitInput`):

```ts
it('ENG-258: onResolveSku elicits a pick and returns the pin', async () => {
  const elicitInput = vi.fn(async () => ({ action: 'accept', content: { sku_uuid: 'b' } }));
  const server = { elicitInput, getClientCapabilities: () => ({ elicitation: {} }) } as never;
  const cbs = makeDeployCallbacks({ server, extra: makeExtra() });
  const pick = await cbs.onResolveSku!([
    { skuUuid: 'a', providerUuid: 'p1', name: 'docker-micro', active: true },
    { skuUuid: 'b', providerUuid: 'p2', name: 'docker-micro', active: true },
  ]);
  expect(pick).toEqual({ skuUuid: 'b', providerUuid: 'p2' });
  expect(elicitInput).toHaveBeenCalledTimes(1);
});
```

(Reuse the file's existing `makeExtra()` / server-mock helpers.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/agent/src/callbacks.test.ts -t onResolveSku`
Expected: FAIL — `onResolveSku` not on the returned callbacks.

- [ ] **Step 3: Implement the callback**

In `callbacks.ts`:
- Import `buildSkuPickSchema, parseSkuChoice` from `./elicitation.js` and `SkuCandidate` from agent-core.
- Add to the object returned by `makeDeployCallbacks`:

```ts
    onResolveSku: async (
      candidates: SkuCandidate[],
    ): Promise<{ skuUuid: string; providerUuid: string }> => {
      const message =
        `The requested SKU name maps to ${candidates.length} SKUs across providers. ` +
        'Choose which to deploy to:';
      const result = await server.elicitInput(
        { message, requestedSchema: buildSkuPickSchema(candidates) },
        elicitOptions(extra),
      );
      // Dismiss/timeout → parseSkuChoice throws OPERATION_CANCELLED (safe: no
      // on-chain state at resolution time). Let it propagate; deployApp aborts.
      return parseSkuChoice(result, candidates);
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/agent/src/callbacks.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check agent + full suite**

Run: `cd packages/agent && npm run lint && npx vitest run && cd ../..`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/callbacks.ts packages/agent/src/callbacks.test.ts
git commit -m "feat(agent): wire onResolveSku to SKU-pick elicitation (ENG-258)"
```

---

### Task 19: Document the disambiguators on `deploy_app_orchestrated`

**Files:**
- Modify: `packages/agent/src/index.ts` (`deploy_app_orchestrated` `spec` description ~312-318)

- [ ] **Step 1: Update the `spec` description**

Since `spec` is a `looseObject`, `size`/`providerUuid`/`skuUuid` already pass through. Update the `.describe(...)` text so the model knows to use them:

```ts
            .describe(
              'DeploySpec — SingleServiceSpec ({ image, port?, env?, customDomain? }) or ' +
                'StackSpec ({ services, customDomain?, serviceName? }). Also carries `size` (SKU tier name) ' +
                'and, when a SKU name is published by multiple providers, an optional `providerUuid` or `skuUuid` ' +
                'to disambiguate (see browse_catalog / check_deployment_readiness `sku_candidates`). If omitted ' +
                'and the name is ambiguous, you will be prompted to pick a provider.',
            ),
```

- [ ] **Step 2: Verify build + agent server tests**

Run: `cd packages/agent && npm run lint && npx vitest run && cd ../..`
Expected: PASS (no schema-shape change — description only).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "docs(agent): document size/providerUuid/skuUuid on deploy_app_orchestrated (ENG-258)"
```

---

# Phase 6 — e2e

### Task 20: Pin SKUs by uuid/provider in e2e helpers + duplicate-name scenario

**Files:**
- Modify: e2e specs that resolve SKUs by name (`e2e/*deploy-roundtrip*`, `*misc-edges*`, `*lifecycle*`, `*billing-custom-domain*`, `*billing-sku-lifecycle*`, `*chain-routing*`) — replace `.find(s => s.name === …)` with uuid/provider pinning and consume the flat `skus[]` shape from `browse_catalog`.
- Add: a duplicate-name scenario (if the e2e chain seeding allows publishing two same-named SKUs on different providers).

- [ ] **Step 1: Inventory the name-based selections**

Run: `grep -rn "find(.*name ===\|\.tiers\b\|tiers\[" e2e/`
Expected: lists the call sites named above.

- [ ] **Step 2: Update each helper**

For each hit, replace name-based selection with the flat catalog shape, e.g.:

```ts
// before: const sku = catalog.tiers['docker-micro'][0];
// after:
const sku = catalog.skus.find((s) => s.name === 'docker-micro' && s.provider_uuid === PROVIDER_UUID);
// ...use sku.sku_uuid / sku.provider_uuid; pass provider_uuid/sku_uuid to deploy_app.
```

- [ ] **Step 3: Add the duplicate-name e2e (if seedable)**

If the e2e SKU seeding (`e2e/docker-compose.yml` + fixtures) can publish two `docker-micro` SKUs on different providers, add a spec asserting: `deploy_app({ size: 'docker-micro' })` → SKU_AMBIGUOUS; `deploy_app({ size, provider_uuid })` → leases on that provider. If not seedable, `log()` the limitation in the spec and skip with a `// TODO: requires multi-provider seed` note referencing ENG-258.

- [ ] **Step 4: Run e2e**

Run:
```bash
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): pin SKUs by uuid/provider; duplicate-name scenario (ENG-258)"
```

---

## Final verification

- [ ] **Whole-repo gates**

```bash
npm run build && npm run lint && npm run test && npm run check
```
Expected: all green. (`check` = biome format + import-sort + lint.)

- [ ] **Grep for stragglers**

```bash
grep -rn "findSkuUuid\|\.tiers\b" packages/ ; echo "--- expect: no results (all migrated to resolveSku / skus[]) ---"
```

---

## Spec-coverage self-review (filled during planning)

| Spec item | Task |
|-----------|------|
| §4.1 core resolver + `SKU_AMBIGUOUS` + non-retryable + machine-readable details | Tasks 1, 2 |
| §4.2 fred deployManifest via resolveSku; `byName` carries provider; storage same-provider | Task 3 |
| §4.2 fred `DeployAppInput` provider_uuid/sku_uuid + selector mapping | Task 4 |
| §4.2 fred readiness candidates + narrowing + structured available | Task 6 |
| §4.2 fred catalog flat `skus[]` + split provider fields | Task 8 |
| §4.2 fred tool schemas (deploy_app, check_deployment_readiness, browse_catalog) | Tasks 5, 7, 9 |
| §4.2 fred prompt disambiguation | Task 10 |
| §4.3 delete agent-core dup resolver; pin early; thread to estimateFees/fred/plan | Tasks 11, 12, 13 |
| §4.3 evaluate-readiness candidate gate + price | Tasks 14, 15 |
| §4.3 / Q3 render provider in plan | Task 16 |
| §4.4 agent elicitation (schema, parser, onResolveSku wiring, tool docs) | Tasks 17, 18, 19 |
| §4.5 consistency (pin-by-UUID; chain re-validates) | Behavioral — covered by Task 12's design + Task 3's no-broadcast-on-ambiguity test |
| §6 test impact (invert first-match; new dup cases; e2e pins) | Tasks 2, 3, 6, 8, 20 |
