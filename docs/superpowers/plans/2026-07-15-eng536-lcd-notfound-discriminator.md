# ENG-536 — LCD not-found discriminator: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the not-found contract the LCD adapter severs, so the already-declared `T | null` reads (`getLease`, `getBalance`'s credits, `manageDomain`'s lookup) actually return null instead of throwing over LCD/REST.

**Architecture:** One new classifier module in core reads the grpc-gateway envelope (`{"code":5}`) off an LCD error and mints `ManifestMCPError(NOT_FOUND, …, {httpStatus, grpcCode, grpcMessage})`. A public `isNotFoundError` predicate accepts all three error shapes a Manifest read can produce. Every existing not-found guard is re-keyed onto that predicate and its regexes deleted. Classification keys on grpc `code === 5`, never HTTP 404 — a proxy 404 carries no envelope and must keep throwing.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, tsdown, biome. Core is `platform: "neutral"` — the classifier must stay browser-safe (no node builtins, no axios import; duck-type the shape).

**Spec:** `docs/superpowers/specs/2026-07-15-eng536-lcd-notfound-discriminator-design.md`

---

## READ THIS FIRST — five traps that will waste your day

This plan was adversarially reviewed (53 agents) after a first draft shipped 12 defects. Each rule below is a **reproduced** failure, not a precaution.

**1. `npm run build` after EVERY `core/src` edit — or your gates are false green.**
`packages/core`'s `exports["."]` maps to `./dist/*`, and `lint` is `tsc --noEmit` (not `tsc -b`), so nothing rebuilds implicitly. Siblings resolve core through **stale `dist/`**. Proven: a symbol added to `core/src` yields `TS2305` in lease/agent-core, and `ManifestMCPErrorCode.NOT_FOUND` is `undefined` at runtime — **tests pass while asserting nothing.** Every task that touches `core/src` ends with a build.

**2. This is NOT a billing-read change. It is module-wide, on BOTH transports.**
`adaptModule` is applied to **~25 namespaces** (`lcd-adapter.ts:205-322`). Task 2 rewires its shared catch, so *every* not-found across `cosmos_query` — auth accounts, wasm, gov, group, IBC — moves `QUERY_FAILED` → `NOT_FOUND`. Task 8 does the same on the RPC leg. Two e2e files already pin the old code (Tasks 6/8).

**3. The new predicate is NARROWER than the old regexes, deliberately.**
Old `NOT_FOUND_RES` was `/not.?found/i` — it matched the *proxy* 404 `"Endpoint not found"` (a false positive) and MISSED the real keeper message `"no lease with custom_domain …"`. Two existing fixtures depend on the old looseness and must be retargeted (Tasks 4, 7). **Do not "fix" a red fixture by re-widening the predicate.** Re-widening the plain-`Error` leg specifically would slip past *both* new proxy-404 tests (one uses a `ManifestMCPError`, one an axios envelope; neither covers that leg).

**4. `isNotFoundError` must NOT use `instanceof`.**
`ManifestMCPError` carries no brand (`types.ts:402-418`, only `setPrototypeOf` — same-copy only). Both shipped precedents avoid `instanceof` for exactly this: `isSkuAmbiguousError` value-checks `.code` (`sku-resolution.ts:35-45`, comment: *"no `instanceof`, so it is dual-package-safe. cosmjs `isDeliverTxFailure` idiom"*). Cross-copy, `instanceof` → false → predicate returns false → `getLease` throws: **byte-identical to the pre-fix symptom, and no test can catch it** (vitest loads one copy).

**5. Start from a clean tree.**
`git status` must be empty before Task 1. A review agent previously left an `assertUuid` experiment in `reads.ts`; it has been reverted. If the tree is dirty, the red gates below are unreachable.

---

## Background

The bug in one line: `lcd-adapter.ts:88-91` wraps every LCD failure as `ManifestMCPError(QUERY_FAILED, …)` interpolating only axios's `.message`, discarding `response.status` and `response.data`. Downstream, `catchNotFound` (`tools/getBalance.ts:6-22`) opens with `if (err instanceof ManifestMCPError) throw err` — so it rethrows the wrapped 404 before its regexes run. The null branches are dead code over LCD.

(agent-core's `isNotFoundError` at `manage-domain.ts:465-473` reaches the same dead end differently: it `return false`s on a `ManifestMCPError`, and the rethrow is at `:444`. The spec previously misquoted this — the conclusion holds, the mechanism differs.)

**Real wire shapes, captured live from `https://api.manifest.network`** — use verbatim in tests:

```jsonc
// billing not-found (all five singular reads) — HTTP 404
{"code":5,"message":"lease not found","details":[]}
{"code":5,"message":"no lease with custom_domain definitely-unclaimed-xyz.example.com","details":[]}
{"code":5,"message":"credit account not found","details":[]}

// PROXY 404 — a node that doesn't serve billing (nodes.chandrastation.com, our own .env.example!)
{"error":"not_found","message":"Endpoint not found"}

// collection reads DO NOT 404 — HTTP 200
{"leases":[],"pagination":{"next_key":null,"total":"0"}}
```

Verified raw shape: `constructor: AxiosError`, `response.status: 404` (number), `response.data` = the **parsed** object above, `response.data.code: 5` (number). **Landmine:** `AxiosError` has its own `.code` (a string like `'ERR_BAD_REQUEST'`) which is NOT `response.data.code`. Also `@cosmology/lcd` can `reject('no response data')` — a **bare string**, not an Error.

**Why the old tests missed it:** every existing mock rejects with a bare `Error` or a pre-built `ManifestMCPError`. **Nothing mocks the axios shape.**

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `packages/core/src/internals/classify-query-error.ts` | The only place that knows the LCD/grpc wire shape. `classifyLcdError` + `isNotFoundError` + `QueryErrorDetails`. |
| **Create** `packages/core/src/internals/classify-query-error.test.ts` | Table-driven over the real shapes. |
| **Modify** `packages/core/src/types.ts` | `ManifestMCPErrorCode.NOT_FOUND`. |
| **Modify** `packages/core/src/index.ts` | Export the primitive (**Task 1**, not Task 9 — Task 7 needs it). |
| **Modify** `packages/core/src/lcd-adapter.ts` | `adaptModule` catch → `classifyLcdError`. |
| **Modify** `packages/core/src/retry.ts` | `NOT_FOUND` non-retryable; 5xx via `details.httpStatus`. |
| **Modify** `packages/core/src/__test-utils__/mocks.ts` | **:222,:230** reject with the real shape, not `new Error('key not found')`. |
| **Modify** `packages/core/src/tools/getBalance.ts` | `catchNotFound` → predicate. |
| **Modify** `packages/core/src/tools/reads.ts` | null branches + `assertUuid`; `getLeaseByCustomDomain` → `\| null`. |
| **Modify** `packages/core/src/tools/reads.test.ts` | uuid placeholders + narrow the `\| null` derefs (:153-156). |
| **Modify** `packages/core/src/reads.crossface.test.ts` | uuid placeholders (:101,:103). |
| **Modify** `packages/core/src/client-factory.test.ts` | uuid placeholders (:215-216). |
| **Modify** `packages/core/src/cosmos.ts` | RPC leg only (:147). LCD leg already preserves `error.code`. |
| **Modify** `packages/lease/src/index.ts` | `:469` destructure → null handling. |
| **Modify** `packages/lease/src/server.test.ts` | `:970-995` contract flip. |
| **Modify** `packages/agent-core/src/manage-domain.ts` | Re-key; delete `NOT_FOUND_RES`. |
| **Modify** `packages/agent-core/src/manage-domain.test.ts` | `:203-205` fixture retarget + `onFailure` assertions. |
| **Modify** `packages/sdk/src/index.ts` | **ROOT** barrel value export (NOT `/reads`). |
| **Modify** `packages/sdk/src/index.test.ts` | ROOT keyset. **Leave `READS` at 8.** |
| **Create** `e2e/rest-mode-notfound.e2e.test.ts` | New file — `rest-mode.e2e.test.ts` is MCP-stdio and cannot host these. |
| **Modify** `e2e/billing-custom-domain.e2e.test.ts` | `:277-278` `QUERY_FAILED` → `NOT_FOUND`. |
| **Modify** `e2e/chain-routing.e2e.test.ts` | `:1064-1080` IBC denom-trace pin. |
| **Modify** `CHANGELOG.md` | Module-wide + both-transport framing. |

**Verified as NOT needing edits:** `client-factory.ts` (binds via `BoundFn<typeof fn>` — nullability propagates through the type). agent-core's `manageDomain` call site (calls `queryClient.liftedinit.billing.v1.leaseByCustomDomain` **directly** at `:404`, not core's read).

