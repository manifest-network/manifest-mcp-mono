# ENG-536 — LCD not-found discriminator: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the not-found contract the LCD adapter severs, so the already-declared `T | null` reads (`getLease`, `getBalance`'s credits, `manageDomain`'s lookup) actually return null instead of throwing over LCD/REST.

**Architecture:** One new classifier module in core reads the grpc-gateway envelope (`{"code":5}`) off an LCD error and mints `ManifestMCPError(NOT_FOUND, …, {httpStatus, grpcCode, grpcMessage})`. A public `isNotFoundError` predicate accepts all three error shapes a Manifest read can produce — our `ManifestMCPError`, a **raw axios/grpc-envelope error** from a consumer's own manifestjs client, and a plain RPC `Error`. Every existing not-found guard is re-keyed onto that predicate and its regexes deleted. Classification keys on grpc `code === 5`, never HTTP 404 — a proxy 404 carries no envelope and must keep throwing.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, tsdown, biome. Core is `platform: "neutral"` — the classifier must stay browser-safe (no node builtins, no axios type import; duck-type the shape).

**Spec:** `docs/superpowers/specs/2026-07-15-eng536-lcd-notfound-discriminator-design.md`

---

## Background you need

The bug in one line: `lcd-adapter.ts:88-91` wraps every LCD failure as `ManifestMCPError(QUERY_FAILED, …)` interpolating only axios's `.message`, discarding `response.status` and `response.data`. Downstream, `catchNotFound` (`tools/getBalance.ts:6`) and agent-core's `isNotFoundError` (`manage-domain.ts:465`) both open with `if (err instanceof ManifestMCPError) throw err` — so they rethrow the wrapped 404 before their regexes ever run. The null branches are dead code over LCD.

**Real wire shapes, captured from the live chain (`https://api.manifest.network`)** — use these verbatim in tests:

```jsonc
// billing not-found (all five singular reads) — HTTP 404
{"code":5,"message":"lease not found","details":[]}
{"code":5,"message":"no lease with custom_domain definitely-unclaimed-xyz.example.com","details":[]}
{"code":5,"message":"credit account not found","details":[]}

// PROXY 404 from a node that doesn't serve billing (nodes.chandrastation.com — our own .env.example!)
{"error":"not_found","message":"Endpoint not found"}

// collection reads DO NOT 404 — HTTP 200
{"leases":[],"pagination":{"next_key":null,"total":"0"}}
```

An axios error carries these as `err.response.status` (number) and `err.response.data` (already JSON-parsed).

**Why the tests missed it:** every existing mock rejects with a bare `Error` or a pre-built `ManifestMCPError`. **Nothing mocks the axios shape.** That is the whole reason this shipped. Tests below therefore reject with `{response: {status, data}}` objects.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `packages/core/src/internals/classify-query-error.ts` | The only place that knows the LCD/grpc wire shape. Exports `classifyLcdError` (adapter-facing) + `isNotFoundError` (public primitive) + `QueryErrorDetails`. |
| **Create** `packages/core/src/internals/classify-query-error.test.ts` | Table-driven over the real shapes above. |
| **Modify** `packages/core/src/types.ts` | `ManifestMCPErrorCode.NOT_FOUND`. |
| **Modify** `packages/core/src/lcd-adapter.ts:82-102` | `adaptModule` catch delegates to `classifyLcdError`. |
| **Modify** `packages/core/src/retry.ts` | `NOT_FOUND` non-retryable; 5xx via `details.httpStatus`. |
| **Modify** `packages/core/src/tools/getBalance.ts:6-22` | `catchNotFound` delegates to the predicate; delete 3 regexes. |
| **Modify** `packages/core/src/tools/reads.ts` | `getLease`/`getWithdrawableAmount` → null + `assertUuid`; `getLeaseByCustomDomain` → `\| null`. |
| **Modify** `packages/core/src/cosmos.ts:147` | Plain-`Error` (RPC) branch classifies. **LCD leg needs no change** (:137-145 already preserves `error.code`). |
| **Modify** `packages/core/src/index.ts` | Export `isNotFoundError` + `type QueryErrorDetails`. |
| **Modify** `packages/sdk/src/reads.ts` | Re-export `isNotFoundError`. |
| **Modify** `packages/agent-core/src/manage-domain.ts:83,465-473` | Re-key onto core's predicate; delete `NOT_FOUND_RES`. |
| **Modify** `packages/lease/src/index.ts:469` | Handle the `\| null` destructure. |

**Not touched (verified):** `client-factory.ts` binds via `BoundFn<typeof getLeaseByCustomDomain>` so nullability propagates through the type automatically. agent-core calls `queryClient.liftedinit.billing.v1.leaseByCustomDomain` **directly** (`manage-domain.ts:404`), not core's read — so the signature change doesn't reach it.

---

## Task 1: The classifier module

**Files:**
- Create: `packages/core/src/internals/classify-query-error.ts`
- Create: `packages/core/src/internals/classify-query-error.test.ts`
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add the `NOT_FOUND` error code**

