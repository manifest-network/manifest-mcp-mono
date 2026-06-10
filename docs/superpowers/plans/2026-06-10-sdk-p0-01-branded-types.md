# SDK P0 — Plan 1: Branded domain types Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nominal **branded domain types** (`Address`, `LeaseUuid`, `ProviderUuid`, `SkuUuid`, `TierName`, `Fqdn`, `Denom`, `ChainId`) and their **uniform `parse*` constructors** to `@manifest-network/manifest-mcp-core`, so the typed SDK surface never uses bare `string` for identifiers.

**Architecture:** `core/src/brands.ts` owns `Brand<T,B>`, the branded aliases, and the only sanctioned brand-producing constructors (all named `parse*`). Constructors validate-then-cast, reusing the repo's bare-string validators — which this plan consolidates into the **dependency-light `validation.ts`** leaf (`validateAddress` is relocated there so the brand chokepoint never reaches into the cosmjs tx layer; the canonical `FQDN_RE`/`SCHEME_PREFIX_RE`/`DENOM_RE` live there too). Malformed input throws a **new `INVALID_ARGUMENT`** code. Type distinctness is asserted with vitest `expectTypeOf` in a `*.test-d.ts` (run under `--typecheck`), the precise 2024-2026 idiom.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest 4 (co-located `*.test.ts`; `*.test-d.ts` + `--typecheck` for type tests), tsdown build, `tsc --noEmit` lint, Biome. Spec: `docs/.../2026-06-10-manifest-app-sdk-foundation-design.md` §5.0/§7. Issue: ENG-309 (parent ENG-308).

