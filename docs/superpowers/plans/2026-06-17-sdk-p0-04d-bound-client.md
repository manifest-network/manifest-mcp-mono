# SDK P0 — Plan 4d: bound `ManifestClient` methods + `executeTx` + per-signer mutex + `subscribeLeaseStatus`

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Finish the CapabilityCtx keystone — replace the 4b shell casts with real bound action methods over the ctx-shaped free fns, add the multi-message `executeTx` building block, add a per-signer broadcast mutex in `CosmosClientManager`, and add the poll-backed `subscribeLeaseStatus` watch (bound on a new fred-layer `createFredClient`).

**Architecture:** core's `createManifestClient`/`createManifestReadClient` bind ONLY chain-backed methods (10 reads + 3 txs + `executeTx`) by `Object.assign`-ing per-instance arrow-closures over the final client object (which IS the ctx). `subscribeLeaseStatus` hits the **Fred provider** (a different backend), so per the viem "one client = one backend" rule it is NOT on the core client — a new fred-layer `createFredClient` wraps core's client and layers it on, returning `ManifestClient & FredActions`. A per-signer broadcast mutex (keyed by the resolved chain ADDRESS, not `ctx.signer`) lives in `CosmosClientManager` and serializes the whole simulate→sign→broadcast→commit cycle so concurrent broadcasts from one account can't both read the same committed sequence.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4 (+ `*.test-d.ts` typecheck via `expectTypeOf`), tsdown (`unbundle:true`), `tsc --noEmit` lint (`noUnusedLocals`), Biome. Spec §5.2/§5.6/§5.9/§9. Issue: ENG-309. Builds on 4a/4b/4c (the full read+tx spine is ctx-shaped + branded).

**⚠️ FULL-LINT LESSON (bit 4× across 4b/4c):** adding ~14 method signatures to the barrel-exported `ManifestReadClient`/`ManifestClient` interfaces ripples to consumer packages; vitest erases types (green) while `tsc` fails. **The per-task gate is the full-repo `npm run lint`, not the touched package's lint alone.** No in-repo code calls these methods yet (the SDK-direct e2e is the post-4d follow-on), so the runtime blast-radius is small — but the type surface ripples.

---

## Decisions locked (surface-map `wzlz1l5y1` + idiom research `w9ylndvb4`, all HIGH confidence)