---

## Task 1: Classifier + NOT_FOUND + barrel export

**Files:** Create `packages/core/src/internals/classify-query-error.ts` + `.test.ts`; Modify `packages/core/src/types.ts`, `packages/core/src/index.ts`

- [ ] **Step 1: Add `NOT_FOUND`**

`packages/core/src/types.ts`, under `// Query errors`:

```ts
  /**
   * The chain answered "no such entity" — an EXPECTED absence, not a fault.
   * Minted from the grpc-gateway envelope's `code: 5` over LCD, or from cosmjs's
   * `rpc error: code = NotFound` text over RPC. Carries `QueryErrorDetails`.
   * Non-retryable: the answer will not change on retry.
   *
   * Deliberately NOT derived from HTTP 404 — a proxy/route 404 (a node that does
   * not serve the module) is a real failure and must stay QUERY_FAILED.
   */
  NOT_FOUND = 'NOT_FOUND',
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/internals/classify-query-error.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { classifyLcdError, isNotFoundError } from './classify-query-error.js';

/** An axios-shaped rejection: what @cosmology/lcd actually throws. */
function axiosError(status: number, data: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`);
  Object.assign(err, { response: { status, data }, isAxiosError: true, code: 'ERR_BAD_REQUEST' });
  return err;
}

describe('classifyLcdError', () => {
  it('classifies a grpc-gateway code:5 envelope as NOT_FOUND with details', () => {
    const err = classifyLcdError('lease', axiosError(404, { code: 5, message: 'lease not found', details: [] }));
    expect(err.code).toBe(ManifestMCPErrorCode.NOT_FOUND);
    expect(err.details).toMatchObject({ httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found' });
  });

  // THE regression guard: a real 404 from nodes.chandrastation.com, which does not
  // serve billing. No grpc envelope => NOT a not-found.
  it('does NOT classify a proxy 404 (no grpc envelope) as NOT_FOUND', () => {
    const err = classifyLcdError('lease', axiosError(404, { error: 'not_found', message: 'Endpoint not found' }));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 404 });
    expect(err.details?.grpcCode).toBeUndefined();
  });

  it('preserves httpStatus on a 500 so retry can branch on the number', () => {
    const err = classifyLcdError('lease', axiosError(500, { code: 13 }));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 500, grpcCode: 13 });
  });

  it('handles a non-object body (proxy HTML)', () => {
    const err = classifyLcdError('lease', axiosError(502, '<html>bad gateway</html>'));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 502 });
  });

  it('handles an error with no response (network failure)', () => {
    const err = classifyLcdError('lease', new Error('fetch failed'));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('fetch failed');
  });

  // @cosmology/lcd rejects with a BARE STRING on this path (LCDClient.get).
  it('handles a bare-string rejection', () => {
    const err = classifyLcdError('lease', 'no response data');
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('no response data');
  });
});