In `packages/core/src/types.ts`, under the `// Query errors` group (currently `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS`, `INVALID_ARGUMENT`), add:

```ts
  /**
   * The chain answered "no such entity" — an EXPECTED absence, not a fault.
   * Minted from the grpc-gateway envelope's `code: 5` (NOT_FOUND) over LCD, or
   * from cosmjs's `rpc error: code = NotFound` text over RPC. Carries
   * `QueryErrorDetails`. Non-retryable: the answer will not change on retry.
   *
   * Deliberately NOT derived from HTTP 404 — a proxy/route 404 (a node that
   * doesn't serve the module) is a real failure and must stay QUERY_FAILED.
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
  Object.assign(err, { response: { status, data } });
  return err;
}

describe('classifyLcdError', () => {
  it('classifies a grpc-gateway code:5 envelope as NOT_FOUND with details', () => {
    const err = classifyLcdError(
      'lease',
      axiosError(404, { code: 5, message: 'lease not found', details: [] }),
    );
    expect(err.code).toBe(ManifestMCPErrorCode.NOT_FOUND);
    expect(err.details).toMatchObject({
      httpStatus: 404,
      grpcCode: 5,
      grpcMessage: 'lease not found',
    });
  });

  // THE regression guard: a real 404 from nodes.chandrastation.com, which does
  // not serve the billing module. No grpc envelope => NOT a not-found.
  it('does NOT classify a proxy 404 (no grpc envelope) as NOT_FOUND', () => {
    const err = classifyLcdError(
      'lease',
      axiosError(404, { error: 'not_found', message: 'Endpoint not found' }),
    );
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

  it('handles an error with no response at all (network failure)', () => {
    const err = classifyLcdError('lease', new Error('fetch failed'));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('fetch failed');
  });

  it('handles a non-Error throw', () => {
    const err = classifyLcdError('lease', 'boom');
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('boom');
  });
});

describe('isNotFoundError', () => {
  it('accepts our own ManifestMCPError(NOT_FOUND)', () => {
    expect(
      isNotFoundError(
        new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found'),
      ),
    ).toBe(true);
  });

  // Decision 4: a consumer keeps manifestjs as its transport and borrows our
  // semantic. If this regresses, the "don't reinvent manifestjs" story dies.
  it('accepts a RAW axios error from a consumer-owned manifestjs client', () => {
    expect(
      isNotFoundError(
        axiosError(404, { code: 5, message: 'credit account not found' }),
      ),
    ).toBe(true);
  });

  it('accepts a plain RPC Error', () => {
    expect(
      isNotFoundError(
        new Error('rpc error: code = NotFound desc = lease not found'),
      ),
    ).toBe(true);
  });

  it('rejects a raw proxy 404', () => {
    expect(
      isNotFoundError(axiosError(404, { error: 'not_found', message: 'Endpoint not found' })),
    ).toBe(false);
  });

  it('rejects QUERY_FAILED', () => {
    expect(
      isNotFoundError(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'lease not found'),
      ),
    ).toBe(false);
  });

  it.each([undefined, null, 'not found', 42])('rejects non-error %p', (v) => {
    expect(isNotFoundError(v)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internals/classify-query-error.test.ts`
Expected: FAIL — `Failed to resolve import "./classify-query-error.js"`.

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/internals/classify-query-error.ts`:

```ts
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * gRPC status code for NOT_FOUND. grpc-gateway maps this to HTTP 404, but the
 * reverse does NOT hold — see `isNotFoundError`.
 */
const GRPC_NOT_FOUND = 5;

/**
 * cosmjs surfaces a gRPC NotFound only as message text over RPC — there is no
 * structured code on that transport. This is the same concession cosmjs itself
 * makes in `StargateClient.getAccount`.
 */
const RPC_NOT_FOUND_RE = /rpc error: code = NotFound/i;

/**
 * @public — structured transport detail carried by query errors. Fields are
 * absent when the transport cannot supply them (RPC has no HTTP layer; a proxy
 * 404 has no grpc envelope).
 */
export interface QueryErrorDetails {
  /** HTTP status from the LCD gateway. Absent over RPC. */
  readonly httpStatus?: number;
  /** gRPC code from the grpc-gateway envelope. Absent when the body isn't an envelope. */
  readonly grpcCode?: number;
  /** Keeper message from the envelope, e.g. "lease not found". */
  readonly grpcMessage?: string;
}

/** Duck-typed read of an axios-ish `err.response`. No axios type dependency: core is platform-neutral. */
function readResponse(err: unknown): { status?: unknown; data?: unknown } | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const resp = (err as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) return undefined;
  return resp as { status?: unknown; data?: unknown };
}

/**
 * Extract the grpc-gateway envelope's `code`, or undefined when the body is not
 * an envelope. A body is only an envelope when `code` is a number — that is what
 * separates a keeper NotFound from a proxy's `{"error":"not_found"}`.
 */