**v2 changes (from the online idiomatic review):** uniform `parse*` (was `parse*`/`as*`); new `INVALID_ARGUMENT` error code (was `INVALID_CONFIG`, which was semantically wrong + inconsistent with `requireUuid`'s `QUERY_FAILED`); `parseFqdn` **normalizes** case (RFC 4343) and reuses the **existing** `agent-core` `FQDN_RE` rules (rejects IPv4 literals + scheme prefixes — the "no existing FQDN validator" premise was false); `validateAddress` relocated to `validation.ts` (the brand chokepoint must not transitively import `@cosmjs/stargate`); type tests via `expectTypeOf`/`*.test-d.ts` (the `@ts-expect-error` approach is imprecise and type-blind under `vitest run`); `parseDenom` reuses the real denom grammar.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` (modify) | Add `ManifestMCPErrorCode.INVALID_ARGUMENT` (malformed caller input). |
| `packages/core/src/retry.ts` (modify) | Add `INVALID_ARGUMENT` to `NON_RETRYABLE_ERROR_CODES`. |
| `packages/core/src/validation.ts` (modify) | New dependency-light home of bare-string validators: relocate `validateAddress` here (it needs only `fromBech32`); export `assertUuid` + `UUID_RE` (extracted from `requireUuid`); add canonical `FQDN_RE`, `SCHEME_PREFIX_RE`, `DENOM_RE`. |
| `packages/core/src/transactions/utils.ts` (modify) | Re-export `validateAddress` from `validation.ts` (back-compat for ~18 existing importers). |
| `packages/core/src/brands.ts` (create) | `Brand<T,B>`, the branded aliases, the uniform `parse*` constructors. The single home of the `as Brand` cast. |
| `packages/core/src/brands.test.ts` (create) | Runtime behaviour tests (accept/reject/normalize) for every constructor. |
| `packages/core/src/brands.test-d.ts` (create) | `expectTypeOf` type-distinctness + one-way + reverse assertions (run via `--typecheck`). |
| `packages/core/vitest.config.ts` (modify) | Enable `typecheck` for `*.test-d.ts`. |
| `packages/core/src/index.ts` (modify) | Re-export the public brand types + constructors. |

**Deferred to P0 Plan 8 (Packaging/guards):** the `dependency-cruiser` rules (`as Brand` casts only in `brands.ts`; **forbid `brands.ts → transactions/**`**). Deferred to P1/P3: `agent-core/manage-domain.ts` imports the canonical `FQDN_RE` from `core` (deleting its private copy).

---

## Task 0: Worktree setup (one-time)

- [ ] **Step 1:** Run `npm install` at the worktree repo root (a fresh worktree has no `node_modules`; CLAUDE.md ENG-220). Expected: completes, no error.
- [ ] **Step 2:** Establish a green baseline. Run `npm run build && npm run lint && npx vitest run packages/core`. Expected: build "Build complete"; lint exit 0; core tests pass.

---

## Task 1: Add the `INVALID_ARGUMENT` error code

Malformed caller-supplied identifiers are an *argument* error, not a *config* error. The repo's ENG-258 design set the precedent of adding a named code rather than overloading an existing one (AIP-193).

**Files:** Modify `packages/core/src/types.ts`, `packages/core/src/retry.ts`. Test: `packages/core/src/retry.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/retry.test.ts` (create if absent):

```ts
import { describe, expect, it } from 'vitest';
import { isRetryable } from './retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('INVALID_ARGUMENT is a non-retryable input error', () => {
  it('exists on the enum', () => {
    expect(ManifestMCPErrorCode.INVALID_ARGUMENT).toBe('INVALID_ARGUMENT');
  });
  it('is classified non-retryable', () => {
    const err = new ManifestMCPError(ManifestMCPErrorCode.INVALID_ARGUMENT, 'bad');
    expect(isRetryable(err)).toBe(false);
  });
});
```

(If the exported retry predicate is not named `isRetryable`, open `packages/core/src/retry.ts`, find the exported classifier — it wraps `NON_RETRYABLE_ERROR_CODES` near line 95-100 — and use its real name.)

- [ ] **Step 2: Run → fail.** Run `npx vitest run packages/core/src/retry.test.ts`. Expected: FAIL — `INVALID_ARGUMENT` is `undefined` on the enum.

- [ ] **Step 3: Implement.** In `packages/core/src/types.ts`, add to the `ManifestMCPErrorCode` enum, next to `INVALID_ADDRESS` (line ~359):

```ts
  /** Caller passed a malformed argument (e.g. a non-UUID id, a bad FQDN). Non-retryable. */
  INVALID_ARGUMENT = 'INVALID_ARGUMENT',
```

In `packages/core/src/retry.ts`, add to the `NON_RETRYABLE_ERROR_CODES` array (line ~17):

```ts
  ManifestMCPErrorCode.INVALID_ARGUMENT,
```

- [ ] **Step 4: Run → pass.** Run `npx vitest run packages/core/src/retry.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -m "feat(core): add non-retryable INVALID_ARGUMENT error code (ENG-309)"
```

---

## Task 2: Consolidate bare-string validators into the `validation.ts` leaf

`brands.ts` must depend only on a dependency-light leaf. `validation.ts` imports only `./types.js` today. We (a) relocate `validateAddress` here (it needs only `fromBech32` from `@cosmjs/encoding`, not the `@cosmjs/stargate` machinery `transactions/utils.ts` pulls in), (b) extract a bare-string `assertUuid` from `requireUuid`, and (c) add the canonical `FQDN_RE`/`SCHEME_PREFIX_RE`/`DENOM_RE`.

**Files:** Modify `packages/core/src/validation.ts`, `packages/core/src/transactions/utils.ts`. Test: `packages/core/src/validation.test.ts`.

- [ ] **Step 1: Write the failing test** — `packages/core/src/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import {
  assertUuid,
  DENOM_RE,
  FQDN_RE,
  requireUuid,
  SCHEME_PREFIX_RE,
  validateAddress,
} from './validation.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDR = 'manifest1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn7hzdtn';

describe('assertUuid (bare string)', () => {
  it('accepts a valid UUID', () => {
    expect(() => assertUuid(UUID, 'leaseUuid')).not.toThrow();
  });
  it('throws with the label and a custom code', () => {
    try {
      assertUuid('nope', 'skuUuid', ManifestMCPErrorCode.INVALID_ARGUMENT);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_ARGUMENT);
      expect((err as ManifestMCPError).message).toContain('skuUuid');
    }
  });
});

describe('requireUuid still delegates correctly', () => {
  it('returns a valid UUID field', () => {
    expect(requireUuid({ leaseUuid: UUID }, 'leaseUuid')).toBe(UUID);
  });
});

describe('validateAddress relocated to validation.ts', () => {
  it('accepts a bech32 address and enforces an explicit prefix', () => {
    expect(() => validateAddress(ADDR, 'address')).not.toThrow();
    expect(() => validateAddress(ADDR, 'address', 'cosmos')).toThrow(ManifestMCPError);
  });
});

describe('canonical regexes', () => {
  it('FQDN_RE rejects IPv4 literals (letter-led TLD) and accepts a real FQDN', () => {
    expect(FQDN_RE.test('app.example.com')).toBe(true);
    expect(FQDN_RE.test('192.168.1.1')).toBe(false);
  });
  it('SCHEME_PREFIX_RE matches http(s) prefixes', () => {
    expect(SCHEME_PREFIX_RE.test('https://x.io')).toBe(true);
    expect(SCHEME_PREFIX_RE.test('x.io')).toBe(false);
  });
  it('DENOM_RE accepts umfx / ibc paths and rejects leading-digit', () => {
    expect(DENOM_RE.test('umfx')).toBe(true);
    expect(DENOM_RE.test('ibc/ABC123')).toBe(true);
    expect(DENOM_RE.test('1bad')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.** Run `npx vitest run packages/core/src/validation.test.ts`. Expected: FAIL — `validation.js` does not export `assertUuid`/`validateAddress`/`FQDN_RE`/`SCHEME_PREFIX_RE`/`DENOM_RE`.

- [ ] **Step 3a: Relocate `validateAddress` into `validation.ts`.** First read `packages/core/src/transactions/utils.ts:251-280` to copy the exact `validateAddress` body. Add to the TOP of `validation.ts` (it currently imports only `./types.js`):

```ts
import { fromBech32 } from '@cosmjs/encoding';
```

Then append the relocated function + the canonical regexes + the extracted UUID validator to `validation.ts`:

```ts
/** Validate a bech32 address (optionally pinning the prefix). Throws ManifestMCPError. */
export function validateAddress(
  address: string,
  fieldName: string,
  expectedPrefix?: string,
): void {
  if (!address || address.trim() === '') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `${fieldName} is required`,
    );
  }
  try {
    const { prefix } = fromBech32(address);
    if (expectedPrefix && prefix !== expectedPrefix) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        `Invalid ${fieldName}: "${address}". Expected prefix "${expectedPrefix}", got "${prefix}"`,
      );
    }
  } catch (error) {
    if (error instanceof ManifestMCPError) throw error;
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `Invalid ${fieldName}: "${address}". Not a valid bech32 address.`,
    );
  }
}

