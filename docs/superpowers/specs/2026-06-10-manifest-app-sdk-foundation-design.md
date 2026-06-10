# Manifest App SDK — Phase 0 Foundation Design

- **Status:** Draft for review (v4 — final-review corrections: boundary policy by trust, signer/ctx fixes, discriminated clear, factual precision)
- **Date:** 2026-06-10
- **Owner:** Felix Morency
- **Related:** `manifest-app-sdk-readiness.md` (living scorecard, same dir); Linear epic TBD
- **Supersedes framing of:** ENG-127 (orchestration umbrella), ENG-279 (Barney migration)
- **Verification:** v2 (3-stream: fact-check + completeness + idiomatic audit), v3 (streaming-idiom research + type-safety directive), v4 (final online idiomatic review: branded-types / validation-boundaries / holistic). All "sound-with-tweaks", no architectural reconsideration.

---

## 1. Context & goal

`manifest-mcp-mono` today is five MCP servers + a `core` library + an `agent-core` orchestration library. The chain/Fred capabilities are real and well-tested, but they are **shaped for MCP servers** (stringly tool args, server-bound DI), and `agent-core` re-declares a **narrower** deploy type than `fred`. That narrowness is why Barney abandoned `agent-core` and now maintains a near-complete **parallel** chain stack (~19 source files under `src/api/` + a 2,845-line `compositeTransactions.ts`).

**Goal:** transform the repo into a real **app-building SDK for Manifest + Fred** — building blocks any consumer (the Claude Code plugin via MCP, a browser app like Barney, a future dashboard/daemon) composes to build a full application, **reinventing nothing**.

**Acceptance test (definition of done for the whole effort):** an in-repo example app builds a deploy-, query-, **and live-status** flow composing **only** `@manifest-network/manifest-sdk` + `manifestjs` — zero hand-rolled client, queries, auth, pricing, orchestration, or streaming.

This document specifies **Phase 0** — the SDK foundation. Phases 1–4 are out of scope here (§3).

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

**Boundary rule (first-class):** `core` *wraps* manifestjs; it never re-declares a chain type or stands up a second query client. Raw typed reads go to the configured manifestjs client (`ctx.query`); `core` adds only what manifestjs can't express — connection/DI, REST↔camelCase normalization, retry, the error model, **branded domain types**, value-added compositions, ports, orchestration. (The textbook Telescope/ts-proto idiom: re-export curated types from one module, wrap *behavior* not *declarations*. The `lcd-adapter` is a legitimate **Adapter**, not a forbidden second client.)

**Two faces, one implementation:**
- **Stringly face** — `cosmosQuery` / `cosmosTx` (`args: string[]` → JSON): the MCP/LLM surface, and the **parse boundary** (§5.0).
- **Typed face** — the configured manifestjs client (`ctx.query`) + value-added typed building blocks that take/return **branded domain types**.