function readGrpcEnvelopeCode(err: unknown): number | undefined {
  const data = readResponse(err)?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function readDetails(err: unknown): QueryErrorDetails {
  const resp = readResponse(err);
  const data = resp?.data;
  const envelope =
    typeof data === 'object' && data !== null
      ? (data as { code?: unknown; message?: unknown })
      : undefined;
  return {
    httpStatus: typeof resp?.status === 'number' ? resp.status : undefined,
    grpcCode: typeof envelope?.code === 'number' ? envelope.code : undefined,
    grpcMessage: typeof envelope?.message === 'string' ? envelope.message : undefined,
  };
}

/**
 * @public — true when `err` means "the chain answered: no such entity".
 *
 * Accepts the three shapes a Manifest read can produce:
 *  1. a `ManifestMCPError` from our own reads (structured `code`);
 *  2. a RAW LCD error from a caller's own manifestjs client (grpc envelope) —
 *     deliberate: manifestjs owns transport, we own the semantic, so a consumer
 *     keeps its own LCD client and still classifies correctly (spec Decision 4);
 *  3. a plain RPC `Error` (message text only — RPC offers nothing better).
 *
 * Deliberately NOT keyed on HTTP 404: a proxy/route 404 carries no envelope and
 * must not read as "absent".
 */
export function isNotFoundError(err: unknown): boolean {
  if (err instanceof ManifestMCPError) {
    return err.code === ManifestMCPErrorCode.NOT_FOUND;
  }
  const grpcCode = readGrpcEnvelopeCode(err);
  if (grpcCode !== undefined) return grpcCode === GRPC_NOT_FOUND;
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
  return new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `LCD query "${key}" failed: ${raw}`,
    { ...details },
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internals/classify-query-error.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/internals/classify-query-error.ts packages/core/src/internals/classify-query-error.test.ts packages/core/src/types.ts
git commit -m "feat(core): add NOT_FOUND code + grpc-envelope query-error classifier (ENG-536)"
```

---

## Task 2: Wire the adapter

**Files:**
- Modify: `packages/core/src/lcd-adapter.ts:82-102`
- Test: `packages/core/src/lcd-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/lcd-adapter.test.ts` (it already imports `_adaptModule`; match the existing import style):

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
      lease: vi.fn().mockRejectedValue(
        axiosError(404, { code: 5, message: 'lease not found', details: [] }),
      ),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = _adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({
      code: ManifestMCPErrorCode.NOT_FOUND,
      details: { httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found' },
    });
  });

  it('keeps a proxy 404 as QUERY_FAILED', async () => {
    const lcdMod = {
      lease: vi.fn().mockRejectedValue(
        axiosError(404, { error: 'not_found', message: 'Endpoint not found' }),
      ),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = _adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });
});
```

Ensure `ManifestMCPErrorCode` and `vi` are imported in that file; add to the existing import if missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/lcd-adapter.test.ts -t "ENG-536"`
Expected: FAIL — first test gets `QUERY_FAILED`, not `NOT_FOUND`.

- [ ] **Step 3: Implement**

In `packages/core/src/lcd-adapter.ts`, add to the imports:

```ts
import { classifyLcdError } from './internals/classify-query-error.js';
```

Replace the catch inside `adaptModule` (currently lines 86-92):

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

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/lcd-adapter.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lcd-adapter.ts packages/core/src/lcd-adapter.test.ts
git commit -m "fix(core): classify LCD errors instead of discarding status+body (ENG-536)"
```

---

## Task 3: Retry — NOT_FOUND non-retryable + fix the 5xx regex

**Files:**
- Modify: `packages/core/src/retry.ts`
- Test: `packages/core/src/retry.test.ts`

The adjacent bug: `retry.ts:70`'s `/\b(?:http|status)\s*5\d{2}\b/` never matches axios's `Request failed with status code 500` — the word "code" sits between "status" and "500". So **LCD 5xx is never retried today.** Now that `details.httpStatus` exists, branch on the number.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/retry.test.ts`:

```ts
describe('isRetryableError — structured details (ENG-536)', () => {
  it('never retries NOT_FOUND', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found', {
          httpStatus: 404,
          grpcCode: 5,
        }),
      ),
    ).toBe(false);
  });

  // Pins the bug: this message is axios's real template and the 5xx regex misses it.
  it('retries a 5xx via details.httpStatus even though the message says "status code 500"', () => {
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
      isRetryableError(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'bad request', {
          httpStatus: 400,
        }),
      ),
    ).toBe(false);
  });

  it('still retries 429 via details.httpStatus', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'rate limited', {
          httpStatus: 429,
        }),
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/retry.test.ts -t "ENG-536"`
Expected: FAIL — the 500 case returns `false`.

- [ ] **Step 3: Implement**

In `packages/core/src/retry.ts`, add `NOT_FOUND` to `NON_RETRYABLE_ERROR_CODES` (after the `INVALID_ARGUMENT` entry):

```ts
  // The chain answered "no such entity" — an expected, permanent answer.
  // Retrying cannot change it (ENG-536).
  ManifestMCPErrorCode.NOT_FOUND,