/** RFC-4122 UUID (any version), case-insensitive. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical client-side FQDN validator (consolidated from agent-core FQDN_RE):
 * 1-253 chars, >=2 dot-separated RFC-1123 labels (each 1-63 chars), top-level
 * label letter-led so IPv4 literals like "192.168.1.1" are NOT valid FQDNs (RFC 1123 §2.1).
 * Case-insensitive class — callers normalize to lowercase (RFC 4343).
 */
export const FQDN_RE =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A URL scheme prefix (rejected for a bare FQDN, with a targeted message). */
export const SCHEME_PREFIX_RE = /^https?:\/\//i;

/** Cosmos denom grammar: letter-led, then alphanumerics + / _ - (covers umfx, ibc/..., factory/...). */
export const DENOM_RE = /^[a-zA-Z][a-zA-Z0-9/_-]*$/;

/**
 * Assert a BARE string is a valid UUID. The single source of truth for UUID
 * validation (reused by requireUuid + the brand constructors).
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
```

Then replace the existing `UUID_PATTERN` constant + `requireUuid` body (lines 68-88) so `requireUuid` delegates to `assertUuid`:

```ts
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

- [ ] **Step 3b: Re-export `validateAddress` from `transactions/utils.ts`.** In `packages/core/src/transactions/utils.ts`, DELETE the local `validateAddress` function (lines ~251-280) and instead re-export it so the ~18 existing importers keep working unchanged:

```ts
export { validateAddress } from '../validation.js';
```

(Verify `transactions/utils.ts` still imports `fromBech32` only where still needed; if `fromBech32` is now unused there, remove that import to satisfy `noUnusedLocals`.)

- [ ] **Step 4: Run → pass + no regressions.** Run `npx vitest run packages/core` then `npm run build && (cd packages/core && npm run lint)`. Expected: all core tests PASS (the relocation is behaviour-preserving; the ~18 `validateAddress` importers resolve via the re-export); build "Build complete"; lint exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/validation.ts packages/core/src/validation.test.ts packages/core/src/transactions/utils.ts
git commit -m "refactor(core): move validateAddress + add bare-string validators to the validation leaf (ENG-309)"
```

---

## Task 3: The `brands.ts` module (uniform `parse*` constructors)

**Files:** Create `packages/core/src/brands.ts`. Test: Task 4.

- [ ] **Step 1: Implement `brands.ts`.**

```ts
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import {
  assertUuid,
  DENOM_RE,
  FQDN_RE,
  SCHEME_PREFIX_RE,
  validateAddress,
} from './validation.js';

/**
 * Nominal brand. STRING tag key (not a `unique symbol`) ON PURPOSE: a unique-symbol
 * brand is non-assignable across DUPLICATED package copies (each copy mints a distinct
 * symbol), which would break the incremental cross-copy adoption this monorepo needs
 * (the worktree/dep-drift hazard in CLAUDE.md). Never exported. A brand is structurally
 * `string`: assignable TO string, not FROM it. INVARIANT: every `as Brand` cast below is
 * preceded by a throwing validator on all paths.
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

const ARG = ManifestMCPErrorCode.INVALID_ARGUMENT;

/**
 * Validate a bech32 address and brand it. With no `expectedPrefix` this validates
 * bech32 STRUCTURE only and does NOT pin the chain prefix — callers needing chain
 * affinity (e.g. the Signer adapter) pass the configured `addressPrefix`.
 */