describe('isNotFoundError', () => {
  it('accepts our own ManifestMCPError(NOT_FOUND)', () => {
    expect(isNotFoundError(new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found'))).toBe(true);
  });

  // Dual-package safety (ENG-462): a cross-copy error fails `instanceof` but
  // MUST still classify. A plain object with the right `code` stands in for it.
  it('accepts a cross-copy ManifestMCPError-shaped object (no instanceof)', () => {
    expect(isNotFoundError({ name: 'ManifestMCPError', code: 'NOT_FOUND', message: 'lease not found' })).toBe(true);
  });

  // Decision 4: a consumer keeps manifestjs as transport and borrows our semantic.
  it('accepts a RAW axios error from a consumer-owned manifestjs client', () => {
    expect(isNotFoundError(axiosError(404, { code: 5, message: 'credit account not found' }))).toBe(true);
  });

  it('accepts a plain RPC Error', () => {
    expect(isNotFoundError(new Error('rpc error: code = NotFound desc = lease not found'))).toBe(true);
  });

  it('rejects a raw proxy 404', () => {
    expect(isNotFoundError(axiosError(404, { error: 'not_found', message: 'Endpoint not found' }))).toBe(false);
  });

  // The AxiosError `.code` landmine: its own code is a STRING, never 'NOT_FOUND'.
  it('does not confuse AxiosError.code with our code', () => {
    expect(isNotFoundError(axiosError(500, { code: 13 }))).toBe(false);
  });

  it('rejects QUERY_FAILED', () => {
    expect(isNotFoundError(new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'lease not found'))).toBe(false);
  });

  it.each([undefined, null, 'not found', 42])('rejects non-error %p', (v) => {
    expect(isNotFoundError(v)).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run packages/core/src/internals/classify-query-error.test.ts`
Expected: FAIL — `Failed to resolve import "./classify-query-error.js"`.

- [ ] **Step 4: Implement**

Create `packages/core/src/internals/classify-query-error.ts`:

```ts
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/** gRPC status code for NOT_FOUND. grpc-gateway maps it to HTTP 404 — but NOT vice versa. */
const GRPC_NOT_FOUND = 5;

/**
 * cosmjs surfaces a gRPC NotFound only as message text over RPC — no structured
 * code exists on that transport. Character-identical to cosmjs's own probe in
 * StargateClient.getAccount. Do NOT widen: `/not.?found/i` matches a PROXY 404
 * ("Endpoint not found"), which is a real failure, not an absence.
 */
const RPC_NOT_FOUND_RE = /rpc error: code = NotFound/i;

/**
 * @public — structured transport detail carried by query errors. Fields are absent
 * when the transport cannot supply them (RPC has no HTTP layer; a proxy 404 has no
 * grpc envelope).
 */
export interface QueryErrorDetails {
  readonly httpStatus?: number;
  readonly grpcCode?: number;
  readonly grpcMessage?: string;
}

/** Duck-typed `err.response`. No axios import: core is platform-neutral and axios is transitive. */
function readResponse(err: unknown): { status?: unknown; data?: unknown } | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const resp = (err as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) return undefined;
  return resp as { status?: unknown; data?: unknown };
}

function readDetails(err: unknown): QueryErrorDetails {
  const resp = readResponse(err);
  const data = resp?.data;
  const envelope =
    typeof data === 'object' && data !== null ? (data as { code?: unknown; message?: unknown }) : undefined;
  return {
    httpStatus: typeof resp?.status === 'number' ? resp.status : undefined,
    // A body is only a grpc envelope when `code` is a NUMBER. That is exactly what
    // separates a keeper NotFound from a proxy's {"error":"not_found"}.
    grpcCode: typeof envelope?.code === 'number' ? envelope.code : undefined,
    grpcMessage: typeof envelope?.message === 'string' ? envelope.message : undefined,
  };
}

/**
 * @public — true when `err` means "the chain answered: no such entity".
 *
 * Accepts the three shapes a Manifest read can produce:
 *  1. our own `ManifestMCPError` (structured `code`);
 *  2. a RAW LCD error from a caller's own manifestjs client (grpc envelope) —
 *     deliberate: manifestjs owns transport, we own the semantic (spec Decision 4);
 *  3. a plain RPC `Error` (message text only — RPC offers nothing better).
 *
 * Deliberately NOT keyed on HTTP 404: a proxy/route 404 carries no envelope and
 * must not read as "absent".
 *
 * NO `instanceof` (ENG-462): `ManifestMCPError` carries no brand, so `instanceof`
 * is false across duplicate package copies — which would silently reproduce the
 * exact pre-ENG-536 symptom. Value-check `.code` like `isSkuAmbiguousError` does
 * (cosmjs `isDeliverTxFailure` idiom). Safe against the AxiosError `.code`
 * landmine: axios's own codes are 'ERR_BAD_REQUEST'/'ERR_NETWORK', never 'NOT_FOUND'.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    if ((err as { code?: unknown }).code === ManifestMCPErrorCode.NOT_FOUND) return true;
    const grpcCode = readDetails(err).grpcCode;
    if (grpcCode !== undefined) return grpcCode === GRPC_NOT_FOUND;
  }
  if (err instanceof Error) return RPC_NOT_FOUND_RE.test(err.message);
  return false;
}

/**
 * Turn a raw LCD (axios) rejection into a structured `ManifestMCPError`.
 *
 * `NOT_FOUND` only when the grpc envelope says `code: 5`; everything else stays
 * `QUERY_FAILED`. `details` is attached to BOTH so `retry.ts` can branch on
 * `httpStatus` instead of regexing axios's message template.
 */
export function classifyLcdError(key: string, error: unknown): ManifestMCPError {
  const details = readDetails(error);
  const raw = error instanceof Error ? error.message : String(error);

  if (details.grpcCode === GRPC_NOT_FOUND) {
    return new ManifestMCPError(
      ManifestMCPErrorCode.NOT_FOUND,
      `LCD query "${key}" not found: ${details.grpcMessage ?? raw}`,
      { ...details },
    );
  }
  return new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, `LCD query "${key}" failed: ${raw}`, {
    ...details,
  });
}
```

- [ ] **Step 5: Export from the barrel — MUST be here, not Task 9**

Task 7 imports this from `@manifest-network/manifest-mcp-core`. If the export lands in Task 9, agent-core is red across two commits and Task 7's gate is a false green (`isNotFoundError is not a function` makes its `rejects.toThrow()` test pass spuriously).

Add to `packages/core/src/index.ts` (biome enforces sorted exports — place accordingly):

```ts
export {
  isNotFoundError,
  type QueryErrorDetails,
} from './internals/classify-query-error.js';
```

- [ ] **Step 6: Run + BUILD**

```bash
npx vitest run packages/core/src/internals/classify-query-error.test.ts
npm run build -w @manifest-network/manifest-mcp-core
```

Expected: tests PASS; build clean. **The build is mandatory** — siblings resolve core via `dist/`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/internals/classify-query-error.ts packages/core/src/internals/classify-query-error.test.ts packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat(core): add NOT_FOUND code + grpc-envelope query-error classifier (ENG-536)"
```

---

## Task 2: Wire the adapter

**Files:** Modify `packages/core/src/lcd-adapter.ts`; Test `packages/core/src/lcd-adapter.test.ts`

> **Scope note:** this catch is shared by `adaptModule`, applied to ~25 namespaces (`lcd-adapter.ts:205-322`). You are changing not-found classification for **every LCD module**, not just billing.

- [ ] **Step 1: Write the failing test**

`lcd-adapter.test.ts` binds `_adaptModule as adaptModule` at `:4` — use the **local** name `adaptModule`. `ManifestMCPErrorCode` and `vi` are already imported.

```ts
describe('adaptModule error classification (ENG-536)', () => {
  function axiosError(status: number, data: unknown): Error {
    const err = new Error(`Request failed with status code ${status}`);
    Object.assign(err, { response: { status, data } });
    return err;
  }

  // The shape no pre-ENG-536 test used — which is exactly why the bug shipped.
  it('mints NOT_FOUND from a real LCD 404 grpc envelope', async () => {
    const lcdMod = {
      lease: vi.fn().mockRejectedValue(axiosError(404, { code: 5, message: 'lease not found', details: [] })),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({
      code: ManifestMCPErrorCode.NOT_FOUND,
      details: { httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found' },
    });
  });

  it('keeps a proxy 404 as QUERY_FAILED', async () => {
    const lcdMod = {
      lease: vi.fn().mockRejectedValue(axiosError(404, { error: 'not_found', message: 'Endpoint not found' })),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/core/src/lcd-adapter.test.ts -t "ENG-536"`
Expected: FAIL — first test gets `QUERY_FAILED`.

- [ ] **Step 3: Implement**

Add the import to `packages/core/src/lcd-adapter.ts`:

```ts
import { classifyLcdError } from './internals/classify-query-error.js';
```

Replace the catch inside `adaptModule` (lines 86-92):

```ts
      } catch (error) {
        if (error instanceof ManifestMCPError) throw error;
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `LCD query "${key}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
```

with:

```ts
      } catch (error) {
        if (error instanceof ManifestMCPError) throw error;
        // Classify BEFORE wrapping: this is the only place the grpc envelope
        // (response.status/data) still exists. Discarding it here is what made
        // every downstream `T | null` branch unreachable (ENG-536).
        throw classifyLcdError(key, error);
      }
```

Leave the `converter.fromJSON` catch (lines 96-101) as-is — a decode failure is not a transport error.

- [ ] **Step 4: Run + BUILD**

```bash
npx vitest run packages/core/src/lcd-adapter.test.ts
npm run build -w @manifest-network/manifest-mcp-core
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lcd-adapter.ts packages/core/src/lcd-adapter.test.ts
git commit -m "fix(core): classify LCD errors instead of discarding status+body (ENG-536)"
```

---

## Task 3: Retry — NOT_FOUND non-retryable + fix the 5xx regex

**Files:** Modify `packages/core/src/retry.ts`; Test `packages/core/src/retry.test.ts`

Adjacent bug: `retry.ts:70`'s `/\b(?:http|status)\s*5\d{2}\b/` never matches axios's `Request failed with status code 500` — "code" sits between "status" and the number. **LCD 5xx is never retried today.**

- [ ] **Step 1: Write the failing test**

```ts
describe('isRetryableError — structured details (ENG-536)', () => {
  it('never retries NOT_FOUND', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found', { httpStatus: 404, grpcCode: 5 }),
      ),
    ).toBe(false);
  });

  // Pins the bug: axios's real message template defeats the 5xx pattern.
  it('retries a 5xx via details.httpStatus despite the "status code 500" message', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'LCD query "lease" failed: Request failed with status code 500',
          { httpStatus: 500 },
        ),
      ),
    ).toBe(true);
  });

  it('does not retry a 4xx carrying details', () => {
    expect(
      isRetryableError(new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'bad request', { httpStatus: 400 })),
    ).toBe(false);
  });

  it('still retries 429 via details.httpStatus', () => {
    expect(
      isRetryableError(new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'rate limited', { httpStatus: 429 })),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/core/src/retry.test.ts -t "ENG-536"`
Expected: FAIL — the 500 case returns `false`.

- [ ] **Step 3: Implement**

Add to `NON_RETRYABLE_ERROR_CODES` (after `INVALID_ARGUMENT`):

```ts
  // The chain answered "no such entity" — an expected, permanent answer.
  // Retrying cannot change it (ENG-536).
  ManifestMCPErrorCode.NOT_FOUND,
```

Replace `isRetryableError`'s `ManifestMCPError` branch (lines 100-105):

```ts
  if (error instanceof ManifestMCPError) {
    if (NON_RETRYABLE_ERROR_CODES.includes(error.code)) {
      return false;
    }
    // Prefer the structured status when the transport supplied one: axios's
    // template is "Request failed with status code 500", which the message
    // patterns below CANNOT match (the word "code" sits between "status" and the
    // number) — so LCD 5xx went unretried before ENG-536.
    const httpStatus = error.details?.httpStatus;
    if (typeof httpStatus === 'number') {
      return httpStatus >= 500 || httpStatus === 429;
    }
    // Fall back to message sniffing for the RPC leg, which has no status.
    return isTransientErrorMessage(error.message);
  }
```

- [ ] **Step 4: Run**

Run: `npx vitest run packages/core/src/retry.test.ts`
Expected: PASS (no build needed — no cross-package consumer of this change).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -m "fix(core): retry on structured httpStatus; never retry NOT_FOUND (ENG-536)"
```

---

## Task 4: Revive `catchNotFound` + fix the shared mock fixtures

**Files:** Modify `packages/core/src/tools/getBalance.ts`, `packages/core/src/__test-utils__/mocks.ts`; Test `packages/core/src/tools/getBalance.test.ts`

Highest-severity user-facing fix: `getBalance` throws for **any address with no credit account** — every new user.

> **Trap:** the shared mock rejects with a plain `Error` the new predicate does not recognise. Applying only the `getBalance.ts` change gives `4 failed | 2 passed`. The fixture is part of the fix — the plain-`Error` mock is *itself* why this bug shipped.

- [ ] **Step 1: Fix the shared fixtures**

`packages/core/src/__test-utils__/mocks.ts:222` is `throw new Error('key not found')` and `:230` is `throw new Error('credit not found')`. Neither matches `RPC_NOT_FOUND_RE`. Replace with the shape the post-Task-2 adapter actually mints:

```ts
          creditAccount: vi.fn().mockImplementation(async () => {
            if (creditAccount === null)
              throw new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
                httpStatus: 404,
                grpcCode: 5,
                grpcMessage: 'credit account not found',
              });
            return {
              creditAccount,
              balances: creditAccountBalances,
              availableBalances: creditAccountAvailableBalances,
            };
          }),
          creditEstimate: vi.fn().mockImplementation(async () => {
            if (creditEstimate === null)
              throw new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
                httpStatus: 404,
                grpcCode: 5,
                grpcMessage: 'credit account not found',
              });
            return creditEstimate;
          }),
```

Import `ManifestMCPError` / `ManifestMCPErrorCode` in `mocks.ts` if absent.

- [ ] **Step 2: Write the failing test**

Add to `getBalance.test.ts`. **Keep** the existing `RPC_CONNECTION_FAILED` propagation test at `:74-90` — still correct.

```ts
it('returns credits: null when the chain says the credit account is absent', async () => {
  const client = makeMockQueryClient();
  vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
      httpStatus: 404, grpcCode: 5, grpcMessage: 'credit account not found',
    }),
  );
  vi.mocked(client.liftedinit.billing.v1.creditEstimate).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
      httpStatus: 404, grpcCode: 5, grpcMessage: 'credit account not found',
    }),
  );

  const result = await getBalance(makeReadCtx({ query: client }), address);
  expect(result.credits).toBeNull();
  expect(result.balances).toBeDefined();
});

it('still throws when the credit read fails for a non-not-found reason', async () => {
  const client = makeMockQueryClient();
  vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'LCD query "creditAccount" failed', { httpStatus: 500 }),
  );
  await expect(getBalance(makeReadCtx({ query: client }), address)).rejects.toMatchObject({
    code: ManifestMCPErrorCode.QUERY_FAILED,
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run packages/core/src/tools/getBalance.test.ts -t "credit account is absent"`
Expected: FAIL — throws instead of returning `credits: null`.

- [ ] **Step 4: Implement**

Replace `catchNotFound` (`getBalance.ts:6-22`) entirely:

```ts
function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    // Keyed on the structured code, NOT message text. Pre-ENG-536 this rethrew
    // EVERY ManifestMCPError, and the LCD adapter wraps 404s into exactly that —
    // so this guard was dead code over REST and the regexes below never ran.
    // Real not-found messages also vary by keeper ("no lease with custom_domain X"
    // contains no "not found" at all).
    if (isNotFoundError(err)) return null;
    throw err;
  });
}
```

Update imports:

```ts
import type { ReadCtx } from '../ctx.js';
import { isNotFoundError } from '../internals/classify-query-error.js';
import { withReadSignal } from '../internals/read-signal.js';
import type { CallOptions } from '../options.js';
```

Remove the now-unused `ManifestMCPError` import if nothing else in the file uses it (biome will flag it).

- [ ] **Step 5: Run — the WHOLE file**

Run: `npx vitest run packages/core/src/tools/getBalance.test.ts`
Expected: **all 6 PASS**, including the retained `RPC_CONNECTION_FAILED` test (that code is not NOT_FOUND, so it still propagates) and the 4 that the fixture fix repairs.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/getBalance.ts packages/core/src/tools/getBalance.test.ts packages/core/src/__test-utils__/mocks.ts
git commit -m "fix(core): getBalance returns credits: null for an absent credit account (ENG-536)"
```

---

## Task 5: `getLease` + `getWithdrawableAmount` — null + uuid validation (BREAKING)

**Files:** Modify `packages/core/src/tools/reads.ts`, `packages/core/src/tools/reads.test.ts`, `packages/core/src/reads.crossface.test.ts`, `packages/core/src/client-factory.test.ts`

Use `assertUuid(value, label, errorCode)` from `../validation.js` — **not** `requireUuid`, whose signature is `(input: Record<string, unknown>, field, errorCode)` and cannot take a bare string.

Why validation is required: the keeper returns `code:5 "lease not found"` for a **malformed** uuid too (probed: `lease/not-a-uuid` → 404 `{"code":5,…}`). Without it, `getLease(ctx, 'typo')` returns `null` — making null mean both "absent" and "you sent garbage".

> **Trap:** `assertUuid` breaks **8 passing tests across 3 files** — every existing fixture uses `'lease-uuid-1'`, which `UUID_RE` (`validation.ts:70-71`) rejects. Migrating them is part of this task. **Do not weaken or delete `assertUuid` to make them pass** — that destroys the invariant.

- [ ] **Step 1: Migrate the uuid fixtures**

Define once in each file: `const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';`

| file | lines | note |
|---|---|---|
| `packages/core/src/tools/reads.test.ts` | `:22, :35, :100, :109, :112, :128, :319, :336` | `:112` and `:326` assert the uuid **round-trips**, so the `makeMockQueryClient` lease fixture must change in lockstep |
| `packages/core/src/reads.crossface.test.ts` | `:60, :93, :101, :103` | not named in the first draft |
| `packages/core/src/client-factory.test.ts` | `:215, :216` | not named in the first draft; the first draft wrongly declared this file untouched |

Replace every `'lease-uuid-1'` / `'lease-uuid'` used as a **lease uuid argument or asserted value** with `VALID_UUID`. Leave `'sku-uuid-1'`/`'provider-uuid-1'` alone — those reads gain no validation.

- [ ] **Step 2: Write the failing test**

Add to `reads.test.ts`:

```ts
const NOT_FOUND_ERR = new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found', {
  httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found',
});

describe('getLease not-found (ENG-536)', () => {
  it('returns null when the chain says the lease is absent', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.lease).mockRejectedValue(NOT_FOUND_ERR);
    await expect(getLease(makeReadCtx({ query: client }), VALID_UUID)).resolves.toBeNull();
  });

  it('rethrows a transient failure rather than reporting absence', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.lease).mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'boom', { httpStatus: 500 }),
    );
    await expect(getLease(makeReadCtx({ query: client }), VALID_UUID)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  // The keeper returns code:5 for a MALFORMED uuid too, so without this guard a
  // typo would silently read as "absent".
  it('rejects a malformed uuid with INVALID_ARGUMENT without issuing a read', async () => {
    const client = makeMockQueryClient();
    await expect(getLease(makeReadCtx({ query: client }), 'not-a-uuid')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_ARGUMENT,
    });
    expect(client.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
  });
});

describe('getWithdrawableAmount not-found (ENG-536)', () => {
  it('returns null when the lease is absent', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.withdrawableAmount).mockRejectedValue(NOT_FOUND_ERR);
    await expect(getWithdrawableAmount(makeReadCtx({ query: client }), VALID_UUID)).resolves.toBeNull();
  });

  it('rejects a malformed uuid with INVALID_ARGUMENT', async () => {
    const client = makeMockQueryClient();
    await expect(getWithdrawableAmount(makeReadCtx({ query: client }), 'not-a-uuid')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_ARGUMENT,
    });
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run packages/core/src/tools/reads.test.ts -t "ENG-536"`
Expected: FAIL — NOT_FOUND propagates instead of resolving null.

- [ ] **Step 4: Implement**

Add imports to `reads.ts`:

```ts
import { isNotFoundError } from '../internals/classify-query-error.js';
import { assertUuid } from '../validation.js';
```

Replace `getLease` (`:87-101`):

```ts
export async function getLease(
  ctx: ReadCtx,
  leaseUuid: string,
  opts?: CallOptions,
): Promise<BrandedLease | null> {
  // MUST precede the read: the keeper answers `code:5 "lease not found"` for a
  // malformed uuid too, so without this a typo would return null — making null
  // mean both "absent" and "you sent garbage" (ENG-536).
  assertUuid(leaseUuid, 'lease_uuid', ManifestMCPErrorCode.INVALID_ARGUMENT);

  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1.lease({ leaseUuid }).catch((error: unknown) => {
        // .catch scoped to the INNER read so AbortError/TimeoutError propagate (OI-CATCH)
        if (isNotFoundError(error)) return null;
        throw error;
      }),
    opts,
  );
  if (r === null) return null;
  return r.lease ? toBrandedLease(r.lease) : null;
}
```

Replace `getWithdrawableAmount` (`:180-191`):

```ts
export async function getWithdrawableAmount(
  ctx: ReadCtx,
  leaseUuid: string,
  opts?: CallOptions,
): Promise<Coin[] | null> {
  assertUuid(leaseUuid, 'lease_uuid', ManifestMCPErrorCode.INVALID_ARGUMENT);

  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1.withdrawableAmount({ leaseUuid }).catch((error: unknown) => {
        if (isNotFoundError(error)) return null;
        throw error;
      }),
    opts,
  );
  return r === null ? null : r.amounts;
}
```

- [ ] **Step 5: Run + BUILD + full lint**

```bash
npx vitest run packages/core/src/tools/reads.test.ts packages/core/src/reads.crossface.test.ts packages/core/src/client-factory.test.ts
npm run build -w @manifest-network/manifest-mcp-core
npm run lint
```

Expected: all PASS. The build **must** precede the lint, or the lint reads a stale `dist/` and greens falsely.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/reads.ts packages/core/src/tools/reads.test.ts packages/core/src/reads.crossface.test.ts packages/core/src/client-factory.test.ts
git commit -F - <<'EOF'
feat(core)!: getLease/getWithdrawableAmount return null on absence (ENG-536)

Also validate the lease uuid up-front: the keeper answers code:5 "lease not
found" for a MALFORMED uuid too, so without this a typo would silently render
as null — making null mean both "absent" and "you sent garbage".

BREAKING CHANGE: getWithdrawableAmount now returns `Coin[] | null` instead of
`Coin[]`. getLease's signature is unchanged (already `| null`) but its null
branch is now actually reachable over LCD. A malformed lease uuid now throws
INVALID_ARGUMENT instead of QUERY_FAILED.
EOF
```

---

## Task 6: `getLeaseByCustomDomain` → `| null` (BREAKING)

**Files:** Modify `packages/core/src/tools/reads.ts`, `packages/core/src/tools/reads.test.ts`, `packages/lease/src/index.ts`, `packages/lease/src/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('getLeaseByCustomDomain not-found (ENG-536)', () => {
  it('returns null for an unclaimed FQDN', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'no lease with custom_domain app.example.com', {
        httpStatus: 404, grpcCode: 5, grpcMessage: 'no lease with custom_domain app.example.com',
      }),
    );
    await expect(getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com')).resolves.toBeNull();
  });

  it('rethrows a transient failure', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'boom', { httpStatus: 503 }),
    );
    await expect(getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });
});
```

- [ ] **Step 2: Narrow the existing unguarded derefs — core's own tsc breaks otherwise**

`reads.test.ts:148-156` does `const result = await getLeaseByCustomDomain(...)` then derefs `result.lease.uuid` / `.tenant` / `.providerUuid` / `result.serviceName` unguarded. Core's tsconfig includes `src/**/*` under `strict`, so `| null` emits 4× `TS18047: 'result' is possibly 'null'`. Insert after the call:

```ts
    expect(result).not.toBeNull();
    if (result === null) throw new Error('unreachable — guarded above');
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run packages/core/src/tools/reads.test.ts -t "unclaimed FQDN"`
Expected: FAIL — rejects instead of resolving null.

- [ ] **Step 4: Implement the core change**

Replace `getLeaseByCustomDomain` (`:103-125`):

```ts
/**
 * Reverse-look up the lease holding `customDomain`.
 *
 * Returns `null` when no lease claims the FQDN — an EXPECTED outcome (this is the
 * conflict-check every domain claim runs). A transport/decode failure still throws,
 * so `null` unambiguously means "unclaimed" (ENG-536).
 */
