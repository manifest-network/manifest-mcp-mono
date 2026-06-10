# Manifest App SDK — Phase 0 Foundation Design

- **Status:** Draft for review (v3 — adds branded-type-safety principle + the live-status streaming building block)
- **Date:** 2026-06-10
- **Owner:** Felix Morency
- **Related:** `manifest-app-sdk-readiness.md` (living scorecard, same dir); Linear epic TBD
- **Supersedes framing of:** ENG-127 (orchestration umbrella), ENG-279 (Barney migration)
- **Verification:** v2 passed a 3-stream pass (code fact-check + completeness critique + online idiomatic audit, all sound-with-tweaks). v3 folds in the streaming-idiom research and the type-safety directive.

---

## 1. Context & goal

`manifest-mcp-mono` today is five MCP servers + a `core` library + an `agent-core` orchestration library. The chain/Fred capabilities are real and well-tested, but they are **shaped for MCP servers** (stringly tool args, server-bound dependency injection), and `agent-core` re-declares a **narrower** deploy type than `fred`. That narrowness is why Barney abandoned `agent-core` and now maintains a near-complete **parallel** chain stack (~19 source files under `src/api/` + a 2,845-line `compositeTransactions.ts`).

**Goal:** transform the repo into a real **app-building SDK for Manifest + Fred** — building blocks any consumer (the Claude Code plugin via MCP, a browser app like Barney, a future dashboard/daemon) composes to build a full application, **reinventing nothing**.

**Acceptance test (definition of done for the whole effort):** an in-repo example app builds a deploy-and-query flow composing **only** `@manifest-network/manifest-sdk` + `manifestjs` — zero hand-rolled client, queries, auth, pricing, or orchestration.

This document specifies **Phase 0** — the SDK foundation. Phases 1–4 are out of scope here (see §3).

## 2. Architecture — the hexagon over manifestjs

```
manifestjs (codegen)   protobuf types · LCD/RPC query client · tx message composers
   ── REUSE, NEVER RE-DECLARE ──
core (value layer)     configured client (LCD↔camelCase adapter, rate-limit, retry, error model)
                       · CapabilityCtx + ports (signer, fetch, events?) · branded domain types
                       · value-added typed reads/txs · catalog/SKU/pricing
   ──
agent-core             orchestration: deploy/manage/troubleshoot/close
                       over the IoC callback contract (onPlan/onConfirm/onProgress/onComplete/onFailure)
   ──
edge adapters          manifest-mcp-agent (plugin) · React bindings (Barney) · future dashboard/daemon
   ──
@manifest-network/manifest-sdk   aggregating barrel + scoped subpaths — the public SDK entry (Option A)
```

**Boundary rule (first-class):** `core` *wraps* manifestjs; it never re-declares a chain type or stands up a second query client. Raw typed reads go to the configured manifestjs client (`ctx.query`); `core` adds only what manifestjs can't express — connection/DI, REST↔camelCase normalization, retry, the error model, **branded domain types**, value-added compositions, ports, and orchestration. (The textbook Telescope/ts-proto idiom: re-export curated types from one module, wrap *behavior* not *declarations*. The `lcd-adapter` is a legitimate **Adapter**, not a forbidden second client.)

**Two faces, one implementation:**
- **Stringly face** — `cosmosQuery` / `cosmosTx` (`args: string[]` → JSON): the MCP/LLM surface. It is also the **parse boundary** (§5.0): it parses `string` → branded domain types before reaching the shared handlers.
- **Typed face** — the configured manifestjs client (`ctx.query`) + value-added typed building blocks that take/return **branded domain types**: the app-author surface.

