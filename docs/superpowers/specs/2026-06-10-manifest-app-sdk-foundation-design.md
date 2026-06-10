# Manifest App SDK — Phase 0 Foundation Design

- **Status:** Draft for review (v6 — final-review corrections: per-signer serialization invariant (await-block-inclusion), `TxOptions`→`TxCallOptions` collision rename, fee precedence, `@beta`-only tags, DoD two-claims, Logger trace convention)
- **Date:** 2026-06-10
- **Owner:** Felix Morency
- **Related:** `manifest-app-sdk-readiness.md` (living scorecard, same dir); Linear epic TBD
- **Supersedes framing of:** ENG-127 (orchestration umbrella), ENG-279 (Barney migration)
- **Verification:** v2 (3-stream), v3 (streaming research + type-safety), v4 (final idiomatic review), v5 (gap analysis + versioning/logging research), v6 (final v5 idiomatic review: concurrency/sequence, options/logger/versioning, holistic). All "sound-with-tweaks", no architectural reconsideration.

---

## 1. Context & goal

`manifest-mcp-mono` today is five MCP servers + a `core` library + an `agent-core` orchestration library. The chain/Fred capabilities are real and well-tested, but they are **shaped for MCP servers** (stringly tool args, server-bound DI), and `agent-core` re-declares a **narrower** deploy type than `fred`.

**Goal:** transform the repo into a real **app-building SDK for Manifest + Fred** — building blocks any consumer (the Claude Code plugin via MCP, a browser app like Barney, a future dashboard/daemon) composes to build a full application, **reinventing nothing**.

**Acceptance test (definition of done for the whole effort):** an in-repo example app builds a deploy-, query-, **and live-status** flow composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, exercised end-to-end **against the live `e2e/docker-compose` chain + Fred provider** — zero hand-rolled client, queries, auth, pricing, orchestration, or streaming.

This document specifies **Phase 0** — the SDK foundation. Phases 1–4 and later phases are in §3.

## 2. Architecture — a layered SDK over manifestjs

```
manifestjs (codegen)   protobuf types · LCD/RPC query client · tx message composers
   ── REUSE, NEVER RE-DECLARE ──
core + fred  =  CAPABILITY TIER     the shared layer every consumer builds on
                configured client (lcd-adapter, rate-limit, retry, error model) · CapabilityCtx
                + ports (signer, fetch, logger, events?) · branded domain types
                · typed reads/txs (incl. multi-msg executeTx) · catalog/SKU/pricing · provider ops
   ──
agent-core   =  ORCHESTRATION TIER (OPTIONAL)   plan/confirm/progress/recover over the capability tier
                IoC callback contract (onPlan/onConfirm/onProgress/onComplete/onFailure)
   ──
edge adapters          manifest-mcp-agent (plugin, MCP elicitation) · manifest-sdk-react (later) · daemon
   ──
@manifest-network/manifest-sdk   aggregating barrel + scoped subpaths — the public SDK entry (Option A)
```

