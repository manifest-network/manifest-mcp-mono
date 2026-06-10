# Manifest App SDK — Phase 0 Foundation Design

- **Status:** Draft for review (v2 — incorporates code fact-check + completeness critique + online idiomatic audit)
- **Date:** 2026-06-10
- **Owner:** Felix Morency
- **Related:** `manifest-app-sdk-readiness.md` (living scorecard, same dir); Linear epic TBD
- **Supersedes framing of:** ENG-127 (orchestration umbrella), ENG-279 (Barney migration)

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
                       · CapabilityCtx + ports (signer, fetch) · value-added typed reads/txs
                       · catalog/SKU/pricing
   ──
agent-core             orchestration: deploy/manage/troubleshoot/close
                       over the IoC callback contract (onPlan/onConfirm/onProgress/onComplete/onFailure)
   ──
edge adapters          manifest-mcp-agent (plugin) · React bindings (Barney) · future dashboard/daemon
   ──
@manifest-network/manifest-sdk   aggregating barrel + scoped subpaths — the public SDK entry (Option A)
```

**Boundary rule (first-class):** `core` *wraps* manifestjs; it never re-declares a chain type or stands up a second query client. Raw typed reads go to the configured manifestjs client (`ctx.query`); `core` adds only what manifestjs can't express — connection/DI, REST↔camelCase normalization, retry, the error model, value-added compositions, ports, and orchestration. (Validated as the textbook Telescope/ts-proto idiom: re-export curated types from one module, wrap *behavior* not *declarations*, use the generated client directly. The `lcd-adapter` is a legitimate **Adapter**, not a forbidden second client.)

**Two faces, one implementation:**
- **Stringly face** — `cosmosQuery` / `cosmosTx` (`args: string[]` → JSON): the MCP/LLM surface. Unchanged.
- **Typed face** — the correctly-configured manifestjs client (`ctx.query`) + value-added typed building blocks: the app-author surface.

Both backed by the **same** per-module handlers in `core/queries/*` and `core/transactions/*`. **This is the load-bearing invariant** (it is the AWS client-vs-resource / Stripe typed-vs-`rawRequest` pattern, idiomatic *because* logic isn't forked). It MUST be guarded, not just asserted: validation/normalization/error-mapping lives in the shared handler; both faces are pure adapters over it (string-parse vs typed pass-through), and a **cross-face equivalence test** pins that the same input through both faces yields equivalent results (§9). The stringly face is **not** auto-generated from the typed one (it is necessarily dynamic — LLM-supplied args).

## 3. Non-goals (later phases)

- **P1** — widen `agent-core` `DeploySpec` to a faithful superset of `fred`'s `DeployAppInput`; delete `internals/build-fred-input.ts`.
- **P2** — converge every legacy capability fn to `fn(ctx, input)`.
- **P3** — consumer adoption (Barney deletes `src/api/` + `compositeTransactions.ts`; the plugin is already current on `manifest-mcp-node@0.14.0`).
- **P4** — deploy-saga durability (idempotency + reconcile-on-resume).
- **Live lease/provision events** (Barney's `connectLeaseEvents`, a Tendermint WS subscription) — **DEFERRED with intent.** There is zero websocket/streaming code in the mono today, and a WS transport is inherently node-`ws`-vs-browser-`WebSocket` divergent (an isomorphism hazard, exactly what §8 cares about), so it needs a **streaming port** on `ctx` (`ctx.events?`), not a drive-by add. Barney **keeps its WS code** until a named later phase. *(Open: scope a minimal `subscribeLeaseStatus(ctx, leaseUuid, cb)` into P0 instead — flagged for owner decision.)*
- **Package renames** (dropping `mcp`) — a separate cosmetic pass. Phase 0 uses **Option A**.

## 4. Packaging — Option A (barrel + scoped subpaths)

A new package **`@manifest-network/manifest-sdk`**: an aggregating barrel that re-exports the curated public SDK surface from `core` + `fred` + `agent-core`. Existing package names unchanged; the release pipeline gains one package (published **last**, after its deps).

Audit refinement (every leading SDK ships a barrel **and** scoped entrypoints — viem `.` + ~25 subpaths, wagmi `wagmi`/`/actions`/`/query`, AWS SDK v3 fully modular): ship **scoped subpath entrypoints from day one** alongside the barrel —
`@manifest-network/manifest-sdk` (barrel) + `…/reads`, `…/catalog`, `…/deploy`, `…/orchestration` — and set **`"sideEffects": false`** on the SDK package (and verify each intermediate package keeps it). This de-risks the documented barrel-file tree-shaking pitfall (an aggregating barrel over 3 upstream packages is the highest-risk shape; `sideEffects:false` alone does not reliably rescue it) and keeps the browser example app's bundle small. Cheap now, expensive to retrofit, fully compatible with Option A's reversibility.

Node-only helpers (guarded fetch, keyfile signer) are exposed via **one** `node`-conditioned subpath `@manifest-network/manifest-sdk/node`, replicating `core`'s existing guard verbatim: `{ "types": …, "node": …, "default": null }` — the `"default": null` makes a browser/bundler resolution **fail loudly** instead of dragging undici/`node:async_hooks` into the graph. Add **`publint` + `attw` (Are The Types Wrong)** as CI-only checks (tsdown supports both) to validate the conditional-exports map and `.d.ts` resolution across node16/bundler.

The dual-package hazard is a **non-issue** here (ESM-only, `type:module`, stateless re-exported surface) — confirmed, not assumed.

## 5. Components

### 5.1 Canonical types in `core` (over manifestjs)

Relocate the value types into a **single chokepoint module** `core/src/manifest-types.ts` — the *only* file permitted to import manifestjs generated type paths — re-exported by `fred`, `agent-core`, and the SDK barrel. Re-exports of manifestjs protobuf types (`Lease`, `SKU`, `Provider`, `CreditAccount`, `Coin`) are **type-only** (`export type { … }`) so no generated runtime/encoder code leaks into the browser barrel. The single chokepoint is what makes the §8 CI import-rule trivial and exact.

Types to own canonically:
- `DeployAppInput`, `ServiceConfig` (`fred/src/tools/deployApp.ts`), `BuildManifestOptions` / `ManifestFormat` / `ManifestValidationResult` (`fred/src/manifest.ts`), `DeployManifestInput` / `DeployAppResult` (`fred/src/tools/deployManifest.ts`), the manifest-preview input (`fred/src/tools/buildManifestPreview.ts`).
- **`SkuIntent`** = `{ kind: 'byName'; size; providerUuid?; skuUuid? } | { kind: 'resolved'; skuUuid; providerUuid }` — **one** definition, replacing `fred`'s `SkuSelector` (`deployManifest.ts:72`), `core`'s `ResolveSkuInput`, and `agent-core`'s loose `size`/`providerUuid`/`skuUuid` fields.
- **`PortConfig`** — **net-new** (does not exist today; the current shape is `ServiceConfig.ports?: Record<string, Record<string, never>>` + flat `DeployAppInput.port?: number`). Introduce it carrying the ENG-282 `{ host_port?; ingress? }` shape as the canonical port type. (Not a relocation — a new type whose shape ENG-282 defines.)

`fred` imports + re-exports the relocated declarations (no consumer breakage). **`agent-core` keeps its narrow deploy/SKU fields through P0** (converged in P1, which deletes `build-fred-input.ts`); the canonical `core` types and `agent-core`'s loose fields **coexist by design** until then — so the §8 boundary guard MUST exempt `agent-core`'s internal types until P1, or it will block P0.

### 5.2 `CapabilityCtx` + `createManifestClient`

```ts
interface CapabilityCtx {
  chain: CosmosClientManager;     // connection, signing, rate-limit, retry
  query: ManifestQueryClient;     // configured manifestjs LCD/RPC client (raw typed reads)
  signer?: Signer;                // unified signer port (§5.3); ABSENT in query-only mode
  fetch: typeof globalThis.fetch; // injected fetch (guarded on node, providerFetch in browser)
}
type QueryCtx = Omit<CapabilityCtx, 'signer'>; // no signer member at all

// Overloaded so the mode is a TYPE distinction, not just a runtime throw:
function createManifestClient(opts: { config; walletProvider: WalletProvider; fetch?; skuSpecs? }): CapabilityCtx;
function createManifestClient(opts: { config; fetch?; skuSpecs? }): QueryCtx;
```

`ctx.query` is `core.createLCDQueryClient(...)` / `clientManager.getQueryClient()` — the manifestjs client with `lcd-adapter` normalization, **inheriting `CosmosClientManager`'s existing restUrl-preferred routing unchanged** (do not re-decide it). This is the idiomatic viem `createClient` + `fn(client, args)` model and the wagmi `createConfig` optional-wallet (read-only) model — query-only consumers get a **compile error** if they reach for `signer`, with the existing `INVALID_CONFIG` throw retained only as the runtime backstop for the stringly/MCP path.

**Interface-segregation (ISP):** building blocks are typed against the **narrowest slice** of `ctx` they use — a read takes `(ctx: Pick<CapabilityCtx, 'query' | 'chain'>, input)`, a deploy takes `(ctx: CapabilityCtx, input)` — so query-only consumers can call reads even with no signer. (Document that consumers bind `ctx` once and partially-apply, viem-`.extend()`-style, rather than threading it per call.)

### 5.3 Ports

**`Signer`** — one wallet-shaped port (mirrors the Keplr wallet object: `getOfflineSigner` + `signArbitrary` + `getKey` co-located), but **interface-segregated at the type level** so a keyfile-only-tx signer isn't forced to implement ADR-036 it may not support:

```ts
interface TxSigner   { getAddress(): Promise<string>; getSigner(): Promise<OfflineSigner>; }       // chain tx
interface AuthSigner extends TxSigner { signArbitrary(address: string, data: string): Promise<SignArbitraryResult>; } // ADR-036
type Signer = AuthSigner; // the full wallet shape app authors hold; TxSigner is the narrowed subset
```

Query-only and pure-tx flows depend on `TxSigner`; deploy/provider/auth flows depend on `AuthSigner`. `WalletProvider` (`core/src/types.ts`, `signArbitrary` optional) remains the concrete shape; a `requireAuthSigner(ctx): AuthSigner` guard narrows once at the boundary (throws `INVALID_CONFIG` if absent). `getSigner()`'s `OfflineSigner` is **`@manifest-network/stargate`'s** (the fork override) so it stays consistent with `connectWithSigner`. Concrete impls live at the **edge** (node keyfile/mnemonic in `packages/node`; browser wallet in Barney's CosmosKit); `core` never holds a key (the `platform:neutral` build is the guardrail). This is exactly cosmjs's edge-injected BYO-signer (`connectWithSigner(endpoint, signer)`).

**Auth-token factory** — `createAuthTokens(signer: AuthSigner, { chainId }) → { getAuthToken, getLeaseDataAuthToken }`, wrapping `fred`'s `AuthTokenService`. Tokens are **lazily cached and re-signed on expiry** (ADR-036 tokens carry a unix timestamp with server-enforced expiry — mirror `AuthTokenService`'s TTL; **not** mint-per-call, or every provider HTTP call eats signing latency). Replaces the per-call closures threaded into every `fred` fn and Barney's `makeFredAuthTokens` (`barney/src/ai/toolExecutor/fredAuth.ts`).

**`fetch`** — on `ctx`; default guarded-undici (node subpath) or `globalThis.fetch` (browser); Barney injects `providerFetch`.

### 5.4 Reads — two faces

- **Stringly:** `cosmosQuery(...)` — unchanged (MCP/LLM).
- **Raw typed:** `ctx.query.liftedinit.billing.v1.leases({...})` etc. — manifestjs, **no wrapper**.
- **Value-added typed building blocks (`core`):** these largely **already exist** as handlers in `core/queries/*` and are surfaced today as **stringly MCP tools in `packages/lease`** (`get_skus`, `get_providers`, `leases_by_tenant`, `lease_by_custom_domain`) and as **typed fns in Barney** (`src/api/billing.ts`, `src/api/sku.ts`). The P0 work is to **unify these into one typed `core` fn each** (reuse the existing handler + add pagination defaults/filters) — *not* port net-new logic from Barney. Inventory:
  - `getBalance` (+runway), `getCreditAccount`, `getCreditEstimate`, `getCreditAddress`, `getAccountInfo` (chain account/sequence/balance — `chain` server's `get_account_info`).
  - `getLeasesByTenant(state?, pagination?)`, `getLease`, `getLeasesByProvider`, `getLeasesBySKU`, `getWithdrawableAmount` (per-lease), **`getProviderWithdrawable`** (per-provider earnings, paginated — a provider dashboard needs it), `getAllLeases` / `getAllCredits`, `getBillingParams` (all in `barney/src/api/billing.ts` today).
  - `getProviders` / `getSKUs` / `getSKUsByProvider` / `getSKUParams`, `getLeaseByCustomDomain`.
  - **`paginateAll(ctx, pageFn, { maxPages })`** — **net-new** generic exhaustion helper (follows `nextKey`, respects rate-limit via `ctx.chain.acquireRateLimit`, caller-supplied page cap). The current handlers do single-page reads returning `hasMore`/`nextKey`; `getAll*` compose `paginateAll`.

### 5.5 Catalog / SKU / pricing + customizable spec-map

- `browseCatalog` — one canonical, **stays in `fred`** (it calls `getProviderHealth`, provider HTTP over the injected fetch) and is re-exported via the SDK.
- `resolveSku` / `listSkuCandidates` — `core`, unchanged.
- **New `core` helpers — PURE functions over already-fetched `SKU[]`/`Provider[]` + the spec-map (no HTTP, no fetch), so they are safe in `platform:neutral` core:** `selectCheapest(...)`, `normalizeHourlyPrice(price, unit)`, the tier-spec join. `browseCatalog` (provider HTTP, in `fred`) fetches the data and feeds them. *(This closes Open-Q1 and the §8 isomorphism risk: the pricing helpers never reach for provider HTTP.)*
- **`SkuSpecSource` (customizable):** the consumer supplies the off-chain CPU/RAM/disk specs:
  ```ts
  type SkuSpecMap = Record<string, { cores: number; ramMB: number; diskGB: number }>;
  type SkuSpecSource = SkuSpecMap | ((ctx: CapabilityCtx) => Promise<SkuSpecMap>);
  ```
  Internally **normalized to one resolver and memoized** on first resolution (an async source is not re-fetched per pricing join; the producer must be pure/idempotent). The factory form receives `ctx` so a **remote** spec source reuses `ctx.fetch` and stays inside the SSRF guard rather than reaching for a second fetch. `core` does the join (chain SKUs × spec-map) + cheapest + per-hour pricing; the **spec source is the consumer's** (env, remote, static). Display formatting (e.g. `formatTierSpecs`) stays **consumer-side** (presentation, not capability).

### 5.6 Transactions — two faces

- **Stringly:** `cosmosTx` / `cosmosEstimateFee` — unchanged.
- **Typed building blocks (`core`):**
  - `fundCredits`.
  - `setItemCustomDomain(ctx, { leaseUuid, customDomain, serviceName? })` — pass `customDomain: ""` (or `clear: true`) to **clear**; this is the **only** domain write (there is no separate `clearItemCustomDomain`).
  - `stopApp` — **this IS the close-lease write** (the lease server's `close_lease` wraps it). Expose **one** typed fn, not two.
  - a **faucet** helper (drip + verify) surfaced from chain logic (Barney reinvents it in `src/api/faucet.ts`).
  - Per-module tx composers (`core/transactions/*`; 14 `routeXxxTransaction` defined, 12 re-exported) are exposed typed only where an app needs them; otherwise apps use `cosmosTx` or manifestjs composers.

### 5.7 Fred provider ops

`deployManifest` / `deployApp` / `buildManifest` / `restartApp` / `updateApp` / `getAppLogs` / `appStatus` / `waitForAppReady` / `uploadLeaseData` / `pollLeaseUntilReady` — built, re-exported via the SDK. Converting their ad-hoc positional DI to `ctx` is **P2**; P0 leaves signatures as-is.

### 5.8 MCP servers as thin callers (back-compat)

The chain/lease/fred/cosmwasm/agent servers keep their tool surface. Where they duplicate logic now in the typed API, they become thin callers — but **the typed fn must be a byte-equivalent substitution**. The refactor is gated by **BOTH** the pinned `annotations`/`_meta.manifest` matrix tests **AND** each server's existing behavioral `*.test.ts` suites (response shape via `bigIntReplacer`, error text, canonicalization/trims — e.g. `lease_by_custom_domain` trims at two layers, rate-limit timing). **Snapshot each tool's JSON output before the refactor.** "No behavior change" is a *tested obligation*, not an assertion; the annotation matrix alone (it pins metadata, not runtime behavior) is too weak.

## 6. Data flow (examples)

- **Query:** `createManifestClient(...)` → `ctx.query.liftedinit.billing.v1.leases(...)` (raw) **or** `getLeasesByTenant(ctx, tenant, { state })` (value-added) → typed `Lease[]`.
- **Deploy (P0 capability path, pre-orchestration):** `resolveSku(ctx, intent)` → `buildManifest(...)` → `deployManifest(ctx, { manifest, sku, customDomain })` → `DeployAppResult`. The orchestrated plan/confirm/recover path is `agent-core` (P1). **The acceptance test exercises this capability path and therefore passes at end of P0** (it needs nothing from `agent-core`/P1).

## 7. Error handling

Preserve `ManifestMCPError` + `ManifestMCPErrorCode` + `sanitizeForLogging` + retry classification (`retry.ts`). The SDK surfaces the **same** typed errors; no new error model. `SKU_AMBIGUOUS`, `OPERATION_CANCELLED`, `INVALID_CONFIG`, etc. unchanged.

## 8. Isomorphic / build constraints + boundary enforcement

- `core`, `fred`, `agent-core`, `manifest-sdk`: `platform:neutral` + dynamic-import-gated node code (the proven pattern this repo runs). `"sideEffects": false` end-to-end so neutral builds stay tree-shakeable.
- Node-only code stays behind the `…/node` **subpath** with the `"default": null` browser-hard-fail guard (§4). `publint` + `attw` in CI validate the exports map + `.d.ts`.
- **Boundary enforcement — split by mechanism** (an import-graph tool cannot do a semantic type check):
  - **Import-edge rules → `dependency-cruiser`** (framework-agnostic; this repo is npm workspaces, not Nx): (a) *only* `core/src/manifest-types.ts` may import manifestjs generated type paths; (b) *only* `core` may construct the LCD/RPC client; (c) the **whole dependency DAG** direction `edge → agent-core → core → manifestjs`, never reverse, no `agent-core → edge` — this same config can subsume the ENG-281/287 browser-barrel hygiene checks. The aggregating barrel must re-export **only** from each package's public browser-safe entry (never deep paths).
  - **Semantic "narrower re-declaration of the same shape" (the actual Barney/agent-core failure) → NOT a grep.** A regex misses `type X =`, aliases, partial shapes, and namespaced names, and this repo has scars from grep-based CI checks misfiring. Rely on the **single-source-of-truth canonical type + `tsc`** to flag drift; add a `ts-morph`/AST check only if full automation is wanted.
  - The boundary guard ships with its **own meta-test** (a known-bad fixture it must fail on) — avoid the "test passes because of the bug" trap.

## 9. Testing & acceptance

- Unit tests per building block (co-located `*.test.ts`), reusing existing suites.
- **Cross-face equivalence test:** the same input through the stringly face and the typed face yields equivalent results (pins the §2 single-handler invariant).
- **The acceptance test (single tracked "done" metric, a P0 deliverable):** an in-repo example app (e.g. `examples/minimal-app`) that, composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, (1) queries leases/credit/catalog and (2) runs the **deploy capability path** — **built for the browser**. CI asserts not just that it compiles but that the emitted browser chunk contains **no node builtins** (`node:`/`async_hooks`/`undici`/`fs`) and stays within a **bundle-size budget** (`size-limit`/`bundlewatch`) — converting "it builds" into "the isomorphic contract held."
- The pinned annotation/`_meta` matrix tests **and** the server behavioral suites stay green (§5.8).

## 10. Migration & back-compat

- **Additive:** new `manifest-sdk` package + new `core` modules; existing packages keep working.
- `fred` re-exports the relocated types (no consumer breakage).
- Servers refactor to thin callers incrementally; gated by §5.8 (behavioral suites + matrix + JSON snapshot).
- **Plugin:** already on `0.14.0` via MCP; unaffected by P0.
- **Barney:** adopts in P3 (deletes `src/api/` + `compositeTransactions.ts`); untouched in P0.

## 11. Risks & mitigations

- **Browser-bundle regression** from a node-only leak into the SDK barrel → the example-app browser build (with the no-node-builtins assertion + size budget) + the `dependency-cruiser` DAG/boundary guard + `publint`/`attw` (ENG-281/287 cascade lesson). The aggregating barrel is the highest-risk spot — re-export only public browser-safe entries.
- **Type-relocation churn** (`fred` → `core`) → keep `fred` re-exports; compile-error-driven. Note: `agent-core` retains its narrow types through P0, so the canonical `core` types and `agent-core`'s loose fields **coexist transiently** until P1; the §8 boundary guard must exempt `agent-core`'s internal types until then.
- **Dual-face drift** → the single shared handler + the cross-face equivalence test (§9); neither face owns business logic.
- **Scope creep into P1/P2** → P0 explicitly leaves `agent-core` and legacy-fn `ctx` conversion alone.
- **ENG-282** (PortConfig `host_port`/`ingress`) → the canonical `PortConfig` IS the ENG-282 shape; introduce it during the type work.

## 12. Open questions (with leans)

1. ~~Does `browseCatalog` move into `core`?~~ **Resolved:** stays in `fred` (provider HTTP); pricing helpers are pure and consume its output (§5.5).
2. `SkuSpecSource` shape — **Resolved:** union, normalized + memoized internally, factory receives `ctx` (§5.5).
3. SDK node-only subpath — **Resolved:** one `…/node` (matches viem's single `viem/node`); split per-capability only if a concrete consumer needs it.
4. **Live events** — defer with a streaming port (default), or scope a minimal `subscribeLeaseStatus` into P0? **Owner decision.**
5. File a Linear epic + per-phase issues now? **Recommend:** yes, once the spec is approved.

## 13. Phase 0 deliverables checklist

- [ ] `@manifest-network/manifest-sdk` package — barrel **+ scoped subpaths** (`/reads`, `/catalog`, `/deploy`, `/orchestration`) + `…/node` with `"default": null` + `"sideEffects": false` + release wiring
- [ ] Canonical types relocated to `core/src/manifest-types.ts` (single chokepoint, type-only re-exports); `fred` re-exports; `SkuIntent` unified; `PortConfig` net-new (ENG-282 shape)
- [ ] `CapabilityCtx` / `QueryCtx` + overloaded `createManifestClient` (type-level query-only vs full)
- [ ] `TxSigner`/`AuthSigner` split + `requireAuthSigner` guard + `createAuthTokens(signer, { chainId })` (lazy-cached) + `fetch` on `ctx`
- [ ] Value-added typed reads (billing/lease/credit/sku/provider/account) in `core` — **unify** existing lease-server handlers + Barney typed fns, don't reinvent
- [ ] `paginateAll` generic exhaustion helper (net-new)
- [ ] `selectCheapest` + `normalizeHourlyPrice` + tier-spec join (pure; customizable memoized `SkuSpecSource`)
- [ ] faucet helper
- [ ] `dependency-cruiser` boundary + whole-DAG guard (with meta-test) + `publint`/`attw` CI
- [ ] Cross-face equivalence test
- [ ] Example app + acceptance test (browser build; no-node-builtins assertion + size budget; CI)
- [ ] Servers refactored to thin callers (behavioral suites + matrix green; JSON snapshots)
- [ ] SDK author guide (docs)
- [ ] Live-events decision recorded (§3 / Open-Q4)