export function parseAddress(value: string, expectedPrefix?: string): Address {
  validateAddress(value, 'address', expectedPrefix);
  return value as Address;
}

export function parseLeaseUuid(value: string): LeaseUuid {
  assertUuid(value, 'leaseUuid', ARG);
  return value as LeaseUuid;
}
export function parseProviderUuid(value: string): ProviderUuid {
  assertUuid(value, 'providerUuid', ARG);
  return value as ProviderUuid;
}
export function parseSkuUuid(value: string): SkuUuid {
  assertUuid(value, 'skuUuid', ARG);
  return value as SkuUuid;
}

/** Reject whitespace-only (stricter than requireString's length check) — a blank tier/chainId is never meaningful. */
function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ManifestMCPError(ARG, `${label} must be a non-empty string`);
  }
}

export function parseTierName(value: string): TierName {
  assertNonEmpty(value, 'size');
  return value as TierName;
}
export function parseChainId(value: string): ChainId {
  assertNonEmpty(value, 'chainId');
  return value as ChainId;
}
export function parseDenom(value: string): Denom {
  if (!DENOM_RE.test(value)) {
    throw new ManifestMCPError(ARG, `denom "${value}" is not a valid denom`);
  }
  return value as Denom;
}

/**
 * Normalize (RFC 4343: DNS is case-insensitive) and validate a custom domain.
 * Rejects scheme prefixes and IPv4 literals (FQDN_RE has a letter-led top-level label).
 * The chain remains the authoritative validator (reserved suffixes, etc.).
 */