export async function getLeaseByCustomDomain(
  ctx: ReadCtx,
  customDomain: string,
  opts?: CallOptions,
): Promise<{ lease: BrandedLease; serviceName: string } | null> {
  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1
        .leaseByCustomDomain({ customDomain })
        .catch((error: unknown) => {
          // .catch scoped to the INNER read so AbortError/TimeoutError propagate (OI-CATCH)
          if (isNotFoundError(error)) return null;
          if (error instanceof ManifestMCPError) throw error;
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            `lease_by_custom_domain failed: ${error instanceof Error ? error.message : String(error)}`,
            { customDomain },
          );
        }),
    opts,
  );
  if (r === null) return null;
  return { lease: toBrandedLease(r.lease), serviceName: r.serviceName };
}
```

- [ ] **Step 5: Fix the lease-server call site**

`packages/lease/src/index.ts:469` destructures and will not compile. Replace:

```ts
        const found = await getLeaseByCustomDomain(ctx, customDomain);
        if (found === null) {
          // The tool contract THROWS on an unclaimed FQDN (callers expect a
          // structured error, not an empty result). Pre-ENG-536 this surfaced as
          // an opaque QUERY_FAILED; NOT_FOUND finally delivers the "you sent
          // garbage" vs "the chain answered no-such-thing" distinction this
          // handler's own comment promises.
          throw new ManifestMCPError(
            ManifestMCPErrorCode.NOT_FOUND,
            `lease_by_custom_domain: no lease with custom_domain ${customDomain}`,
            { customDomain },
          );
        }
        return jsonResponse({ lease: found.lease, service_name: found.serviceName }, bigIntReplacer);