Both backed by the **same** per-module handlers in `core/queries/*` and `core/transactions/*` — **the load-bearing invariant** (the AWS client-vs-resource / Stripe typed-vs-`rawRequest` pattern; idiomatic *because* logic isn't forked). It is **guarded** by a cross-face equivalence test (§9), not just asserted; validation/normalization/error-mapping lives in the shared handler. The stringly face is **not** auto-generated from the typed one (it is necessarily dynamic — LLM-supplied args).

## 3. Non-goals (later phases)

- **P1** — widen `agent-core` `DeploySpec` to a faithful superset of `fred`'s `DeployAppInput`; delete `internals/build-fred-input.ts`.
- **P2** — converge every legacy capability fn to `fn(ctx, input)`.
- **P3** — consumer adoption (Barney deletes `src/api/` + `compositeTransactions.ts`; the plugin is already current on `manifest-mcp-node@0.14.0`).
- **P4** — deploy-saga durability (idempotency + reconcile-on-resume).
- **Live-status WebSocket transport** (the `ctx.events` WS port + isomorphic WS factory + WS-SSRF guard) — **deferred to a named later phase.** Note: the *streaming building-block surface* (`subscribeLeaseStatus`) **does** ship in P0, backed by polling; only the WS transport behind it is deferred (§5.9). Barney keeps its `connectLeaseEvents` WS until then; it becomes the `ctx.events` transport with no surface churn.
- **Chain-event subscription** (CometBFT/Tendermint WS for on-chain lease-tx watching) — out of scope; provision status is provider-side, not a chain event. Reserve cosmjs's WS client for a future "watch lease tx on-chain" feature.
- **Package renames** (dropping `mcp`) — a separate cosmetic pass. Phase 0 uses **Option A**.

## 4. Packaging — Option A (barrel + scoped subpaths)

A new package **`@manifest-network/manifest-sdk`**: an aggregating barrel that re-exports the curated public SDK surface from `core` + `fred` + `agent-core`. Existing package names unchanged; the release pipeline gains one package (published **last**, after its deps).

Ship **scoped subpath entrypoints from day one** alongside the barrel (every leading SDK does — viem `.` + ~25 subpaths, wagmi `wagmi`/`/actions`/`/query`, AWS SDK v3 modular): `@manifest-network/manifest-sdk` (barrel) + `…/reads`, `…/catalog`, `…/deploy`, `…/orchestration`, and set **`"sideEffects": false`** on the SDK package (verify each intermediate package keeps it). This de-risks the barrel-file tree-shaking pitfall (an aggregating barrel over 3 upstream packages is the highest-risk shape; `sideEffects:false` alone does not reliably rescue it) and keeps the browser example app's bundle small. Reversible-compatible with a later rename.

Node-only helpers (guarded fetch, the WS factory, keyfile signer) are exposed via **one** `node`-conditioned subpath `@manifest-network/manifest-sdk/node`, replicating `core`'s existing guard verbatim: `{ "types": …, "node": …, "default": null }` — `"default": null` makes a browser/bundler resolution **fail loudly** instead of dragging undici/`ws`/`node:async_hooks` into the graph. Add **`publint` + `attw`** as CI-only checks (tsdown supports both). The dual-package hazard is a non-issue (ESM-only, stateless re-exported surface).

## 5. Components

### 5.0 Type safety — branded domain types, not bare `string`

**Principle:** the typed face and all canonical SDK types use **branded (opaque) domain types** for identifiers and domain-meaningful values — never bare `string`. This is the viem idiom (`Address` = `` `0x${string}` ``, `Hash`, `Hex` are branded; every typed action takes them with parse/assert helpers). It makes "lease uuid where a provider uuid was expected", "raw user string used as an address", and unit mix-ups **compile errors**.

Define them **once** in `core` (e.g. `core/src/brands.ts`), exported via the SDK barrel:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type Address     = Brand<string, 'Address'>;     // bech32 manifest1…
type Tenant      = Address;                       // a tenant IS an address
type LeaseUuid   = Brand<string, 'LeaseUuid'>;
type ProviderUuid= Brand<string, 'ProviderUuid'>;
type SkuUuid     = Brand<string, 'SkuUuid'>;
type TierName    = Brand<string, 'TierName'>;     // SKU/size name, e.g. 'docker-small'
type Fqdn        = Brand<string, 'Fqdn'>;         // custom domain
type Denom       = Brand<string, 'Denom'>;
type ChainId     = Brand<string, 'ChainId'>;
// amounts/coins reuse manifestjs Coin; never a bare string for a quantity
```

**Parse, don't validate** — provide constructor/guards that validate **once** at the boundary and return the branded type, reusing existing validators (`validateAddress`, the RFC-4122 UUID check, FQDN validation): `parseAddress(s): Address`, `asLeaseUuid(s): LeaseUuid`, … (throwing `ManifestMCPError(INVALID_*)` on bad input). Internally a brand is assignable to `string`, so passing a branded id **into** the manifestjs client is free; reading a `string` **out** of a codegen response and exposing it on an SDK type goes through the parser at that boundary.

**Interaction with the two boundaries:**
- **manifestjs codegen types keep their generated `string` fields** — we do **not** re-declare or re-brand them (the §2 boundary rule). Branding lives on **our** surface: building-block params/returns, the canonical types (`DeployAppInput`, `SkuIntent`, `DeployAppResult`, …), and `ctx`.
- **The stringly face is the parse boundary.** `cosmosQuery`/`cosmosTx` and the MCP tools take `string` (LLM-supplied) and call the `parse*`/`as*` constructors to produce branded ids before reaching the shared handlers — so validation lives once and the typed face never sees an unvalidated `string`. (Literally "parse, don't validate": the stringly→branded conversion *is* the parse step.)

This principle applies to **every** signature in §§5.2–5.9 and §13: identifiers and domain values are branded; `string` survives only as raw LLM input on the stringly face (immediately parsed) and inside manifestjs codegen types.

### 5.1 Canonical types in `core` (over manifestjs)

Relocate the value types into a **single chokepoint module** `core/src/manifest-types.ts` — the *only* file permitted to import manifestjs generated type paths — re-exported by `fred`, `agent-core`, and the SDK barrel. Re-exports of manifestjs protobuf types (`Lease`, `SKU`, `Provider`, `CreditAccount`, `Coin`) are **type-only** (`export type { … }`) so no generated runtime/encoder code leaks into the browser barrel. The single chokepoint makes the §8 CI import-rule trivial and exact.

Types to own canonically (fields branded per §5.0 — e.g. `DeployAppResult.leaseUuid: LeaseUuid`, `…providerUuid: ProviderUuid`):
- `DeployAppInput`, `ServiceConfig` (`fred/src/tools/deployApp.ts`), `BuildManifestOptions` / `ManifestFormat` / `ManifestValidationResult` (`fred/src/manifest.ts`), `DeployManifestInput` / `DeployAppResult` (`fred/src/tools/deployManifest.ts`), the manifest-preview input (`fred/src/tools/buildManifestPreview.ts`).
- **`SkuIntent`** = `{ kind: 'byName'; size: TierName; providerUuid?: ProviderUuid; skuUuid?: SkuUuid } | { kind: 'resolved'; skuUuid: SkuUuid; providerUuid: ProviderUuid }` — **one** definition, replacing `fred`'s `SkuSelector` (`deployManifest.ts:72`), `core`'s `ResolveSkuInput`, and `agent-core`'s loose fields.
- **`PortConfig`** — **net-new** (does not exist today; current shape is `ServiceConfig.ports?: Record<string, Record<string, never>>` + flat `DeployAppInput.port?: number`). Introduce it carrying the ENG-282 `{ host_port?; ingress? }` shape.

`fred` imports + re-exports the relocated declarations (no consumer breakage). **`agent-core` keeps its narrow deploy/SKU fields through P0** (converged in P1, which deletes `build-fred-input.ts`); the canonical `core` types and `agent-core`'s loose fields **coexist by design** until then — so the §8 boundary guard MUST exempt `agent-core`'s internal types until P1.

### 5.2 `CapabilityCtx` + `createManifestClient`

```ts
interface CapabilityCtx {
  chain: CosmosClientManager;     // connection, signing, rate-limit, retry
  query: ManifestQueryClient;     // configured manifestjs LCD/RPC client (raw typed reads)
  signer?: Signer;                // unified signer port (§5.3); ABSENT in query-only mode
  fetch: typeof globalThis.fetch; // injected fetch (guarded on node, providerFetch in browser)
  events?: EventTransport;        // DEFERRED streaming transport (§5.9); absent ⇒ poll fallback
}
type QueryCtx = Omit<CapabilityCtx, 'signer'>;

function createManifestClient(opts: { config; walletProvider: WalletProvider; fetch?; skuSpecs?; events? }): CapabilityCtx;
function createManifestClient(opts: { config; fetch?; skuSpecs?; events? }): QueryCtx;
```

`ctx.query` is `core.createLCDQueryClient(...)` / `clientManager.getQueryClient()` — the manifestjs client with `lcd-adapter` normalization, **inheriting `CosmosClientManager`'s existing restUrl-preferred routing unchanged**. Idiomatic viem `createClient` + `fn(client, args)` and wagmi `createConfig` optional-wallet (read-only) model — query-only consumers get a **compile error** reaching for `signer`, with the existing `INVALID_CONFIG` throw retained as the runtime backstop for the stringly/MCP path.

**Interface-segregation (ISP):** building blocks are typed against the **narrowest slice** of `ctx` they use — a read takes `(ctx: Pick<CapabilityCtx, 'query' | 'chain'>, input)`, a deploy takes `(ctx: CapabilityCtx, input)` — so query-only consumers can call reads with no signer. Consumers bind `ctx` once and partially-apply (viem-`.extend()`-style).

### 5.3 Ports

**`Signer`** — one wallet-shaped port (mirrors the Keplr wallet object), **interface-segregated** so a keyfile-only-tx signer isn't forced to implement ADR-036:

```ts
interface TxSigner   { getAddress(): Promise<Address>; getSigner(): Promise<OfflineSigner>; }
interface AuthSigner extends TxSigner { signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>; }
type Signer = AuthSigner;
```

(`getAddress` returns a branded `Address`.) Query-only/pure-tx flows depend on `TxSigner`; deploy/provider/auth flows depend on `AuthSigner`. `WalletProvider` (`core/src/types.ts`, `signArbitrary` optional) is the concrete shape; `requireAuthSigner(ctx): AuthSigner` narrows once at the boundary (throws `INVALID_CONFIG` if absent). `getSigner()`'s `OfflineSigner` is **`@manifest-network/stargate`'s** (the fork override). Impls at the **edge** (node keyfile/mnemonic; browser CosmosKit); `core` never holds a key (the `platform:neutral` build is the guardrail) — cosmjs's edge-injected BYO-signer.

**Auth-token factory** — `createAuthTokens(signer: AuthSigner, { chainId: ChainId }) → { getAuthToken, getLeaseDataAuthToken }`, wrapping `fred`'s `AuthTokenService`. Tokens are **lazily cached and re-signed on expiry** (ADR-036 tokens carry a server-enforced timestamp; mirror `AuthTokenService`'s TTL — not mint-per-call). Replaces Barney's `makeFredAuthTokens` (`src/ai/toolExecutor/fredAuth.ts`).

**`fetch`** — on `ctx`; default guarded-undici (node subpath) or `globalThis.fetch` (browser); Barney injects `providerFetch`.

### 5.4 Reads — two faces

- **Stringly:** `cosmosQuery(...)` — unchanged (MCP/LLM); parses args to branded ids (§5.0).
- **Raw typed:** `ctx.query.liftedinit.billing.v1.leases({...})` — manifestjs, **no wrapper**.
- **Value-added typed building blocks (`core`)** — these largely **already exist** as handlers in `core/queries/*`, surfaced today as **stringly lease-server tools** (`packages/lease/src/index.ts`: `get_skus`, `get_providers`, `leases_by_tenant`, `lease_by_custom_domain`) and as **typed fns in Barney** (`src/api/billing.ts`, `src/api/sku.ts`). The P0 work is to **unify into one typed `core` fn each** (reuse the handler + add pagination defaults/filters), **not** port net-new logic. Signatures take branded ids:
  - `getBalance(ctx, address: Address)` (+runway), `getCreditAccount(ctx, tenant: Tenant)`, `getCreditEstimate`, `getCreditAddress`, `getAccountInfo(ctx, address: Address)`.
  - `getLeasesByTenant(ctx, tenant: Tenant, { state?, pagination? })`, `getLease(ctx, leaseUuid: LeaseUuid)`, `getLeasesByProvider(ctx, providerUuid: ProviderUuid, …)`, `getLeasesBySKU(ctx, skuUuid: SkuUuid, …)`, `getWithdrawableAmount`, **`getProviderWithdrawable`** (paginated), `getAllLeases` / `getAllCredits`, `getBillingParams`.
  - `getProviders` / `getSKUs` / `getSKUsByProvider(ctx, providerUuid: ProviderUuid)` / `getSKUParams`, `getLeaseByCustomDomain(ctx, fqdn: Fqdn)`.
  - **`paginateAll(ctx, pageFn, { maxPages })`** — **net-new** generic exhaustion helper (follows `nextKey`, rate-limit-aware via `ctx.chain.acquireRateLimit`, capped); `getAll*` compose it.

### 5.5 Catalog / SKU / pricing + customizable spec-map

- `browseCatalog` — one canonical, **stays in `fred`** (provider HTTP via `getProviderHealth`); re-exported via the SDK.
- `resolveSku` / `listSkuCandidates` — `core`, unchanged (return `SkuCandidate` with branded `skuUuid`/`providerUuid`).
- **New `core` helpers — PURE over already-fetched `SKU[]`/`Provider[]` + the spec-map (no HTTP/fetch), safe in `platform:neutral` core:** `selectCheapest(...)`, `normalizeHourlyPrice(price, unit)`, the tier-spec join. `browseCatalog` (in `fred`) fetches and feeds them. *(Closes Open-Q1 + the §8 isomorphism risk.)*
- **`SkuSpecSource` (customizable):** consumer-supplied off-chain CPU/RAM/disk specs, keyed by `TierName`:
  ```ts
  type SkuSpecMap = Record<TierName, { cores: number; ramMB: number; diskGB: number }>;
  type SkuSpecSource = SkuSpecMap | ((ctx: CapabilityCtx) => Promise<SkuSpecMap>);
  ```
  Internally **normalized to one resolver and memoized** on first resolution (async source not re-fetched per join; producer must be pure/idempotent). The factory receives `ctx` so a remote source reuses `ctx.fetch` (stays inside the SSRF guard). `core` does the join + cheapest + per-hour pricing; display formatting (e.g. `formatTierSpecs`) stays **consumer-side**.

### 5.6 Transactions — two faces

- **Stringly:** `cosmosTx` / `cosmosEstimateFee` — unchanged (parse args to branded ids).
- **Typed building blocks (`core`):**
  - `fundCredits(ctx, { amount, tenant?: Tenant })`.
  - `setItemCustomDomain(ctx, { leaseUuid: LeaseUuid, customDomain: Fqdn | '', serviceName? })` — pass `customDomain: ''` (or `clear: true`) to **clear**; the **only** domain write (no separate `clearItemCustomDomain`).
  - `stopApp(ctx, { leaseUuid: LeaseUuid })` — **this IS the close-lease write** (lease server's `close_lease` wraps it). One typed fn, not two.
  - a **faucet** helper (drip + verify) — Barney reinvents it in `src/api/faucet.ts`.
  - Per-module tx composers (`core/transactions/*`; 14 defined, 12 re-exported) exposed typed only where an app needs them; else `cosmosTx`/manifestjs composers.

### 5.7 Fred provider ops

`deployManifest` / `deployApp` / `buildManifest` / `restartApp` / `updateApp` / `getAppLogs` / `appStatus` / `waitForAppReady` / `uploadLeaseData` / `pollLeaseUntilReady` — built, re-exported via the SDK. Converting their ad-hoc positional DI to `ctx` is **P2**.

### 5.8 MCP servers as thin callers (back-compat)

Servers keep their tool surface; where they duplicate logic now in the typed API they become thin callers — but **the typed fn must be a byte-equivalent substitution**. Gated by **BOTH** the pinned `annotations`/`_meta.manifest` matrix tests **AND** each server's behavioral `*.test.ts` suites (response shape via `bigIntReplacer`, error text, canonicalization/trims, rate-limit timing). **Snapshot each tool's JSON output before the refactor.** "No behavior change" is a *tested obligation*, not an assertion.

### 5.9 Live status — streaming building block (surface in P0, WS transport deferred)

Grounded fact: Barney's `connectLeaseEvents` is a **provider (Fred) WebSocket** carrying `provision_status` — the **same data `pollLeaseUntilReady` already polls**. So polling already covers it; the WS is a latency optimization, not a missing capability. Design (the viem `watch*` idiom — *one surface, swappable transport*):

- **Shape (typed face only):** `subscribeLeaseStatus(ctx: Pick<CapabilityCtx,'query'|'chain'|'fetch'|'events'>, leaseUuid: LeaseUuid, { onData(status: FredLeaseStatus), onError?(err), signal?: AbortSignal }): () => void` — callback-in, **synchronous unsubscribe-out**, plus `AbortSignal`. Consistent with our IoC callbacks and `pollLeaseUntilReady`'s `{ onProgress, abortSignal }`; maps 1:1 to React `useEffect` cleanup; no RxJS/xstream/EventEmitter shim. `onData` emits the **same `FredLeaseStatus`** the poller emits, so poll and stream are interchangeable to the caller. (Internally, an async-iterator transport with a callback adapter on top — pull-backpressure underneath, callback ergonomics at the edge — matching Barney's existing `{ events: AsyncGenerator; close() }`.)
- **Transport — swappable behind that one surface.** If `ctx.events` (the deferred WS port) is present → subscribe; else, or on permanent WS failure → transparently drive the existing `pollLeaseUntilReady` and re-emit via the same `onData`. (viem's WS→`getLogs` auto-fallback; Barney's `waitForLeaseReady` already does this via `disableWS` + `catch → pollLeaseUntilReady`.)
- **P0 scope:** ship the **poll-backed surface now**; the WS transport is **deferred** (§3). Barney adopts the stable surface immediately and keeps its WS as the later `ctx.events` transport — **no surface churn when WS lands.**
- **Layer:** `fred` (provider transport, like `browseCatalog`); not `core`.
- **Not on the stringly/MCP face:** MCP has no client-driven tool-subscription primitive (progress notifications are request-scoped; resource-subscriptions are a separate capability). The LLM path keeps "long-running tool emits progress while polling, then returns."

**Deferred WS transport** (`EventTransport` on `ctx.events`, named later phase): an injected **WebSocket factory mirroring the fetch seam** — node default behind the `…/node` subpath with `"default": null` (so `ws` never leaks into a browser bundle), `ws` as an **exact-pinned** `optionalDependency`. The node factory carries the **WS-SSRF guard**: undici's guarded dispatcher does not cover `ws`, so DNS-resolve the provider host, reuse the shared `ipaddr.js` unicast check (factor a `assertUnicastHost(url)` out of `core/internals/guarded-fetch.ts`), connect to the resolved IP with a pinned `Host`; gate on `MANIFEST_*_WS_GUARDED` (default ON). Reconnection/backoff is ours (~150 lines; cosmjs curve 100ms→×2→5s cap, reset-on-open, a `ConnectionStatus` surface). **Not** cosmjs's WS client (chain events — wrong source).

## 6. Data flow (examples)

- **Query:** `createManifestClient(...)` → `getLeasesByTenant(ctx, asTenant(addr), { state })` → typed `Lease[]`.
- **Deploy (P0 capability path):** `resolveSku(ctx, intent)` → `buildManifest(...)` → `deployManifest(ctx, { manifest, sku, customDomain })` → `DeployAppResult`. **The acceptance test exercises this and passes at end of P0.**
- **Live status (P0):** `const stop = subscribeLeaseStatus(ctx, leaseUuid, { onData })` → poll-backed today, WS-backed later, identical caller code.

## 7. Error handling

Preserve `ManifestMCPError` + `ManifestMCPErrorCode` + `sanitizeForLogging` + retry classification (`retry.ts`). The branded-type parse constructors throw the existing `INVALID_*` codes. No new error model.

## 8. Isomorphic / build constraints + boundary enforcement

- `core`, `fred`, `agent-core`, `manifest-sdk`: `platform:neutral` + dynamic-import-gated node code; `"sideEffects": false` end-to-end.
- Node-only code (guarded fetch, **WS factory**, keyfile signer) behind the `…/node` **subpath** with the `"default": null` browser-hard-fail guard. `publint` + `attw` in CI.
- **Boundary enforcement — split by mechanism:**
  - **Import-edge rules → `dependency-cruiser`** (npm workspaces, not Nx): (a) *only* `core/src/manifest-types.ts` imports manifestjs generated type paths; (b) *only* `core` constructs the LCD/RPC client; (c) the **whole DAG** `edge → agent-core → core → manifestjs`, never reverse, no `agent-core → edge` (subsumes the ENG-281/287 barrel hygiene checks). The barrel re-exports **only** each package's public browser-safe entry (never deep paths).
  - **Semantic "narrower re-declaration" → NOT a grep** (misses `type X =`, aliases, partial shapes; repo has grep-CI scars). Rely on the **single-source-of-truth canonical type + `tsc`**; `ts-morph`/AST only if fully automating.
  - The guard ships with its **own meta-test** (a known-bad fixture it must fail on).

## 9. Testing & acceptance

- Unit tests per building block (co-located `*.test.ts`).
- **Branded-type tests:** `parse*`/`as*` round-trip + reject invalid input; a negative type-fixture (e.g. `tsd`/`expect-error`) asserting a `LeaseUuid` is not assignable where a `ProviderUuid` is required.
- **Cross-face equivalence test:** same input through the stringly + typed faces → equivalent results (pins §2's single-handler invariant).
- **The acceptance test (single tracked "done" metric, a P0 deliverable):** an in-repo example app composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, that (1) queries leases/credit/catalog, (2) runs the **deploy capability path**, and (3) drives `subscribeLeaseStatus` — **built for the browser**. CI asserts the emitted browser chunk has **no node builtins** (`node:`/`async_hooks`/`undici`/`ws`/`fs`) and stays within a **bundle-size budget** (`size-limit`/`bundlewatch`).
- The annotation/`_meta` matrix **and** server behavioral suites stay green (§5.8).

## 10. Migration & back-compat

- **Additive:** new `manifest-sdk` package + new `core` modules; existing packages keep working.
- `fred` re-exports the relocated types; branded types are assignable to `string`, so existing `string`-typed call sites keep compiling during migration.
- Servers refactor to thin callers incrementally; gated by §5.8.
- **Plugin:** already on `0.14.0`; unaffected by P0. **Barney:** adopts in P3 (and migrates onto `subscribeLeaseStatus` immediately for live status, keeping its WS as the future transport).

## 11. Risks & mitigations

- **Browser-bundle regression** (node-only leak into the SDK barrel — now incl. `ws`) → example-app browser build (no-node-builtins assertion + size budget) + `dependency-cruiser` DAG/boundary guard + `publint`/`attw`. The barrel is the highest-risk spot — re-export only public browser-safe entries.
- **Branded-type friction** → brands are structurally `string` (assignable to `string`), so adoption is incremental and never blocks a `string` call site; the cost is only at the parse boundary, which is where validation should live anyway.
- **WS-SSRF** (provider WS URL from on-chain data) → the deferred `ctx.events` node factory reuses the `ipaddr.js` unicast guard; gated, default ON. Not in P0.
- **Type-relocation churn** → `fred` re-exports; `agent-core` narrow types coexist transiently until P1 (the §8 guard exempts them).
- **Dual-face drift** → single shared handler + cross-face equivalence test.
- **ENG-282** → the canonical `PortConfig` IS the ENG-282 shape.

## 12. Open questions (with resolutions)

1. ~~`browseCatalog` in `core`?~~ **Resolved:** stays in `fred`; pricing helpers are pure (§5.5).
2. `SkuSpecSource` shape — **Resolved:** memoized union, factory receives `ctx` (§5.5).
3. SDK node-only subpath — **Resolved:** one `…/node`.
4. ~~Live events: defer vs scope into P0?~~ **Resolved:** **decouple surface from transport** — ship the poll-backed `subscribeLeaseStatus` **surface** in P0; **defer the WS transport** (`ctx.events`) to a named phase (§5.9).
5. File a Linear epic + per-phase issues now? **Recommend:** yes, once the spec is approved.

## 13. Phase 0 deliverables checklist

- [ ] `@manifest-network/manifest-sdk` — barrel **+ scoped subpaths** + `…/node` (`"default": null`) + `"sideEffects": false` + release wiring
- [ ] **Branded domain types** (`core/src/brands.ts`: `Address`/`Tenant`/`LeaseUuid`/`ProviderUuid`/`SkuUuid`/`TierName`/`Fqdn`/`Denom`/`ChainId`) + `parse*`/`as*` constructors; threaded through every typed signature; stringly face parses to them
- [ ] Canonical types relocated to `core/src/manifest-types.ts` (single chokepoint, type-only re-exports); `SkuIntent` unified; `PortConfig` net-new (ENG-282 shape)
- [ ] `CapabilityCtx` / `QueryCtx` + overloaded `createManifestClient` (type-level query-only vs full)
- [ ] `TxSigner`/`AuthSigner` split + `requireAuthSigner` guard + `createAuthTokens(signer, { chainId })` (lazy-cached) + `fetch` on `ctx`
- [ ] Value-added typed reads (billing/lease/credit/sku/provider/account) — **unify** existing lease-server handlers + Barney typed fns
- [ ] `paginateAll` exhaustion helper (net-new)
- [ ] `selectCheapest` + `normalizeHourlyPrice` + tier-spec join (pure; memoized `SkuSpecSource`)
- [ ] faucet helper
- [ ] **`subscribeLeaseStatus`** (viem-shape callback+unsubscribe), **poll-backed** via `pollLeaseUntilReady`; `ctx.events?` left as the deferred WS upgrade
- [ ] `dependency-cruiser` boundary + whole-DAG guard (meta-test) + `publint`/`attw` CI
- [ ] Cross-face equivalence test + branded-type negative type-fixture
- [ ] Example app + acceptance test (browser build; no-node-builtins assertion + size budget; CI)
- [ ] Servers refactored to thin callers (behavioral suites + matrix green; JSON snapshots)
- [ ] SDK author guide (docs)