export function parseFqdn(value: string): Fqdn {
  if (SCHEME_PREFIX_RE.test(value)) {
    throw new ManifestMCPError(
      ARG,
      `customDomain "${value}" must not include a scheme — pass a bare FQDN`,
    );
  }
  const normalized = value.toLowerCase();
  if (!FQDN_RE.test(normalized)) {
    throw new ManifestMCPError(
      ARG,
      `customDomain "${value}" is not a valid FQDN`,
    );
  }
  return normalized as Fqdn;
}
```

- [ ] **Step 2: Biome format.** Run `npx @biomejs/biome check --write packages/core/src/brands.ts`. Expected: exit 0 (formats imports/spacing).

---

## Task 4: Runtime behaviour tests for `brands.ts`

**Files:** Create `packages/core/src/brands.test.ts`.

- [ ] **Step 1: Write the test.**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseAddress,
  parseChainId,
  parseDenom,
  parseFqdn,
  parseLeaseUuid,
  parseProviderUuid,
  parseSkuUuid,
  parseTierName,
} from './brands.js';
import { assertUuid } from './validation.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDR = 'manifest1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn7hzdtn';

describe('uuid brands', () => {
  it('accept a valid UUID and return it unchanged', () => {
    expect(parseLeaseUuid(UUID)).toBe(UUID);
    expect(parseProviderUuid(UUID)).toBe(UUID);
    expect(parseSkuUuid(UUID)).toBe(UUID);
  });
  it('reject a non-UUID with INVALID_ARGUMENT and the field label', () => {
    try {
      parseLeaseUuid('nope');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_ARGUMENT);
      expect((err as ManifestMCPError).message).toContain('leaseUuid');
    }
  });
  it('a malformed UUID yields the SAME code via parseLeaseUuid as via assertUuid(INVALID_ARGUMENT)', () => {
    const codeFromConstructor = (() => {
      try { parseLeaseUuid('bad'); return null; } catch (e) { return (e as ManifestMCPError).code; }
    })();
    const codeFromAssert = (() => {
      try { assertUuid('bad', 'leaseUuid', ManifestMCPErrorCode.INVALID_ARGUMENT); return null; }
      catch (e) { return (e as ManifestMCPError).code; }
    })();
    expect(codeFromConstructor).toBe(codeFromAssert);
  });
});

describe('parseAddress', () => {
  it('accepts a valid bech32 address (prefix unpinned by default)', () => {
    expect(parseAddress(ADDR)).toBe(ADDR);
  });
  it('enforces the prefix when given (rejects a manifest addr as cosmos)', () => {
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
  it.each(['app.example.com', 'a.io', 'sub.domain.co.uk', 'xn--80akhbyknj4f.com'])(
    'accepts %s',
    (fqdn) => expect(parseFqdn(fqdn)).toBe(fqdn),
  );
  it('NORMALIZES case (RFC 4343) instead of rejecting', () => {
    expect(parseFqdn('APP.Example.COM')).toBe('app.example.com');
  });
  it.each([
    ['nodot', 'no dot'],
    ['', 'empty'],
    ['192.168.1.1', 'IPv4 literal (numeric TLD)'],
    ['https://app.io', 'scheme prefix'],
    ['app.example.com.', 'trailing dot'],
    [`${'a'.repeat(64)}.com`, '64-char label'],
    ['-bad.com', 'leading hyphen'],
  ])('rejects %s (%s)', (bad) => {
    expect(() => parseFqdn(bad)).toThrow(ManifestMCPError);
  });
});

describe('trim + denom brands', () => {
  it('parseTierName/parseChainId accept non-empty, reject whitespace-only', () => {
    expect(parseTierName('docker-small')).toBe('docker-small');
    expect(parseChainId('manifest-1')).toBe('manifest-1');
    expect(() => parseTierName('   ')).toThrow(ManifestMCPError);
  });
  it('parseDenom enforces the denom grammar', () => {
    expect(parseDenom('umfx')).toBe('umfx');
    expect(parseDenom('ibc/ABC')).toBe('ibc/ABC');
    expect(() => parseDenom('1bad')).toThrow(ManifestMCPError);
    expect(() => parseDenom('')).toThrow(ManifestMCPError);
  });
});
```