```

The message deliberately echoes the keeper's own wording (`no lease with custom_domain X`) — `e2e/billing-custom-domain.e2e.test.ts:269-272` exists to pin that the chain's diagnostic survives.

Also update the stale comment at `:459-463` — it claims the QUERY_FAILED wrap "now lives inside the core fn", no longer true:

```ts
        // getLeaseByCustomDomain acquires its own rate-limit token via
        // withReadSignal, so we do NOT pre-acquire here — that would
        // double-consume on the same logical read. The core fn returns null for
        // an unclaimed FQDN (ENG-536); this tool re-raises it as NOT_FOUND to
        // keep its throw-on-absence contract.
```

- [ ] **Step 6: Flip the lease server's contract pin**

`packages/lease/src/server.test.ts:970-995` — core's `getLeaseByCustomDomain` is **not** mocked there (the `vi.mock` factory spreads `actual` and overrides only 6 symbols), so the real fn runs over the mocked query client. Its mock message contains `rpc error: code = NotFound`, which the new predicate matches → core returns null → the handler throws `NOT_FOUND`. The end state is intended; update the pin:

- rename: `it('raises an unclaimed FQDN as structured NOT_FOUND', …)`
- `expect(parsed.code).toBe('QUERY_FAILED')` → `toBe('NOT_FOUND')`
- keep `expect(parsed.message).toMatch(/no lease with custom_domain/)` (the re-raise preserves it)
- keep the `details` assertion
- update the leading comment: the keeper's NotFound now classifies to `NOT_FOUND` in core, and the tool re-raises rather than wrapping.

- [ ] **Step 7: Run + BUILD + full lint**

```bash
npx vitest run packages/core/src/tools/reads.test.ts
npm run build -w @manifest-network/manifest-mcp-core
npx vitest run packages/lease
npm run lint
```

Expected: all PASS. **The build must precede the lease run and the lint** — otherwise lease resolves core's stale `dist/` and both green falsely, which is precisely the gate this task depends on.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tools/reads.ts packages/core/src/tools/reads.test.ts packages/lease/src/index.ts packages/lease/src/server.test.ts
git commit -F - <<'EOF'
feat(core)!: getLeaseByCustomDomain returns null for an unclaimed FQDN (ENG-536)

BREAKING CHANGE: getLeaseByCustomDomain now returns
`{lease, serviceName} | null` instead of throwing on an unclaimed FQDN.
Callers must handle null. The lease_by_custom_domain MCP tool keeps its
throw contract, now raising NOT_FOUND instead of an opaque QUERY_FAILED.
EOF
```

