# SDK P0 — Plan 1: Branded domain types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nominal **branded domain types** (`Address`, `LeaseUuid`, `ProviderUuid`, `SkuUuid`, `TierName`, `Fqdn`, `Denom`, `ChainId`) and their parse-don't-validate constructors to `@manifest-network/manifest-mcp-core`, so the typed SDK surface never uses bare `string` for identifiers.

**Architecture:** A single `core/src/brands.ts` module owns the `Brand<T,B>` helper, the branded aliases, and the only sanctioned brand-producing constructors (`parse*`/`as*`). The constructors reuse the repo's existing validators (`validateAddress`, a new bare-string `assertUuid`, the exported `DNS_LABEL_RE`). The lone `as Brand` cast lives only in this file. Brands are structurally `string` (assignable **to** `string`, not **from** it), so adoption is incremental.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest (co-located `*.test.ts`), tsdown build, `tsc --noEmit` lint, Biome. Spec: `docs/superpowers/specs/2026-06-10-manifest-app-sdk-foundation-design.md` §5.0. Issue: ENG-309 (parent ENG-308).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/validation.ts` (modify) | Extract a bare-string `assertUuid(value, label, errorCode?)`; have the existing object-shaped `requireUuid` delegate to it (DRY, behavior-preserving). |
| `packages/core/src/brands.ts` (create) | `Brand<T,B>`, the branded aliases, and the `parse*`/`as*` constructors. The single home of the `as Brand` cast. |
| `packages/core/src/brands.test.ts` (create) | Runtime tests for every constructor (accept valid, reject invalid) + `@ts-expect-error` type assertions that the UUID-backed brands are mutually non-assignable. |
| `packages/core/src/index.ts` (modify) | Re-export the public brand types + constructors from the package barrel. |

**Note on scope:** the `dependency-cruiser` rule that enforces "brands are declared **only** in `brands.ts`" ships in the later Packaging plan (P0 Plan 8) together with the rest of the boundary guard. This plan delivers the module + its tests.

---

## Task 0: Worktree setup (one-time)

**Files:** none.

- [ ] **Step 1: Install dependencies in the worktree**

A fresh git worktree has no `node_modules` and would otherwise resolve stale hoisted deps (CLAUDE.md ENG-220). Install at the repo root of the worktree.

Run: `npm install`
Expected: completes; `node_modules/` populated; no error.

- [ ] **Step 2: Confirm the baseline gates are green before changing anything**

Run: `npm run build && npm run lint && npx vitest run packages/core/src/validation.test.ts`
Expected: build "Build complete"; lint exit 0; the validation tests pass (if `validation.test.ts` does not exist, run `npx vitest run packages/core` and confirm exit 0). Establishes the green baseline.

---

## Task 1: Extract a bare-string `assertUuid` from `requireUuid`

`requireUuid` validates a UUID **field of an object**; the brand constructors need to validate a **bare string**. Extract the bare-string check and have `requireUuid` delegate to it, so the UUID regex stays single-sourced.

**Files:**
- Modify: `packages/core/src/validation.ts`
- Test: `packages/core/src/validation.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `packages/core/src/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { assertUuid, requireUuid } from './validation.js';