**Two tiers, one SDK, pick your altitude.** The **capability tier** (`fred`+`core`) is the full-fidelity building-block layer everyone uses. The **orchestration tier** (`agent-core`) is an *optional, composable* layer on top that adds plan→confirm→recover for consumers that want managed UX. This is the established SDK shape (AWS low-level client vs high-level resource; viem actions vs higher-level helpers). The original "Barney bypassed agent-core" divergence was **not** capability-vs-orchestration — it was a **type-fidelity bug** (agent-core's narrow `DeploySpec`); P1 fixes it so the orchestration tier is **loss-free and a genuine option for every consumer**, not a fork to avoid. agent-core stops being "plugin-only."

**Boundary rule (first-class):** `core` *wraps* manifestjs; it never re-declares a chain type or stands up a second query client. `core` adds only what manifestjs can't express — DI/connection, REST↔camelCase normalization, retry, error model, **branded domain types**, value-added compositions, ports, orchestration. (The `lcd-adapter` is a legitimate **Adapter**, not a forbidden second client.)

**Two faces, one implementation:** the **stringly face** (`cosmosQuery`/`cosmosTx`, the MCP/LLM surface, and the parse boundary §5.0) and the **typed face** (configured `ctx.query` + value-added typed building blocks returning **branded** types) are backed by the **same** per-module handlers — guarded by the cross-face equivalence test (§9), not just asserted.

## 3. Phases & scope boundaries

- **P0** — the SDK foundation (this doc).
- **P1** — widen `agent-core` `DeploySpec` to a faithful superset of `fred`'s `DeployAppInput`; delete `internals/build-fred-input.ts` → the optional orchestration tier becomes loss-free.
- **P2** — converge every legacy capability fn to `fn(ctx, input)`.
- **P3** — consumer adoption (Barney migrates to the SDK; deletes `src/api/` + `compositeTransactions.ts`; the plugin is already current on `manifest-mcp-node@0.14.0`).
- **P4** — deploy-saga durability (idempotency + reconcile-on-resume).
- **Later: `@manifest-network/manifest-sdk-react`** — a shared TanStack-Query-backed React-hooks package (`useLeases`/`useDeploy`/`useLeaseStatus`/`useCatalog`) over the framework-agnostic core, the wagmi `@wagmi/core`→`wagmi` shape, so Barney *and* a future dashboard share hooks instead of each rebuilding them. Sequenced **after** the core surface stabilizes (needs ≥1 React consumer to validate hook shapes) — not P0.
- **Later: live-status WebSocket transport** (the `ctx.events` WS port + isomorphic WS factory + WS-SSRF guard + frame parsing). The *streaming surface* (`subscribeLeaseStatus`) ships in P0 poll-backed (§5.9); only the WS transport is deferred. Its `EventTransport` shape is `@beta` (§14).

**Explicit P0 scope boundaries (stated, not silent):**
- **Admin/governance modules** — `x/group`, `x/tokenfactory`, `gov`, `poa`, `staking`, `distribution`, `authz`, `feegrant`, `mint`, `ibc-transfer` are reachable via the **stringly face only** in P0 (their `core/queries`+`core/transactions` handlers exist; typed Face-B wrappers are deferred until a typed admin/multisig consumer needs them). Documented boundary, not an omission.
- **cosmwasm converter** (MFX→PWR, `smartContractState`+`MsgExecuteContract`) — **out of P0**; the `cosmwasm` server stays MCP-only. (Add a typed `wasmQuery`/`wasmExecute` helper in a later phase if a consumer needs it.)
- **Chain-event subscription** (CometBFT WS) — out of scope; provision status is provider-side, not a chain event.
- **Package renames** (dropping `mcp`) — a separate cosmetic pass.

## 4. Packaging — Option A (barrel + scoped subpaths)

New package **`@manifest-network/manifest-sdk`**: an aggregating barrel re-exporting the curated surface from `core`+`fred`+`agent-core`, **+ scoped subpath entrypoints from day one** (`…/reads`, `…/catalog`, `…/deploy`, `…/orchestration`) with `"sideEffects": false`; node-only helpers (guarded fetch, WS factory, keyfile signer) via **one** `…/node` subpath with the `{ "node": …, "default": null }` browser-hard-fail guard. `publint` + `attw` in CI. Internal-only packages stay `private: true` so the public SDK can later be cut onto an independent train (§14). Released **last** on the lockstep train; the install graph must resolve **one** copy of `core`/`fred` (AWS-SDK lesson). Dual-package hazard is a non-issue (ESM-only, stateless surface).

## 5. Components

### 5.0 Type safety — branded domain types, not bare `string`

**Principle:** the typed face and all canonical SDK types use **branded (opaque) domain types** for identifiers/domain values — never bare `string`. viem encodes constraints **structurally** via template-literal types (`Hex`/`Hash` = `` `0x${string}` ``; `Address` from ABIType) + parse/assert helpers; Manifest's bech32/UUID/FQDN ids can't be cheap template literals, so we get the equivalent guarantee via **nominal brands + parse constructors**:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B }; // never exported; STRING key, not unique symbol
type Address=Brand<string,'Address'>; type Tenant=Address; type LeaseUuid=Brand<string,'LeaseUuid'>;
type ProviderUuid=Brand<string,'ProviderUuid'>; type SkuUuid=Brand<string,'SkuUuid'>;
type TierName=Brand<string,'TierName'>; type Fqdn=Brand<string,'Fqdn'>; type Denom=Brand<string,'Denom'>; type ChainId=Brand<string,'ChainId'>;
// quantities reuse manifestjs Coin { denom, amount }; never a bare string amount
```

- **String `__brand` key, not `unique symbol`** — a `unique symbol` brand is non-assignable across *duplicated* package copies (the worktree dep-drift hazard CLAUDE.md documents for `ipaddr.js`); type-fest reverted symbol→string for exactly this (PR #875).
- **`Tenant = Address`** is an intentional transparent alias; branding does not distinguish tenant from address (the §9 fixture covers *distinct* brands).

**Parse, don't validate.** `parse*`/`as*` constructors are the **only** sanctioned brand producers; the lone `as Brand` cast lives **only inside `brands.ts`** (enforced by §8). Existing `validateAddress`(void)/`requireUuid`(string) are *validators*, so each constructor wraps them. `parseFqdn` is **net-new** (no existing client-side FQDN validator — FQDN is chain-validated today) — a minimal structural check (non-empty, has a dot, lowercased); the chain stays authoritative.

**Boundary policy by trust** (brands are runtime-erased, so re-applied at every runtime boundary):

| Boundary | Policy |
|---|---|
| Stringly/MCP face (LLM args) | **parse + validate** → brand (single semantic-validation site) |
| Chain/codegen reads (`ctx.query`/lcd-adapter) | **brand by trust-cast** at the mapping site — no re-validation (chain is source of truth; viem casts JSON-RPC outputs likewise); never throws `INVALID_*` |
| Provider-HTTP reads (Fred: `FredLeaseStatus`, deploy/catalog) | **parse + validate** (provider untrusted) when surfacing as a branded id |
| Wallet-in (`WalletProvider.getAddress(): string`) | **parse once** in the Signer adapter (§5.3) |
| Persisted-state `JSON.parse` | **re-brand** on load |

`string` survives only: (a) the stringly face (immediately parsed); (b) manifestjs codegen types; (c) provider wire types (`FredLeaseStatus`) whose string fields are opaque provider state.

**Considered & declined for P0:** Zod `.brand()` (conflicts with §7 no-new-error-model; not a dep; bundle weight) and type-fest `Tagged` (dep on the foundational module for ~8 zero-dep lines). Revisit if broader schema validation is adopted.

### 5.1 Canonical types in `core` (over manifestjs)

Single chokepoint `core/src/manifest-types.ts` (only file importing manifestjs generated type paths; type-only re-exports). Canonical (id fields branded): `DeployAppInput`, `ServiceConfig`, `PortConfig` (**net-new**, ENG-282 `{ host_port?; ingress? }`), `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult`, `DeployManifestInput`/`DeployAppResult`, manifest-preview input, **`SkuIntent`** (unified `byName | resolved`), and **`FredLeaseStatus`** (relocated; id fields branded, opaque-state fields stay `string`). `fred`/`agent-core` derive; `agent-core`'s narrow fields coexist until P1 (the §8 guard exempts them).

### 5.2 `CapabilityCtx` + `createManifestClient`

```ts
interface CapabilityCtx {
  chain: CosmosClientManager;     // connection, signing, rate-limit, retry, per-signer broadcast serialization (§5.6)
  query: ManifestQueryClient;     // configured manifestjs LCD/RPC client (raw typed reads)
  signer?: Signer;                // §5.3; absent in query-only mode
  fetch: typeof globalThis.fetch; // injected (guarded on node, providerFetch in browser)
  logger: Logger;                 // §5.3; noopLogger by default (silent)
  events?: EventTransport;        // @beta, DEFERRED (§5.9); absent ⇒ poll fallback
}
type QueryCtx = Omit<CapabilityCtx, 'signer'>;