---

## Task 7: agent-core — re-key `isNotFoundError`

**Files:** Modify `packages/agent-core/src/manage-domain.ts`, `packages/agent-core/src/manage-domain.test.ts`

agent-core calls `queryClient.liftedinit.billing.v1.leaseByCustomDomain` **directly** (`:404`), so Task 6's signature change does not reach it. Its regexes are broken **both ways** on the real chain:

```
"no lease with custom_domain …"  -> NOT_FOUND_RES: false   ← real not-found, MISSED
"Endpoint not found"             -> NOT_FOUND_RES: true    ← proxy 404, FALSE POSITIVE
```

> **Trap:** the new predicate is **narrower**. `manage-domain.test.ts:203-205` rejects with `new Error('NotFound: domain not claimed')` — matched by the old `/not.?found/i`, **not** matched by `RPC_NOT_FOUND_RE` (which requires `rpc error: code = NotFound`). That fixture must be retargeted to a realistic shape. **The narrowing is deliberate — do not re-widen the predicate to make it pass.** Re-widening the plain-`Error` leg would slip past both proxy-404 tests, since neither covers that leg.

- [ ] **Step 1: Retarget the fixture + write the failing tests**

`manage-domain.test.ts:203-205` — replace the mock rejection (keep the fixture JSON unchanged):

```ts
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.NOT_FOUND,
        'no lease with custom_domain unclaimed.example.com',
        { httpStatus: 404, grpcCode: 5, grpcMessage: 'no lease with custom_domain unclaimed.example.com' },
      ),
    );
```

Add the false-positive guard + the callback-contract pin (today an unclaimed FQDN fires `onFailure` at `:441-443` before throwing; post-fix it must fire `onComplete` and never `onFailure`):

```ts
it('THROWS for a proxy 404 whose message merely contains "not found" (ENG-536)', async () => {
  // A node that doesn't serve billing must NOT read as "FQDN unclaimed".
  const queryClient = makeMockQueryClient();
  queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Endpoint not found', { httpStatus: 404 }),
  );
  // ...mirror the 05-lookup-not-found setup...
  await expect(manageDomain(args, callbacks, { clientManager })).rejects.toThrow();
  expect(callbacks.onFailure).toHaveBeenCalled();
});
```

And in the retargeted `05-lookup-not-found` test, assert the contract flip:

```ts
    expect(callbacks.onFailure).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts -t "05-lookup-not-found"`
Expected: FAIL — the old guard `return false`s on a `ManifestMCPError`, so it throws instead of returning `{lease: null}`.

- [ ] **Step 3: Implement**