```

Then replace the body of `isRetryableError`'s `ManifestMCPError` branch (currently lines 100-105):

```ts
  if (error instanceof ManifestMCPError) {
    if (NON_RETRYABLE_ERROR_CODES.includes(error.code)) {
      return false;
    }
    // Prefer the structured status when the transport supplied one: axios's
    // message template is "Request failed with status code 500", which the
    // message patterns below CANNOT match (the word "code" sits between
    // "status" and the number) — so LCD 5xx went unretried before ENG-536.
    const httpStatus = error.details?.httpStatus;
    if (typeof httpStatus === 'number') {
      return httpStatus >= 500 || httpStatus === 429;
    }
    // Fall back to message sniffing for the RPC leg, which has no status.
    return isTransientErrorMessage(error.message);
  }
```

Leave `isTransientErrorMessage` itself untouched — it is still the RPC-leg fallback.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/retry.test.ts`
Expected: PASS, including pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -m "fix(core): retry on structured httpStatus; never retry NOT_FOUND (ENG-536)"
```

---

## Task 4: Revive `catchNotFound` in getBalance

**Files:**
- Modify: `packages/core/src/tools/getBalance.ts:6-22`
- Test: `packages/core/src/tools/getBalance.test.ts`

This is the highest-severity user-facing fix: `getBalance` currently throws for **any address with no credit account** — every new user.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/getBalance.test.ts`. **Keep** the existing `RPC_CONNECTION_FAILED` propagation test at :74-90 — it is still correct.

```ts
it('returns credits: null when the chain says the credit account is absent', async () => {
  const client = makeMockQueryClient();
  vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
      httpStatus: 404,
      grpcCode: 5,
      grpcMessage: 'credit account not found',
    }),
  );
  vi.mocked(client.liftedinit.billing.v1.creditEstimate).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'credit account not found', {
      httpStatus: 404,
      grpcCode: 5,
      grpcMessage: 'credit account not found',
    }),
  );

  const result = await getBalance(makeReadCtx({ query: client }), address);
  expect(result.credits).toBeNull();
  expect(result.balances).toBeDefined();
});

it('still throws when the credit read fails for a non-not-found reason', async () => {
  const client = makeMockQueryClient();
  vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'LCD query "creditAccount" failed', {
      httpStatus: 500,
    }),
  );
  await expect(
    getBalance(makeReadCtx({ query: client }), address),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/tools/getBalance.test.ts -t "credit account is absent"`
Expected: FAIL — it throws NOT_FOUND instead of returning `credits: null`.

- [ ] **Step 3: Implement**

In `packages/core/src/tools/getBalance.ts`, replace the whole `catchNotFound` function (lines 6-22) with:

```ts
function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    // Keyed on the structured code, NOT on message text. Pre-ENG-536 this
    // rethrew EVERY ManifestMCPError, and the LCD adapter wraps 404s into
    // exactly that — so this guard was dead code over REST and the regexes
    // below it never ran. Real not-found messages also vary by keeper
    // ("no lease with custom_domain X" contains no "not found" at all).
    if (isNotFoundError(err)) return null;
    throw err;
  });
}
```

Update the imports at the top of the file:

```ts
import type { ReadCtx } from '../ctx.js';
import { isNotFoundError } from '../internals/classify-query-error.js';
import { withReadSignal } from '../internals/read-signal.js';
import type { CallOptions } from '../options.js';
```

`ManifestMCPError` is no longer referenced here — remove it from the import if nothing else in the file uses it (check first; biome will flag an unused import).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/tools/getBalance.test.ts`
Expected: PASS — including the retained `RPC_CONNECTION_FAILED` test (that code is not NOT_FOUND, so it still propagates).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/getBalance.ts packages/core/src/tools/getBalance.test.ts
git commit -m "fix(core): getBalance returns credits: null for an absent credit account (ENG-536)"
```

---

## Task 5: `getLease` + `getWithdrawableAmount` — null + uuid validation (BREAKING)

**Files:**
- Modify: `packages/core/src/tools/reads.ts:87-101,180-191`
- Test: `packages/core/src/tools/reads.test.ts`

Note `assertUuid(value: string, label: string, errorCode?)` is the right primitive — `requireUuid` takes `(input: Record<string, unknown>, field, …)` and does **not** fit a bare-string arg. `assertUuid` lives in `../validation.js` and is not on the barrel; import it directly.