Both backed by the **same** per-module handlers in `core/queries/*` and `core/transactions/*` — **the load-bearing invariant** (AWS client-vs-resource / Stripe typed-vs-`rawRequest`; idiomatic *because* logic isn't forked). Guarded by the cross-face equivalence test (§9), not just asserted; validation/normalization/error-mapping lives in the shared handler. The stringly face is **not** auto-generated from the typed one (it is necessarily dynamic — LLM-supplied args).

## 3. Non-goals (later phases)

- **P1** — widen `agent-core` `DeploySpec` to a faithful superset of `fred`'s `DeployAppInput`; delete `internals/build-fred-input.ts`.
- **P2** — converge every legacy capability fn to `fn(ctx, input)`.
- **P3** — consumer adoption (Barney deletes `src/api/` + `compositeTransactions.ts`; the plugin is already current on `manifest-mcp-node@0.14.0`).
- **P4** — deploy-saga durability (idempotency + reconcile-on-resume).
- **Live-status WebSocket transport** (the `ctx.events` WS port + isomorphic WS factory + WS-SSRF guard + WS frame-payload parsing) — **deferred to a named later phase.** The *streaming building-block surface* (`subscribeLeaseStatus`) **does** ship in P0, poll-backed (§5.9); only the WS transport behind it is deferred. Barney keeps `connectLeaseEvents` until then; it becomes the `ctx.events` transport with no surface churn.
- **Chain-event subscription** (CometBFT/Tendermint WS for on-chain lease-tx watching) — out of scope; provision status is provider-side, not a chain event.
- **Package renames** (dropping `mcp`) — a separate cosmetic pass. Phase 0 uses **Option A**.

## 4. Packaging — Option A (barrel + scoped subpaths)

A new package **`@manifest-network/manifest-sdk`**: an aggregating barrel re-exporting the curated public SDK surface from `core` + `fred` + `agent-core`. Existing package names unchanged; the release pipeline gains one package (published **last**).

Ship **scoped subpath entrypoints from day one** alongside the barrel (every leading SDK does — viem `.` + ~25 subpaths, wagmi `/actions`/`/query`, AWS SDK v3 modular): `@manifest-network/manifest-sdk` + `…/reads`, `…/catalog`, `…/deploy`, `…/orchestration`, with **`"sideEffects": false`** on the SDK package (verify each intermediate package keeps it). De-risks the barrel-file tree-shaking pitfall and keeps the browser example app's bundle small. Reversible-compatible with a later rename.

Node-only helpers (guarded fetch, the WS factory, keyfile signer) via **one** `node`-conditioned subpath `@manifest-network/manifest-sdk/node`, replicating `core`'s guard verbatim: `{ "types": …, "node": …, "default": null }` — `"default": null` makes a browser/bundler resolution **fail loudly**. Add **`publint` + `attw`** as CI-only checks. The dual-package hazard is a non-issue (ESM-only, stateless surface).

## 5. Components

### 5.0 Type safety — branded domain types, not bare `string`

**Principle:** the typed face and all canonical SDK types use **branded (opaque) domain types** for identifiers and domain-meaningful values — never bare `string`. This makes "lease uuid where a provider uuid was expected", "raw string used as an address", and unit mix-ups **compile errors**.

**Why nominal brands here (and how viem actually does it):** viem encodes constraints **structurally** via template-literal types (`Hex` / `Hash` = `` `0x${string}` ``; `Address` from ABIType) plus parse/assert helpers (`getAddress`, `isAddress`) — it does **not** use `__brand`. Manifest's identifiers (bech32 `manifest1…`, RFC-4122 UUIDs, FQDNs) can't be captured by a cheap template literal, so we get the equivalent guarantee via **nominal brands + parse constructors**:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B }; // never exported
type Address     = Brand<string, 'Address'>;     // bech32 manifest1…
type Tenant      = Address;                        // a tenant IS an address (see note)
type LeaseUuid   = Brand<string, 'LeaseUuid'>;
type ProviderUuid= Brand<string, 'ProviderUuid'>;
type SkuUuid     = Brand<string, 'SkuUuid'>;
type TierName    = Brand<string, 'TierName'>;
type Fqdn        = Brand<string, 'Fqdn'>;
type Denom       = Brand<string, 'Denom'>;
type ChainId     = Brand<string, 'ChainId'>;
// quantities reuse manifestjs Coin { denom, amount }; never a bare string amount
```

- **String `__brand` key, not `unique symbol`** — deliberate: a `unique symbol` brand is mutually non-assignable across *duplicated* package copies (TS sees each copy's symbol as distinct), so assignability becomes hoisting-dependent. type-fest reverted symbol→string for exactly this (PR #875); this repo is an aggregating barrel over 3 packages with documented worktree dep-drift (same hazard CLAUDE.md calls out for `ipaddr.js`), so a string key is the safer, library-correct choice.
- **`Tenant = Address`** is an intentional transparent alias (a tenant genuinely is an address); branding therefore does **not** distinguish a tenant from any other address — the §9 negative fixture covers *distinct* brands, not this pair.

**Parse, don't validate.** The `parse*`/`as*` constructors are the **only** sanctioned brand producers (`parseAddress(s): Address`, `asLeaseUuid(s): LeaseUuid`, …), validating once and returning the brand (throwing the existing `INVALID_*` codes). The repo's existing `validateAddress` (throws/`void`) and `requireUuid` (returns `string`) are *validators*, so each constructor is a thin wrapper (existing-check + the **lone** `as Brand` cast). That cast appears **only inside `brands.ts`** (enforced by §8), so no call site can mint an unvalidated brand. Note: there is **no existing client-side FQDN validator** (FQDN is chain-validated today), so `parseFqdn` is **net-new** — scope it to a minimal structural check (non-empty, contains a dot, lowercased) and defer authoritative validation to the chain.

**Branding is compile-time-only (erased at runtime) — so it must be (re)applied at every runtime boundary, with a policy set by *trust*:**

| Boundary | Direction | Policy |
|---|---|---|
| Stringly / MCP face (LLM string args) | inbound | **parse + validate** → brand (the single semantic-validation site) |
| Chain / codegen reads (manifestjs via `ctx.query`/lcd-adapter) | response → SDK | **brand by assertion (trust-cast)** at the single mapping site — **no** re-validation (the chain is the source of truth; viem likewise casts JSON-RPC outputs to `Address`/`Hash` without re-checking). Never throws `INVALID_*`. |
| Provider-HTTP reads (Fred: `FredLeaseStatus`, deploy/catalog payloads) | response → SDK | **parse + validate** when surfacing a value as a branded id — the provider is the least-trusted source (URL from on-chain SKU data, network-SSRF-guarded but payload-untrusted) |
| Wallet-in (`WalletProvider.getAddress(): string`) | impl → SDK | **parse once** in the Signer adapter (§5.3) |
| Persisted-state `JSON.parse` (saveManifest / chain-data file / Barney localStorage) | load → SDK | **re-brand** on load |

**`string` survives only:** (a) on the stringly face (immediately parsed); (b) inside manifestjs codegen types (we don't re-declare them); (c) inside provider wire types (e.g. fred's `FredLeaseStatus`) whose string fields are **opaque provider state** (`provision_status`, `phase`, `last_error`), not SDK identifiers.

**Considered and rejected for P0:** Zod `.brand()` (gives runtime validation for free, but conflicts with §7's "no new error model", isn't a dependency, and adds weight to a size-budgeted browser SDK for simple checks); type-fest `Tagged` (the library-blessed primitive — `Opaque` is deprecated — but a dependency on the most foundational module for what ~8 zero-dep lines already do). Revisit if/when broader schema validation is adopted.

### 5.1 Canonical types in `core` (over manifestjs)

Relocate the value types into a **single chokepoint module** `core/src/manifest-types.ts` — the *only* file permitted to import manifestjs generated type paths — re-exported by `fred`, `agent-core`, and the SDK barrel; re-exports are **type-only** (`export type { … }`). The chokepoint makes the §8 CI import-rule exact.

Canonical types (domain-id fields branded per §5.0 — e.g. `DeployAppResult.leaseUuid: LeaseUuid`, `…providerUuid: ProviderUuid`, branded by trust-cast at the read/result mapping site):
- `DeployAppInput`, `ServiceConfig`, `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult`, `DeployManifestInput`/`DeployAppResult`, the manifest-preview input. (Per-type homes today: `ServiceConfig`+`DeployAppInput` in `fred/src/tools/deployApp.ts`; `SkuSelector`+`DeployAppResult`+`DeployManifestInput` in `deployManifest.ts`; `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult` in `manifest.ts`; preview input in `tools/buildManifestPreview.ts`.)
- **`SkuIntent`** = `{ kind: 'byName'; size: TierName; providerUuid?: ProviderUuid; skuUuid?: SkuUuid } | { kind: 'resolved'; skuUuid: SkuUuid; providerUuid: ProviderUuid }` — one definition, replacing `fred`'s `SkuSelector`, `core`'s `ResolveSkuInput`, and `agent-core`'s loose fields.
- **`PortConfig`** — **net-new** (does not exist today; current shape is `ServiceConfig.ports?: Record<string, Record<string, never>>` + flat `DeployAppInput.port?: number`). Introduce it carrying the ENG-282 `{ host_port?; ingress? }` shape.
- **`FredLeaseStatus`** — relocate fred's provider wire type here (its id fields branded; its opaque-state fields stay `string` per §5.0(c)); used by `subscribeLeaseStatus` + `pollLeaseUntilReady`.

`fred` imports + re-exports the relocated declarations. **`agent-core` keeps its narrow deploy/SKU fields through P0** (converged in P1); the canonical `core` types and `agent-core`'s loose fields **coexist by design** until then — so the §8 boundary guard MUST exempt `agent-core`'s internal types until P1.

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

`ctx.query` is `core.createLCDQueryClient(...)` / `clientManager.getQueryClient()` (manifestjs client + lcd-adapter normalization), **inheriting `CosmosClientManager`'s restUrl-preferred routing unchanged**. Idiomatic viem `createClient` + `fn(client, args)` and wagmi `createConfig` optional-wallet (read-only) model — query-only consumers get a **compile error** reaching for `signer`, with the existing `INVALID_CONFIG` throw as the runtime backstop for the stringly/MCP path. `EventTransport` is forward-declared in §5.9.

**ISP:** building blocks are typed against the **narrowest slice** of `ctx` they use — a chain read takes `(ctx: Pick<CapabilityCtx, 'query' | 'chain'>, input)`, a deploy takes `(ctx: CapabilityCtx, input)`, a provider op takes the slice that includes `signer` (it needs an ADR-036 auth token). Consumers bind `ctx` once and partially-apply (viem-`.extend()`-style).

### 5.3 Ports

**`Signer`** — one wallet-shaped port (mirrors the Keplr wallet object), **interface-segregated** so a keyfile-only-tx signer isn't forced to implement ADR-036:

```ts
interface TxSigner   { getAddress(): Promise<Address>; getSigner(): Promise<OfflineSigner>; }
interface AuthSigner extends TxSigner { signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>; }
type Signer = AuthSigner;
```

`OfflineSigner` is **`@cosmjs/proto-signing`'s** (matching the concrete `WalletProvider.getSigner`; the `@manifest-network/stargate` fork override applies to `@cosmjs/stargate`'s signAmino path, **not** proto-signing). Query-only/pure-tx flows depend on `TxSigner`; deploy/provider/auth flows depend on `AuthSigner`; `requireAuthSigner(ctx): AuthSigner` narrows once at the boundary (throws `INVALID_CONFIG` if absent).

**`Signer` is an SDK-surface adapter over the concrete `WalletProvider`** (`core/src/types.ts`, whose `getAddress(): Promise<string>` and optional `signArbitrary(address: string, …)` use bare `string`). The adapter brands the address once — `parseAddress(await wallet.getAddress())` — so the port exposes `Address` while the edge impl keeps `string`. (`WalletProvider` is **adapted to** a `Signer`, it is not itself one.) Impls at the **edge** (node keyfile/mnemonic; browser CosmosKit); `core` never holds a key (the `platform:neutral` build is the guardrail).

**Auth-token factory** — `createAuthTokens(signer: AuthSigner, { chainId: ChainId }) → { getAuthToken, getLeaseDataAuthToken }`, wrapping `fred`'s `AuthTokenService`. Tokens **lazily cached, re-signed on expiry** (mirror `AuthTokenService`'s TTL — not mint-per-call). Replaces Barney's `makeFredAuthTokens` (`src/ai/toolExecutor/fredAuth.ts`).

**`fetch`** — on `ctx`; default guarded-undici (node subpath) or `globalThis.fetch` (browser); Barney injects `providerFetch`.

### 5.4 Reads — two faces

- **Stringly:** `cosmosQuery(...)` — unchanged; parses args to branded ids (§5.0).
- **Raw typed:** `ctx.query.liftedinit.billing.v1.leases({...})` — manifestjs, **no wrapper** (returns codegen types with `string` ids).
- **Value-added typed building blocks (`core`)** — these largely **already exist** as handlers in `core/queries/*`, surfaced today as **stringly lease-server tools** (`packages/lease/src/index.ts`: `get_skus`, `get_providers`, `leases_by_tenant`, `lease_by_custom_domain`) and **typed in Barney** (`src/api/billing.ts`, `src/api/sku.ts`). P0 work is to **unify into one typed `core` fn each** (reuse the handler + add pagination defaults/filters), **not** port net-new logic. Params take branded ids; **return types brand domain-id fields by trust-cast** at the single mapping site (the read boundary, §5.0 — no re-validation of chain-vouched data):
  - `getBalance(ctx, address: Address)` (+runway), `getCreditAccount(ctx, tenant: Tenant)`, `getCreditEstimate`, `getCreditAddress`, `getAccountInfo(ctx, address: Address)`.
  - `getLeasesByTenant(ctx, tenant: Tenant, { state?, pagination? })`, `getLease(ctx, leaseUuid: LeaseUuid)`, `getLeasesByProvider(ctx, providerUuid: ProviderUuid, …)`, `getLeasesBySKU(ctx, skuUuid: SkuUuid, …)`, `getWithdrawableAmount`, **`getProviderWithdrawable`** (paginated), `getAllLeases` / `getAllCredits`, `getBillingParams`.
  - `getProviders` / `getSKUs` / `getSKUsByProvider(ctx, providerUuid: ProviderUuid)` / `getSKUParams`, `getLeaseByCustomDomain(ctx, fqdn: Fqdn)`.
  - **`paginateAll(ctx, pageFn, { maxPages })`** — **net-new** exhaustion helper (follows `nextKey`, rate-limit-aware, capped); `getAll*` compose it.

### 5.5 Catalog / SKU / pricing + customizable spec-map

- `browseCatalog` — one canonical, **stays in `fred`** (provider HTTP via `getProviderHealth`); re-exported via the SDK. Its provider-payload ids are parsed/branded at the read boundary (§5.0, provider-HTTP = untrusted).
- `resolveSku` / `listSkuCandidates` — `core`, unchanged.
- **New `core` helpers — PURE over already-fetched `SKU[]`/`Provider[]` + the spec-map (no HTTP/fetch), safe in `platform:neutral` core:** `selectCheapest(...)`, `normalizeHourlyPrice(price, unit)`, the tier-spec join. `browseCatalog` (in `fred`) fetches and feeds them.
- **`SkuSpecSource` (customizable):**
  ```ts
  type SkuSpecMap = Record<TierName, { cores: number; ramMB: number; diskGB: number }>;
  type SkuSpecSource = SkuSpecMap | ((ctx: CapabilityCtx) => Promise<SkuSpecMap>);
  ```
  **normalized to one resolver and memoized** on first resolution; the factory receives `ctx` so a remote source reuses `ctx.fetch` (SSRF guard). `core` does the join + cheapest + per-hour pricing; display formatting stays **consumer-side**.

### 5.6 Transactions — two faces

- **Stringly:** `cosmosTx` / `cosmosEstimateFee` — unchanged (parse args to branded ids).
- **Typed building blocks (`core`):**
  - `fundCredits(ctx, { amount, tenant?: Tenant })`.
  - `setItemCustomDomain(ctx, { leaseUuid: LeaseUuid; customDomain: Fqdn; serviceName? } | { leaseUuid: LeaseUuid; clear: true; serviceName? })` — a **discriminated union**: clearing is `{ clear: true }`, **never** an empty branded string. This preserves the existing reject-empty guard (an empty/missing `customDomain` without `clear: true` is rejected) so it stays a **byte-equivalent** substitution per §5.8. Still the **only** domain write.
  - `stopApp(ctx, { leaseUuid: LeaseUuid })` — **this IS the close-lease write** (lease server's `close_lease` wraps it). One typed fn.
  - a **faucet** helper (drip + verify) — Barney reinvents it in `src/api/faucet.ts`.
  - Per-module tx composers (`core/transactions/*`; 14 defined, 12 re-exported) exposed typed only where an app needs them.

### 5.7 Fred provider ops

`deployManifest` / `deployApp` / `buildManifest` / `restartApp` / `updateApp` / `getAppLogs` / `appStatus` / `waitForAppReady` / `uploadLeaseData` / `pollLeaseUntilReady` — built, re-exported via the SDK. Provider responses are parsed/branded at the read boundary (§5.0(provider-HTTP)). ctx-ifying the ad-hoc positional DI is **P2**.

### 5.8 MCP servers as thin callers (back-compat)

Servers keep their tool surface; thin callers must be **byte-equivalent substitutions**. Gated by **BOTH** the pinned `annotations`/`_meta.manifest` matrix tests **AND** each server's behavioral `*.test.ts` suites (response shape via `bigIntReplacer`, error text, canonicalization/trims, rate-limit timing). **Snapshot each tool's JSON output before the refactor.** The MCP `inputSchema` stays a **thin structural gate** (presence/types/enums/descriptions for `tools/list` + `-32602` fast-fail); **all semantic validation (UUID/bech32/FQDN/denom) lives once in the `parse*`/`as*` constructors** invoked inside the shared handler — the Zod `inputSchema` must NOT re-encode those format rules (and can't cleanly: the MCP SDK doesn't reliably support transform/brand schemas in `inputSchema` — #816/#1308). "No behavior change" is a *tested obligation*.

### 5.9 Live status — streaming building block (surface in P0, WS transport deferred)

Grounded fact: Barney's `connectLeaseEvents` is a **provider (Fred) WebSocket** carrying `provision_status` — the **same data `pollLeaseUntilReady` already polls**. Polling already covers it; the WS is a latency optimization. Design (the viem `watch*` idiom — *one surface, swappable transport*):

```ts
function subscribeLeaseStatus(
  ctx: Pick<CapabilityCtx, 'query' | 'chain' | 'fetch' | 'signer' | 'events'>,
  leaseUuid: LeaseUuid,
  opts: { onData(status: FredLeaseStatus): void; onError?(err: unknown): void; signal?: AbortSignal },
): () => void; // returns unsubscribe
```

- **Shape (typed face only):** callback-in, **synchronous unsubscribe-out**, plus an optional `AbortSignal` for parent-scope composition (Azure-SDK style). The returned `unsubscribe` and `signal` abort are **equivalent and idempotent**: aborting calls the same teardown as `unsubscribe`, does **not** invoke `onError` (abort is not an error), and calling `unsubscribe` twice is a no-op. Maps 1:1 to React `useEffect` cleanup; no RxJS/xstream/EventEmitter shim. (Internally an async-iterator transport with a callback adapter on top — pull-backpressure underneath — matching Barney's existing `{ events: AsyncGenerator; close() }`.)
- **Auth:** the poll transport needs a Fred lease-data auth token (so the `ctx` slice includes `signer`); it mints it via `createAuthTokens(requireAuthSigner(ctx), { chainId })` exactly as `appStatus` does today.
- **Transport — swappable behind that one surface.** If `ctx.events` is present → subscribe; else, or on permanent WS failure → transparently drive the existing `pollLeaseUntilReady` and re-emit via the same `onData`. (viem's WS→`getLogs` auto-fallback; Barney's `waitForLeaseReady` already does this.) **Both transports parse each frame/response into `FredLeaseStatus` (light structural parse + brand any ids) before `onData`** — "interchangeable" means "both go through the same parse gate", not "both forward raw provider JSON"; a frame that fails to parse routes to `onError` and does not crash the subscription.
- **P0 scope:** ship the **poll-backed surface now**; the WS transport is **deferred** (§3). Barney adopts the stable surface immediately and keeps its WS as the later `ctx.events` transport — **no surface churn**.
- **Layer:** `fred` (provider transport, like `browseCatalog`); not `core`.
- **Not on the stringly/MCP face:** MCP has no client-driven tool-subscription primitive (progress notifications are request-scoped; resource-subscriptions are a separate capability). The LLM path keeps "long-running tool emits progress while polling, then returns".

**Deferred WS transport** (`EventTransport` on `ctx.events`, named later phase; shape finalized then):

```ts
interface EventTransport { // forward declaration; finalized with the WS phase
  subscribeLease(leaseUuid: LeaseUuid, opts: { onData(s: FredLeaseStatus): void; onError?(e: unknown): void; signal?: AbortSignal }): () => void;
}
```

an injected **WebSocket factory mirroring the fetch seam** — node default behind the `…/node` subpath with `"default": null` (so `ws` never leaks into a browser bundle), `ws` as an **exact-pinned** `optionalDependency`. The node factory carries the **WS-SSRF guard** (undici's guarded dispatcher doesn't cover `ws`, so DNS-resolve, reuse the shared `ipaddr.js` unicast check factored out of `core/internals/guarded-fetch.ts` as `assertUnicastHost(url)`, connect to the resolved IP with a pinned `Host`; gate `MANIFEST_*_WS_GUARDED`, default ON). **The WS frame payload is an untrusted boundary requiring the same parse as the poll path** (not just the connection). Reconnection/backoff is ours (~150 lines; cosmjs curve 100ms→×2→5s cap). **Not** cosmjs's WS client (chain events — wrong source).

## 6. Data flow (examples)

- **Query:** `createManifestClient(...)` → `getLeasesByTenant(ctx, parseAddress(addr) as Tenant, { state })` → `Lease[]` (ids branded at the read boundary).
- **Deploy (P0 capability path):** `resolveSku(ctx, intent)` → `buildManifest(...)` → `deployManifest(ctx, { manifest, sku, customDomain })` → `DeployAppResult`. **The acceptance test exercises this and passes at end of P0.**
- **Live status (P0):** `const stop = subscribeLeaseStatus(ctx, leaseUuid, { onData })` → poll-backed today, WS-backed later, identical caller code.

## 7. Error handling

Preserve `ManifestMCPError` + `ManifestMCPErrorCode` + `sanitizeForLogging` + retry classification. The `parse*`/`as*` constructors throw the existing `INVALID_*` codes; **chain/codegen read brands are trust-casts and never throw** (chain is source of truth), while **provider-HTTP read brands reuse the existing `INVALID_*` throws**. No new error model.

## 8. Isomorphic / build constraints + boundary enforcement

- `core`, `fred`, `agent-core`, `manifest-sdk`: `platform:neutral` + dynamic-import-gated node code; `"sideEffects": false` end-to-end.
- Node-only code (guarded fetch, **WS factory**, keyfile signer) behind the `…/node` **subpath** with `"default": null`. `publint` + `attw` in CI.
- **Boundary enforcement — split by mechanism:**
  - **Import-edge rules → `dependency-cruiser`** (npm workspaces, not Nx): (a) *only* `core/src/manifest-types.ts` imports manifestjs generated type paths; (a′) **branded domain types are declared *only* in `core/src/brands.ts` and re-exported — no other module declares a `Brand<…>`/`__brand` type, and the lone `as Brand` cast lives only there**; (b) *only* `core` constructs the LCD/RPC client; (c) the **whole DAG** `edge → agent-core → core → manifestjs`, never reverse, no `agent-core → edge` (subsumes ENG-281/287). The barrel re-exports **only** each package's public browser-safe entry.
  - **Semantic "narrower re-declaration" → NOT a grep**; rely on the single-source-of-truth canonical type + `tsc`.
  - The guard ships **meta-tests** (known-bad fixtures it must fail on): a duplicate manifest-type re-declaration **and** a duplicate `Brand` declaration outside `brands.ts`.

## 9. Testing & acceptance

- Unit tests per building block.
- **Branded-type tests:** `parse*`/`as*` round-trip + reject invalid; a `tsd`/`expect-error` **negative type-fixture** covering the confusable **`LeaseUuid`/`ProviderUuid`/`SkuUuid` trio** (all UUID-backed, identical except the tag — the only thing proving the tags were wired distinctly); and a **read-boundary type-fixture** per canonical read (`ReturnType` of `getLease` exposes `.uuid: LeaseUuid`, not `string`) — forcing the read-side cast to exist (a runtime-erased gap is invisible to `tsc` otherwise; "test passes because of the bug" guard).
- **Cross-face equivalence test:** same input through stringly + typed faces → equivalent results, **and a malformed id is rejected by BOTH faces with the same `ManifestMCPErrorCode`/message** (pins one-validation-source; catches Zod-`inputSchema`-vs-constructor drift).
- **The acceptance test (single tracked "done" metric, a P0 deliverable):** an in-repo example app composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, that (1) queries leases/credit/catalog, (2) runs the **deploy capability path**, (3) drives `subscribeLeaseStatus` (poll-backed) — **built for the browser**. CI asserts the emitted browser chunk has **no node builtins** (`node:`/`async_hooks`/`undici`/`ws`/`fs`) and stays within a **bundle-size budget** (`size-limit`/`bundlewatch`).
- The annotation/`_meta` matrix **and** server behavioral suites stay green (§5.8).

## 10. Migration & back-compat

- **Additive:** new `manifest-sdk` package + new `core` modules; existing packages keep working.
- `fred` re-exports the relocated types; brands are structurally `string` (assignable to `string`), so existing `string`-typed call sites keep compiling during a leaf-by-leaf migration.
- Servers refactor to thin callers incrementally; gated by §5.8.
- **Plugin:** already on `0.14.0`; unaffected. **Barney:** adopts in P3 (and migrates onto `subscribeLeaseStatus` immediately for live status, keeping its WS as the future transport).

## 11. Risks & mitigations

- **Browser-bundle regression** (node-only leak into the SDK barrel — now incl. `ws`) → example-app browser build (no-node-builtins assertion + size budget) + `dependency-cruiser` DAG/boundary guard + `publint`/`attw`.
- **Branded-type friction** → brands are structurally `string` (one-way assignable), so adoption is incremental and never blocks a `string` call site; the lone cast is contained to `brands.ts` (read-side) and parse constructors (write-side).
- **WS-SSRF + hostile frame payload** (provider WS) → the deferred `ctx.events` node factory reuses the `ipaddr.js` unicast guard *and* the same payload parse as the poll path. Not in P0.
- **Type-relocation churn** → `fred` re-exports; `agent-core` narrow types coexist transiently until P1 (the §8 guard exempts them).
- **Dual-face drift** → single shared handler + cross-face equivalence test (incl. identical error codes).
- **ENG-282** → the canonical `PortConfig` IS the ENG-282 shape.

## 12. Open questions (with resolutions)

1. ~~`browseCatalog` in `core`?~~ Stays in `fred`; pricing helpers pure (§5.5).
2. `SkuSpecSource` shape — memoized union, factory receives `ctx` (§5.5).
3. SDK node-only subpath — one `…/node`.
4. ~~Live events: defer vs scope into P0?~~ **Decouple surface from transport** — poll-backed `subscribeLeaseStatus` **surface** in P0; **defer the WS transport** (§5.9).
5. Branding library — **hand-rolled `Brand` for P0** (zero-dep, audit-trivial); Zod `.brand()` and type-fest `Tagged` considered and declined (§5.0). Revisit if broader schema validation is adopted.
6. File a Linear epic + per-phase issues now? **Recommend:** yes, once the spec is approved.

## 13. Phase 0 deliverables checklist

- [ ] `@manifest-network/manifest-sdk` — barrel **+ scoped subpaths** + `…/node` (`"default": null`) + `"sideEffects": false` + release wiring
- [ ] **Branded domain types** (`core/src/brands.ts`: `Address`/`Tenant`/`LeaseUuid`/`ProviderUuid`/`SkuUuid`/`TierName`/`Fqdn`/`Denom`/`ChainId`) + `parse*`/`as*` constructors (note: `parseFqdn` is **net-new** client-side validation — no existing FQDN validator; minimal structural check, chain remains authoritative); the lone `as Brand` cast lives only here; threaded through every typed signature; boundary policy by trust (§5.0)
- [ ] Canonical types relocated to `core/src/manifest-types.ts` (single chokepoint, type-only); `SkuIntent` unified; `PortConfig` net-new; `FredLeaseStatus` relocated
- [ ] `CapabilityCtx` / `QueryCtx` + overloaded `createManifestClient`; `EventTransport` forward-declared
- [ ] `TxSigner`/`AuthSigner` split (`OfflineSigner` = `@cosmjs/proto-signing`) + `requireAuthSigner` + `Signer` adapter over `WalletProvider` (brands the address once) + `createAuthTokens(signer, { chainId })` (lazy-cached) + `fetch` on `ctx`
- [ ] Value-added typed reads (billing/lease/credit/sku/provider/account) — **unify** existing lease-server handlers + Barney typed fns; brand ids by trust-cast at the read boundary
- [ ] `paginateAll` exhaustion helper (net-new)
- [ ] `selectCheapest` + `normalizeHourlyPrice` + tier-spec join (pure; memoized `SkuSpecSource`)
- [ ] faucet helper
- [ ] **`subscribeLeaseStatus`** (viem-style callback+unsubscribe + AbortSignal; signer slice for auth; parse-each-emit), **poll-backed** via `pollLeaseUntilReady`; `ctx.events?` deferred WS upgrade
- [ ] `dependency-cruiser` boundary + **brands.ts chokepoint** + whole-DAG guard (meta-tests for both chokepoints) + `publint`/`attw` CI
- [ ] Cross-face equivalence test (incl. identical error codes) + branded-type negative + read-boundary fixtures
- [ ] Example app + acceptance test (browser build; no-node-builtins assertion + size budget; deploy + query + subscribeLeaseStatus; CI)
- [ ] Servers refactored to thin callers (behavioral suites + matrix green; JSON snapshots; `inputSchema` thin/structural-only)
- [ ] SDK author guide (docs)