In `packages/agent-core/src/manage-domain.ts`:
- Delete the `NOT_FOUND_RES` constant (`:83-87`).
- Delete the local `isNotFoundError` (`:465-473`).
- Add to imports: `import { isNotFoundError } from '@manifest-network/manifest-mcp-core';`

The call site at `:429` is unchanged. Core's predicate is strictly more correct: it accepts the raw LCD shape and never false-positives on message text.

- [ ] **Step 4: Run**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts`
Expected: PASS. (Core is already built and its barrel already exports the predicate — Task 1 Step 5.)

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/manage-domain.ts packages/agent-core/src/manage-domain.test.ts
git commit -m "fix(agent-core): key domain lookup on NOT_FOUND, not message regexes (ENG-536)"
```

---

## Task 8: tier-2 `cosmosQuery` RPC leg

**Files:** Modify `packages/core/src/cosmos.ts`; Test `packages/core/src/cosmos.test.ts`

**The LCD leg needs no change** — `cosmosQuery`'s catch at `:137-145` already re-wraps preserving `error.code`, so an adapter-minted NOT_FOUND propagates with `{module, subcommand}` merged in for free. Only the plain-`Error` branch (`:147`, the RPC leg) needs classifying.

> **Trap:** the module name is **`billing`**, not `'liftedinit.billing'`. `VALID_NAME_PATTERN` (`cosmos.ts:24`) is `/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/` — **no dot** — and `validateName` runs at `:108`, *before* the catch you're editing. A dotted name throws `UNSUPPORTED_QUERY` and the test can never reach the code under test. The registry key is `billing` (`modules.ts:394`). **Do not "fix" this by admitting dots to `VALID_NAME_PATTERN`** — that defeats the injection guard pinned by `cosmos.test.ts:166-193`.

- [ ] **Step 1: Write the failing test**

```ts
it('surfaces an RPC NotFound as NOT_FOUND, not QUERY_FAILED (ENG-536)', async () => {
  // cosmjs/gRPC gives only message text on this transport.
  mockHandler.mockRejectedValue(new Error('rpc error: code = NotFound desc = lease not found'));
  await expect(cosmosQuery(clientManager, 'billing', 'lease', ['some-uuid'])).rejects.toMatchObject({
    code: ManifestMCPErrorCode.NOT_FOUND,
  });
});

it('preserves an adapter-minted NOT_FOUND through the LCD leg with attribution (ENG-536)', async () => {
  mockHandler.mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found', { httpStatus: 404, grpcCode: 5 }),
  );
  await expect(cosmosQuery(clientManager, 'billing', 'lease', ['some-uuid'])).rejects.toMatchObject({
    code: ManifestMCPErrorCode.NOT_FOUND,
    details: { module: 'billing', subcommand: 'lease', grpcCode: 5 },
  });
});
```

Adapt `mockHandler`/`clientManager` to the file's existing harness.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/core/src/cosmos.test.ts -t "ENG-536"`
Expected: the first FAILs (gets QUERY_FAILED). The second should already PASS — it documents the free behaviour; keep it as a guard.

- [ ] **Step 3: Implement**

Add the import:

```ts
import { isNotFoundError } from './internals/classify-query-error.js';
```

Replace the trailing throw of `cosmosQuery`'s catch (`:147-151`):

```ts
        // The RPC leg throws plain Errors — classify so the generic query path
        // yields NOT_FOUND on BOTH transports (the LCD leg already arrives as a
        // structured ManifestMCPError and is preserved above). ENG-536.
        throw new ManifestMCPError(
          isNotFoundError(error) ? ManifestMCPErrorCode.NOT_FOUND : ManifestMCPErrorCode.QUERY_FAILED,
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand },
        );
```

Do **not** touch `loadBuildContext` (`:38-75`) — that is the tx-build path, out of scope.

- [ ] **Step 4: Run + BUILD**

```bash
npx vitest run packages/core/src/cosmos.test.ts
npm run build -w @manifest-network/manifest-mcp-core
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cosmos.ts packages/core/src/cosmos.test.ts
git commit -m "fix(core): classify RPC NotFound on the tier-2 query path (ENG-536)"
```

---

## Task 9: Publish the primitive on the SDK ROOT

**Files:** Modify `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts`

> **Trap:** it does **not** go on `/reads`. `packages/sdk/src/index.test.ts:186-188` pins *"`/reads` runtime exports are EXACTLY the 8 reads"* — a 9th breaks it. The **root** is the documented home: its docstring says *"NO free fns EXCEPT error-vocabulary helpers over ManifestMCPError (sanitizeForLogging, isSkuAmbiguousError)"*, and `isSkuAmbiguousError` lives there. Architecturally `/reads` is backwards anyway — post-fix, `/reads` consumers get `T | null` and never need the predicate; it serves `/chain` and raw-manifestjs consumers. **Leave `READS` at 8. Do not touch `packages/sdk/src/reads.ts`.**

Note the root is `export type * from core` + a curated **value** list — a value export must be named explicitly; `export type *` will not carry it.

- [ ] **Step 1: Write the failing test**

Add `'isNotFoundError'` to the **ROOT** exact-keyset array in `packages/sdk/src/index.test.ts` (`:151-183`), sorted beside `isSkuAmbiguousError`. Leave `READS` (`:38-47`) untouched.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/sdk/src/index.test.ts`
Expected: FAIL — `isNotFoundError` missing from the root's actual exports.

- [ ] **Step 3: Implement**

In `packages/sdk/src/index.ts`, add to the curated value block (alphabetical — it sorts immediately before `isSkuAmbiguousError`):

```ts
  isNotFoundError,
```

- [ ] **Step 4: BUILD, then run**

```bash
npm run build
npx vitest run packages/sdk
npm run check
```

The build **must** come first — the SDK resolves core via `dist/`. `npm run build` also runs `publint` + `@arethetypeswrong/core` over the SDK surface.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/index.ts packages/sdk/src/index.test.ts
git commit -m "feat(sdk): export isNotFoundError on the root error-vocabulary surface (ENG-536)"
```

---

## Task 10: E2E — pin the real chain contract

**Files:** Create `e2e/rest-mode-notfound.e2e.test.ts`; Modify `e2e/billing-custom-domain.e2e.test.ts`, `e2e/chain-routing.e2e.test.ts`