Why validation is required here: the keeper returns `code:5 "lease not found"` for a **malformed** uuid too (probed: `lease/not-a-uuid` → 404 `{"code":5,...}`). Without validating first, `getLease(ctx, 'typo')` would return `null` — giving null two meanings.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/reads.test.ts`:

```ts
const NOT_FOUND_ERR = new ManifestMCPError(
  ManifestMCPErrorCode.NOT_FOUND,
  'lease not found',
  { httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found' },
);
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('getLease not-found (ENG-536)', () => {
  it('returns null when the chain says the lease is absent', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.lease).mockRejectedValue(NOT_FOUND_ERR);
    await expect(
      getLease(makeReadCtx({ query: client }), VALID_UUID),
    ).resolves.toBeNull();
  });

  it('rethrows a transient failure rather than reporting absence', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.lease).mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'boom', { httpStatus: 500 }),
    );
    await expect(
      getLease(makeReadCtx({ query: client }), VALID_UUID),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  // The keeper returns code:5 for a MALFORMED uuid too, so without this guard
  // a typo would silently read as "absent".
  it('rejects a malformed uuid with INVALID_ARGUMENT without issuing a read', async () => {
    const client = makeMockQueryClient();
    await expect(
      getLease(makeReadCtx({ query: client }), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_ARGUMENT });
    expect(client.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
  });
});

describe('getWithdrawableAmount not-found (ENG-536)', () => {
  it('returns null when the lease is absent', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.withdrawableAmount).mockRejectedValue(NOT_FOUND_ERR);
    await expect(
      getWithdrawableAmount(makeReadCtx({ query: client }), VALID_UUID),
    ).resolves.toBeNull();
  });

  it('rejects a malformed uuid with INVALID_ARGUMENT', async () => {
    const client = makeMockQueryClient();
    await expect(
      getWithdrawableAmount(makeReadCtx({ query: client }), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_ARGUMENT });
  });
});
```

If `reads.test.ts` lacks `makeMockQueryClient`/`makeReadCtx` helpers, mirror the ones in `getBalance.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/tools/reads.test.ts -t "ENG-536"`
Expected: FAIL — NOT_FOUND propagates instead of resolving null; malformed uuid throws QUERY_FAILED not INVALID_ARGUMENT.

- [ ] **Step 3: Implement**

In `packages/core/src/tools/reads.ts` add imports:

```ts
import { isNotFoundError } from '../internals/classify-query-error.js';
import { assertUuid } from '../validation.js';
```

Replace `getLease` (lines 87-101):

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

Replace `getWithdrawableAmount` (lines 180-191):

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
      ctx.query.liftedinit.billing.v1
        .withdrawableAmount({ leaseUuid })
        .catch((error: unknown) => {
          if (isNotFoundError(error)) return null;
          throw error;
        }),
    opts,
  );
  return r === null ? null : r.amounts;
}
```

Keep the existing `r.lease ? … : null` guard in `getLease` — its comment explains it backs a mock-driven test.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/tools/reads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/reads.ts packages/core/src/tools/reads.test.ts
git commit -F - <<'EOF'
feat(core)!: getLease/getWithdrawableAmount return null on absence (ENG-536)

Also validate the lease uuid up-front: the keeper answers code:5
"lease not found" for a MALFORMED uuid too, so without this a typo would
silently render as null — making null mean both "absent" and "you sent
garbage".

BREAKING CHANGE: getWithdrawableAmount now returns `Coin[] | null` instead
of `Coin[]`. getLease's signature is unchanged (already `| null`) but its
null branch is now actually reachable over LCD. A malformed lease uuid now
throws INVALID_ARGUMENT instead of QUERY_FAILED.
EOF
```

Run `npm run lint` before this commit as well — `getWithdrawableAmount`'s nullability is a type-level break and may ripple into consumer packages.

---

## Task 6: `getLeaseByCustomDomain` → `| null` (BREAKING)

**Files:**
- Modify: `packages/core/src/tools/reads.ts:103-125`
- Modify: `packages/lease/src/index.ts:469`
- Test: `packages/core/src/tools/reads.test.ts`

**This is the breaking change.** TypeScript flags every call site, so it is loud. Barney's own `queryLeaseByCustomDomain` is already `Promise<… | null>`, so this aligns us to the consumer's shipped contract.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/reads.test.ts`:

```ts
describe('getLeaseByCustomDomain not-found (ENG-536)', () => {
  it('returns null for an unclaimed FQDN', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.NOT_FOUND,
        'no lease with custom_domain app.example.com',
        { httpStatus: 404, grpcCode: 5, grpcMessage: 'no lease with custom_domain app.example.com' },
      ),
    );
    await expect(
      getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com'),
    ).resolves.toBeNull();
  });

  it('rethrows a transient failure', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain).mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'boom', { httpStatus: 503 }),
    );
    await expect(
      getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com'),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/tools/reads.test.ts -t "unclaimed FQDN"`
Expected: FAIL — it rejects instead of resolving null.

- [ ] **Step 3: Implement the core change**

Replace `getLeaseByCustomDomain` (lines 103-125):

```ts
/**
 * Reverse-look up the lease holding `customDomain`.
 *
 * Returns `null` when no lease claims the FQDN — an EXPECTED outcome (this is
 * the conflict-check every domain claim runs). A transport/decode failure still
 * throws, so `null` unambiguously means "unclaimed" (ENG-536).
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

- [ ] **Step 4: Fix the lease-server call site**

`packages/lease/src/index.ts:469` currently destructures the result and will not compile:

```ts
        const { lease, serviceName } = await getLeaseByCustomDomain(
          ctx,
          customDomain,
        );
        return jsonResponse(
          { lease, service_name: serviceName },
          bigIntReplacer,
        );
