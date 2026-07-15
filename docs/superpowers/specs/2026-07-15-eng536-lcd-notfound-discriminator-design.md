# ENG-536 — LCD adapter discards the not-found signal

**Date:** 2026-07-15
**Issue:** [ENG-536](https://linear.app/liftedinit/issue/ENG-536/lcd-adapter-discards-the-not-found-signal-getbalancegetlease-throw)
**Verified against:** `origin/main` @ `ff976d7` (v0.18.0 release commit); live chain `https://api.manifest.network`; `manifest-network/barney` @ main.

## Summary

`lcd-adapter.ts` collapses every LCD read failure into `ManifestMCPError(QUERY_FAILED, …)`, interpolating only axios's `.message` and discarding `response.status` and `response.data`. The repo **already implements** the cosmjs `T | null` not-found idiom, but over LCD/REST those null branches are unreachable, so the read surface lies.

**This is a repair, not a redesign.** We are not adopting a new contract; we are making an existing one honest.

## The problem

### The idiom is already here — and already broken

| surface | declared contract | actual behaviour over LCD |
| --- | --- | --- |
| `getLease` (`tools/reads.ts:87`) | `Promise<BrandedLease \| null>` | throws; `null` unreachable |
| `getBalance` (`tools/getBalance.ts:24`) | `credits: {…} \| null` | throws |
| `manageDomain` lookup (agent-core) | `{ lease: null }` on unclaimed | throws |

Both guards dead-end on a `ManifestMCPError`, though by different routes — the adapter has already wrapped the 404 into exactly that, so **the regexes below them never execute**. They can only fire over RPC, where cosmjs throws a plain `Error`.

- `catchNotFound` (`tools/getBalance.ts:9`) opens with `if (err instanceof ManifestMCPError) throw err;` — comment: *"never suppress structured infrastructure errors."*
- agent-core's `isNotFoundError` (`manage-domain.ts:469`) opens with `if (err instanceof ManifestMCPError) return false;` — the rethrow lands 24 lines later at `:444`.

(An earlier revision of this spec presented a single fenced quote as if both sites shared it. They do not; only `getBalance.ts` rethrows inline. The conclusion is unaffected — the `T | null` branch is dead code either way — but the misquote is corrected here because Task 7 sends an implementer to read exactly that line range.)

### Proof — real read path, live chain

```
── getLease(<nonexistent uuid>)          declared: BrandedLease | null
   ACTUAL: THREW ManifestMCPError code=QUERY_FAILED
           LCD query "lease" failed: Request failed with status code 404
           details: (none)

── getBalance(<addr with no credit account>)
   ACTUAL: THREW ManifestMCPError code=QUERY_FAILED
           LCD query "creditAccount" failed: Request failed with status code 404
           details: (none)

── getLeaseByCustomDomain(<unclaimed fqdn>)
   ACTUAL: THREW ManifestMCPError code=QUERY_FAILED
           LCD query "leaseByCustomDomain" failed: Request failed with status code 404
           details: (none)
```

`getBalance` is a **shipped public SDK read** (`/reads`) and throws for any address with no credit account — every new user. That is the highest-severity item and is independent of Barney.

### Why the tests didn't catch it

`getBalance.test.ts:74-90` pins "propagate `ManifestMCPError` instead of suppressing as not-found" using `RPC_CONNECTION_FAILED` — a case that *should* rethrow. Nothing mocks the **real LCD error shape** (an axios error carrying `response.status`/`response.data`), so no test ever exercises the path where a 404 arrives pre-wrapped. The guard passes because of the bug, not despite it.

This is the regression-guard inversion pattern: a heavily-mocked path where the mock is more forgiving than reality.

## Blast radius (probed, not inferred)

Singular-entity reads 404 with a grpc-gateway envelope; collection reads return 200-with-empty (standard Cosmos keeper convention — the same reason bank's `allBalances` needs no not-found handling). Scope is exactly five reads.

**Affected:**

| LCD path | SDK read | response |
| --- | --- | --- |
| `lease/{uuid}` | `getLease` | 404 `{"code":5,"message":"lease not found"}` |
| `lease/by-domain/{fqdn}` | `getLeaseByCustomDomain` | 404 `{"code":5,"message":"no lease with custom_domain …"}` |
| `credit/{tenant}` | `getBalance` | 404 `{"code":5,"message":"credit account not found"}` |
| `credit/{tenant}/estimate` | `getBalance` | 404 `{"code":5,"message":"credit account not found"}` |
| `lease/{uuid}/withdrawable` | `getWithdrawableAmount` | 404 `{"code":5,"message":"lease not found"}` |

**Unaffected (200):** `leases/tenant` → `{"leases":[]}`, `credit-address`, `params`.

## Design

### Decision 1 — classify on the gRPC code, never on HTTP status or message

`code === 5` is the discriminator. HTTP 404 is necessary but **not sufficient**.

**Counterexample, real and reproducible:** `https://nodes.chandrastation.com/api/manifest/` — the endpoint in our own `packages/node/.env.example` — does not serve the billing module:

```
HTTP 404  {"error":"not_found","message":"Endpoint not found"}
```

A proxy/route 404 with no grpc envelope. Classifying on status would reconcile every RUNNING app to stopped against a misconfigured or version-skewed endpoint. Barney's current fallback (`src/api/queryClient.ts`, `e.response?.status === 404`) has exactly this bug, so our classification is strictly safer than the status check it replaces.

Message matching is worse than useless — on the real chain it fails in **both** directions:

```
"no lease with custom_domain …"  -> isNotFoundError: false   ← real not-found, MISSED
"Endpoint not found"             -> isNotFoundError: true    ← proxy 404, FALSE POSITIVE
```

agent-core's `NOT_FOUND_RES` only appears to work over RPC because the gRPC status name "NotFound" happens to appear in the wrapped message and matches `/not.?found/i`.

### Decision 2 — `Promise<T | null>` is the public surface; the error code is plumbing

The idiom is ecosystem-relative, so it is settled by the library we wrap. CosmJS — forked as `@manifest-network/stargate` — makes `getAccount(): Promise<Account | null>` the contract and hides detection:

```ts
public async getAccount(searchAddress: string): Promise<Account | null> {
  try {
    const account = await this.forceGetQueryClient().auth.account(searchAddress);
    return account ? this.accountParser(account) : null;
  } catch (error) {
    if (/rpc error: code = NotFound/i.test(error.toString())) return null;
    throw error;
  }
}
```

Two lessons. First, the split is by **whether absence is expected**, not by transport or severity: `getAccount` returns null, `getSequence` throws, `getBalance` doesn't handle it at all. Second, cosmjs string-matches *as a concession* — RPC offers nothing better. We have the structured grpc code over LCD and can classify strictly better while presenting the same surface.

Exposing `httpStatus` as the consumer-facing discriminator was **rejected**: it leaks the transport (RPC has no HTTP status — the field would be silently `undefined` and a consumer's branch would never fire) and makes every consumer re-derive a conclusion we are better positioned to draw.

### Decision 3 — `NOT_FOUND` is public, but as an escape hatch

Typed reads return null, so most consumers never touch the error. `NOT_FOUND` is still exported because:

- Tier-2 `cosmosQuery` (SDK `/chain`) has no typed shape to nullify.
- `retry.ts` must classify it as permanently non-retryable.
- It matches the established convention: `SKU_AMBIGUOUS` sets the precedent that a distinct semantic outcome gets a distinct code plus typed `details`.

### Decision 4 — one client; the SDK is sufficient, not exhaustive

**The separation of concerns this design commits to:**

> **The SDK is the foundation. Foundation means _sufficient, not exhaustive_ — a consumer never needs to reach around it.** Everything is reachable through **one** client. What the SDK *adds* — branding, ctx composition (rate limiting, abort, retry), not-found semantics, multi-call orchestration, transport lifecycle — it owns. What manifestjs already defines (the wire API) it **carries** rather than copies.

`client.query` is that seam and **already exists**: `ManifestReadClient extends QueryCtx` (`client-factory.ts:192`), `QueryCtx.query` is `@public` (`ctx.ts:59-63`), and `client-factory.ts:188-191` already documents it as an "honest Telescope/cosmjs drop-down". Proved live: `client.query.liftedinit.billing.v1.creditAddress({tenant})` and `client.query.cosmos.bank.v1beta1.balance({address, denom})` both work, `snakeToCamelDeep` + `fromJSON`-converted. It is mentioned **zero times** in `packages/sdk/README.md` and `docs/library-usage.md` — which is why the reference consumer built a parallel LCD client. **The defect is docs, not surface** (ENG-537).

This is the mainstream shape, not an invention: of 9 SDKs surveyed, **7 expose a same-instance escape hatch** (`viem.request`, `ethers.send()`, Prisma `$queryRaw`, `octokit.request`, Stripe `rawRequest`, Supabase `rpc()`, Apollo `link`/`cache`); the 2 that split the object (AWS SDK v3, cosmjs) still share the transport. **Zero expect a second, independently-constructed client.** (Note: cosmjs's `forceGetQueryClient()` is `protected` — it is *not* a consumer escape hatch, and an earlier draft of this spec wrongly cited it as our precedent.)

So a passthrough read is served by `client.query.<ns>.<method>()` — same client, our transport, our lifecycle, our error semantics. `creditAddress` (1:1, 200-always) and single-denom `bank.balance` (1:1, cosmos-standard) get **no wrapper**: wrapping them would reinvent manifestjs, and they need no wrapper to be reachable. Two consequences worth stating plainly:

- **Coverage is complete for real consumers.** Only `cosmos.orm.query.v1alpha1` and `liftedinit.manifest.v1` are `unsupportedModule` proxies (throwing on property *access*). The former is ORM introspection; the latter **exposes no queries at all** (its generated `Query` service is an empty stub). Neither has an app-facing read.
- **Migrating to `client.query` deletes consumer code, not just duplicates it.** Barney's `lcdConvert` uses `fromAmino`, which yields `state = "LEASE_STATE_ACTIVE"` (a *string*, violating the declared `Lease.state: LeaseState`); our adapter's `fromJSON` yields `state = 2`. Barney's `fixEnumField`/`fixLeaseEnums` exists solely to patch that — and its own `readClient.ts` already credits the SDK path as "the reason `fixSKUEnums` is deletable".

**Honest caveat:** `client.query` bypasses the token-bucket rate limiter — only typed reads acquire tokens via `withReadSignal`. Moving a passthrough from a consumer's own client to `client.query` therefore recovers no rate budget (it recovers correctness, one lifecycle, and deleted conversion code). Only moving to a *typed* read recovers budget. Document this rather than implying otherwise.

**Consequence for this design:** the genuine SDK concern here is the *classification semantic*, not per-endpoint wrappers. `isNotFoundError` is exported as a public primitive; it also accepts a raw LCD (axios) error, which keeps the predicate total over "errors from a Manifest chain read" for anyone using manifestjs without our read client. That branch is defence-in-depth, **not** an endorsement of a second client — the recommended path is `client.query`.

### Components

**`internals/classify-query-error.ts` (new, core)** — the single classifier.

```ts
/** gRPC status code for NOT_FOUND (grpc-gateway maps this to HTTP 404). */
const GRPC_NOT_FOUND = 5;

/** `details` carried by transport read errors. Fields absent when the transport can't supply them. */
export interface QueryErrorDetails {
  readonly httpStatus?: number;    // LCD only; RPC has no HTTP layer
  readonly grpcCode?: number;      // from the grpc-gateway envelope; absent for a proxy 404
  readonly grpcMessage?: string;   // keeper text, e.g. "lease not found"
}
```

`classifyLcdError(key, error)` duck-types `error.response.status` / `.data` (no axios type dependency — axios arrives transitively via `@cosmology/lcd`), treats the body as an envelope **only** when `typeof body.code === 'number'`, and returns `NOT_FOUND` when `grpcCode === 5`, else `QUERY_FAILED`. `details` is attached to **both** — preserving status on non-404s is what lets `retry.ts` branch on a number instead of a string.

`isNotFoundError(err)` — **the public primitive** (Decision 4). Accepts all three error shapes a Manifest read can produce, so a consumer using manifestjs as its own transport can borrow the semantic without importing a wrapper per endpoint:

```ts
/**
 * @public — true when `err` means "the chain answered: no such entity".
 *
 * Accepts three shapes:
 *  1. a `ManifestMCPError` from our own reads (structured `code`);
 *  2. a RAW LCD error from a caller's own manifestjs client (grpc-gateway envelope);
 *  3. a plain RPC `Error` (message text only — see below).
 *
 * Shape 2 is defence-in-depth, so the predicate is TOTAL over "errors from a Manifest
 * chain read". It is NOT an endorsement of a second client: the recommended path is
 * `client.query` (Decision 4), whose errors arrive as shape 1.
 *
 * Deliberately NOT keyed on HTTP 404 — a proxy/route 404 carries no grpc envelope
 * and must NOT read as "absent" (see Decision 1).
 */
export function isNotFoundError(err: unknown): boolean {
  // NO `instanceof` (ENG-462): ManifestMCPError carries no brand, so `instanceof`
  // is false across duplicate package copies — silently reproducing the exact
  // pre-ENG-536 symptom, uncatchable by tests (vitest loads one copy). Value-check
  // `.code`, as isSkuAmbiguousError does (cosmjs isDeliverTxFailure idiom).
  // Safe against the AxiosError `.code` landmine: axios's own codes are
  // 'ERR_BAD_REQUEST'/'ERR_NETWORK', never 'NOT_FOUND'.
  if (typeof err === 'object' && err !== null) {
    if ((err as { code?: unknown }).code === ManifestMCPErrorCode.NOT_FOUND) return true;
    const grpcCode = readGrpcEnvelopeCode(err); // duck-typed err.response.data.code
    if (grpcCode !== undefined) return grpcCode === GRPC_NOT_FOUND;
  }
  // RPC leg: cosmjs/gRPC surfaces NotFound only as message text. Same concession
  // cosmjs makes in StargateClient.getAccount — no structured code exists over RPC.
  if (err instanceof Error) return /rpc error: code = NotFound/i.test(err.message);
  return false;
}
```

Exported from core's barrel (browser-safe, no node builtins) and re-exported on the **SDK root**, beside `isSkuAmbiguousError` — the root docstring already carves out this symbol class (*"NO free fns EXCEPT error-vocabulary helpers over ManifestMCPError"*). **Not** on `/reads`, which is pinned to exactly the 8 reads (`sdk/src/index.test.ts:186-188`) and is architecturally backwards for it: post-fix, `/reads` consumers get `T | null` and never touch the predicate — it serves `/chain` and raw-manifestjs consumers.

**Edits:**

- `types.ts` — add `ManifestMCPErrorCode.NOT_FOUND` under "Query errors"; export `QueryErrorDetails`.
- `lcd-adapter.ts:82-102` — `adaptModule`'s catch calls `classifyLcdError`. The `if (error instanceof ManifestMCPError) throw error` passthrough stays.
- `retry.ts` — add `NOT_FOUND` to `NON_RETRYABLE_ERROR_CODES`; rewrite the 5xx check to prefer `details.httpStatus >= 500`, keeping the string patterns as the RPC-leg fallback.
- `tools/getBalance.ts` — `catchNotFound` delegates to `isNotFoundError`; delete its three regexes.
- `tools/reads.ts` — `getLease` and `getWithdrawableAmount` catch not-found → null (`getWithdrawableAmount` goes `Coin[]` → `Coin[] | null`, **also breaking**); `getLeaseByCustomDomain` → `| null`; **add `assertUuid`** in front of `getLease` / `getWithdrawableAmount` (see invariant 4). Note the primitive is `assertUuid(value, label, errorCode)` from `../validation.js` — **not** `requireUuid`, whose signature is `(input: Record<string, unknown>, field, errorCode)` and does not fit a bare-string argument.
- `agent-core/manage-domain.ts` — `isNotFoundError` re-keys onto core's predicate; delete `NOT_FOUND_RES`.
- `cosmos.ts` `cosmosQuery` (catch at :136-152) — **the LCD leg needs no change**: the `error instanceof ManifestMCPError` branch already re-wraps preserving `error.code`, so an adapter-minted `NOT_FOUND` propagates with `{module, subcommand}` merged in for free. Only the plain-`Error` branch (:147, the RPC leg) needs the predicate so the generic path yields `NOT_FOUND` on **both** transports. (Note `loadBuildContext` at :38-75 is the **tx**-build path and is out of scope.)

### Data flow

```
OUR reads (LCD)   404 {"code":5} ──> adaptModule ──> classifyLcdError ──> NOT_FOUND + details ─┐
OUR reads (RPC)   "rpc error: code = NotFound" ──> plain Error ────────────────────────────────┤
CONSUMER's own manifestjs client ──> raw axios err {response:{data:{code:5}}} ─────────────────┤
                                                                                              v
                                                                                   isNotFoundError(err)
                                                                                              │
                        ┌──────────────────────┬────────────────────┬──────────────────────┬──┘
                        v                      v                    v                      v
             catchNotFound →           getLease → null      cosmos.ts →        consumer maps its OWN
             credits: null                                  NOT_FOUND          manifestjs call → null
```

The third input row is defence-in-depth, not the recommended path: a consumer using `client.query` (Decision 4) produces row 1, since the adapter has already classified. It exists so the predicate stays total for anyone holding a manifestjs client without our read client.

A proxy 404 (no envelope) yields `QUERY_FAILED` and **throws** — the fail-safe direction: an app stays RUNNING rather than being wrongly reconciled to stopped.

### Error handling invariants

1. **Only `grpcCode === 5` is not-found.** No envelope, no classification.
2. **Non-404s keep `QUERY_FAILED`** but now carry `details`.
3. **`NOT_FOUND` is never retried.**
4. **`getLease` must gain client-side uuid validation.** The keeper returns `code:5` `"lease not found"` for a *malformed* uuid too (probed: `lease/not-a-uuid` → 404 `{"code":5,"message":"lease not found"}`), so the code cannot separate garbage input from absence.

   Core's `getLease` does **not** validate today — `requireUuid` is called only in fred's `deployManifest`. Without adding it, this change would make `getLease(ctx, 'typo')` return `null`, silently reporting "absent" for malformed input and giving `null` two meanings. So we **add** `requireUuid` in front of the read, converting malformed input to `INVALID_ARGUMENT` (already non-retryable) before the call.

   This is a deliberate scope addition, not a preservation. It is a behaviour change — a malformed uuid currently throws `QUERY_FAILED` and will now throw `INVALID_ARGUMENT` — and it matches the established convention that `parseX()` validates at trust boundaries (ENG-446 M2). It is what makes `null` unambiguously mean "absent".
5. **Collection reads are untouched.** They 200-with-empty.

## Testing

The bug survived because mocks were more forgiving than reality. Tests must therefore assert against the **real wire shape**, captured from the live chain.

- **Unit — `classify-query-error.test.ts`:** table-driven over captured shapes — grpc envelope 404 `code:5` → NOT_FOUND; proxy 404 `{"error":"not_found"}` → QUERY_FAILED (**the regression guard for the false-positive**); 500 → QUERY_FAILED + `httpStatus: 500`; non-object body; missing `response`.
- **Unit — `isNotFoundError` (the public primitive, Decision 4):** must be proven on **all three** shapes, since the contract promises all three — a `ManifestMCPError(NOT_FOUND)`; a **raw axios-shaped error** `{response:{status:404,data:{code:5,message:'lease not found'}}}` (the consumer-with-own-manifestjs case — if this regresses, the "don't reinvent manifestjs" story silently dies); a plain RPC `Error('rpc error: code = NotFound …')`. Negatives: raw axios proxy 404 `{response:{status:404,data:{error:'not_found'}}}` → **false**; `ManifestMCPError(QUERY_FAILED)` → false; `undefined`/`null`/string → false.
- **Unit — `lcd-adapter.test.ts`:** `adaptModule` mocks reject with an **axios-shaped** error (`{response: {status, data}}`), not a bare `Error`. This is the shape no existing test uses.
- **Unit — `getBalance.test.ts`:** keep the `RPC_CONNECTION_FAILED` rethrow test (still correct); **add** a sibling asserting a `NOT_FOUND` from `creditAccount` yields `credits: null` rather than throwing.
- **Unit — `reads.test.ts`:** `getLease` / `getWithdrawableAmount` → null on NOT_FOUND, rethrow on QUERY_FAILED; `getLeaseByCustomDomain` → null; a **malformed uuid throws `INVALID_ARGUMENT` without issuing a read** (guards invariant 4 — otherwise the keeper's `code:5` would silently render it as `null`).
- **Unit — `retry.test.ts`:** `NOT_FOUND` non-retryable; `details.httpStatus: 500` retryable (pins the `status code 500` bug).
- **Unit — agent-core:** `manageDomain` lookup returns `{lease: null}` for a NOT_FOUND; **still throws for a proxy 404** whose message contains "Endpoint not found" — the false-positive guard.
- **E2E — `rest-mode.e2e.test.ts`:** pin the real contract per endpoint against devnet: nonexistent lease → null; unclaimed FQDN → null; address with no credit account → `credits: null`; `leases/tenant` → empty array, not a throw. This converts the probe into a standing guard.

Full-repo `npm run lint` is required, not per-package: `getLeaseByCustomDomain`'s nullability ripples into consumer packages, and vitest passes while tsc fails because types erase.

## Scope

**In:** the new `classify-query-error.ts` module (including the **public `isNotFoundError` primitive**, Decision 4), the source edits above (`types.ts`, `lcd-adapter.ts`, `retry.ts`, `getBalance.ts`, `reads.ts`, `manage-domain.ts`, `cosmos.ts`, `lease/index.ts`), the core-barrel + SDK-**root** export, the `assertUuid` addition, and tests.

**Blast radius — larger than a "billing reads" fix.** An adversarial review of the plan (2026-07-15) reproduced these; the implementation plan carries the details:
- `adaptModule` is applied to **~25 namespaces** (`lcd-adapter.ts:205-322`), and `cosmos.ts` re-codes the RPC leg — so this reaches far beyond billing, on **both transports**. But it follows the **keeper's own code, not the HTTP status**, and Cosmos keepers are not uniform (verified live): `status.Error(codes.NotFound)` modules give 404 `{"code":5}` → `NOT_FOUND` (billing lease, gov proposal, IBC denom-trace), while `sdkerrors`-wrapped keepers collapse to `codes.Unknown` → **HTTP 500 `{"code":2}`** and keep `QUERY_FAILED` (`cosmwasm.wasm` "no such code", `cosmos.group` "not found: group"). An earlier draft claimed wasm/group become `NOT_FOUND` — false, and it had reached user-facing CHANGELOG text. Two existing e2e files pin the old code on paths that *do* change: `billing-custom-domain.e2e.test.ts:277-278` and `chain-routing.e2e.test.ts:1064-1080`.
- That same keeper variance makes a blanket `httpStatus >= 500 → retry` a **regression**: a deterministic wasm/group not-found would burn N attempts + backoff + N rate-limiter tokens where it costs one round trip today. So retry keys on the **gRPC code**, not the HTTP status — an explicit transient set (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`); every other enveloped status is a fixed answer; an unenveloped 5xx/429 is a raw transport failure and is retried.

  **Do not justify this as "an envelope means the chain answered"** — that is false, and an earlier draft said it. grpc-gateway `status.Convert()`s its *own* failures too (`runtime/errors.go`, "regardless of error origin — whether from backend application logic or transport layer failures"): verified live, `/liftedinit/nonexistent/v1/foo` → 501 `{"code":12}` and `/cosmos/gov/v1/proposals/not_an_int` → 400 `{"code":3}` (the gateway's path decoder; no keeper ran). An envelope means only *the request reached grpc-gateway and carries a gRPC status*. The transient set is justified empirically, not axiomatically — and the axiom was self-refuting anyway, since 4/8/14 are transport-level codes that only exist because envelopes can originate below the application. `code:2` is ambiguous (keeper answer, or a gateway-side non-status coerced by `status.Convert`); we deliberately do not retry it.
- Ten pre-existing test files across five packages go red and must be migrated, notably the shared fixtures at `__test-utils__/mocks.ts:222,230` (which reject with a plain `Error('key not found')` the new predicate correctly does not recognise — that forgiving fixture is itself part of why the bug shipped), and the uuid placeholders (`'lease-uuid-1'`) that `assertUuid` rejects across `reads.test.ts`, `reads.crossface.test.ts`, `client-factory.test.ts`.
- Every task touching `core/src` must `npm run build` before any cross-package gate: core resolves via `dist/` and `lint` is `tsc --noEmit`, so an unbuilt change greens falsely while asserting nothing.

**Out — and mostly out permanently, per Decision 4.** Verified against barney@main: ENG-536 alone does not let Barney delete `src/api/queryClient.ts` — but that goal is itself partly wrong. Four reads have no SDK equivalent, and **three of them should never get one**:

| Barney fn | chain read | SDK equivalent after this? |
| --- | --- | --- |
| `billing.getLease` | `billing.lease` | ✓ |
| `leaseByCustomDomain.queryLeaseByCustomDomain` | `billing.leaseByCustomDomain` | ✓ |
| `billing.getLeasesByTenant` | `billing.leasesByTenant` | ✓ |
| `billing.getLeasesByTenantPaginated` | `leasesByTenant` + pagination | ~ SDK hardcodes `reverse:false` |
| `billing.getBillingParams` | — | ✓ already migrated |
| `billing.getCreditAccount` | `billing.creditAccount` | ✗ bundled in `getBalance` — **undecided**, see below |
| `billing.getCreditEstimate` | `billing.creditEstimate` | ✗ bundled in `getBalance` — **undecided**, see below |
| `billing.getCreditAddress` | `billing.creditAddress` | ✗ no wrapper — reach it via `client.query` |
| `bank.getBalance(addr, denom)` | `cosmos.bank.balance` | ✗ no wrapper — reach it via `client.query` |

Applying Decision 4: `creditAddress` and single-denom `bank.balance` are pure passthroughs that add no branding, no composition, and no semantic (`creditAddress` returns 200 always — there is no not-found to classify). Wrapping them would reinvent manifestjs; they need no wrapper because **`client.query` already reaches them on the same client**:

```ts
client.query.liftedinit.billing.v1.creditAddress({ tenant })
client.query.cosmos.bank.v1beta1.balance({ address, denom })
```

So they are not "missing from the SDK" — they are *offered by* the SDK, without a bespoke fn. A consumer needs **one** client, not two.

Genuinely undecided → **ENG-537**: standalone `creditAccount` / `creditEstimate`. They would carry branded types, so they clear the branding bar — but `getBalance` already composes them, and Barney only wants them split to dodge the `bank.allBalances` over-fetch. That smells like `getBalance` being too coarse rather than a missing read; it deserves its own decision, not a reflex add. Also there: `reverse` on `getLeasesByTenant` pagination (a defect in our existing composition, not new surface).

Note also that Barney's `getCreditAccount` synthesizes a zero-account on not-found rather than returning null, so its contract differs from `credits: null` even once fixed — a product decision that correctly stays in Barney.

**Explicit non-goals:** wrapping `creditAddress` or single-denom `bank.balance` (Decision 4 — permanently out); standalone credit reads and `reverse` pagination (deferred to ENG-537); deep-proxying the RPC client to mint `NOT_FOUND` there (the shared predicate covers the contract surface at a fraction of the complexity).

## Breaking changes

**Two type-level breaks**, both loud (TypeScript flags every call site):

1. `getLeaseByCustomDomain`: `Promise<{lease, serviceName}>` → `Promise<{lease, serviceName} | null>`.
2. `getWithdrawableAmount`: `Promise<Coin[]>` → `Promise<Coin[] | null>`.

Plus one **behaviour** change that is not type-visible: `getLease` / `getWithdrawableAmount` now throw `INVALID_ARGUMENT` rather than `QUERY_FAILED` for a malformed uuid (invariant 4).

The SDK is 0.x, so these ride **0.19.0**. ENG-436 is *not* a breaking train (it is ctx convergence, still backlog) — 0.18.0 shipped without it, so there is no batch to wait for.

Barney's own `queryLeaseByCustomDomain` is **already** `Promise<… | null>` with the comment *"Returns null when no lease holds that domain (chain 404)"*. Break 1 aligns the SDK to a contract the reference consumer already ships and proves in production.

**Internal call sites — verified, not assumed:**

- `packages/lease/src/index.ts:469` — **must change**: it destructures (`const { lease, serviceName } = await getLeaseByCustomDomain(...)`), which does not compile against `| null`. The tool deliberately throws on not-found; it should now raise a `NOT_FOUND`-derived error rather than a generic `QUERY_FAILED`, which finally delivers the distinction its own comment claims.
- `packages/core/src/client-factory.ts` — **no change needed**: it binds via `BoundFn<typeof getLeaseByCustomDomain>`, so the nullability propagates through the type automatically.
- agent-core's `manageDomain` — **not affected by the signature change**: it calls `queryClient.liftedinit.billing.v1.leaseByCustomDomain` **directly** (`manage-domain.ts:404`), not core's read. It changes only because its `isNotFoundError` re-keys onto the shared predicate.

## Open questions

1. **Should `lease_by_custom_domain` (MCP tool) keep throwing?** Its comment says failures are "kept distinct so callers can tell 'you sent garbage' from 'the chain answered no-such-thing'" — a distinction it cannot currently make. Recommend: keep throwing (tool contract), but surface `NOT_FOUND` so the claim becomes true.
2. **Does `getBalance` warrant splitting?** It fires three queries and fails whole if `bank.allBalances` fails. Out of scope; note for the additive-surface issue.