> **Trap:** the first draft targeted `e2e/rest-mode.e2e.test.ts`. That file imports only `{MCPTestClient, parseToolErrorCode}` and drives an MCP server over stdio via `callTool`; it has no `ctx`, and both its `serverEntry` values are `chain.js` (which has no lease/credit tools). Its "helpers generate keys" premise is also false — `e2e/helpers/mcp-client.ts:6` holds one genesis-funded mnemonic, i.e. an address that **has** credit. Hence a new file using the library path.
>
> Local `npm run test:e2e` cannot run here (docker can't publish devnet ports — missing `xt_nat`). Verify via CI.

- [ ] **Step 1: Create the new e2e file**

Mirror `e2e/sdk-acceptance.e2e.test.ts`'s client construction (the one file already in the library-import style). Use `createManifestReadClient` against the devnet REST endpoint, and generate a fresh wallet for the guaranteed-no-credit address (`DirectSecp256k1HdWallet.generate(24, { prefix: 'manifest' })`, cf. `e2e/wallet.e2e.test.ts:12,69`).

```ts
describe('not-found contract over LCD (ENG-536)', () => {
  const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
  let client: Awaited<ReturnType<typeof createManifestReadClient>>;
  let freshAddress: string;

  beforeAll(async () => {
    client = await createManifestReadClient({
      config: { chainId: CHAIN_ID, restUrl: REST_URL },
    });
    const wallet = await DirectSecp256k1HdWallet.generate(24, { prefix: 'manifest' });
    freshAddress = (await wallet.getAccounts())[0].address;
  });
  afterAll(() => client?.dispose());

  it('getLease returns null for a lease that does not exist', async () => {
    await expect(client.getLease(ABSENT_UUID)).resolves.toBeNull();
  });

  it('getLeaseByCustomDomain returns null for an unclaimed FQDN', async () => {
    await expect(client.getLeaseByCustomDomain('definitely-unclaimed-xyz.example.com')).resolves.toBeNull();
  });

  it('getBalance returns credits: null for an address with no credit account', async () => {
    const result = await client.getBalance(freshAddress);
    expect(result.credits).toBeNull();
  });

  // Collection reads 200-with-empty — they must NOT be swept into the fix.
  it('getLeasesByTenant returns an empty list, not a throw, for a tenant with no leases', async () => {
    const result = await client.getLeasesByTenant({
      tenant: freshAddress,
      stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
    });
    expect(result.leases).toEqual([]);
  });
});
```

- [ ] **Step 2: Update the two existing pins**

Both assert the pre-ENG-536 code on paths this change re-codes.

- `e2e/billing-custom-domain.e2e.test.ts:277-278` — `expect(err.code).toBe('QUERY_FAILED')` → `'NOT_FOUND'`. Keep the `/no lease with custom_domain/` message assertion (Task 6's re-raise preserves the keeper text). Update the `:269-272` comment.
- `e2e/chain-routing.e2e.test.ts:1064-1080` — `expectChainSide(err, ['QUERY_FAILED'])` → `['NOT_FOUND']` for `ibc-transfer denom-trace` on an unknown hash. **This is not billing** — it is the module-wide blast radius (trap 2) surfacing. Confirmed live: `GET api.manifest.network/ibc/apps/transfer/v1/denom_traces/000…0` → 404 + `{"code":5,…}`.

- [ ] **Step 3: Run in CI**

```bash
git add e2e/rest-mode-notfound.e2e.test.ts e2e/billing-custom-domain.e2e.test.ts e2e/chain-routing.e2e.test.ts
git commit -m "test(e2e): pin the LCD not-found contract; update two pre-existing code pins (ENG-536)"
git push -u origin worktree-eng-lcd-notfound-discriminator
gh workflow run e2e.yml --ref worktree-eng-lcd-notfound-discriminator
```

Watch with `gh run watch`. Expected: green.

---

## Task 11: Changelog + final gate

**Files:** Modify `CHANGELOG.md`

- [ ] **Step 1: Add the entry**

House style (see 0.17.0) uses `### Upgrade notes` + `**BREAKING (…callers):**`. The framing must be **module-wide and both-transport** — not a billing-read fix.

```markdown
### Fixed

- **core:** the LCD/REST adapter discarded the not-found signal, so every declared `| null` read threw instead of returning null over REST. `getBalance` threw for any address with no credit account (every new user); `getLease`'s `BrandedLease | null` could never return null; agent-core's domain lookup could not report an unclaimed FQDN. LCD errors are now classified from the grpc-gateway envelope (`code: 5` → `NOT_FOUND`) and carry `details: {httpStatus, grpcCode, grpcMessage}`. Classification keys on the grpc code, never HTTP 404 — a proxy/route 404 from a node that doesn't serve the module still throws. (ENG-536)
- **core:** `isRetryableError` now branches on `details.httpStatus`. LCD 5xx failures were never retried, because axios's `Request failed with status code 500` does not match the 5xx message pattern. (ENG-536)

### Added

- **core, sdk:** `isNotFoundError(err)` — a public predicate accepting a `ManifestMCPError`, a **raw LCD/axios error from your own manifestjs client**, or a plain RPC `Error`. Lets a consumer keep manifestjs as its transport and still classify not-found correctly. Value-checks `.code` (no `instanceof`) so it is dual-package-safe, matching `isSkuAmbiguousError`. (ENG-536)
- **core:** `ManifestMCPErrorCode.NOT_FOUND` + the `QueryErrorDetails` type. (ENG-536)

### Changed

- **core:** not-found errors now surface as `NOT_FOUND` instead of `QUERY_FAILED` across **all LCD modules and both transports** — not just billing. `adaptModule` is applied to ~25 namespaces, and the generic `cosmos_query` path is re-coded on the RPC leg too, so an absent auth account, wasm contract, gov/group entity or IBC denom-trace now yields `NOT_FOUND`. (ENG-536)

### Upgrade notes

**BREAKING (SDK callers):** `getLeaseByCustomDomain` returns `{lease, serviceName} | null` instead of throwing for an unclaimed FQDN; `getWithdrawableAmount` returns `Coin[] | null`. Handle `null`. The `lease_by_custom_domain` MCP tool keeps its throw contract, now raising `NOT_FOUND` rather than an opaque `QUERY_FAILED`.

**BREAKING (error-code consumers):** code that matched `QUERY_FAILED` for a not-found outcome must now match `NOT_FOUND`. This applies to `cosmos_query` on any module, not only billing.

**Changed:** `getLease` / `getWithdrawableAmount` now validate the lease uuid up-front, throwing `INVALID_ARGUMENT` for a malformed value (previously `QUERY_FAILED`) — required because the keeper answers `code:5 "lease not found"` for a malformed uuid too, which would otherwise render as `null`.
```

- [ ] **Step 2: Full gate**

```bash
npm run build
npm run lint
npm run test
npm run check
```

All four must pass. `npm run lint` is the **full-repo** tsc — never substitute a per-package lint.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): ENG-536 LCD not-found discriminator"
```

---

## Done criteria

- [ ] `getBalance` returns `credits: null` for an address with no credit account (was: threw).
- [ ] `getLease` returns null for an absent lease; throws on a 500; throws `INVALID_ARGUMENT` on a malformed uuid.
- [ ] `getLeaseByCustomDomain` returns null for an unclaimed FQDN.
- [ ] A **proxy 404** (`{"error":"not_found"}`, no grpc envelope) still throws everywhere — no false "absent".
- [ ] `isNotFoundError` is on the SDK **root**, passes on a raw axios error AND on a cross-copy code-shaped object, and contains **no `instanceof`**.
- [ ] `/reads` still exports exactly 8.
- [ ] LCD 5xx is retried; NOT_FOUND never is.
- [ ] `npm run build` ran after every `core/src` edit.
- [ ] Full gate green: `npm run build`, `npm run lint`, `npm run test`, `npm run check`.
- [ ] E2E green in CI.

## Release note

`getLeaseByCustomDomain` + `getWithdrawableAmount` are type-level breaking, and the `QUERY_FAILED` → `NOT_FOUND` move is behaviourally breaking for error-code consumers → **0.19.0**. Bump via `scripts/version.mjs` (never hand-edit `package-lock.json`) as a separate user-driven release step.