- **Q4 layered attachment (viem #2535 one-backend rule; cosmjs `withExtensions`):** split-attachment. core's factories bind only chain-backed methods; a NEW fred-layer `createFredClient` returns `ManifestClient & FredActions`. **core does NOT declare `subscribeLeaseStatus`** (it hits the Fred backend, not `ctx.query`/`ctx.chain`). The fully-decorated factory lives in fred. Reject runtime-injection seams (dishonest type, defeats tree-shaking).
- **Q2 `executeTx` result (cosmjs `DeliverTxResponse` is tx-level; honesty discipline):** a dedicated **label-free** `ExecuteTxResult = Omit<CosmosTxResult,'module'|'subcommand'> & { msgTypeUrls?: readonly string[] }`. A heterogeneous multi-msg tx has no single `(module, subcommand)` — never synthesize one. `msgTypeUrls` (the protobuf `typeUrl[]`) is the only honest per-message identity cosmjs carries.
- **Q1 read-param branding (Cosmos OVERRIDES EVM):** bound read methods take **bare `string`** ids (identical to the free fns). Our brands are NOMINAL (not viem's template-literal `Address`), so branding read INPUTS would force every caller to `parse*` first — a tax cosmjs (`getBalance(address: string)`) never imposes. Brand OUTPUTS + TX inputs only. Consistency axis = "bound method === free fn", not "read input === tx input".
- **Q6 attachment + mutex (viem `createClient` substrate; cosmjs account-sequence serialization):** single `Object.assign` of arrow-closures over the FINAL `const client` (NOT viem's chained `.extend` — its re-bind leaves stale closures over a pre-merge object, a hazard for our mutable `disposed` flag; NOT a class — `this` un-binds on destructuring; NOT a Proxy). Mutex = pure-JS promise-chain keyed in a `Map<address, Promise>`, release-on-throw, **NO `node:async_hooks`/`AsyncLocalStorage`** (browser-safety, ENG-281). Acquire ONCE around the whole `cosmosTx`/`executeTx` call (re-acquiring per `withRetry` attempt would deadlock on the same key); mutex OUTER, `acquireRateLimit` INNER.
- **Q3 mutex scope:** the mutex lives in `CosmosClientManager` (the shared singleton both faces reach) and `cosmosTx`'s broadcast leg routes through it — so the stringly `cosmos_tx`/MCP face serializes too (concurrent `fundCredits` from one signer otherwise still race). The mutex changes only TIMING, not broadcast bytes → §5.8 byte-equivalence preserved.
- **Q5 scope ceiling (already greenlit):** 4d = **core/fred surface only**. The `@manifest-network/manifest-sdk` aggregating barrel + the SDK-direct e2e acceptance app (the P0a gate) are the explicit "Then" follow-on (a separate plan), per the 4c-txs Next note.
- **Q7 `executeTx` input:** raw `EncodeObject[]` only for P0. No `build*Msg` helpers (none exist; the spec's `[buildFundCreditsMsg(...)]` example is aspirational — note it, defer it).
- **Tree-shaking (Q6, load-bearing):** keep the read factory and full factory in SEPARATE modules so a reads-only browser import never reaches a tx fn. `createManifestClient` + the `ManifestClient` interface move to a new `client-full.ts`; `buildClient` + `createManifestReadClient` + `ManifestReadClient` stay in `client-factory.ts`. The bound-method interface types are derived from the free fns via a `BoundFn<F>` utility (drift-proof); the free-fn VALUE imports are split so `client-factory.ts` imports only read fns.

---

## OPEN ITEMS (resolved)

- **OI-MUTEX-KEY — the mutex keys off `await clientManager.getAddress()` (the chain wallet address), NEVER `ctx.signer`.** `ctx.signer` is unset in the agent-core/spine tx flows (the wallet lives on `ctx.chain`); keying on it would collapse every broadcast into one `undefined` bucket or fail to serialize. The lock lives IN the manager, which owns the `WalletProvider`, so it resolves its own address. Today one manager = one wallet = one address (the per-address `Map` degenerates to a single lock), but key by address for forward-correctness per spec §5.6. **Fix the misleading `ctx.ts:44-46` comment** that says `signer?` is "reserved for 4d's per-signer broadcast mutex".
- **OI-EXEC-GUARDS — `executeTx` is a DIRECT `signAndBroadcast` path that BYPASSES `cosmosTx`**, so it must re-apply the two invariants that live inside `cosmosTx`: the fee+gasMultiplier mutual-exclusion `INVALID_CONFIG` guard (`cosmos.ts:184-189`) and `validateMemo` (`transactions/utils.ts:253`). Forgetting either silently drops a 4c invariant.
- **OI-EXEC-SENDER — `executeTx` resolves `sender = await ctx.chain.getAddress()` (OI-SENDER, no `requireAuthSigner`); the CALLER's messages must already carry the matching `sender`/`authority` field** (executeTx does not inject it into message bodies) or the tx fails on-chain. Document on the fn.
- **OI-SUBSCRIBE-SIGNER — `subscribeLeaseStatus` DOES call `requireAuthSigner(ctx)`** (unlike the 3 txs): it needs the `AuthSigner` to mint the ADR-036 status token via `createAuthTokens`. It is bound only on the fred client (`createFredClient`), whose `ctx.signer` is populated (full client, signer narrowed to required). The status endpoint uses `getAuthToken` (the `tenant:lease:ts` message `appStatus` mints), NOT `getLeaseDataAuthToken`.
- **OI-TREE-SPLIT — `client-full.ts` split** (see Decisions). `BoundFn<F>` is exported from `client-factory.ts` and type-imported by `client-full.ts`.
- **OI-SUBSCRIBE-POLLSRC — `subscribeLeaseStatus` polls the PROVIDER HTTP `/v1/leases/{uuid}/status` endpoint** (full `FredLeaseStatus`), NOT chain `getLease` (which observes only `state`, never `provision_status`/`phase`/`instances` — a chain-only watch would report ready mid-provision, the exact §5.9 failure the provider gate prevents). It CANNOT reuse `pollLeaseUntilReady` (one-shot resolve-or-throw) — it needs its own continuous emit-to-`onData` loop.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/client.ts` (modify) | Add `private broadcastLocks: Map<string, Promise<unknown>>` + `withBroadcastLock(address, fn)` (pure-JS promise-chain mutex). |
| `packages/core/src/cosmos.ts` (modify) | Route `cosmosTx`'s broadcast through `withBroadcastLock`; factor the error-enrichment into `enrichTxError`. |
| `packages/core/src/ctx.ts` (modify) | Fix the misleading `TxCtx` mutex comment (OI-MUTEX-KEY). |
| `packages/core/src/types.ts` (modify) | Add `ExecuteTxResult`. |
| `packages/core/src/transactions/utils.ts` (modify) | Add `buildExecuteTxResult` (sibling to `buildTxResult`, label-free). |
| `packages/core/src/tools/executeTx.ts` (create) | `executeTx(ctx: TxCtx, messages, opts?)` free fn — direct multi-msg broadcast; barrel-exported. |
| `packages/core/src/client-factory.ts` (modify) | `BoundFn<F>` util; declare 10 read methods on `ManifestReadClient`; bind them in `buildClient` (read fn VALUE imports only). `createManifestClient` + `ManifestClient` MOVE OUT. |
| `packages/core/src/client-full.ts` (create) | `createManifestClient` + the `ManifestClient` interface (declares 3 tx methods + `executeTx` via `BoundFn`); `bindFullMethods(client)` attaches tx + executeTx (tx fn VALUE imports isolated here). |
| `packages/core/src/index.ts` (modify) | Re-export `createManifestClient`/`ManifestClient` from `client-full.js`; export `ExecuteTxResult`, `executeTx`. |
| `packages/core/src/client-factory.test.ts` / `.test-d.ts` (modify) | Runtime + type tests for the bound methods + read-vs-full guarantee + `BoundFn` drift guard. |
| `packages/core/src/{client,cosmos,tools/executeTx}.test.ts` (modify/create) | Mutex serialization/height-assert; executeTx behavior. |
| `packages/fred/src/tools/subscribeLeaseStatus.ts` (create) | `subscribeLeaseStatus(ctx, leaseUuid, opts) => unsubscribe` poll-backed watch. |
| `packages/fred/src/client.ts` (create) | `createFredClient` + `fredActions` + `FredActions`/`FredClient` types. |
| `packages/fred/src/index.ts` (modify) | Export `subscribeLeaseStatus`, `createFredClient`, `fredActions`, `FredActions`, `FredClient`, `SubscribeLeaseStatusOptions`. |
| `packages/fred/src/tools/subscribeLeaseStatus.test.ts` (create) | Watch behavior + §5.9 FredLeaseStatus wire-frame contract test. |
| `docs/superpowers/specs/manifest-app-sdk-readiness.md` (modify) | Tick rows A/E/H; fix the stale "overloaded factory" wording. |

---

## Task 0: Confirm baseline

- [ ] Worktree root: `npm run build` (8 pkgs, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green). HEAD is the 4c-txs commits (`…9188842`). If red, STOP.

---

## Task 1: Per-signer broadcast mutex in `CosmosClientManager` + route `cosmosTx`

**Files:** `packages/core/src/client.ts`, `cosmos.ts`, `ctx.ts` (+ `client.test.ts`, `cosmos.test.ts`).

- [ ] **Step 1: Failing tests** — `client.test.ts`: (a) two concurrent `withBroadcastLock(addr, fn)` with the SAME address run SEQUENTIALLY (the 2nd `fn` starts only after the 1st settles — assert via an order log); (b) DIFFERENT addresses run CONCURRENTLY (both `fn`s start before either settles); (c) a REJECTING `fn` releases the lock (the next queued `fn` for that address still runs) and does not emit an unhandledRejection. `cosmos.test.ts`: (d) `cosmosTx` acquires the lock around the broadcast — assert two concurrent `cosmosTx` calls serialize per address (this test needs the REAL promise-chain — give the local mock the real serializing `withBroadcastLock` or a passthrough won't prove serialization); (e) the existing single-`cosmosTx` happy path + error attribution still pass — **but the existing `cosmos.test.ts` MUST be patched first (see Step 4a): its local mock lacks `withBroadcastLock` and its call-order test pins the OLD order.**

  **NOTE — `client.test.ts` has NO `makeMockClientManager`; the suite uses `CosmosClientManager.getInstance(...)`. `withBroadcastLock` is a pure-JS promise-chain (no network), so construct a real instance** (`const mgr = CosmosClientManager.getInstance(makeConfig(), wallet)`, `mgr.disconnect()` in cleanup):

```ts
// client.test.ts (sketch — real instance; withBroadcastLock touches no network)
it('withBroadcastLock serializes same-address fns', async () => {
  const mgr = CosmosClientManager.getInstance(makeConfig(), wallet);
  const order: string[] = [];
  const slow = () => new Promise<void>((r) => setTimeout(() => { order.push('a-end'); r(); }, 30));
  const fast = () => { order.push('b-run'); return Promise.resolve(); };
  const p1 = mgr.withBroadcastLock('addr1', async () => { order.push('a-start'); await slow(); });
  const p2 = mgr.withBroadcastLock('addr1', fast);
  await Promise.all([p1, p2]);
  expect(order).toEqual(['a-start', 'a-end', 'b-run']); // b waited for a
  mgr.disconnect();
});
it('withBroadcastLock runs different addresses concurrently', async () => {
  const mgr = CosmosClientManager.getInstance(makeConfig(), wallet);
  let bStarted = false;
  const p1 = mgr.withBroadcastLock('addr1', () => new Promise<void>((r) => setTimeout(r, 30)));
  const p2 = mgr.withBroadcastLock('addr2', async () => { bStarted = true; });
  await p2;
  expect(bStarted).toBe(true); // did not wait for addr1
  await p1; mgr.disconnect();
});
it('withBroadcastLock releases on throw', async () => {
  const mgr = CosmosClientManager.getInstance(makeConfig(), wallet);
  await expect(mgr.withBroadcastLock('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  await expect(mgr.withBroadcastLock('a', () => Promise.resolve('ok'))).resolves.toBe('ok');
  mgr.disconnect();
});
```

- [ ] **Step 2: Run → fail.** `(cd packages/core && npx vitest run src/client.test.ts src/cosmos.test.ts)`.

- [ ] **Step 3: Implement the mutex** — `client.ts`, add the field next to `rateLimiter` (after line 120) and the method (place it just after `acquireRateLimit`, ~line 480):

```ts
  // Per-signer broadcast serialization. A promise-chain lock keyed by signer ADDRESS so concurrent
  // signAndBroadcast calls from one account can't both read the same committed sequence (cosmjs
  // re-queries the sequence per broadcast — account-sequence-mismatch). Pure-JS (NO node:async_hooks
  // — browser-safe). One entry per distinct address (today one wallet ⇒ one entry).
  private broadcastLocks: Map<string, Promise<unknown>> = new Map();
```

```ts
  /**
   * Serialize an async fn against all other broadcasts for `address`, holding the lock until `fn`
   * settles (success OR failure). The next waiter chains off the prior settlement regardless of
   * outcome, so a rejected broadcast neither wedges the queue nor leaks an unhandledRejection.
   * Orthogonal to the rate limiter: callers acquire THIS (outer), then acquireRateLimit (inner).
   * Acquire ONCE per logical broadcast — NOT inside a withRetry attempt (re-acquiring the same key
   * deadlocks); a transient retry re-broadcasts under the same held lock, which is correct for
   * sequence safety.
   */
  async withBroadcastLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.broadcastLocks.get(address) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior task's outcome
    // Store a swallowed tail so the next waiter chains cleanly and no unhandledRejection escapes.
    this.broadcastLocks.set(
      address,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
```

- [ ] **Step 4: Route `cosmosTx` through the lock + factor `enrichTxError`** — `cosmos.ts`. Add the module-local helper (above `cosmosTx`):

```ts
function enrichTxError(
  error: unknown,
  module: string,
  subcommand: string,
  args: string[],
): ManifestMCPError {
  if (error instanceof ManifestMCPError) {
    if (!error.details?.module) {
      return new ManifestMCPError(error.code, error.message, {
        ...error.details,
        module,
        subcommand,
        args,
      });
    }
    return error;
  }
  return new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `Tx ${module} ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}`,
    { module, subcommand, args },
  );
}
```

  Then replace the `return withRetry(async () => { ... }, {...});` block (`cosmos.ts:228-275`) with the address-resolved, lock-wrapped form:

```ts
  // Resolve the sender ONCE — it is both the broadcast-lock key and the signAndBroadcast sender.
  // Resolve BEFORE the lock so the per-signer mutex can key on it; enrich a wallet failure with the
  // same {module,subcommand,args} attribution the broadcast leg uses.
  let senderAddress: string;
  try {
    senderAddress = await clientManager.getAddress();
  } catch (error) {
    throw enrichTxError(error, module, subcommand, args);
  }

  // Per-signer broadcast mutex (OUTER) serializes the whole simulate→sign→broadcast→commit cycle
  // for this address; acquireRateLimit stays INNER. Acquired ONCE around withRetry.
  return clientManager.withBroadcastLock(senderAddress, () =>
    withRetry(
      async () => {
        try {
          await clientManager.acquireRateLimit();
          const signingClient = await clientManager.getSigningClient();
          return await handler(
            signingClient,
            senderAddress,
            subcommand,
            args,
            waitForConfirmation,
            txOptions,
            buildContext,
            txExtras,
          );
        } catch (error) {
          throw enrichTxError(error, module, subcommand, args);
        }
      },
      {
        config: clientManager.getConfig().retry,
        operationName: `tx ${module} ${subcommand}`,
      },
    ),
  );
```

  (The inner `const senderAddress = await clientManager.getAddress()` is REMOVED — it's resolved once above. **NOT byte/behavior-identical in one narrow way:** `getAddress` is now resolved once BEFORE the lock (outside `withRetry`) because the mutex keys on the resolved address, so a transient `getAddress`/`connect` failure is no longer retried — **acceptable** because the common wallet error codes (`WALLET_NOT_CONNECTED`/`WALLET_CONNECTION_FAILED`) are already `NON_RETRYABLE` (`retry.ts:17-43`); the residual delta is only a plain-`Error` transient message from `connect()`, a rare pre-broadcast case. Broadcast bytes + attribution + retry config are otherwise unchanged. (Optional: wrap the pre-lock `getAddress` in its own `withRetry` to fully restore retry parity.))

- [ ] **Step 4a: Patch the existing `cosmos.test.ts`** (REQUIRED — routing `cosmosTx` through the lock + resolving `getAddress` first breaks two existing tests; `cosmos.test.ts` drives the REAL `cosmosTx`, unlike the tx-tool tests which `vi.mock('../cosmos.js')`):
  1. Add `withBroadcastLock` to the LOCAL `makeMockClientManager` (`cosmos.test.ts:38-47`): `withBroadcastLock: <T>(_addr: string, fn: () => Promise<T>) => fn()` (a passthrough — sufficient for the existing single-`cosmosTx` tests). The NEW concurrency test (d) CANNOT use this passthrough; it needs the real serializing chain (give that one test the real `withBroadcastLock` impl on the mock, or a real `CosmosClientManager`).
  2. Update the call-order assertion (`cosmos.test.ts:~372-377`, the "acquires rate limit before RPC call" test) from `['rateLimit','getClient','getAddress','handler']` to **`['getAddress','rateLimit','getClient','handler']`** — `getAddress` is now resolved first (before the lock).

- [ ] **Step 5: Fix the misleading mutex comment** — `ctx.ts:42-47`, replace the `TxCtx` JSDoc's last sentence:

```ts
/**
 * @public — the tx-path ISP slice (spec §5.5): txs take chain+signer+logger (no query/fetch).
 * NOTE: 4c/4d do NOT consume `ctx.signer` for on-chain txs — the wallet AND the query-only
 * INVALID_CONFIG guard come from `ctx.chain` (via getSigningClient), and 4d's per-signer broadcast
 * mutex keys off the resolved CHAIN ADDRESS (ctx.chain.getAddress()), NOT ctx.signer. `signer?` is
 * carried for the full client's required-signer narrowing + provider ops (subscribeLeaseStatus); do
 * not call requireAuthSigner on the signer-less ctx the on-chain tx call sites build.
 */
export type TxCtx = Pick<CapabilityCtx, 'chain' | 'signer' | 'logger'>;
```

- [ ] **Step 6: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(core): per-signer broadcast mutex in CosmosClientManager + route cosmosTx (ENG-309)"`.

---

## Task 2: `ExecuteTxResult` + `executeTx` free fn

**Files:** `packages/core/src/types.ts`, `transactions/utils.ts`, `tools/executeTx.ts` (create), `index.ts` (+ `tools/executeTx.test.ts`).

- [ ] **Step 1a: Prerequisite — extend the SHARED mock** (REQUIRED; the plan's `executeTx` calls `ctx.chain.withBroadcastLock`, which `__test-utils__/mocks.ts:335`'s `makeMockClientManager` does NOT define → `TypeError` before any broadcast). Add a real serializing impl (so the concurrency test (g) genuinely proves serialization):

```ts
// __test-utils__/mocks.ts — inside makeMockClientManager's returned object
withBroadcastLock: <T>(_address: string, fn: () => Promise<T>): Promise<T> => fn(),
```

  (A passthrough is fine for tests (a)–(f); the serialization test (g) needs the REAL promise-chain — either override `withBroadcastLock` on that test's mock with the real impl, or use a real `CosmosClientManager`. This change is additive; cross-package consumers mock core wholesale, so it's safe.)

- [ ] **Step 1: Failing tests** — `tools/executeTx.test.ts` (`makeTxCtx({ chain })` from `__test-utils__/mocks.ts`; there is NO `makeChainWith` — build the chain mock inline by overriding `getSigningClient` to return a fake `{ signAndBroadcast, simulate }`): (a) broadcasts the `EncodeObject[]` and returns an `ExecuteTxResult` with `transactionHash`/`height`/`code:0`/`msgTypeUrls`, NO `module`/`subcommand`; (b) `opts.fee` is passed straight to `signAndBroadcast` and `simulate`/`buildGasFee` is NOT called (fee-wins); (c) `opts.gasMultiplier` drives the simulate path; (d) `fee`+`gasMultiplier` → `INVALID_CONFIG`; (e) empty `messages` → `INVALID_ARGUMENT`; (f) a non-zero `code` result → `TX_FAILED` naming the `msgTypeUrls`; (g) two concurrent `executeTx` from the same `ctx.chain` serialize (real lock); (h) **M2 regression — a RAW transient error (`new Error('socket hang up')`) thrown by `signAndBroadcast` is NOT re-broadcast** (`signAndBroadcast` called exactly once), mirroring `retry.test.ts:111`.

```ts
// executeTx.test.ts (sketch)
const msgs = [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} }];
function ctxWith(signAndBroadcast: ReturnType<typeof vi.fn>, simulate = vi.fn().mockResolvedValue(100_000)) {
  const chain = makeMockClientManager();
  chain.getSigningClient = vi.fn().mockResolvedValue({ signAndBroadcast, simulate });
  return makeTxCtx({ chain });
}
it('broadcasts multi-msg and returns a label-free result with height + msgTypeUrls', async () => {
  const signAndBroadcast = vi.fn().mockResolvedValue({ code: 0, transactionHash: 'HASH', height: 42, gasUsed: 1n, gasWanted: 2n, events: [], rawLog: '' });
  const res = await executeTx(ctxWith(signAndBroadcast), msgs);
  expect(res).toMatchObject({ transactionHash: 'HASH', height: '42', code: 0, msgTypeUrls: ['/cosmos.bank.v1beta1.MsgSend'] });
  expect(res.height).toBe('42'); // §5.6 guard: a COMMITTED DeliverTxResponse (height), never a sync hash
  expect(res).not.toHaveProperty('module');
  expect(signAndBroadcast).toHaveBeenCalledWith(expect.any(String), msgs, expect.anything(), '');
});
it('rejects fee + gasMultiplier', async () => {
  await expect(executeTx(makeTxCtx(), msgs, { fee: { amount: [], gas: '1' }, gasMultiplier: 1.5 }))
    .rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
});
it('rejects empty messages', async () => {
  await expect(executeTx(makeTxCtx(), [])).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_ARGUMENT });
});
it('does NOT re-broadcast on a raw transient broadcast error (no double-broadcast)', async () => {
  const signAndBroadcast = vi.fn().mockRejectedValue(new Error('socket hang up')); // transient MESSAGE
  await expect(executeTx(ctxWith(signAndBroadcast), msgs)).rejects.toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
  expect(signAndBroadcast).toHaveBeenCalledTimes(1); // wrapped to TX_FAILED ⇒ NON_RETRYABLE ⇒ sent once
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add `ExecuteTxResult`** — `types.ts`, after `CosmosTxResult` (line 322):

```ts
/**
 * Result of a multi-message `executeTx` broadcast. A heterogeneous batch has no single
 * (module, subcommand), so this is the tx-level subset of CosmosTxResult plus the per-message
 * protobuf typeUrls (the only honest per-message identity cosmjs carries). A CosmosTxResult is
 * assignable to this for any consumer reading only tx-level fields.
 */
export type ExecuteTxResult = Omit<CosmosTxResult, 'module' | 'subcommand'> & {
  readonly msgTypeUrls?: readonly string[];
};
```

- [ ] **Step 4: Add `buildExecuteTxResult`** — `transactions/utils.ts`, after `buildTxResult` (line 572). Import `ExecuteTxResult` from `../types.js`:

```ts
/**
 * Build an ExecuteTxResult from a multi-message DeliverTxResponse. Mirrors buildTxResult but carries
 * no (module, subcommand) — a multi-msg tx has neither; failure messages name the message typeUrls.
 * executeTx always confirms (signAndBroadcast waits for inclusion).
 */
export function buildExecuteTxResult(
  result: Awaited<ReturnType<SigningStargateClient['signAndBroadcast']>>,
  msgTypeUrls: readonly string[],
): ExecuteTxResult {
  if (result.code !== 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `executeTx (${msgTypeUrls.join(', ') || 'no messages'}) failed with code ${result.code}: ${result.rawLog || 'no details'}`,
      {
        code: result.code,
        transactionHash: result.transactionHash,
        rawLog: result.rawLog,
        height: String(result.height),
        msgTypeUrls,
      },
    );
  }
  return {
    transactionHash: result.transactionHash,
    code: result.code,
    height: String(result.height),
    rawLog: result.rawLog || undefined,
    gasUsed: String(result.gasUsed),
    gasWanted: String(result.gasWanted),
    events: result.events,
    msgTypeUrls,
    confirmed: true,
    confirmationHeight: String(result.height),
  };
}
```

- [ ] **Step 5: Create `tools/executeTx.ts`:**

```ts
import type { EncodeObject } from '@cosmjs/proto-signing';
import type { TxCtx } from '../ctx.js';
import { withTxConfirmation } from '../internals/tx-confirmation.js';
import type { TxCallOptions } from '../options.js';
import { withRetry } from '../retry.js';
import { buildExecuteTxResult, buildGasFee, validateMemo } from '../transactions/utils.js';
import type { ExecuteTxResult, TxOptions } from '../types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Broadcast MULTIPLE messages as ONE atomic transaction (single sequence, single fee, all-or-nothing).
 * A direct signAndBroadcast path — it does NOT go through the per-module cosmos_tx router (there is no
 * module/subcommand for a raw heterogeneous batch). Threads TxCallOptions exactly like the 3 typed txs
 * (fee-wins / gasMultiplier-simulate / memo / signal) and serializes under the per-signer broadcast
 * mutex. The CALLER's messages must already carry the matching `sender`/`authority` field — executeTx
 * resolves the sender for signing (OI-SENDER: ctx.chain, no requireAuthSigner) but does NOT inject it
 * into message bodies. Typed-face only (no stringly equivalent; §9).
 */
export async function executeTx(
  ctx: TxCtx,
  messages: readonly EncodeObject[],
  opts?: TxCallOptions,
): Promise<ExecuteTxResult> {
  if (messages.length === 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'executeTx requires at least one message',
    );
  }
  // Re-apply the guards that live inside cosmosTx (bypassed by this direct path — OI-EXEC-GUARDS).
  if (opts?.fee !== undefined && opts?.gasMultiplier !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'passing both fee and gasMultiplier is a caller error; fee wins (it skips simulation), gasMultiplier applies only on the simulate path',
    );
  }
  let txOptions: TxOptions | undefined;
  if (opts?.gasMultiplier !== undefined) {
    if (!Number.isFinite(opts.gasMultiplier) || opts.gasMultiplier < 1) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${opts.gasMultiplier}`,
      );
    }
    const gasPrice = ctx.chain.getConfig().gasPrice;
    if (!gasPrice) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'gasMultiplier override requires gasPrice configuration',
      );
    }
    txOptions = { gasMultiplier: opts.gasMultiplier, gasPrice };
  }

  const typeUrls = messages.map((m) => m.typeUrl);
  const sender = await ctx.chain.getAddress();

  return withTxConfirmation(
    () =>
      ctx.chain.withBroadcastLock(sender, () =>
        withRetry(
          async () => {
            try {
              await ctx.chain.acquireRateLimit();
              const client = await ctx.chain.getSigningClient();
              const effectiveMemo = opts?.memo ?? '';
              validateMemo(effectiveMemo);
              const fee =
                opts?.fee !== undefined
                  ? opts.fee
                  : await buildGasFee(client, sender, messages, txOptions, effectiveMemo);
              const result = await client.signAndBroadcast(sender, messages, fee, effectiveMemo);
              return buildExecuteTxResult(result, typeUrls);
            } catch (error) {
              // M2 — MIRROR cosmosTx's broadcast-leg wrapping (cosmos.ts:251-269): a pre-broadcast
              // ManifestMCPError (e.g. a transient RPC_CONNECTION_FAILED from getSigningClient) passes
              // through and stays retryable; ANY raw/non-ManifestMCPError (a network error from
              // signAndBroadcast/simulate) becomes TX_FAILED → NON_RETRYABLE (retry.ts:35), so a
              // submitted-but-failed multi-msg batch is NEVER re-broadcast (no double-spend).
              if (error instanceof ManifestMCPError) throw error;
              throw new ManifestMCPError(
                ManifestMCPErrorCode.TX_FAILED,
                `executeTx (${typeUrls.join(', ') || 'no messages'}) failed: ${error instanceof Error ? error.message : String(error)}`,
                { msgTypeUrls: typeUrls },
              );
            }
          },
          {
            config: ctx.chain.getConfig().retry,
            operationName: `executeTx (${messages.length} msgs)`,
          },
        ),
      ),
    opts,
  );
}
```

- [ ] **Step 6: Barrel-export** — `index.ts`: add `executeTx` to the tools exports (next to `fundCredits`/`stopApp`). `ExecuteTxResult` needs NO explicit export — `index.ts`'s `export * from './types.js'` already re-exports it (matching `CosmosTxResult`).

- [ ] **Step 7: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(core): add executeTx multi-message broadcast + ExecuteTxResult (ENG-309)"`.

---

## Task 3: Bind the 10 READ methods on `ManifestReadClient`

**Files:** `packages/core/src/client-factory.ts` (+ `client-factory.test.ts`, `client-factory.test-d.ts`).

- [ ] **Step 1: Failing type-test** — `client-factory.test-d.ts`: assert the read methods exist on `ManifestReadClient` with the free-fn tail signatures, and the `BoundFn` drift guard. (Test files may use `typeof` freely — not shipped.)

```ts
import { getLease } from './tools/reads.js';
import type { ManifestReadClient } from './client-factory.js';

describe('ManifestReadClient bound reads', () => {
  it('exposes getLease with the free-fn tail (ctx dropped)', () => {
    expectTypeOf<ManifestReadClient['getLease']>().toEqualTypeOf<
      (leaseUuid: string, opts?: import('./options.js').CallOptions) => ReturnType<typeof getLease>
    >();
  });
  it('getBalance return matches the free fn (drift guard)', () => {
    expectTypeOf<ReturnType<ManifestReadClient['getBalance']>>().toEqualTypeOf<
      ReturnType<typeof import('./tools/getBalance.js').getBalance>
    >();
  });
});
```

- [ ] **Step 2: Failing runtime test** — `client-factory.test.ts`: a read client (`createManifestReadClient`) HAS the 10 read methods and calling one forwards `ctx` to the free fn.

```ts
it('read client exposes bound read methods that forward ctx', async () => {
  const client = await createManifestReadClient({ config: queryOnlyConfig });
  expect(typeof client.getLease).toBe('function');
  expect(typeof client.getProviders).toBe('function');
  // forwarding: a bound read calls the free fn with `client` as ctx (spy the chain query path)
});
```

- [ ] **Step 3: Run → fail** (methods undefined). `(cd packages/core && npx vitest run src/client-factory.test.ts src/client-factory.test-d.ts)`.

- [ ] **Step 4: Implement** — `client-factory.ts`. Add the `BoundFn` util + read fn VALUE imports + declare the methods on `ManifestReadClient` + attach them in `buildClient`:

```ts
// VALUE imports (used both for typeof in the interface and for runtime binding). READS ONLY — never
// import a tx fn here, so a reads-only browser bundle importing createManifestReadClient stays tx-free.
import { getBalance } from './tools/getBalance.js';
import {
  getBillingParams,
  getLease,
  getLeaseByCustomDomain,
  getLeasesByTenant,
  getProviders,
  getSKUs,
  getWithdrawableAmount,
} from './tools/reads.js';
import { listSkuCandidates, resolveSku } from './sku-resolution.js';

/**
 * Strip the leading ctx parameter: a free fn `(ctx, ...rest) => R` becomes the bound method
 * `(...rest) => R`. Keeps the bound-method interface signatures DERIVED from (never drifting from)
 * the free fns — including getBalance's inferred return.
 */
export type BoundFn<F> = F extends (ctx: infer _C, ...rest: infer R) => infer Ret
  ? (...rest: R) => Ret
  : never;

/** The trailing (post-ctx) parameter tuple of a free fn — the value-level companion of BoundFn,
 *  used to type the bound-method closures. Exported so client-full.ts single-sources it (N7). */
export type TailOf<F> = F extends (ctx: infer _C, ...rest: infer R) => unknown ? R : never;
```

  Declare the methods on the interface (`client-factory.ts:122-129`):

```ts
export interface ManifestReadClient extends QueryCtx {
  dispose(): void;
  getBalance: BoundFn<typeof getBalance>;
  resolveSku: BoundFn<typeof resolveSku>;
  listSkuCandidates: BoundFn<typeof listSkuCandidates>;
  getLeasesByTenant: BoundFn<typeof getLeasesByTenant>;
  getLease: BoundFn<typeof getLease>;
  getLeaseByCustomDomain: BoundFn<typeof getLeaseByCustomDomain>;
  getSKUs: BoundFn<typeof getSKUs>;
  getProviders: BoundFn<typeof getProviders>;
  getBillingParams: BoundFn<typeof getBillingParams>;
  getWithdrawableAmount: BoundFn<typeof getWithdrawableAmount>;
}
```

  Attach in `buildClient` — replace `const base = {...}; const client = ...; return client as ManifestReadClient;` (`client-factory.ts:90-92`) with arrow-closures over the FINAL `client` object (Q6):

```ts
    const base = { chain, query, fetch, logger, dispose };
    const ctxShell = signer ? { ...base, signer } : base;
    // Bind the read methods as per-instance arrow-closures over the FINAL object (it IS the ctx).
    // The bound methods close over `client`; `dispose` closes over the buildClient-local `disposed`
    // flag — both end up on the single returned object (no soundness issue, N9).
    const client = ctxShell as ManifestReadClient;
    Object.assign(client, {
      getBalance: (address: string, opts?: CallOptions) => getBalance(client, address, opts),
      resolveSku: (...a: TailOf<typeof resolveSku>) => resolveSku(client, ...a),
      listSkuCandidates: (...a: TailOf<typeof listSkuCandidates>) => listSkuCandidates(client, ...a),
      getLeasesByTenant: (...a: TailOf<typeof getLeasesByTenant>) => getLeasesByTenant(client, ...a),
      getLease: (...a: TailOf<typeof getLease>) => getLease(client, ...a),
      getLeaseByCustomDomain: (...a: TailOf<typeof getLeaseByCustomDomain>) => getLeaseByCustomDomain(client, ...a),
      getSKUs: (...a: TailOf<typeof getSKUs>) => getSKUs(client, ...a),
      getProviders: (...a: TailOf<typeof getProviders>) => getProviders(client, ...a),
      getBillingParams: (...a: TailOf<typeof getBillingParams>) => getBillingParams(client, ...a),
      getWithdrawableAmount: (...a: TailOf<typeof getWithdrawableAmount>) => getWithdrawableAmount(client, ...a),
    });
    return client;
```

  `TailOf` is the exported helper declared with `BoundFn` above (single-sourced; `client-full.ts` imports it — N7). (Add `import type { CallOptions } from './options.js';` for the `getBalance` closure.) The `dispose`/`disposed` closure (`client-factory.ts:79-84`) is unchanged — it already closes over the outer scope; it now coexists with the bound methods on the same `client`. The `catch` block (`:93-99`) is unchanged.

- [ ] **Step 5: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(core): bind the 10 read methods on ManifestReadClient (ENG-309)"`.

---

## Task 4: Split out `client-full.ts` — bind TX + `executeTx` on `ManifestClient`

**Files:** `packages/core/src/client-full.ts` (create), `client-factory.ts` (remove `createManifestClient`/`ManifestClient`), `index.ts` (+ `client-factory.test.ts`/`.test-d.ts`).

- [ ] **Step 1: Failing tests** — `client-factory.test-d.ts`: `ManifestClient` has `fundCredits`/`setItemCustomDomain`/`stopApp`/`executeTx` (via `BoundFn`); a `ManifestReadClient` is NOT assignable to `ManifestClient`; `ManifestReadClient` does NOT have `fundCredits` at the type level. `client-factory.test.ts`: a full client (`createManifestClient`) HAS the tx + executeTx methods AT RUNTIME; a read client does NOT (`expect('fundCredits' in readClient).toBe(false)`, `expect('executeTx' in readClient).toBe(false)`); the `'signer' in readClient === false` invariant still holds.

```ts
it('full client has tx methods; read client does not (runtime)', async () => {
  const full = await createManifestClient({ config: fullConfig, walletProvider });
  const read = await createManifestReadClient({ config: queryOnlyConfig });
  expect(typeof full.fundCredits).toBe('function');
  expect(typeof full.executeTx).toBe('function');
  expect('fundCredits' in read).toBe(false);
  expect('executeTx' in read).toBe(false);
  expect('signer' in read).toBe(false); // query-only omits the signer key (4b invariant)
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `client-full.ts`** (the tx fn VALUE imports are isolated here — never reachable from `createManifestReadClient`):

```ts
import { buildClient } from './client-factory.js';
import type { BoundFn, FullClientOptions, ManifestReadClient, TailOf } from './client-factory.js';
import type { CapabilityCtx } from './ctx.js';
import type { Signer } from './signer.js';
import { executeTx } from './tools/executeTx.js';
import { fundCredits } from './tools/fundCredits.js';
import { setItemCustomDomain } from './tools/setItemCustomDomain.js';
import { stopApp } from './tools/stopApp.js';

/**
 * @public — full bound client: ManifestReadClient + the on-chain tx methods + executeTx, with a
 * REQUIRED signer (the read-vs-full type guarantee). Provider methods (subscribeLeaseStatus) are NOT
 * here — they hit the Fred backend; see fred's createFredClient (viem one-client-one-backend rule).
 */
export interface ManifestClient extends ManifestReadClient, CapabilityCtx {
  readonly signer: Signer;
  fundCredits: BoundFn<typeof fundCredits>;
  setItemCustomDomain: BoundFn<typeof setItemCustomDomain>;
  stopApp: BoundFn<typeof stopApp>;
  executeTx: BoundFn<typeof executeTx>;
}

export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // buildClient (withSigner=true) returns the read-bound, signer-carrying shell.
  const client = (await buildClient(opts, opts.walletProvider, true)) as ManifestClient;
  // Layer the tx + executeTx methods over the SAME object (Q6 single Object.assign over final const).
  Object.assign(client, {
    fundCredits: (...a: TailOf<typeof fundCredits>) => fundCredits(client, ...a),
    setItemCustomDomain: (...a: TailOf<typeof setItemCustomDomain>) => setItemCustomDomain(client, ...a),
    stopApp: (...a: TailOf<typeof stopApp>) => stopApp(client, ...a),
    executeTx: (...a: TailOf<typeof executeTx>) => executeTx(client, ...a),
  });
  return client;
}
```

  To enable this, in `client-factory.ts`:
  - **export** `buildClient` (`async function buildClient` → `export async function buildClient`), and confirm `FullClientOptions`/`BoundFn`/`TailOf`/`ManifestReadClient` are exported (BoundFn/TailOf added in Task 3).
  - REMOVE its own `createManifestClient` + the `ManifestClient` interface (`:102-108`, `:131-146`).
  - **M4 — fix the now-ORPHANED imports** (else `noUnusedLocals` (`tsconfig.base.json`) → TS6133): `CapabilityCtx` (`client-factory.ts:3`) was used ONLY by `ManifestClient extends … CapabilityCtx`, and `Signer` (`:6`) ONLY by `readonly signer: Signer` — both now move to `client-full.ts`. So change `import type { CapabilityCtx, EventTransport, QueryCtx } from './ctx.js'` → `import type { EventTransport, QueryCtx } from './ctx.js'`, and DELETE `import type { Signer } from './signer.js'` (KEEP the value import `createSignerAdapter` from `./signer.js`).
  - **M4 — re-point the test imports** (else TS2305 / runtime "not a function"): in `client-factory.test.ts` and `client-factory.test-d.ts`, change `createManifestClient` (and `type ManifestClient`) to import `from './client-full.js'`, keeping `createManifestReadClient`/`ManifestReadClient`/option types/`BoundFn` from `./client-factory.js`.

- [ ] **Step 4: Re-export from the barrel** — `index.ts`: change the `createManifestClient` / `ManifestClient` exports to come from `./client-full.js` (keep `createManifestReadClient` / `ManifestReadClient` / `ReadClientOptions` / `FullClientOptions` / `BoundFn` / `TailOf` from `./client-factory.js`). Public import path unchanged.

- [ ] **Step 5: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(core): bind tx + executeTx on ManifestClient via client-full.ts (tree-shaking split) (ENG-309)"`.

---

## Task 5: `subscribeLeaseStatus` free fn (fred)

**Files:** `packages/fred/src/tools/subscribeLeaseStatus.ts` (create), `packages/fred/src/http/fred.ts` (export `PROVISION_IN_PROGRESS`/`PROVISION_FAILED`), `index.ts` (+ `subscribeLeaseStatus.test.ts`).

- [ ] **Step 1: Failing tests** — `subscribeLeaseStatus.test.ts`. The contract is a **converging watch** (spec §5.9) that ALWAYS ends in exactly one of `{onComplete, onError, silent-abort}` then auto-unsubscribes: (a) **dedup** — `onData` emits the FIRST status, then suppresses consecutive emits equal on `(state, provision_status)`; `emitEvery: true` emits raw per-poll; emitted `state` is a `LeaseState` ENUM (not a string); (b) **terminal-success** (`LEASE_STATE_ACTIVE` + settled provision) → a final `onData` then `onComplete(final)` then auto-stop (no further polls/callbacks); (c) **terminal-failure** (`LEASE_STATE_CLOSED`/`REJECTED`/`EXPIRED`, or `provision_status` in `PROVISION_FAILED`) → delivered as final `onData` + `onComplete(final)`, **NOT** `onError` (a watched outcome is a value); (d) **timeout** (poll deadline reached, lease still non-terminal) → `onError` + stop (a stuck lease is loud); (e) **abnormal** — a setup failure (lease not found) or a poll network/parse error → `onError` + stop; (f) **abort** — `opts.signal` abort stops silently (no `onError`, no `onComplete`); (g) `unsubscribe()` is idempotent (2nd call a no-op); (h) the **§5.9 wire-frame contract test** — a representative Fred status frame parses to the same branded `FredLeaseStatus` the poll path emits.

  **Test-harness constraints (N2/N3):** drive the REAL `getLeaseStatus` — `makeSubscribeCtx` must wire `ctx.fetch` to return `Response`-shaped frames (with an `https`/`localhost` provider `apiUrl` so `validateProviderUrl` + `leaseStateFromJSON` actually run); do NOT `vi.mock('../http/fred.js')` to return a pre-converted status (that bypasses the string→enum conversion under test). All watch tests (a)–(f) use the same fetch-level mock. Use fake timers (`vi.useFakeTimers()` + `advanceTimersByTimeAsync`) and make every setup await (`acquireRateLimit`, the lease + provider queries, `signArbitrary`, `ctx.fetch`) resolve immediately so the first `onData` lands within `advanceTimersByTimeAsync(1)`.

```ts
// subscribeLeaseStatus.test.ts (sketch — fake timers; 'provisioning' ∈ PROVISION_IN_PROGRESS (non-terminal),
// 'running' = settled terminal-success, 'failed' ∈ PROVISION_FAILED (terminal-failure))
it('dedups onData on (state, provision_status) and stops on unsubscribe', async () => {
  vi.useFakeTimers();
  // same in-progress status every poll → emit ONCE (dedup), keep polling
  const ctx = makeSubscribeCtx({ providerUuid: 'prov-1', statusFrames: [{ state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' }] });
  const onData = vi.fn(); const onComplete = vi.fn();
  const stop = subscribeLeaseStatus(ctx, 'lease-1' as LeaseUuid, { onData, onComplete, intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(35); // ~3 polls
  expect(onData).toHaveBeenCalledTimes(1); // deduped
  expect(onData).toHaveBeenCalledWith(expect.objectContaining({ state: LeaseState.LEASE_STATE_PENDING }));
  expect(onComplete).not.toHaveBeenCalled();
  stop(); stop(); // idempotent
});
it('terminal-success → final onData + onComplete + auto-stop', async () => {
  vi.useFakeTimers();
  const ctx = makeSubscribeCtx({ providerUuid: 'prov-1', statusFrames: [{ state: 'LEASE_STATE_ACTIVE', provision_status: 'running' }] });
  const onData = vi.fn(); const onComplete = vi.fn(); const onError = vi.fn();
  subscribeLeaseStatus(ctx, 'lease-1' as LeaseUuid, { onData, onComplete, onError, intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(1);
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ state: LeaseState.LEASE_STATE_ACTIVE }));
  expect(onError).not.toHaveBeenCalled();
  const calls = onData.mock.calls.length;
  await vi.advanceTimersByTimeAsync(50);
  expect(onData.mock.calls.length).toBe(calls); // auto-stopped
});
it('terminal-FAILURE is delivered via onComplete, NOT onError', async () => {
  vi.useFakeTimers();
  const ctx = makeSubscribeCtx({ providerUuid: 'prov-1', statusFrames: [{ state: 'LEASE_STATE_ACTIVE', provision_status: 'failed' }] });
  const onComplete = vi.fn(); const onError = vi.fn();
  subscribeLeaseStatus(ctx, 'lease-1' as LeaseUuid, { onData: vi.fn(), onComplete, onError, intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(1);
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ provision_status: 'failed' }));
  expect(onError).not.toHaveBeenCalled();
});
it('timeout (stuck non-terminal lease) → onError', async () => {
  vi.useFakeTimers();
  const ctx = makeSubscribeCtx({ providerUuid: 'prov-1', statusFrames: [{ state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' }] });
  const onError = vi.fn(); const onComplete = vi.fn();
  subscribeLeaseStatus(ctx, 'lease-1' as LeaseUuid, { onData: vi.fn(), onError, onComplete, intervalMs: 10, timeout: 25 });
  await vi.advanceTimersByTimeAsync(40);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
});
// also: (e) abort → silent (no onError/onComplete); (e) setup lease-not-found → onError; (e) network/parse error → onError + stop.
it('§5.9 contract: a Fred status wire frame parses to the emitted FredLeaseStatus shape', async () => {
  vi.useFakeTimers();
  // Representative Fred provider /status frame (substitute the exact Barney WS frame when available).
  // REAL parse path (N2): makeSubscribeCtx wires ctx.fetch to return this as a Response — NOT vi.mock(getLeaseStatus).
  const frame = { state: 'LEASE_STATE_ACTIVE', provision_status: 'running', phase: 'Running',
    instances: [{ name: 'web-0', status: 'running', ports: { '80': 30080 }, fqdn: 'app.example.com' }],
    endpoints: { web: 'https://app.example.com' } };
  const ctx = makeSubscribeCtx({ providerUuid: 'prov-1', statusFrames: [frame] });
  const onData = vi.fn();
  subscribeLeaseStatus(ctx, 'lease-1' as LeaseUuid, { onData, onComplete: vi.fn(), intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(1);
  const emitted = onData.mock.calls[0][0];
  expect(emitted.state).toBe(LeaseState.LEASE_STATE_ACTIVE); // string → enum (real leaseStateFromJSON)
  expect(emitted.provision_status).toBe('running');
  expect(emitted.instances[0].fqdn).toBe('app.example.com');
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `subscribeLeaseStatus.ts`:**

First, **export the classification sets from `http/fred.ts`** (they are file-local today, `fred.ts:235`/`:248`): `export const PROVISION_IN_PROGRESS` and `export const PROVISION_FAILED` — the watch reuses them so its terminal oracle never drifts from `pollLeaseUntilReady`'s.

```ts
import {
  type CapabilityCtx,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
  requireAuthSigner,
} from '@manifest-network/manifest-mcp-core';
import { createAuthTokens } from '../http/auth-tokens-factory.js';
import { getLeaseStatus, PROVISION_FAILED, PROVISION_IN_PROGRESS } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** The capability slice subscribeLeaseStatus needs: query (provider lookup) + chain (rate limit +
 *  chainId) + fetch (provider HTTP) + signer (ADR-036 status token) + logger. */
export type SubscribeCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'signer' | 'logger' | 'events'
>;

export interface SubscribeLeaseStatusOptions {
  /** Each (deduped) observed status, branded. */
  onData: (status: FredLeaseStatus) => void;
  /** Terminal reached (success OR observed lease-failure). Fires ONCE with the final status, then auto-unsubscribe. */
  onComplete?: (final: FredLeaseStatus) => void;
  /** ABNORMAL stop only: poll timeout, network, parse-failure. NOT lease-failure (→ onComplete), NOT abort (→ silent). */
  onError?: (err: unknown) => void;
  /** Caller cancellation ≡ unsubscribe: silent stop, no onError, no onComplete. */
  signal?: AbortSignal;
  /** Poll DEADLINE in ms (default 120000, matches pollLeaseUntilReady). Reaching it on a non-terminal lease → onError. */
  timeout?: number;
  /** Poll interval in ms (default 3000). */
  intervalMs?: number;
  /** false (default) = dedup onData on (state, provision_status); true = raw per-poll emit. */
  emitEvery?: boolean;
}

/** Local abortable sleep — rejects when `signal` aborts (so an abort during the interval unsubscribes). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Terminal classification, mirroring pollLeaseUntilReady (fred.ts:374-409) but returning a verdict
 *  instead of resolve/throw. Reuses the EXPORTED PROVISION_* sets so it never drifts. */
type Terminal = 'success' | 'failure' | 'pending';
function classifyTerminal(s: FredLeaseStatus): Terminal {
  switch (s.state) {
    case LeaseState.LEASE_STATE_ACTIVE: {
      const ps = s.provision_status;
      if (ps !== undefined) {
        if (PROVISION_FAILED.has(ps)) return 'failure';
        if (PROVISION_IN_PROGRESS.has(ps)) return 'pending';
      }
      return 'success'; // ACTIVE + settled/absent/unrecognized provision_status (forward-compat, like pollLeaseUntilReady)
    }
    case LeaseState.LEASE_STATE_CLOSED:
    case LeaseState.LEASE_STATE_REJECTED:
    case LeaseState.LEASE_STATE_EXPIRED:
      return 'failure';
    default:
      return 'pending'; // PENDING / UNRECOGNIZED — keep watching until terminal or the deadline
  }
}

/**
 * Watch a lease's Fred provision status by polling the provider's /v1/leases/{uuid}/status endpoint
 * (full FredLeaseStatus — provision_status/phase/instances/endpoints, which chain getLease cannot
 * observe; §5.9). A CONVERGING watch: it ALWAYS ends in exactly one of {onComplete, onError, silent
 * abort} then auto-unsubscribes. Terminal-success OR observed terminal-failure → final onData +
 * onComplete (a watched outcome is a value); the poll DEADLINE (stuck non-terminal lease) + network/
 * parse errors → onError; a caller `signal` abort → silent stop. onData dedups on (state,
 * provision_status) unless emitEvery. Returns a synchronous, idempotent unsubscribe. Poll-backed in P0
 * (ctx.events WS transport deferred). Typed-face only. (viem watch* SHAPE + Cosmos converging SEMANTICS.)
 */
export function subscribeLeaseStatus(
  ctx: SubscribeCtx,
  leaseUuid: LeaseUuid,
  opts: SubscribeLeaseStatusOptions,
): () => void {
  // Caller cancellation ONLY. `opts.timeout` is the abnormal poll DEADLINE handled in-loop (→ onError),
  // distinct from a caller abort (→ silent) — so do NOT fold opts.timeout into this signal.
  const controller = new AbortController();
  const abortSignal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeout ?? 120_000;

  let stopped = false;
  const unsubscribe = (): void => {
    if (stopped) return; // idempotent
    stopped = true;
    controller.abort();
  };

  // Dedup over (state, provision_status); the terminal status always emits (force) even if unchanged.
  let lastKey: string | undefined;
  const emit = (status: FredLeaseStatus, force = false): void => {
    const key = `${status.state}|${status.provision_status ?? ''}`;
    if (force || opts.emitEvery || key !== lastKey) {
      lastKey = key;
      opts.onData(status);
    }
  };

  void (async () => {
    let providerUrl: string;
    // ADR-036 status token (getAuthToken, the appStatus pattern — NOT getLeaseDataAuthToken). Built
    // INSIDE the setup try (N1): requireAuthSigner throws synchronously on a signer-less ctx, and the
    // contract is a synchronous, never-throwing unsubscribe return — so a signer-less ctx must surface
    // via onError, not by throwing out of subscribeLeaseStatus. signer is present on the full fred
    // client; re-minted per poll (replay-tracker safe; fresh-per-call).
    let tokens: ReturnType<typeof createAuthTokens>;
    try {
      tokens = createAuthTokens(requireAuthSigner(ctx), {
        chainId: ctx.chain.getConfig().chainId,
      });
      await ctx.chain.acquireRateLimit();
      const leaseRes = await ctx.query.liftedinit.billing.v1.lease({ leaseUuid });
      if (!leaseRes.lease) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Lease "${leaseUuid}" not found on chain`,
        );
      }
      providerUrl = await resolveProviderUrl(ctx.query, leaseRes.lease.providerUuid);
    } catch (err) {
      if (!stopped && !abortSignal.aborted) opts.onError?.(err);
      return; // setup failure — cannot poll without a provider URL (abnormal → onError)
    }

    const deadlineAt = Date.now() + timeoutMs;
    while (!stopped && !abortSignal.aborted) {
      let status: FredLeaseStatus;
      try {
        const token = await tokens.getAuthToken(leaseUuid);
        status = await getLeaseStatus(providerUrl, leaseUuid, token, ctx.fetch);
      } catch (err) {
        if (stopped || abortSignal.aborted) return; // abort during the await ≡ silent unsubscribe
        opts.onError?.(err); // abnormal (network/parse) → onError + STOP
        return;
      }
      if (stopped || abortSignal.aborted) return;

      const terminal = classifyTerminal(status);
      if (terminal !== 'pending') {
        emit(status, true); // ALWAYS emit the terminal status (bypass dedup)
        stopped = true;
        opts.onComplete?.(status); // success OR observed failure — both complete (failure is a value)
        return;
      }
      emit(status); // non-terminal: dedup-aware
      if (Date.now() >= deadlineAt) {
        opts.onError?.(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            `subscribeLeaseStatus timed out after ${timeoutMs}ms; lease ${leaseUuid} still non-terminal`,
          ),
        );
        return; // stuck non-terminal lease is LOUD (abnormal → onError), not a quiet done
      }
      try {
        await abortableSleep(intervalMs, abortSignal);
      } catch {
        return; // abort during the interval ≡ silent unsubscribe (no onError/onComplete)
      }
    }
  })();

  return unsubscribe;
}
```

- [ ] **Step 4: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(fred): add subscribeLeaseStatus poll-backed lease watch (ENG-309)"`.

---

## Task 6: `createFredClient` — bind `subscribeLeaseStatus` on the fred client

**Files:** `packages/fred/src/client.ts` (create), `index.ts` (+ `client.test.ts`).

- [ ] **Step 1: Failing tests** — `fred/src/client.test.ts`: (a) `createFredClient(fullOpts)` returns a client with all the core read+tx methods AND `subscribeLeaseStatus`; (b) `subscribeLeaseStatus` on it forwards the client as ctx (a poll emits via onData); (c) type-test (`client.test-d.ts` or inline `expectTypeOf`): `FredClient` is `ManifestClient & FredActions`; a query-only client (no signer) is NOT a `FredClient`.

```ts
it('createFredClient layers subscribeLeaseStatus over the core client', async () => {
  const client = await createFredClient({ config: fullConfig, walletProvider });
  expect(typeof client.subscribeLeaseStatus).toBe('function');
  expect(typeof client.fundCredits).toBe('function'); // inherited from ManifestClient
  expect(typeof client.getLease).toBe('function');
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `client.ts`:**

```ts
import {
  createManifestClient,
  type FullClientOptions,
  type LeaseUuid,
  type ManifestClient,
} from '@manifest-network/manifest-mcp-core';
import {
  subscribeLeaseStatus,
  type SubscribeLeaseStatusOptions,
} from './tools/subscribeLeaseStatus.js';

/** Provider-backed methods layered onto a core ManifestClient by createFredClient. */
export interface FredActions {
  subscribeLeaseStatus(
    leaseUuid: LeaseUuid,
    opts: SubscribeLeaseStatusOptions,
  ): () => void;
}

/** A full Manifest client + the Fred provider methods. */
export type FredClient = ManifestClient & FredActions;

/** The fred-action decorator: thin .bind(ctx) closures over the free fns (viem-style; ctx = the client). */
export function fredActions(ctx: ManifestClient): FredActions {
  return {
    subscribeLeaseStatus: (leaseUuid, opts) => subscribeLeaseStatus(ctx, leaseUuid, opts),
  };
}

/**
 * Create a full app client: core's chain-backed ManifestClient plus the Fred provider methods. The
 * fully-decorated factory lives in fred (not core) because subscribeLeaseStatus hits the Fred backend,
 * not the chain ctx wraps (viem one-client-one-backend rule, #2535). Requires a walletProvider.
 */
export async function createFredClient(opts: FullClientOptions): Promise<FredClient> {
  const client = await createManifestClient(opts);
  // Single Object.assign over the SAME client object (it IS the ctx the actions close over).
  return Object.assign(client, fredActions(client));
}
```

- [ ] **Step 4: Barrel-export** — `fred/src/index.ts`: add `createFredClient`, `fredActions`, `type FredActions`, `type FredClient` from `./client.js`, and `subscribeLeaseStatus`, `type SubscribeLeaseStatusOptions`, `type SubscribeCtx` from `./tools/subscribeLeaseStatus.js`. (All browser-safe: core's `createManifestClient` + fred's HTTP/auth modules carry no node-only static imports; the SSRF-guarded fetch is injected via `opts.fetch`.) Verify `FullClientOptions` is exported from core's barrel (it is the input type to `createManifestClient`); if not, add it in Task 4 Step 4.

- [ ] **Step 5: Run → pass + full-repo lint + Biome + commit.** `git commit -m "feat(fred): add createFredClient (ManifestClient & FredActions) binding subscribeLeaseStatus (ENG-309)"`.

---

## Task 7: Scorecard reconciliation + 4d close-out

**Files:** `docs/superpowers/specs/manifest-app-sdk-readiness.md`, this plan doc.

- [ ] **Step 1: Reconcile the scorecard** — read `manifest-app-sdk-readiness.md` and update the rows describing the PRE-4d baseline: tick the bound-client row (**A, ~line 31**), the executeTx/mutex row (**E, ~line 76**), and the subscribeLeaseStatus row (**H, ~line 111**) to `☑` with a one-line "landed in 4d" note (ticking A reflects the bound-method client completed by 4a–4d together). Fix the stale Row A wording "overloaded factory" → "two named factories (createManifestClient / createManifestReadClient) + the fred-layer createFredClient" (the overload was replaced 2026-06-15). Do NOT tick the "SDK package" / "example app + acceptance test" rows — those are the post-4d follow-on.

- [ ] **Step 1b: Note the residual mutex gap (N10)** — add a one-line caveat under the per-signer-mutex row (E): `packages/cosmwasm/src/index.ts:253` broadcasts via a direct `signingClient.signAndBroadcast`, bypassing BOTH `cosmosTx` and `executeTx`, so it is NOT serialized by the mutex. Out of scope for 4d (Q5 = core/fred; cosmwasm is a separate server/process today), but the "one account never races two txs" guarantee has this documented hole — track it for the cosmwasm ctx-ification follow-on.

- [ ] **Step 2: Write the 4d "Next" note** (in this plan's Next section below, already present) and confirm it points at the `@manifest-network/manifest-sdk` aggregating barrel + the SDK-direct e2e acceptance harness (the P0a gate).

- [ ] **Step 3: Full gate** — worktree root: `npm run build` (8, exit 0); **`npm run lint` (ALL packages, exit 0)** — the branded/interface ripple gate; `npx vitest run packages/` (all pass); `npm run check` (biome, exit 0).

- [ ] **Step 4: Commit.** `git commit -m "docs(sdk): reconcile readiness scorecard for the 4d bound-client surface (ENG-309)"`.

- [ ] All green ⇒ 4d done. **The CapabilityCtx keystone is COMPLETE** — ctx + ports + two named factories + bound read/tx methods + executeTx + per-signer mutex + the fred client with subscribeLeaseStatus.

---

## Self-Review (completed)

- **Spec §5.2 (bound client):** real `.bind(ctx)` methods replace the 4b shell casts; `BoundFn` derives the signatures from the free fns (drift-proof); single `Object.assign` over the final object (Q6). Read-vs-full guarantee enforced at type (`ManifestClient` requires signer) AND runtime (tx/executeTx absent on the read client) levels.
- **Spec §5.6 (executeTx + mutex):** `executeTx` is a direct multi-msg `signAndBroadcast` returning a label-free `ExecuteTxResult` (Q2), re-applying the fee/gasMultiplier guard + `validateMemo` (OI-EXEC-GUARDS); the per-signer mutex lives in `CosmosClientManager`, keyed by the chain address (OI-MUTEX-KEY), serializing BOTH `cosmosTx` and `executeTx` (Q3), acquired once around `withRetry`, mutex-outer/rate-limit-inner. The mandated height-assert is covered by the result asserting `height` (a committed `DeliverTxResponse`), and serialization tests pin same-address-sequential / different-address-parallel.
- **Spec §5.9 (subscribeLeaseStatus):** poll-backed provider-HTTP **converging watch** (OI-SUBSCRIBE-POLLSRC) — its own loop (not `pollLeaseUntilReady`) that ALWAYS ends in exactly one of {onComplete, onError, silent-abort} then auto-unsubscribes: terminal-success/observed-failure → final `onData`+`onComplete` (failure is a value); poll-deadline/network/parse → `onError`; caller-`signal` abort → silent. `onData` dedups on `(state, provision_status)` (`emitEvery` opt-out). viem watch* SHAPE + Cosmos converging SEMANTICS (research wd0swoidp; Akash/Spheron auto-stop). `requireAuthSigner` for the status token (OI-SUBSCRIBE-SIGNER); reuses the exported `PROVISION_*` sets so the terminal oracle never drifts. Bound on the fred-layer `createFredClient` (Q4 — core never imports fred), returning `ManifestClient & FredActions`. The §5.9 wire-frame contract test (real `getLeaseStatus` parse path) keeps the deferred WS boundary honest.
- **Spec §9 (cross-face):** `executeTx` + `subscribeLeaseStatus` are typed-face-only composites (no stringly equivalent) → unit tests only, no cross-face equivalence test. `cosmosTx`'s bytes are unchanged (the mutex changes only timing) → §5.8 byte-equivalence preserved.
- **Branding (Q1):** bound read methods take bare `string` (= free fns; Cosmos overrides EVM); outputs + tx inputs stay branded.
- **Tree-shaking (Q6/OI-TREE-SPLIT):** read factory (`client-factory.ts`) imports only read fn values; tx fn values isolated in `client-full.ts`; subscribe stays in fred. Browser-safety: mutex is pure-JS (no `async_hooks`); no node-only static imports added.
- **Type consistency:** `BoundFn`/`TailOf` used uniformly; `ManifestReadClient` (Task 3) → `ManifestClient extends ManifestReadClient` (Task 4) → `FredClient = ManifestClient & FredActions` (Task 6). `ExecuteTxResult` defined once (Task 2), consumed by `executeTx` + `buildExecuteTxResult`. `SubscribeLeaseStatusOptions`/`SubscribeCtx` consistent across Tasks 5–6.
- **Full-lint gate** on every code task (the interface ripple).

## Next plan

→ **The P0a acceptance follow-on** (post-keystone): stand up `@manifest-network/manifest-sdk` (the aggregating barrel + `/reads`,`/catalog`,`/deploy`,`/orchestration`,`/node` subpaths, `sideEffects:false`, `publint`/`attw`), then a NEW library-direct e2e harness (compose `createFredClient` + bound methods against the docker-compose chain — NOT the MCP-stdio `MCPTestClient`) exercising deploy → query → getLeaseConnectionInfo → setItemCustomDomain → restart/update/getLogs → **executeTx batch** → **subscribeLeaseStatus (poll)** → stopApp, single- AND multi-service, plus the browser-bundle no-node-builtins + bundle-size assertions. That e2e is the single tracked P0a metric. Then P1 (agent-core DeploySpec superset, ENG-310).