```

Replace with:

```ts
        const found = await getLeaseByCustomDomain(ctx, customDomain);
        if (found === null) {
          // The tool contract THROWS on an unclaimed FQDN (callers expect a
          // structured error, not an empty result). Pre-ENG-536 this surfaced
          // as an opaque QUERY_FAILED; NOT_FOUND finally delivers the
          // "you sent garbage" vs "the chain answered no-such-thing"
          // distinction this handler's own comment promises.
          throw new ManifestMCPError(
            ManifestMCPErrorCode.NOT_FOUND,
            `lease_by_custom_domain: no lease has claimed "${customDomain}".`,
            { customDomain },
          );
        }
        return jsonResponse(
          { lease: found.lease, service_name: found.serviceName },
          bigIntReplacer,
        );
```

Also update the stale comment above the call (lines 459-463) — it claims the QUERY_FAILED wrap for the keeper's NotFound "now lives inside the core fn", which is no longer true:

```ts
        // getLeaseByCustomDomain acquires its own rate-limit token via
        // withReadSignal, so we do NOT pre-acquire here — that would
        // double-consume on the same logical read. The core fn returns null
        // for an unclaimed FQDN (ENG-536); this tool re-raises it as NOT_FOUND
        // to keep its throw-on-absence contract.
```

Verify `ManifestMCPErrorCode` is imported in `packages/lease/src/index.ts` (it is — used at :455).

- [ ] **Step 5: Run tests + full lint**

```bash
npx vitest run packages/core/src/tools/reads.test.ts
npx vitest run packages/lease
npm run lint
```

Expected: all PASS. **The full-repo lint is mandatory here, not the per-package one** — nullability ripples into consumer packages, and vitest passes while tsc fails because types erase at runtime.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/reads.ts packages/core/src/tools/reads.test.ts packages/lease/src/index.ts
git commit -m "feat(core)!: getLeaseByCustomDomain returns null for an unclaimed FQDN (ENG-536)

BREAKING CHANGE: getLeaseByCustomDomain now returns
\`{lease, serviceName} | null\` instead of throwing on an unclaimed FQDN.
Callers must handle null. The lease MCP tool keeps its throw contract,
now raising NOT_FOUND instead of an opaque QUERY_FAILED."
```

---

## Task 7: agent-core — re-key `isNotFoundError`

**Files:**
- Modify: `packages/agent-core/src/manage-domain.ts:83-87,465-473`
- Test: `packages/agent-core/src/manage-domain.test.ts`

agent-core calls `queryClient.liftedinit.billing.v1.leaseByCustomDomain` **directly** (:404), so Task 6's signature change does not reach it — but its regexes are broken on the real chain in **both** directions:

```
"no lease with custom_domain …"  -> NOT_FOUND_RES: false   ← real not-found, MISSED
"Endpoint not found"             -> NOT_FOUND_RES: true    ← proxy 404, FALSE POSITIVE
```

- [ ] **Step 1: Write the failing test**

Add to `packages/agent-core/src/manage-domain.test.ts` (mirror the existing lookup-test setup):

```ts
it('returns lease: null for a chain NOT_FOUND on an unclaimed FQDN', async () => {
  // Real keeper message — contains NO "not found" text, so the old regex missed it.
  queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
    new ManifestMCPError(
      ManifestMCPErrorCode.NOT_FOUND,
      'no lease with custom_domain app.example.com',
      { httpStatus: 404, grpcCode: 5 },
    ),
  );
  const result = await manageDomain(/* ...lookup args... */);
  expect(result).toMatchObject({ action: 'lookup', lease: null });
});

it('THROWS for a proxy 404 whose message merely contains "not found"', async () => {
  // Guards the false positive: a node that doesn't serve billing must NOT read
  // as "FQDN unclaimed".
  queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Endpoint not found', {
      httpStatus: 404,
    }),
  );
  await expect(manageDomain(/* ...lookup args... */)).rejects.toThrow();
});
```

Fill the `manageDomain` args from the neighbouring lookup tests in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts -t "unclaimed FQDN"`
Expected: FAIL — the NOT_FOUND case throws (old guard rethrows every `ManifestMCPError`).

- [ ] **Step 3: Implement**

In `packages/agent-core/src/manage-domain.ts`:

Delete the `NOT_FOUND_RES` constant (lines 83-87) entirely.

Replace `isNotFoundError` (lines 465-473) with a re-export of core's predicate. Add to the imports:

```ts
import { isNotFoundError } from '@manifest-network/manifest-mcp-core';
```

…and delete the local function. The call site at :429 (`if (isNotFoundError(err))`) is unchanged.

If a name clash arises with the local symbol, delete the local one — core's is strictly more correct (it accepts the raw LCD shape too and never false-positives on message text).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/agent-core/src/manage-domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/manage-domain.ts packages/agent-core/src/manage-domain.test.ts
git commit -m "fix(agent-core): key domain lookup on NOT_FOUND, not message regexes (ENG-536)"
```