- [ ] **Step 2: Run → fail then pass.** Run `npx vitest run packages/core/src/brands.test.ts`. (Expected first run before Task 3 is committed: module-resolution FAIL. After Task 3: PASS.) If any FQDN case fails, fix `brands.ts`/`FQDN_RE` — do not weaken the test.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/src/brands.ts packages/core/src/brands.test.ts
git commit -m "feat(core): branded domain types + uniform parse constructors (ENG-309)"
```

---

## Task 5: Type-distinctness tests via `expectTypeOf` (`*.test-d.ts` + `--typecheck`)

`@ts-expect-error` passes on *any* line error (not the intended assignability error) and `vitest run` does not type-check. The 2024-2026 idiom is `expectTypeOf` in a `*.test-d.ts` run under `--typecheck`, which asserts the *exact* relationship.

**Files:** Create `packages/core/src/brands.test-d.ts`; modify `packages/core/vitest.config.ts`.

- [ ] **Step 1: Enable typecheck in `core/vitest.config.ts`.** Add to the `test` block (create the block if the config has none):

```ts
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
```

- [ ] **Step 2: Write `packages/core/src/brands.test-d.ts`.**

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  Denom,
  LeaseUuid,
  ProviderUuid,
  SkuUuid,
  TierName,
} from './brands.js';

// NOTE: never use expectTypeOf(...).branded here — `.branded` normalizes away the
// `& { __brand }` intersection that DEFINES a brand and would defeat these checks.
describe('brand distinctness (type-level)', () => {
  it('UUID-backed brands are mutually non-assignable', () => {
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<ProviderUuid>();
    expectTypeOf<ProviderUuid>().not.toEqualTypeOf<SkuUuid>();
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<SkuUuid>();
  });
  it('a non-UUID pair is also distinct', () => {
    expectTypeOf<Denom>().not.toEqualTypeOf<TierName>();
  });
  it('brands are one-way assignable: TO string, not FROM string', () => {
    expectTypeOf<LeaseUuid>().toExtend<string>(); // brand IS a string
    expectTypeOf<string>().not.toExtend<LeaseUuid>(); // a bare string is NOT a brand
  });
});
```

- [ ] **Step 3: Run → pass.** Run `npx vitest --run --typecheck packages/core/src/brands.test-d.ts`. Expected: PASS (all type assertions hold).

- [ ] **Step 4: Mutation-prove the guard bites.** Temporarily edit `brands.ts` so `ProviderUuid = Brand<string, 'LeaseUuid'>` (same tag as `LeaseUuid`). Re-run Step 3. Expected: **FAIL** on `not.toEqualTypeOf<ProviderUuid>()` (the brands collapsed). **Revert** the edit and re-run → PASS. This proves the guard is real (not a no-op).

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/brands.test-d.ts packages/core/vitest.config.ts
git commit -m "test(core): type-distinctness fixtures for brands via expectTypeOf (ENG-309)"
```

---

## Task 6: Barrel export + full gate

**Files:** Modify `packages/core/src/index.ts`. Test: `packages/core/src/brands.barrel.test.ts`.

- [ ] **Step 1: Failing test** — `packages/core/src/brands.barrel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAddress, parseFqdn, parseLeaseUuid } from './index.js';