function createManifestClient(opts: { config; walletProvider: WalletProvider; fetch?; logger?; logLevel?; skuSpecs?; events? }): CapabilityCtx;
function createManifestClient(opts: { config; fetch?; logger?; logLevel?; skuSpecs?; events? }): QueryCtx;

// Per-call option bags (TxCallOptions is DISTINCT from core's existing internal `TxOptions`/`TxOverrides`):
type CallOptions   = { signal?: AbortSignal; timeout?: number };  // timeout bounds the request/confirmation wait
type TxCallOptions = CallOptions & { gasMultiplier?: number; fee?: StdFee; memo?: string };
// signal+timeout merge: SDK derives the effective signal via AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeout)]).
// fee precedence: explicit `fee` WINS (skips simulate/gasMultiplier/gasPrice; the one path valid WITHOUT a configured
// gasPrice); `gasMultiplier` applies only on the simulate path; both set = caller error. Per-call gasPrice is deferred
// (cosmjs#1526 unresolved upstream) — use explicit `fee`.
```

`ctx.query` inherits `CosmosClientManager`'s restUrl-preferred routing unchanged. Overloaded factory → query-only consumers get a **compile error** reaching for `signer` (runtime `INVALID_CONFIG` backstop for the stringly path). **ISP:** reads take `(ctx: Pick<CapabilityCtx,'query'|'chain'|'logger'>, input, opts?: CallOptions)`; txs/provider ops take the slice incl. `signer`/`fetch`/`logger` + `opts?: TxCallOptions`. `EventTransport` (§5.9) is forward-declared and `@beta`.

### 5.3 Ports

**`Signer`** (interface-segregated; `OfflineSigner` is **`@cosmjs/proto-signing`'s** — the `@manifest-network/stargate` fork overrides `@cosmjs/stargate`, not proto-signing):

```ts
interface TxSigner   { getAddress(): Promise<Address>; getSigner(): Promise<OfflineSigner>; }
interface AuthSigner extends TxSigner { signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>; }
type Signer = AuthSigner;
```

`Signer` is an SDK-surface **adapter over the concrete `WalletProvider`** (whose `getAddress(): string`): the adapter `parseAddress`es the address once, so the port exposes `Address` while the edge impl keeps `string`. `requireAuthSigner(ctx)` narrows once at the boundary. Impls at the edge (node keyfile/mnemonic; browser CosmosKit); `core` never holds a key.

**Auth-token factory** — `createAuthTokens(signer: AuthSigner, { chainId: ChainId }) → { getAuthToken, getLeaseDataAuthToken }` (lazily cached, re-signed on expiry; wraps `fred`'s `AuthTokenService`). Replaces Barney's `makeFredAuthTokens`.

**`fetch`** — on `ctx`; guarded-undici (node subpath) / `providerFetch` (browser).

**`Logger`** — **silent by default, optional injectable, per-instance** (the AWS-SDK-v3 / smithy model; NOT the current global mutable `console.error` singleton, which stays an internal detail of the MCP servers/CLI only):

```ts
interface Logger { trace?(...a: unknown[]): void; debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; } // structural — compatible with console/pino/winston/smithy
const noopLogger: Logger = Object.freeze({ debug(){}, info(){}, warn(){}, error(){} });
```

Resolution: `ctx.logger = opts.logger ?? noopLogger`; the **level gate lives in the SDK** (it never calls `logger.debug` below the configured `logLevel`, default quiet, so passing raw `console` isn't flooded) and the **sink is the injected logger** (the AWS-v3 smithy `Logger` / `ts-log` `dummyLogger` prior art). SDK code calls the optional `trace` level only via `ctx.logger.trace?.(…)` (the frozen `noopLogger` omits it). Level + sink are **per-ctx, never process-global**. The neutral core must never reference `console`/`process.env`/`node:process`/`globalThis` for logging — only `ctx.logger`. The node CLI bootstrap keeps env-driven behavior by constructing each ctx with `{ logger: <adapter over the existing core singleton>, logLevel: fromEnv(LOG_LEVEL) }` (env reading stays in node bootstrap, mirroring `MANIFEST_*_FETCH_GUARDED`). `Logger`/`noopLogger`/`LogLevel` are `@public`; a future structured `onLog`/observability hook stays separate from the `@beta` `EventTransport`.

### 5.4 Reads — two faces (every typed read takes `opts?: CallOptions`)

- **Stringly:** `cosmosQuery(...)` — unchanged.
- **Raw typed:** `ctx.query.liftedinit.billing.v1.leases({...})` — manifestjs, no wrapper.
- **Value-added typed building blocks (`core`)** — unify the existing lease-server handlers + Barney typed fns; return types brand id fields by trust-cast. Inventory:
  - **Balances/credit/account:** `getBalance` (+runway), **`getAllBalances`** (all denoms), `getCreditAccount`, `getCreditEstimate`, `getCreditAddress`, `getAccountInfo`.
  - **Leases/withdrawables:** `getLeasesByTenant({ state?, pagination? })`, `getLease`, `getLeasesByProvider`, `getLeasesBySKU`, `getWithdrawableAmount`, `getProviderWithdrawable`, `getAllLeases`/`getAllCredits`, `getBillingParams`.
  - **SKU/provider:** `getProviders`, **`getProvider(uuid)`**, `getSKUs`, **`getSKU(uuid)`**, `getSKUsByProvider`, `getSKUParams`.
  - **Custom-domain reads (the read side of `setItemCustomDomain`):** `getLeaseByCustomDomain(fqdn)`, **`getLeaseItemsForLease`**, **`getDomainAssignments`**, **`getDomainForService`**, **`getDomainCount`** (pure helpers over `Lease.items`), and **`getReservedDomainSuffixes`** (the off-chain reserved-suffix projection of params, for client-side FQDN pre-validation that `parseFqdn` defers to the chain).
  - **`paginateAll(ctx, pageFn, { maxPages })`** — net-new exhaustion helper (follows `nextKey`, rate-limit-aware). Note: `getLeasesByTenant` exposes cursor (`nextKey`) pagination; the old `lease_history` offset/limit UX maps onto it via the consumer (documented, not a separate block).

Note (sizing, not a gap): `getProviderWithdrawable`/`getLeasesByProvider`/`getLeasesBySKU`/`getAllLeases`/`getAllCredits` have **no current live consumer** — anticipatory provider/dashboard surface, not load-bearing for the acceptance test.

### 5.5 Catalog / SKU / pricing + customizable spec-map

- `browseCatalog` — canonical, **stays in `fred`** (provider HTTP); re-exported. **`getProviderHealth`** is also re-exported standalone (a dashboard checking one provider's health needs it independently).
- `resolveSku` / `listSkuCandidates` — `core`.
- **New pure `core` helpers** (no HTTP — safe in neutral core): `selectCheapest`, `normalizeHourlyPrice`, the tier-spec join over `SkuSpecSource = SkuSpecMap | ((ctx) => Promise<SkuSpecMap>)` (memoized; factory gets `ctx` to reuse `ctx.fetch`).

### 5.6 Transactions — two faces (every typed tx takes `opts?: TxCallOptions`; **fee/gas/memo are preserved**, not dropped — required for §5.8 byte-equivalence)

- **Stringly:** `cosmosTx` / `cosmosEstimateFee` — unchanged.
- **Typed building blocks (`core`):**
  - `fundCredits(ctx, { amount, tenant? }, opts?)`, `setItemCustomDomain(ctx, { leaseUuid; customDomain: Fqdn; serviceName? } | { leaseUuid; clear: true; serviceName? }, opts?)` (discriminated clear, never `''`; the only domain write), `stopApp(ctx, { leaseUuid }, opts?)` (**IS** close-lease — one fn).
  - **`executeTx(ctx, msgs: EncodeObject[], opts?: TxCallOptions)`** — **net-new multi-message** building block and the **PRIMARY way to batch** operations from one signer: a Cosmos tx natively carries `messages[]`, so a batch is **one atomic tx with N messages** (single sequence, single fee; **all-or-nothing** — one failing message rolls back the whole tx). `signAndBroadcast` already takes `EncodeObject[]`. The typed building blocks expose `build*Msg`/`EncodeObject` variants so callers batch **typed** messages (`executeTx(ctx, [buildFundCreditsMsg(...), buildSetDomainMsg(...)])`), not raw protobuf; it is also the sanctioned typed-face path to the deferred admin/gov/wasm messages (§3). P0 batches share a single signer set.
  - a **faucet** helper (drip + verify).
- **Per-signer broadcast serialization** (in `CosmosClientManager`) — for **independent** txs, when one atomic `executeTx` isn't possible: an async mutex/queue keyed by signer `Address` serializes the **whole** cycle — **simulate/estimate-fee → sign → broadcast → AWAIT BLOCK INCLUSION** (cosmjs default `signAndBroadcast`/`broadcastTx`, which polls to commit). The lock is *sufficient* precisely because cosmjs reads the **committed** account sequence (`getSequence → auth.account`) on every call with **no caching**: holding it through commit guarantees the next queued tx reads an already-incremented sequence, so **one account never races two txs into the same block** (sequence-mismatch protection). `signAndBroadcastSync`/`broadcastTxSync` (CheckTx-only, pre-commit) **MUST NOT** be used under this lock — the committed sequence hasn't advanced, so the next tx reads a stale sequence and fails "account sequence mismatch". A failed/timed-out tx still **releases the lock**; because we re-query the committed sequence each call there is **no** local counter to reset (a robustness win over the ethers/viem local-increment NonceManager). Different signers run in parallel; the mutex is orthogonal to the global rate limiter (document the acquire order). *Rationale: Cosmos uses one monotonic account sequence and proposer/priority-mempool reordering makes optimistic concurrent submission from one signer unsafe; the unordered-tx/parallel-nonce work (cosmos-sdk#13009) is not relied upon.* A **test asserts the queue awaits a committed `DeliverTxResponse` (has `height`)**, not a sync hash. Replaces Barney's hand-rolled signing mutex.

### 5.7 Fred provider ops (re-exported; provider responses parsed/branded at the read boundary)

`deployManifest`/`deployApp`/`buildManifest`/**`validateManifest`**/**`buildManifestPreview`**/**`checkDeploymentReadiness`**/`restartApp`/`updateApp`/`getAppLogs`/`appStatus`/`waitForAppReady`/`uploadLeaseData`/`pollLeaseUntilReady`, plus the **diagnostics/connection reads** behind `app_diagnostics`/`app_releases`/`app_status`: **`getLeaseConnectionInfo`** (the live app URL — "where is my app running"), **`getLeaseProvision`**, **`getLeaseReleases`**, **`getLeaseInfo`**. (The validate/preview/readiness *functions* are now listed alongside their already-relocated result types from §5.1.) ctx-ifying the positional DI is P2.

### 5.8 MCP servers as thin callers (back-compat)

Thin callers must be **byte-equivalent substitutions** (incl. the preserved fee/gas/memo `opts`), gated by **BOTH** the annotation/`_meta` matrix tests **AND** each server's behavioral `*.test.ts` (response shape, error text, canonicalization/trims) + a pre-refactor JSON snapshot. The MCP `inputSchema` stays a thin structural gate; semantic validation lives once in the `parse*` constructors inside the shared handler. **P0 converts only enough servers to prove the pattern (the fred + lease servers that back the acceptance test); the remaining servers convert in P2** — full 5-server conversion is not gated into P0.

### 5.9 Live status — streaming building block (surface in P0, WS transport deferred)

Barney's `connectLeaseEvents` is a **provider (Fred) WebSocket** carrying `provision_status` — the same data `pollLeaseUntilReady` polls. viem `watch*` idiom (one surface, swappable transport):

```ts
function subscribeLeaseStatus(
  ctx: Pick<CapabilityCtx, 'query'|'chain'|'fetch'|'signer'|'logger'|'events'>,
  leaseUuid: LeaseUuid,
  opts: { onData(s: FredLeaseStatus): void; onError?(e: unknown): void; signal?: AbortSignal; timeout?: number },
): () => void; // unsubscribe
```

callback-in / **idempotent synchronous unsubscribe-out** + optional `AbortSignal` (abort ≡ unsubscribe, no `onError`; double-unsubscribe is a no-op). Needs `signer` (the poll transport mints the Fred lease-data token via `createAuthTokens(requireAuthSigner(ctx))`, like `appStatus`). Transport swappable behind the one surface: `ctx.events` if present, else `pollLeaseUntilReady`; **both parse each frame/response into branded `FredLeaseStatus` before `onData`** (a frame that fails to parse → `onError`, no crash). **P0 ships poll-backed; the WS transport is deferred** (§3) — its `EventTransport` is `@beta` (forward-declared), and swap-equivalence is a named-phase acceptance criterion, **not** proven at P0. Lives in `fred`; not on the stringly/MCP face.

## 6. Data flow

- **Query:** `createManifestClient(...)` → `getLeasesByTenant(ctx, asTenant(addr), { state }, { signal })` → `Lease[]`.
- **Deploy:** `resolveSku` → `buildManifest` → `validateManifest` → `deployManifest(ctx, …)` → `DeployAppResult`; show URL via `getLeaseConnectionInfo`.
- **Batch:** `executeTx(ctx, [msg1, msg2, …], { gasMultiplier })` — one atomic multi-message tx; concurrent calls per signer serialized.
- **Live status:** `const stop = subscribeLeaseStatus(ctx, leaseUuid, { onData })` — poll-backed today, WS later, identical caller code.

## 7. Error handling

Preserve `ManifestMCPError` + `ManifestMCPErrorCode` + `sanitizeForLogging` + retry classification. `parse*` constructors throw existing `INVALID_*`; chain/codegen read brands are trust-casts (never throw); provider-HTTP read brands reuse the `INVALID_*` throws. No new error model.

## 8. Isomorphic / build constraints + boundary enforcement

`platform:neutral` + dynamic-import-gated node code; `"sideEffects": false` end-to-end; node-only behind `…/node` (`"default": null`); `publint`+`attw`. **`dependency-cruiser`:** (a) only `core/src/manifest-types.ts` imports manifestjs type paths; (a′) branded types declared only in `core/src/brands.ts` and re-exported, the lone `as Brand` cast only there; (b) only `core` constructs the LCD/RPC client; (c) the whole DAG `edge → agent-core → core → manifestjs`. Semantic "narrower re-declaration" relies on the single-source type + `tsc` (not a grep). The guard ships meta-tests (known-bad fixtures: duplicate manifest-type **and** duplicate `Brand`). Public API surface is enforced by **Microsoft API Extractor** release tags (§14).

## 9. Testing & acceptance

- Unit tests per building block; **branded-type** tests (`parse*` round-trip/reject; tsd negative fixture for the `LeaseUuid`/`ProviderUuid`/`SkuUuid` trio; a **read-boundary fixture** that `ReturnType<getLease>.uuid` is `LeaseUuid` not `string`); **cross-face equivalence** (same input → equivalent result; a malformed id rejected by BOTH faces with the same `ManifestMCPErrorCode`).
- **The acceptance test (single tracked metric, P0):** an in-repo example app composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, run **end-to-end against the existing `e2e/docker-compose.yml` (live chain + providerd + faucet)** via the `e2e/deploy-roundtrip` harness — exercising **deploy → query → getLeaseConnectionInfo → setItemCustomDomain → restart/update/getLogs → executeTx batch → subscribeLeaseStatus (poll) → stopApp**, covering single-service *and* a multi-service stack. **Additionally** build the same example **for the browser** and assert the emitted chunk has no node builtins (`node:`/`async_hooks`/`undici`/`ws`/`fs`) + a bundle-size budget. (Two distinct claims: it *deploys* — e2e; it *bundles for browser* — build.) The annotation/`_meta` matrix + converted-server behavioral suites stay green.

## 10. Migration & back-compat

- **Additive:** new `manifest-sdk` + new `core` modules; existing packages keep working. Brands are structurally `string`, so existing `string` call sites keep compiling during incremental migration.
- `fred` re-exports relocated types; `agent-core` narrow types coexist until P1.
- Servers convert to thin callers incrementally (P0 proves the pattern, P2 finishes), gated by §5.8.
- **Barney** migrates to the SDK in P3 (we accept it adopts the SDK surface directly rather than special-casing its in-flight ENG-279 work) and may opt into the orchestration tier; the **plugin** consumes the orchestration tier via the MCP adapter.

## 11. Risks & mitigations

- **Browser-bundle regression** (node leak incl. `ws`) → example browser build (no-node-builtins + size budget) + `dependency-cruiser` + `publint`/`attw`.
- **Branded-type friction** → one-way `string`-assignable, incremental; the cast is contained.
- **WS-SSRF + hostile frame** → deferred `ctx.events` node factory reuses the `ipaddr.js` unicast guard + the same frame parse as poll.
- **Upstream codegen/fork coupling (public-SDK stability risk):** "reuse never re-declare" makes the public type surface a passthrough of `manifestjs` (Telescope codegen) + the `@manifest-network/stargate` CosmJS fork — a codegen bump can break public types with no insulation. Mitigate via the API-Extractor release-tag layer + staying 0.x (§14), pin manifestjs/fork exactly, track the elliptic/protobufjs CVE posture from the earlier review, and gate bumps on the acceptance e2e.
- **Type-relocation churn**, **dual-face drift**, **ENG-282** → as before (chokepoint re-exports; cross-face equivalence test; canonical `PortConfig`).

## 12. Open questions (resolved)

1. `browseCatalog` stays in `fred`; pricing helpers pure. 2. `SkuSpecSource` memoized union w/ `ctx`. 3. One `…/node`. 4. Streaming: poll-backed surface P0, WS transport deferred (`@beta`). 5. Branding: hand-rolled `Brand` (Zod/type-fest declined). 6. **Versioning/stability:** lockstep + 0.x + API-Extractor release tags (§14). 7. **Logging:** silent-by-default injectable `Logger` port (§5.3). 8. **React bindings:** a later-phase `manifest-sdk-react` package (§3). 9. Linear epic + per-phase issues filed once approved (mind the free-tier issue cap — file the epic + per-phase issues; keep per-deliverable items as checklist entries, not issues).

## 13. Phase 0 deliverables checklist

- [ ] `@manifest-network/manifest-sdk` — barrel + scoped subpaths + `…/node` (`"default": null`) + `sideEffects:false` + release wiring; internal packages `private:true`
- [ ] Branded domain types (`core/src/brands.ts`) + `parse*`/`as*` (`parseFqdn` net-new structural check); cast only here; boundary policy by trust
- [ ] Canonical types → `core/src/manifest-types.ts` (chokepoint, type-only); `SkuIntent` unified; `PortConfig` net-new; `FredLeaseStatus` relocated
- [ ] `CapabilityCtx`/`QueryCtx` + overloaded `createManifestClient`; `CallOptions`/`TxCallOptions` (fee-wins precedence; `AbortSignal.any` merge) threaded through every typed read/tx/subscribe; `EventTransport` forward-declared (`@beta`)
- [ ] `TxSigner`/`AuthSigner` (`OfflineSigner` = `@cosmjs/proto-signing`) + `requireAuthSigner` + `Signer` adapter over `WalletProvider` + `createAuthTokens(signer,{chainId})`; `fetch` on `ctx`
- [ ] **`Logger` port** (silent `noopLogger` default, per-ctx level, injectable, isomorphic) + node-bootstrap adapter over the legacy singleton
- [ ] Value-added typed reads incl. the **full read surface**: balances/credit/account, leases/withdrawables, sku/provider (+singles), **custom-domain reads** (`getLeaseItemsForLease`/`getDomainAssignments`/`getDomainForService`/`getDomainCount`/`getReservedDomainSuffixes`), `paginateAll`
- [ ] Typed txs (fee/gas/memo preserved) + **`executeTx` multi-message** + **per-signer broadcast serialization** + faucet
- [ ] `selectCheapest`/`normalizeHourlyPrice`/tier-spec join (pure; memoized `SkuSpecSource`); `getProviderHealth` standalone
- [ ] Fred ops incl. **`validateManifest`/`buildManifestPreview`/`checkDeploymentReadiness`** + **`getLeaseConnectionInfo`/`getLeaseProvision`/`getLeaseReleases`/`getLeaseInfo`**
- [ ] **`subscribeLeaseStatus`** (poll-backed; signer slice; parse-each-emit; `ctx.events?` deferred)
- [ ] `dependency-cruiser` boundary + brands.ts chokepoint + DAG guard (meta-tests) + `publint`/`attw` + **API Extractor** release-tag enforcement (§14)
- [ ] Cross-face equivalence + branded-type negative + read-boundary fixtures
- [ ] Example app + **e2e acceptance** against `e2e/docker-compose` (deploy/query/connection/domain/restart/update/logs/batch/subscribe/stop, single + stack) + browser-build (no-node-builtins + size budget)
- [ ] Servers refactored to thin callers — **fred + lease in P0** (rest P2); behavioral suites + matrix green; JSON snapshots; `inputSchema` thin
- [ ] SDK author guide **+ fix the stale docs debt** (`SECURITY.md`/`docs` "four servers"; agent README `PLAN.md` 404)
- [ ] Versioning/stability policy applied (§14): 0.x lockstep, release tags, `EventTransport` `@beta`

## 14. Versioning & stability policy

`manifest-sdk` ships **lockstep-versioned** with the monorepo (cosmjs/Angular model; idiomatic for a tightly-coupled facade) and remains **0.x through P0**, making **no SemVer guarantee** at the package level — exactly the cover the forward-declared `EventTransport` needs (SemVer §4). Per-symbol stability is governed by **TSDoc release tags enforced by Microsoft API Extractor** (orthogonal to the package version): **`@public`** = supported (post-1.0, no breaking change without a major bump) — the ~30 settled fns, `CapabilityCtx`, branded types, `Logger`; **`@beta`** = unstable preview that may change or be removed at any minor/patch — the `EventTransport` streaming shape ships `@beta` until finalized (API Extractor recognizes only `@alpha`/`@beta`/`@public`/`@internal`; `@experimental` is not a release tag and would fail the gate); **`@internal`** = cross-package, never for third parties. The real enforcement at 0.x is **API Extractor's `.api.md` API-report diff in CI** (an intentional surface change is a reviewed commit), not the package version. Public symbols are removed only via a **`@deprecated` grace period of ≥1 minor release** (never deleted in the same release they're deprecated) — a self-imposed courtesy during 0.x (SemVer compels nothing) that becomes binding at 1.0. The deferred `EventTransport` graduates `@beta`→`@public` **before** we cut a **1.0** (which turns `@public` into a binding SemVer contract). Internal-only packages stay `private:true` so the public SDK can later be cut onto an independent changesets `fixed` group without churn, and the install graph must resolve **one** copy of `core`/`fred`.