describe('assertUuid (bare string)', () => {
  it('accepts a valid RFC-4122 UUID', () => {
    expect(() =>
      assertUuid('550e8400-e29b-41d4-a716-446655440000', 'leaseUuid'),
    ).not.toThrow();
  });

  it('throws ManifestMCPError with the field label for a non-UUID', () => {
    try {
      assertUuid('not-a-uuid', 'leaseUuid');
      throw new Error('expected assertUuid to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
      expect((err as ManifestMCPError).message).toContain('leaseUuid');
    }
  });

  it('honors a custom error code', () => {
    try {
      assertUuid('nope', 'skuUuid', ManifestMCPErrorCode.INVALID_CONFIG);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
    }
  });
});

describe('requireUuid still works after delegating to assertUuid', () => {
  it('returns the value for a valid UUID field', () => {
    const v = '550e8400-e29b-41d4-a716-446655440000';
    expect(requireUuid({ leaseUuid: v }, 'leaseUuid')).toBe(v);
  });

  it('throws for a missing field', () => {
    expect(() => requireUuid({}, 'leaseUuid')).toThrow(ManifestMCPError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/validation.test.ts`
Expected: FAIL — `assertUuid` is not exported (`SyntaxError: ... does not provide an export named 'assertUuid'`).

- [ ] **Step 3: Implement `assertUuid` and refactor `requireUuid` to delegate**

In `packages/core/src/validation.ts`, replace the `UUID_PATTERN` constant and the `requireUuid` function (lines 68-88) with:

```ts
/** RFC-4122 UUID (any version), case-insensitive. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assert that a BARE string is a valid UUID. Throws ManifestMCPError on failure.
 * The single source of truth for UUID validation (reused by requireUuid + the brand constructors).
 */
export function assertUuid(
  value: string,
  label: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): void {
  if (!UUID_RE.test(value)) {
    const display = value.length > 50 ? `${value.slice(0, 50)}...` : value;
    throw new ManifestMCPError(
      errorCode,
      `${label} must be a valid UUID (e.g., "550e8400-e29b-41d4-a716-446655440000"), got "${display}"`,
    );
  }
}

/**
 * Require a non-empty string field that is a valid UUID.
 */
export function requireUuid(
  input: Record<string, unknown>,
  field: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): string {
  const val = requireString(input, field, errorCode);
  assertUuid(val, field, errorCode);
  return val;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/validation.test.ts`
Expected: PASS (all `assertUuid` + `requireUuid` cases green).

- [ ] **Step 5: Verify nothing else broke + lint**

Run: `npx vitest run packages/core && (cd packages/core && npm run lint)`
Expected: all core tests PASS; lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/validation.ts packages/core/src/validation.test.ts
git commit -m "refactor(core): extract bare-string assertUuid from requireUuid (ENG-309)"
```

---

## Task 2: The `brands.ts` module

**Files:**
- Create: `packages/core/src/brands.ts`
- Test: `packages/core/src/brands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/brands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  asChainId,
  asDenom,
  asLeaseUuid,
  asProviderUuid,
  asSkuUuid,
  asTierName,
  parseAddress,
  parseFqdn,
} from './brands.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDR = 'manifest1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn7hzdtn';

describe('uuid brands', () => {
  it('asLeaseUuid accepts a valid UUID and returns it unchanged at runtime', () => {
    expect(asLeaseUuid(UUID)).toBe(UUID);
    expect(asProviderUuid(UUID)).toBe(UUID);
    expect(asSkuUuid(UUID)).toBe(UUID);
  });
  it('rejects a non-UUID with INVALID_CONFIG', () => {
    try {
      asLeaseUuid('nope');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
      expect((err as ManifestMCPError).message).toContain('leaseUuid');
    }
  });
});

describe('parseAddress', () => {
  it('accepts a valid bech32 address', () => {
    expect(parseAddress(ADDR)).toBe(ADDR);
  });
  it('enforces an expected prefix when given', () => {
    expect(() => parseAddress(ADDR, 'cosmos')).toThrow(ManifestMCPError);
  });
  it('rejects a non-bech32 string with INVALID_ADDRESS', () => {
    try {
      parseAddress('not-an-address');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_ADDRESS);
    }
  });
});

describe('parseFqdn', () => {
  it.each(['app.example.com', 'a.io', 'sub.domain.co.uk'])('accepts %s', (fqdn) => {
    expect(parseFqdn(fqdn)).toBe(fqdn);
  });
  it.each(['nodot', '', 'UPPER.com', '-bad.com', 'a..b.com', 'a.b-.com'])(
    'rejects %s',
    (bad) => {
      expect(() => parseFqdn(bad)).toThrow(ManifestMCPError);
    },
  );
});

describe('trim brands', () => {
  it('asTierName/asDenom/asChainId accept non-empty and reject empty/whitespace', () => {
    expect(asTierName('docker-small')).toBe('docker-small');
    expect(asDenom('umfx')).toBe('umfx');
    expect(asChainId('manifest-1')).toBe('manifest-1');
    expect(() => asTierName('   ')).toThrow(ManifestMCPError);
    expect(() => asDenom('')).toThrow(ManifestMCPError);
  });
});
```

- [ ] **Step 2: Add the `@ts-expect-error` type-fixture to the SAME test file**

Append to `packages/core/src/brands.test.ts` — these lines are checked by `tsc` (the lint step); each `@ts-expect-error` MUST flag a real error or lint fails:

```ts
import type { LeaseUuid, ProviderUuid, SkuUuid } from './brands.js';

// Type-level fixture: the three UUID-backed brands are mutually non-assignable.
// Each @ts-expect-error must report a genuine type error (tsc fails the build otherwise).
describe('brand distinctness (compile-time)', () => {
  it('brands are not interchangeable', () => {
    const lease = asLeaseUuid(UUID);
    const provider = asProviderUuid(UUID);
    const wantsProvider = (_p: ProviderUuid): void => {};
    const wantsLease = (_l: LeaseUuid): void => {};
    const wantsSku = (_s: SkuUuid): void => {};
    // @ts-expect-error LeaseUuid is not assignable where ProviderUuid is expected
    wantsProvider(lease);
    // @ts-expect-error ProviderUuid is not assignable where LeaseUuid is expected
    wantsLease(provider);
    // @ts-expect-error LeaseUuid is not assignable where SkuUuid is expected
    wantsSku(lease);
    // a brand IS assignable TO string (one-way), so this is allowed (no @ts-expect-error):
    const s: string = lease;
    expect(typeof s).toBe('string');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/core/src/brands.test.ts`
Expected: FAIL — `./brands.js` does not exist (module resolution error).

- [ ] **Step 4: Implement `brands.ts`**

Create `packages/core/src/brands.ts`:

```ts
import { validateAddress } from './transactions/utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { assertUuid, DNS_LABEL_RE } from './validation.js';

/**
 * Nominal brand. STRING tag key (not a unique symbol) so brands stay assignable
 * across duplicated package copies (the worktree/dep-drift hazard in CLAUDE.md).
 * Never exported. A brand is structurally `string`: assignable TO string, not FROM it.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type Address = Brand<string, 'Address'>;
/** A tenant IS an address — intentional transparent alias (branding does not distinguish them). */
export type Tenant = Address;
export type LeaseUuid = Brand<string, 'LeaseUuid'>;
export type ProviderUuid = Brand<string, 'ProviderUuid'>;
export type SkuUuid = Brand<string, 'SkuUuid'>;
export type TierName = Brand<string, 'TierName'>;
export type Fqdn = Brand<string, 'Fqdn'>;
export type Denom = Brand<string, 'Denom'>;
export type ChainId = Brand<string, 'ChainId'>;

// The ONLY `as Brand` casts in the codebase live in this file (enforced by the
// dependency-cruiser rule shipped in the Packaging plan).

/** Validate a bech32 address (optionally pinning the prefix) and brand it. */
export function parseAddress(value: string, expectedPrefix?: string): Address {
  validateAddress(value, 'address', expectedPrefix);
  return value as Address;
}

export function asLeaseUuid(value: string): LeaseUuid {
  assertUuid(value, 'leaseUuid', ManifestMCPErrorCode.INVALID_CONFIG);
  return value as LeaseUuid;
}

export function asProviderUuid(value: string): ProviderUuid {
  assertUuid(value, 'providerUuid', ManifestMCPErrorCode.INVALID_CONFIG);
  return value as ProviderUuid;
}

export function asSkuUuid(value: string): SkuUuid {
  assertUuid(value, 'skuUuid', ManifestMCPErrorCode.INVALID_CONFIG);
  return value as SkuUuid;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `${label} must be a non-empty string`,
    );
  }
}

export function asTierName(value: string): TierName {
  assertNonEmpty(value, 'size');
  return value as TierName;
}

export function asDenom(value: string): Denom {
  assertNonEmpty(value, 'denom');
  return value as Denom;
}

export function asChainId(value: string): ChainId {
  assertNonEmpty(value, 'chainId');
  return value as ChainId;
}

/**
 * Net-new minimal structural FQDN check (no existing client-side FQDN validator —
 * the chain remains authoritative): lowercase, >=2 dot-separated RFC-1123 labels,
 * total length <= 253. Reuses DNS_LABEL_RE from validation.ts.
 */
export function parseFqdn(value: string): Fqdn {
  const invalid = (reason: string): never => {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `customDomain "${value}" is not a valid FQDN (${reason})`,
    );
  };
  if (value.length === 0 || value.length > 253) invalid('length must be 1-253');
  if (value !== value.toLowerCase()) invalid('must be lowercase');
  const labels = value.split('.');
  if (labels.length < 2) invalid('must contain at least one dot');
  for (const label of labels) {
    if (!DNS_LABEL_RE.test(label)) invalid(`invalid label "${label}"`);
  }
  return value as Fqdn;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/src/brands.test.ts`
Expected: PASS (all runtime cases green).

- [ ] **Step 6: Verify the `@ts-expect-error` fixtures hold (type-check)**

Run: `cd packages/core && npm run lint && cd ../..`
Expected: exit 0. If lint reports `Unused '@ts-expect-error' directive`, a brand pair is wrongly interchangeable — fix the brand tag before proceeding (this is the regression guard the fixture exists for).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/brands.ts packages/core/src/brands.test.ts
git commit -m "feat(core): add branded domain types + parse constructors (ENG-309)"
```

---

## Task 3: Export brands from the package barrel

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/brands.barrel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/brands.barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asLeaseUuid, parseAddress, parseFqdn } from './index.js';

describe('brands are re-exported from the package barrel', () => {
  it('exposes the constructors', () => {
    expect(typeof asLeaseUuid).toBe('function');
    expect(typeof parseAddress).toBe('function');
    expect(typeof parseFqdn).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/brands.barrel.test.ts`
Expected: FAIL — `index.js` does not export `asLeaseUuid` (`does not provide an export named 'asLeaseUuid'`).

- [ ] **Step 3: Add the re-export to `index.ts`**

In `packages/core/src/index.ts`, add this line near the other `export { … } from './...'` lines (e.g. just after the `validateAddress` re-export at line 79):

```ts
export {
  type Address,
  type ChainId,
  type Denom,
  type Fqdn,
  type LeaseUuid,
  type ProviderUuid,
  type SkuUuid,
  type Tenant,
  asChainId,
  asDenom,
  asLeaseUuid,
  asProviderUuid,
  asSkuUuid,
  asTierName,
  parseAddress,
  parseFqdn,
} from './brands.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/brands.barrel.test.ts`
Expected: PASS.

- [ ] **Step 5: Full core gate (build + lint + tests)**

Run: `npm run build && (cd packages/core && npm run lint) && npx vitest run packages/core`
Expected: build "Build complete"; lint exit 0; all core tests PASS. (Build first so any downstream package type-checks against the regenerated `dist/` — the build-then-lint order from CLAUDE.md ENG-220.)

- [ ] **Step 6: Biome check (format + imports)**

Run: `npx @biomejs/biome check packages/core/src/brands.ts packages/core/src/brands.test.ts packages/core/src/brands.barrel.test.ts packages/core/src/validation.ts`
Expected: exit 0 (or run `npx @biomejs/biome check --write …` then re-run; commit the formatting).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/brands.barrel.test.ts
git commit -m "feat(core): export branded types from the package barrel (ENG-309)"
```

---

## Self-Review (completed)

- **Spec coverage (§5.0):** `Brand<T,B>` string-key ✓ (Task 2); the nine branded aliases incl. `Tenant = Address` ✓; parse-don't-validate constructors reusing existing validators ✓ (`validateAddress`, `assertUuid`, `DNS_LABEL_RE`); `parseFqdn` net-new structural check ✓; the lone `as Brand` cast confined to `brands.ts` ✓; UUID-trio negative type-fixture ✓ (Task 2 Step 2). Boundary policy by trust and the codegen-read/wallet-in brand sites are consumed by **later** plans (reads/ctx) — out of scope here. The `dependency-cruiser` "brands only in brands.ts" guard is the Packaging plan.
- **Placeholders:** none — every step has runnable code/commands and expected output.
- **Type consistency:** constructor names (`parseAddress`/`asLeaseUuid`/`asProviderUuid`/`asSkuUuid`/`asTierName`/`parseFqdn`/`asDenom`/`asChainId`) are identical in `brands.ts`, the tests, and the barrel export. `assertUuid` signature matches between `validation.ts` and `brands.ts`.

## Next plan

→ **P0 Plan 2:** canonical types chokepoint (`core/src/manifest-types.ts`, `fred` re-exports), the `Logger` port + `noopLogger`, and the `CallOptions`/`TxCallOptions` option-bag types — the brand types from this plan are consumed there (e.g. `DeployAppResult.leaseUuid: LeaseUuid`).