describe('brands re-exported from the package barrel', () => {
  it('exposes the constructors', () => {
    expect(typeof parseLeaseUuid).toBe('function');
    expect(typeof parseAddress).toBe('function');
    expect(typeof parseFqdn).toBe('function');
  });
});
```

- [ ] **Step 2: Run → fail.** Run `npx vitest run packages/core/src/brands.barrel.test.ts`. Expected: FAIL — `index.js` has no `parseLeaseUuid` export.

- [ ] **Step 3: Add the re-export to `index.ts`** (near the `validateAddress` re-export, ~line 79):

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
  parseAddress,
  parseChainId,
  parseDenom,
  parseFqdn,
  parseLeaseUuid,
  parseProviderUuid,
  parseSkuUuid,
  parseTierName,
} from './brands.js';
```

(`Tenant` is the transparent `export type Tenant = Address` alias declared in `brands.ts`.)

- [ ] **Step 4: Run → pass.** Run `npx vitest run packages/core/src/brands.barrel.test.ts`. Expected: PASS.

- [ ] **Step 5: Full core gate.** Run, in order:

```bash
npm run build
(cd packages/core && npm run lint)
npx vitest run packages/core
npx vitest --run --typecheck packages/core/src/brands.test-d.ts
npx @biomejs/biome check packages/core/src/brands.ts packages/core/src/brands.test.ts packages/core/src/brands.test-d.ts packages/core/src/brands.barrel.test.ts packages/core/src/validation.ts packages/core/src/index.ts
```

Expected: build "Build complete"; lint exit 0; all runtime tests PASS; type tests PASS; Biome exit 0. (Build first so downstream packages type-check against the regenerated `dist/` — CLAUDE.md ENG-220.)

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/index.ts packages/core/src/brands.barrel.test.ts
git commit -m "feat(core): export branded types from the package barrel (ENG-309)"
```

---

## Self-Review (completed)

- **Spec coverage (§5.0/§7):** `Brand<T,B>` string-key + rationale ✓; nine aliases incl. `Tenant = Address` ✓; **uniform `parse*`** constructors ✓; **new `INVALID_ARGUMENT`** code + non-retryable classification ✓ (Task 1); reuse the consolidated `validation.ts` leaf (`validateAddress` relocated, `assertUuid`, `FQDN_RE`/`SCHEME_PREFIX_RE`/`DENOM_RE`) ✓ (Task 2); **`parseFqdn` normalizes case + reuses the existing `FQDN_RE` rules** (IPv4-literal + scheme rejection) ✓; lone `as Brand` cast confined ✓; type distinctness via `expectTypeOf`/`*.test-d.ts` + a **mutation-proof step** ✓ (Task 5). Boundary-policy read/wallet sites are consumed by later plans; the `dependency-cruiser` guard (incl. forbidding `brands.ts → transactions/**`) is P0 Plan 8.
- **Placeholders:** none.
- **Type/name consistency:** constructor names (`parseAddress`/`parseLeaseUuid`/`parseProviderUuid`/`parseSkuUuid`/`parseTierName`/`parseFqdn`/`parseDenom`/`parseChainId`) are identical across `brands.ts`, `brands.test.ts`, `brands.test-d.ts`, and the barrel. `assertUuid`/`validateAddress`/`FQDN_RE`/`DENOM_RE` signatures match between `validation.ts` and `brands.ts`. The `INVALID_ARGUMENT` code is referenced consistently (Tasks 1, 2, 3, 4). The barrel re-exports `Tenant` (the `Address` alias) alongside the other brand types.

## Next plan

→ **P0 Plan 2:** canonical types chokepoint (`core/src/manifest-types.ts`, `fred` re-exports), the `Logger` port + `noopLogger`, and the `CallOptions`/`TxCallOptions` option-bag types — consumes the brands (e.g. `DeployAppResult.leaseUuid: LeaseUuid`). Also: the Signer adapter (Plan 3) threads `config.addressPrefix` into `parseAddress` so wallet addresses are pinned to the active chain.