---

## Task 8: tier-2 `cosmosQuery` RPC leg

**Files:**
- Modify: `packages/core/src/cosmos.ts:147-151`
- Test: `packages/core/src/cosmos.test.ts`

**The LCD leg needs no change** — `cosmosQuery`'s catch at :137-145 already re-wraps preserving `error.code`, so an adapter-minted NOT_FOUND propagates with `{module, subcommand}` merged in for free. Only the plain-`Error` branch (the RPC leg) needs classifying.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/cosmos.test.ts`:

```ts
it('surfaces an RPC NotFound as NOT_FOUND, not QUERY_FAILED (ENG-536)', async () => {
  // cosmjs/gRPC gives only message text on this transport.
  mockHandler.mockRejectedValue(
    new Error('rpc error: code = NotFound desc = lease not found'),
  );
  await expect(
    cosmosQuery(clientManager, 'liftedinit.billing', 'lease', ['some-uuid']),
  ).rejects.toMatchObject({ code: ManifestMCPErrorCode.NOT_FOUND });
});

it('preserves an adapter-minted NOT_FOUND through the LCD leg with attribution', async () => {
  mockHandler.mockRejectedValue(
    new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found', {
      httpStatus: 404,
      grpcCode: 5,
    }),
  );
  await expect(
    cosmosQuery(clientManager, 'liftedinit.billing', 'lease', ['some-uuid']),
  ).rejects.toMatchObject({
    code: ManifestMCPErrorCode.NOT_FOUND,
    details: { module: 'liftedinit.billing', subcommand: 'lease', grpcCode: 5 },
  });
});
```

Adapt `mockHandler`/`clientManager` to the file's existing harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/cosmos.test.ts -t "ENG-536"`
Expected: FAIL on the first (gets QUERY_FAILED). The second should already PASS — it documents the free behaviour; keep it as a guard.

- [ ] **Step 3: Implement**

In `packages/core/src/cosmos.ts` add the import:

```ts
import { isNotFoundError } from './internals/classify-query-error.js';
```

Replace the trailing throw of `cosmosQuery`'s catch (lines 147-151):

```ts
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand },
        );
```

with:

```ts
        // The RPC leg throws plain Errors — classify so the generic query path
        // yields NOT_FOUND on BOTH transports (the LCD leg already arrives as a
        // structured ManifestMCPError and is preserved above). ENG-536.
        throw new ManifestMCPError(
          isNotFoundError(error)
            ? ManifestMCPErrorCode.NOT_FOUND
            : ManifestMCPErrorCode.QUERY_FAILED,
          `Query ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
          { module, subcommand },
        );
```

Do **not** touch `loadBuildContext` (:38-75) — that is the tx-build path and out of scope.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/cosmos.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cosmos.ts packages/core/src/cosmos.test.ts
git commit -m "fix(core): classify RPC NotFound on the tier-2 query path (ENG-536)"
```

---

## Task 9: Publish the primitive (core barrel + SDK)

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/sdk/src/reads.ts`
- Test: `packages/sdk/src/index.test.ts`

`isNotFoundError` is the public face of this work (spec Decision 4) — it lets a consumer keep manifestjs as its transport and still classify correctly. It must be reachable from the SDK or that story doesn't ship.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/index.test.ts` pins the exported surface via sorted name lists. Add `'isNotFoundError'` to the relevant expected-export array(s) — read the file first and match its existing shape rather than guessing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/sdk/src/index.test.ts`
Expected: FAIL — `isNotFoundError` missing from the actual exports.

- [ ] **Step 3: Implement**

In `packages/core/src/index.ts`, add near the other internals-sourced exports (keep biome's import/export sorting happy):

```ts
export {
  isNotFoundError,
  type QueryErrorDetails,
} from './internals/classify-query-error.js';
```

In `packages/sdk/src/reads.ts`, add `isNotFoundError` to the existing re-export block from `@manifest-network/manifest-mcp-core` (alphabetical: it sorts after `getWithdrawableAmount`).

The SDK root barrel re-exports `./reads` already — confirm `isNotFoundError` surfaces on the root; if the root uses `export type *`, a **value** export needs an explicit `export {}` entry. Check and add if needed.

- [ ] **Step 4: Run the tests + build**

```bash
npx vitest run packages/sdk
npm run build
npm run check
```

Expected: PASS. `npm run build` also runs `publint` + `@arethetypeswrong/core` over the SDK surface.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/sdk/src/reads.ts packages/sdk/src/index.test.ts
git commit -m "feat(core,sdk): export isNotFoundError as a public primitive (ENG-536)"
```

---

## Task 10: E2E — pin the real chain contract

**Files:**
- Modify: `e2e/rest-mode.e2e.test.ts`

Converts the one-off probe into a standing guard, over the LCD transport where the bug lived.

> **Note:** local `npm run test:e2e` is blocked on this machine (docker cannot publish devnet ports — missing `xt_nat`). Verify via CI: `gh workflow run e2e.yml --ref worktree-eng-lcd-notfound-discriminator`.

- [ ] **Step 1: Write the tests**

Add to `e2e/rest-mode.e2e.test.ts`, matching its existing client-construction helpers:

```ts
describe('not-found contract over LCD (ENG-536)', () => {
  const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

  it('getLease returns null for a lease that does not exist', async () => {
    await expect(getLease(ctx, ABSENT_UUID)).resolves.toBeNull();
  });

  it('getLeaseByCustomDomain returns null for an unclaimed FQDN', async () => {
    await expect(
      getLeaseByCustomDomain(ctx, 'definitely-unclaimed-xyz.example.com'),
    ).resolves.toBeNull();
  });

  it('getBalance returns credits: null for an address with no credit account', async () => {
    const result = await getBalance(ctx, FRESH_ADDRESS_WITH_NO_CREDIT);
    expect(result.credits).toBeNull();
  });

  // Collection reads 200-with-empty — they must NOT be swept into the fix.
  it('getLeasesByTenant returns an empty list, not a throw, for a tenant with no leases', async () => {
    const result = await getLeasesByTenant(ctx, {
      tenant: FRESH_ADDRESS_WITH_NO_CREDIT,
      stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
    });
    expect(result.leases).toEqual([]);
  });
});
```

Use a freshly generated address for `FRESH_ADDRESS_WITH_NO_CREDIT` (the e2e helpers already generate keys) so it is guaranteed to have no credit account.

- [ ] **Step 2: Run in CI**

```bash
git add e2e/rest-mode.e2e.test.ts
git commit -m "test(e2e): pin the LCD not-found contract per endpoint (ENG-536)"
git push -u origin worktree-eng-lcd-notfound-discriminator
gh workflow run e2e.yml --ref worktree-eng-lcd-notfound-discriminator
```

Expected: green. Watch with `gh run watch`.

---

## Task 11: Changelog + final gate

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the entry**

Under `[Unreleased]`, matching the file's existing section style:

```markdown
### Fixed

- **core:** the LCD/REST adapter discarded the not-found signal, so every declared `| null` read threw instead of returning null over REST. `getBalance` threw for any address with no credit account (every new user); `getLease`'s `BrandedLease | null` could never return null; agent-core's domain lookup could not report an unclaimed FQDN. LCD errors are now classified from the grpc-gateway envelope (`code: 5` → `NOT_FOUND`) and carry `details: {httpStatus, grpcCode, grpcMessage}`. Classification keys on the grpc code, never HTTP 404 — a proxy/route 404 from a node that doesn't serve the module still throws. (ENG-536)
- **core:** `isRetryableError` now branches on `details.httpStatus`. LCD 5xx failures were never retried, because axios's `Request failed with status code 500` does not match the 5xx message pattern. (ENG-536)

### Added

- **core, sdk:** `isNotFoundError(err)` — a public predicate that accepts a `ManifestMCPError`, a **raw LCD/axios error from your own manifestjs client**, or a plain RPC `Error`. Lets a consumer keep manifestjs as its transport and still classify not-found correctly. (ENG-536)
- **core:** `ManifestMCPErrorCode.NOT_FOUND` + the `QueryErrorDetails` type. (ENG-536)

### Changed

- **core:** BREAKING — `getLeaseByCustomDomain` returns `{lease, serviceName} | null` instead of throwing for an unclaimed FQDN. Callers must handle `null`. The `lease_by_custom_domain` MCP tool keeps its throw contract, now raising `NOT_FOUND` rather than an opaque `QUERY_FAILED`. (ENG-536)
- **core:** BREAKING — `getWithdrawableAmount` returns `Coin[] | null`. (ENG-536)
- **core:** `getLease` / `getWithdrawableAmount` now validate the lease uuid up-front, throwing `INVALID_ARGUMENT` for a malformed value (previously `QUERY_FAILED`). Required because the keeper answers `code:5 "lease not found"` for a malformed uuid too, which would otherwise render as `null`. (ENG-536)
```

- [ ] **Step 2: Run the full gate**

```bash
npm run build
npm run lint
npm run test
npm run check
```

All four must pass. `npm run lint` is the **full-repo** tsc — do not substitute a per-package lint.

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
- [ ] `isNotFoundError` is exported from core + SDK and passes on a **raw axios error**.
- [ ] LCD 5xx is retried; NOT_FOUND never is.
- [ ] Full gate green: `npm run build`, `npm run lint`, `npm run test`, `npm run check`.
- [ ] E2E green in CI.

## Release note

`getLeaseByCustomDomain` and `getWithdrawableAmount` are type-level breaking → **0.19.0**. Do the version bump via `scripts/version.mjs` (never hand-edit `package-lock.json`), as a separate user-driven release step after this lands.
