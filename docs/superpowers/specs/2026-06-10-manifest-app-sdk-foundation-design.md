# Manifest App SDK — Phase 0 Foundation Design

- **Status:** Draft for review (v8 — branding-model fix from the Plan-3a-triggered spec re-review: §5.0 now documents **two brand-producer families** — `parse*` (validate at the untrusted boundary) + `as*` (trust-cast, no-revalidation, at the trusted chain/codegen boundary) — resolving a live §5.0/§5.1/§8 contradiction (a re-validating `parse*` can't express the trust-cast the chain-read boundary mandates, and throws on non-canonical ids); the `as*` impl + `DeployResult` branding are sequenced into Plan 3b; corrected the type-fest PR #875 citation and the viem trust-cast attribution. v7 — big-picture re-review corrections: branding **scoped down** to confusable ids (5 brands; `tierName`/`denom`/`chainId` → plain `string`); **bound-method `ManifestClient`** face added beside the tree-shakable free fns; **API Extractor enforcement deferred** to external-publish/1.0 (hand-curated barrel + plain `@beta` TSDoc for P0); **P0 split P0a/P0b** + 5 zero-consumer reads cut to P0b; "two faces, one implementation" re-framed to **one client + one validation chokepoint**; per-process mutex boundary + ADR-070 Later note; signer port = InterchainJS-migration seam; god-core split tripwire)
- **Date:** 2026-06-10
- **Owner:** Felix Morency
- **Related:** `manifest-app-sdk-readiness.md` (living scorecard, same dir); **Linear epic ENG-308** (P0 = ENG-309, P1 = ENG-310, P2 = ENG-311, P3 = ENG-312, P4 = ENG-313, later = ENG-314/ENG-315)
- **Supersedes framing of:** ENG-127 (orchestration umbrella), ENG-279 (Barney migration)
- **Verification:** v2 (3-stream), v3 (streaming research + type-safety), v4 (final idiomatic review), v5 (gap analysis + versioning/logging research), v6 (final v5 idiomatic review: concurrency/sequence, options/logger/versioning, holistic), v7 (big-picture re-review — architecture-coherence + Cosmos-ecosystem alignment + YAGNI/risk, ground-truth-verified against the live Barney repo). All "sound-with-tweaks", no architectural reconsideration; v7 applies the convergent tweaks (branding scope, bound-method face, defer API Extractor, P0a/P0b split). **A third big-picture re-review (97-agent adversarial fan-out, 5 lenses × refute-by-default verification) confirmed the v7 corrections landed correctly + idiomatically and the whole coheres — verdict "sound-with-tweaks, ready to BUILD not re-review."** Three small tweaks applied from it: §5.2 dual-export precedent narrowed to viem (cosmjs/InterchainJS ship only the fat client); §5.6 `getSequence`-no-cache assumption verified against the installed `@cosmjs/stargate` source + pin requirement; §9 cross-face test scoped by an explicit passthrough-vs-composite classification. (The other lens "needs-rework" verdicts measured implementation completeness — the design is ~95% specified, ~5% built — not a spec flaw.) v8 (Plan-3a-triggered spec re-review — 4 lenses × refute-by-default, online idiomatic checks): verdict still **"sound-with-tweaks, go build"**; fixed the §5.0 trust-cast/`parse*` two-family contradiction (the genuine spec-internal inconsistency the plan-level review surfaced), the type-fest PR #875 mis-citation (a sibling the v2–v7 reviews missed), and the viem attribution — all spec-language only; the `as*` code stays sequenced in Plan 3b.

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

**Two faces over one client + one validation chokepoint** (NOT "one handler set" — the typed face is deliberately richer): the **stringly face** (`cosmosQuery`/`cosmosTx`, the MCP/LLM **transport adapter**, and the parse boundary §5.0) and the **typed face** (configured `ctx.query` + value-added typed building blocks returning **branded** types) share **one configured client** (`ctx`/`ManifestClient`) and **one semantic-validation chokepoint** (the `parse*` constructors §5.0) — but they are **allowed to differ in richness**. Where both faces cover the same operation (passthrough reads/txs), the **cross-face equivalence test** (§9) pins them (same input → equivalent result, same `ManifestMCPErrorCode`). Composite typed reads (e.g. `getBalance` = bank + credit + estimate + runway) have **no stringly equivalent by design** — they are app-surface only, so the equivalence test is scoped to the genuinely-overlapping passthrough surface + the parse boundary, not the composites. The stringly face is an **MCP/LLM adapter concern, not a recommended app-developer entry point**; app developers use the typed / bound-method face (§5.2) so they never build on the stringly parse boundary.

## 3. Phases & scope boundaries

- **P0** — the SDK foundation (this doc), split so value ships before the whole hexagon is green:
  - **P0a** — the **acceptance-test spine**: `createManifestClient`/ctx + bound `ManifestClient`, signer port, the reads+txs the deploy→query→connection→domain→batch→subscribe(poll)→stop e2e actually exercises, `executeTx` + per-signer serialization, the fred+lease thin callers, the barrel. **Gated on the e2e** (§9) — this is the single tracked acceptance metric.
  - **P0b** — **anticipatory surface** that the spine does not exercise (the 5 no-live-consumer reads §5.4, `paginateAll` for non-exercised paths, pricing helpers without a current consumer). Lands **incrementally**, **not** gated on the acceptance metric.
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

### 5.0 Type safety — scoped branded domain types for confusable ids

**Principle:** the typed face and canonical SDK types use **branded (opaque) domain types** for the identifiers where a mix-up is **plausible and costly** — *not* blanket-branding every string. The entire Cosmos stack this SDK sits on (cosmjs `SigningStargateClient`, Telescope/manifestjs query methods, InterchainJS, cosmos-kit) uses bare `string` for ids; blanket brands would import a discipline the ecosystem rejected and tax every cosmjs/Telescope interop point for little gain (the v7 Cosmos-alignment finding). viem can brand cheaply because EVM ids are **free structural template literals** (`Hex`/`Hash` = `` `0x${string}` ``); Manifest's bech32/UUID/FQDN ids are opaque strings, so a brand costs a runtime parse — which only earns its keep where confusion is real:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B }; // never exported; STRING key, not unique symbol
type Address=Brand<string,'Address'>; type Tenant=Address; type LeaseUuid=Brand<string,'LeaseUuid'>;
type ProviderUuid=Brand<string,'ProviderUuid'>; type SkuUuid=Brand<string,'SkuUuid'>; type Fqdn=Brand<string,'Fqdn'>;
// SCOPED-DOWN SET (5 brands). Kept where mix-ups are plausible AND costly: the same-shaped Lease/Provider/Sku UUID
// trio (the real payoff — easy to mis-pass to the same fn; the §9 tsd fixture targets it), Address, and Fqdn
// (parse also NORMALIZES — case + IPv4-literal rejection). `tierName`/`denom`/`chainId` are PLAIN `string` —
// single-role-per-call-site, low confusion risk, and the whole ecosystem uses bare string for them.
// quantities reuse manifestjs Coin { denom, amount }; never a bare string amount
```

- **String `__brand` key, not `unique symbol`** — a `unique symbol` brand is non-assignable across *duplicated* package copies (the worktree dep-drift hazard CLAUDE.md documents for `ipaddr.js`). type-fest hit the same duplicated-copy non-assignability problem with its `unique symbol` `Tagged` and chose a locked **shared-symbol** package (`tagged-tag`, PR #875), which it called superior to converting to strings; we take the simpler **string-key** route — a string `__brand` tag is unconditionally assignable across duplicated copies **without** a shared-symbol dependency, which suits a monorepo with worktree dep-drift. (The earlier draft mis-cited PR #875 as a symbol→string *reversion*; it was not — the string-key choice is ours, justified by the no-shared-dep constraint, not by that PR.)
- **`Tenant = Address`** is an intentional transparent alias; branding does not distinguish tenant from address (the §9 fixture covers *distinct* brands).

**Two sanctioned brand-producer families, one per boundary trust-model** (both live **only** in `brands.ts`, so the lone `as Brand` cast stays confined there per §8):

1. **`parse*` — validate + brand at the UNTRUSTED boundary** (`parseAddress`, `parseLeaseUuid`, `parseProviderUuid`, `parseSkuUuid`, `parseFqdn`). Throwing, type-narrowing boundary functions used where input is **untrusted**: the stringly/MCP face (LLM args), provider-HTTP reads surfaced as branded ids, and wallet-in. Each throws a dedicated **`INVALID_ARGUMENT`** code on malformed input.
2. **`as*` — trust-cast (no validation) at the TRUSTED boundary** (`asLeaseUuid`, `asProviderUuid`, `asSkuUuid`, plus `asAddress`/`asFqdn` as needed). Brands an **already-trusted** value **without** re-validating and **never throws** — for chain/codegen reads (`ctx.query`/lcd-adapter), where the chain is the source of truth and re-validating both wastes work and violates parse-once (ENG-258). The `as` prefix honestly signals "no validation, mirrors the TypeScript `as` keyword."

*(This partially revisits Plan 1's "uniform `parse*`, no `as*`" decision — deliberately. Plan 1 dropped `as*` to avoid overloading the unsafe-cast keyword, **before** the boundary-policy-by-trust table and the ENG-258 parse-once constraint forced a distinct trusted-boundary producer. The reversal is partial — `parse*` remains the sole untrusted-boundary family — and the two prefixes now make each call site's trust decision explicit. The `as*` family is implemented in Plan 3b alongside the first chain-read branding; only this spec language lands now.)*

The throwing `parse*` family each throws a dedicated **`INVALID_ARGUMENT`** code on malformed caller input (a new `ManifestMCPErrorCode` member — the AIP-193 / ENG-258 `SKU_AMBIGUOUS` precedent; "no new error model" means reusing the error *machinery* — `sanitizeForLogging`, retry classification — not forbidding a new enum member; it is consistent across entry points, unlike overloading `INVALID_CONFIG`). They reuse the repo's bare-string validators: `validateAddress` (relocated to the dependency-light `validation.ts` so the brand chokepoint doesn't reach into the tx layer) and a bare-string `assertUuid` extracted from `requireUuid`. (`tierName`/`denom`/`chainId` are plain `string`; a `denom` is still shape-checked where it matters via the existing `DENOM_RE` in `parseAmount`, but no `Denom` brand is minted.) **`parseFqdn` consolidates the *existing* client-side FQDN validator** (the repo already has one — `agent-core`'s `FQDN_RE`; the prior "no existing validator" claim was wrong): `parseFqdn` becomes the single source of truth, **normalizing case** (RFC 4343 — DNS is case-insensitive; don't reject `APP.com`, lowercase it) and adopting `FQDN_RE`'s stronger rules (reject IPv4 literals via a letter-led top-level label, reject scheme prefixes, ≤253 chars, RFC-1123 labels); `agent-core` adopts it in P1/P3. The chain stays authoritative. The lone `as Brand` cast lives **only inside `brands.ts`** (enforced by §8).

**Boundary policy by trust** (brands are runtime-erased, so re-applied at every runtime boundary):

| Boundary | Policy |
|---|---|
| Stringly/MCP face (LLM args) | **parse + validate** → brand (single semantic-validation site) |
| Chain/codegen reads (`ctx.query`/lcd-adapter) | **brand via the `as*` trust-cast family** at the mapping site — no re-validation (chain is source of truth — viem likewise types decoded RPC outputs as `Address` *without* re-checksumming, i.e. it trusts upstream; the named `as*` family is ours, justified by parse-once/ENG-258 + the TS `as` convention, not by a viem `as`-producer); never throws `INVALID_*` |
| Provider-HTTP reads (Fred: `FredLeaseStatus`, deploy/catalog) | **parse + validate** (provider untrusted) when surfacing as a branded id |
| Wallet-in (`WalletProvider.getAddress(): string`) | **parse once** in the Signer adapter (§5.3) |
| Persisted-state `JSON.parse` | **re-brand** on load |

`string` survives only: (a) the stringly face (immediately parsed); (b) manifestjs codegen types; (c) provider wire types (`FredLeaseStatus`) whose string fields are opaque provider state.

**Considered & declined for P0:** Zod `.brand()` (conflicts with §7 no-new-error-model; not a dep; bundle weight) and type-fest `Tagged` (dep on the foundational module for ~8 zero-dep lines). Revisit if broader schema validation is adopted.

### 5.1 Canonical types in `core` (over manifestjs)

Single chokepoint `core/src/manifest-types.ts` (only file importing manifestjs generated type paths; type-only re-exports). **Data-vs-behavior split** (researched — the AWS-SDK-v3 / Azure-SDK / viem / DDD idiom): `core` owns only **pure value/DTO shapes** — runtime-orchestration fields never live on a canonical type. Canonical (id fields branded):
- `ServiceConfig`, `PortConfig` (**net-new**, ENG-282 `{ host_port?; ingress? }`), `ManifestFormat`, `BuildManifestOptions`, `ManifestValidationResult`, the manifest-preview input.
- **`SkuIntent`** = `{ kind:'byName'; size: string; providerUuid?: ProviderUuid; skuUuid?: SkuUuid } | { kind:'resolved'; skuUuid: SkuUuid; providerUuid: ProviderUuid }` (unifies fred's `SkuSelector`; `size` is a plain `string` tier name post-scope-down).
- **`AppDeploySpec`** / **`ManifestDeploySpec`** — the **DATA-ONLY** relocation of `DeployAppInput`/`DeployManifestInput` (manifest fields + `size`/sku-disambiguators/`storage`/`customDomain`/`serviceName`). The four **runtime fields** (`onLeaseCreated`, `abortSignal`, `pollOptions`, `gasMultiplier`) are **stripped off** — they move to a fred-layer call-options bag (§5.7). This is load-bearing: keeping `pollOptions?: Omit<PollOptions,…>` on the canonical type would invert the DAG (`core → fred/http`), since `PollOptions` carries an `AbortSignal` + callbacks. It also makes "derive, don't re-declare" clean — `agent-core`'s spec *is* the canonical data (no fragile `Omit`-of-behavior).
- **`DeployResult`** (relocated `DeployAppResult`) — **keeps snake_case** (`lease_uuid`/`provider_uuid`/…): it is the **wire DTO** the `deploy_app` MCP `outputSchema` validates `structuredContent` against at runtime. Branding its id fields (`lease_uuid: LeaseUuid`) is **non-breaking** (brands erase to `string` in JSON), applied via the **`as*` trust-cast family** (§5.0) at the producer: `extractLeaseUuid` returns `LeaseUuid` by `asLeaseUuid`-casting the value its existing `requireUuid` already validated; `asProviderUuid` casts the already-on-chain-resolved provider id — **no** re-validation (parse-once; ENG-258; a re-validating `parse*` here would throw on the non-canonical-UUID provider ids the `kind:'resolved'`/`byName` paths pass verbatim). **Sequencing:** Plan 3a relocates `DeployResult` verbatim with plain `string` ids (zero behavior change); the id-field branding + the `as*` family land in **Plan 3b**. *Do not camelCase it* (would break the `outputSchema` + pinned `server.test.ts`). `agent-core` keeps its **own camelCase `DeployResult`** as a deliberate presentation projection (it already maps snake→camel) — a DTO-vs-domain boundary, not a re-declaration. A **mapping test pins the snake→camel projection** so the deliberate duplication can't silently drift.
- **`ConnectionDetails`** / `ServiceConnectionDetails` / `InstanceInfo` (confirmed **pure data** — relocated from `fred/http/provider.ts`), and **`FredLeaseStatus`** / `FredInstanceInfo`/`FredServiceStatus` (pure wire data; opaque-state fields stay `string`). `LeaseState` is a manifestjs enum already re-exported from `core` (no inversion).

**Stays in `fred`:** `PollOptions` (runtime: `AbortSignal` + `onProgress`/`checkChainState` callbacks). `fred`/`agent-core` derive their inputs from the canonical data and compose their own runtime options on top; `agent-core`'s narrow fields coexist until P1 (the §8 guard exempts them).

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

// Bound-method clients (the ergonomic, Cosmos-idiomatic face) — EXTEND the ctx, so a client IS a valid ctx.
// ManifestClient is a strict SUPERSET of ManifestReadClient (mirrors cosmjs `SigningStargateClient extends
// StargateClient`), so a full client is usable anywhere a read client is expected:
interface ManifestReadClient extends QueryCtx                         { dispose(): void; /* + bound read actions — no signer/tx/subscribe */ }
interface ManifestClient     extends ManifestReadClient, CapabilityCtx { /* + bound tx actions: deployApp(...), executeTx(...), subscribeLeaseStatus(...), … */ }

// TWO NAMED async factories (decision locked 2026-06-15 by the idiom-research-4b-factory online study). Cosmos-grounded:
//   - read vs full = two distinctly-NAMED factories, NOT one overload whose return flips on a signer arg
//     (cosmjs StargateClient.connect vs SigningStargateClient.connectWithSigner; manifestjs createRPCQueryClient
//      vs getSigning*Client; viem createPublicClient vs createWalletClient; ethers Provider vs Signer — unanimous).
//   - ASYNC because the wrapped Telescope/cosmjs query client connects EAGERLY (createRPCQueryClient awaits
//     connectComet); construction is await-once-then-read, the universal Cosmos idiom, so ctx.query is concrete.
//     (EVM factories are sync only because their transports connect lazily — the imported-idiom trap; Cosmos wins.)
function createManifestClient(opts:     { config; walletProvider: WalletProvider; fetch?; logger?; logLevel?; skuSpecs?; events? }): Promise<ManifestClient>;
function createManifestReadClient(opts: { config; fetch?; logger?; logLevel?; skuSpecs?; events? }): Promise<ManifestReadClient>;

// Per-call option bags (TxCallOptions is DISTINCT from core's existing internal `TxOptions`/`TxOverrides`):
type CallOptions   = { signal?: AbortSignal; timeout?: number };  // timeout bounds the request/confirmation wait
type TxCallOptions = CallOptions & { gasMultiplier?: number; fee?: StdFee; memo?: string };
// signal+timeout merge: SDK derives the effective signal via AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeout)]).
// fee precedence: explicit `fee` WINS (skips simulate/gasMultiplier/gasPrice; the one path valid WITHOUT a configured
// gasPrice); `gasMultiplier` applies only on the simulate path; both set = caller error. Per-call gasPrice is deferred
// (cosmjs#1526 unresolved upstream) — use explicit `fee`.
```

**Two consumption styles, one client.** `createManifestClient` / `createManifestReadClient` return (await-constructed) a **bound-method client** (`client.getLeasesByTenant(input, opts?)`, `client.deployApp(...)`, `client.executeTx(...)`, `client.subscribeLeaseStatus(...)`) — the ergonomic, fat-object face Cosmos devs expect (cosmjs `SigningStargateClient` and InterchainJS's signer-carries-queryClient are both single fat clients you call methods on), so the SDK doesn't read as a foreign EVM idiom. **The *dual-export* precedent (a bound client AND tree-shakable free functions from one package) is viem's specifically** — cosmjs/InterchainJS ship only the fat client; we take the fat-client *ergonomics* from Cosmos and the *tree-shakability* from viem. Because `ManifestClient extends CapabilityCtx`, the **same client is also a valid `ctx`** for the **tree-shakable free functions** `fn(ctx, input, opts?)` — the bundle-minimal primitive a browser app imports from `…/reads`/`…/deploy` (so it drags in only what it calls). The bound methods are a thin `.bind(ctx)` layer over those free functions; **neither is generated from the other** (no build-time codegen). **Honest drop-downs (no hidden client):** `client.query` is the raw Telescope query client and `client.chain` is the keyed `CosmosClientManager` whose async `getSigningClient()` returns the underlying cosmjs `SigningStargateClient`, so a cosmjs/Telescope-literate consumer can drop to `await client.chain.getSigningClient()` then `signAndBroadcast(...)`, or to `client.query.<module>.<service>(...)`, with zero surprise — the SDK reuses the ecosystem-standard objects rather than hiding them. (`client.chain` is the manager, not the signing client directly: the cosmjs object is reached via the async accessor — see the `CapabilityCtx.chain` JSDoc.)

`ctx.query` inherits `CosmosClientManager`'s restUrl-preferred routing unchanged. Two named factories → query-only consumers (`createManifestReadClient`) get a **compile error** reaching for `signer`/tx/subscribe (the `ManifestReadClient` type lacks them); runtime `INVALID_CONFIG` backstop via the query-only wallet stub + the stringly path. **ISP:** reads take `(ctx: Pick<CapabilityCtx,'query'|'chain'|'logger'>, input, opts?: CallOptions)`; txs/provider ops take the slice incl. `signer`/`fetch`/`logger` + `opts?: TxCallOptions`. `EventTransport` (§5.9) is forward-declared and `@beta`.

### 5.3 Ports

**`Signer`** (interface-segregated; `OfflineSigner` is **`@cosmjs/proto-signing`'s** — the `@manifest-network/stargate` fork overrides `@cosmjs/stargate`, not proto-signing):

```ts
interface TxSigner   { getAddress(): Promise<Address>; getSigner(): Promise<OfflineSigner>; }
interface AuthSigner extends TxSigner { signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>; }
type Signer = AuthSigner;
```

`Signer` is an SDK-surface **adapter over the concrete `WalletProvider`** (whose `getAddress(): string`): the adapter `parseAddress`es the address once, so the port exposes `Address` while the edge impl keeps `string`. `requireAuthSigner(ctx)` narrows once at the boundary. Impls at the edge (node keyfile/mnemonic; browser CosmosKit); `core` never holds a key.

*Forward-looking (migration seam):* the ecosystem is mid-migration from cosmjs to **InterchainJS** (Telescope 2.0's default; "CosmJS 2.0"), which replaces `OfflineSigner`/`SigningStargateClient` with a unified `IUniSigner`. The `Signer` port is the planned seam for that swap — keep it **shallow** (`getSigner(): OfflineSigner` confines the cosmjs coupling to **one method**; `signArbitrary` (ADR-036) is Manifest-specific and bespoke regardless), and treat the cosmjs signer shape as **migration-risk / `@beta`**, not a permanent contract. `manifestjs` + the `@manifest-network/stargate` fork must move first (§11).

**Auth-token factory** — `createAuthTokens(signer: AuthSigner, { chainId: string }) → { getAuthToken, getLeaseDataAuthToken }` (binds the address once — lazily, on first mint — then mints a **fresh** token per call; tokens are **never cached** — caching is unsafe vs the provider's ADR-036 replay tracker, which rejects duplicate signatures on protected endpoints; reuses `fred`'s stateless `AuthTokenService` builders). `chainId` is **reserved** for a future chain-scoped token format — accepted for API symmetry but not yet embedded in the ADR-036 message. Replaces Barney's `makeFredAuthTokens`.

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
  - **Leases/withdrawables (P0a spine):** `getLeasesByTenant({ state?, pagination? })`, `getLease`, `getWithdrawableAmount`, `getBillingParams`. **(P0b — cut from the spine, no live consumer):** `getLeasesByProvider`, `getLeasesBySKU`, `getProviderWithdrawable`, `getAllLeases`/`getAllCredits`.
  - **SKU/provider:** `getProviders`, **`getProvider(uuid)`**, `getSKUs`, **`getSKU(uuid)`**, `getSKUsByProvider`, `getSKUParams`.
  - **Custom-domain reads (the read side of `setItemCustomDomain`):** `getLeaseByCustomDomain(fqdn)`, **`getLeaseItemsForLease`**, **`getDomainAssignments`**, **`getDomainForService`**, **`getDomainCount`** (pure helpers over `Lease.items`), and **`getReservedDomainSuffixes`** (the off-chain reserved-suffix projection of params, for client-side FQDN pre-validation that `parseFqdn` defers to the chain).
  - **`paginateAll(ctx, pageFn, { maxPages })`** — net-new exhaustion helper (follows `nextKey`, rate-limit-aware). Note: `getLeasesByTenant` exposes cursor (`nextKey`) pagination; the old `lease_history` offset/limit UX maps onto it via the consumer (documented, not a separate block).

Note: `getProviderWithdrawable`/`getLeasesByProvider`/`getLeasesBySKU`/`getAllLeases`/`getAllCredits` have **no current live consumer** — moved to **P0b** (rule of three): they land incrementally when a provider/dashboard consumer needs them and are **not** part of the P0a acceptance spine. Building them now would be presumptive (YAGNI cost-of-carry with zero current payoff).

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
- **Per-signer broadcast serialization** (in `CosmosClientManager`) — for **independent** txs, when one atomic `executeTx` isn't possible: an async mutex/queue keyed by signer `Address` serializes the **whole** cycle — **simulate/estimate-fee → sign → broadcast → AWAIT BLOCK INCLUSION** (cosmjs default `signAndBroadcast`/`broadcastTx`, which polls to commit). The lock is *sufficient* precisely because cosmjs reads the **committed** account sequence (`getSequence → auth.account`) on every call with **no caching** (verified against the installed `@cosmjs/stargate` `stargateclient.js`: `getSequence` re-reads `getAccount(address)` from chain every call — no local cache, no optimistic increment; this is **load-bearing**, so pin the cosmjs/`@manifest-network/stargate` version and keep the height-assert test below as the regression guard): holding it through commit guarantees the next queued tx reads an already-incremented sequence, so **one account never races two txs into the same block** (sequence-mismatch protection). `signAndBroadcastSync`/`broadcastTxSync` (CheckTx-only, pre-commit) **MUST NOT** be used under this lock — the committed sequence hasn't advanced, so the next tx reads a stale sequence and fails "account sequence mismatch". A failed/timed-out tx still **releases the lock**; because we re-query the committed sequence each call there is **no** local counter to reset (a robustness win over the ethers/viem local-increment NonceManager). Different signers run in parallel; the mutex is orthogonal to the global rate limiter (document the acquire order). *Rationale: Cosmos uses one monotonic account sequence and proposer/priority-mempool reordering makes optimistic concurrent submission from one signer unsafe; the unordered-tx/parallel-nonce work (cosmos-sdk#13009) is not relied upon.* A **test asserts the queue awaits a committed `DeliverTxResponse` (has `height`)**, not a sync hash. Replaces Barney's hand-rolled signing mutex (which serializes only the `signArbitrary` call, not the broadcast→commit cycle — so this closes a *real* race). The serialization is **per-signer-Address within one SDK instance** — it does **not** coordinate across separate OS processes signing for the same key (the plugin + a daemon + Barney sharing a key still race; stated so consumers don't assume cross-process protection). *Later (tripwire, not P0): once Manifest enables ADR-070 unordered txs (upstream "ACCEPTED, not implemented" as of 2025; needs chain support + a unique per-tx `timeout_timestamp`), `executeTx` can offer an **opt-in** fire-and-forget path with no lock for throughput-sensitive callers — the default serialized path stays for ordered txs. So the mutex is "current best practice given chain support," not a permanent design.*

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

callback-in / **idempotent synchronous unsubscribe-out** + optional `AbortSignal` (abort ≡ unsubscribe, no `onError`; double-unsubscribe is a no-op). Needs `signer` (the poll transport mints the Fred lease-data token via `createAuthTokens(requireAuthSigner(ctx))`, like `appStatus`). Transport swappable behind the one surface: `ctx.events` if present, else `pollLeaseUntilReady`; **both parse each frame/response into branded `FredLeaseStatus` before `onData`** (a frame that fails to parse → `onError`, no crash). **P0 ships poll-backed; the WS transport is deferred** (§3) — its `EventTransport` is `@beta` (forward-declared), and swap-equivalence is a named-phase acceptance criterion, **not** proven at P0. To keep the deferred boundary honest (the abstraction is asserted, not validated, until both transports are in-tree), a **data-shape contract test ports Barney's *actual* Fred WS frame** (`provision_status`, from `barney/src/api/fred.ts`) **now** and asserts it parses to the **same branded `FredLeaseStatus`** the poll path emits — so the later WS impl validates against reality, not against the surface itself. Lives in `fred`; not on the stringly/MCP face.

## 6. Data flow

- **Query:** `const client = createManifestClient(...)` → `client.getLeasesByTenant(parseAddress(addr), { state, signal })` (or free-fn `getLeasesByTenant(client, parseAddress(addr), { state }, { signal })`) → `Lease[]`.
- **Deploy:** `resolveSku` → `buildManifest` → `validateManifest` → `deployManifest(ctx, …)` → `DeployAppResult`; show URL via `getLeaseConnectionInfo`.
- **Batch:** `executeTx(ctx, [msg1, msg2, …], { gasMultiplier })` — one atomic multi-message tx; concurrent calls per signer serialized.
- **Live status:** `const stop = subscribeLeaseStatus(ctx, leaseUuid, { onData })` — poll-backed today, WS later, identical caller code.

## 7. Error handling

Preserve `ManifestMCPError` + `ManifestMCPErrorCode` + `sanitizeForLogging` + retry classification. `parse*` constructors throw the **new `INVALID_ARGUMENT`** code (malformed caller input — added to the non-retryable set, mirroring the `SKU_AMBIGUOUS` precedent) or `INVALID_ADDRESS`; chain/codegen read brands are trust-casts (never throw); provider-HTTP read brands reuse the `INVALID_*` throws. The error *machinery* is unchanged (one new enum member is not a new error model).

## 8. Isomorphic / build constraints + boundary enforcement

`platform:neutral` + dynamic-import-gated node code; `"sideEffects": false` end-to-end; node-only behind `…/node` (`"default": null`); `publint`+`attw`. **`dependency-cruiser`:** (a) only `core/src/manifest-types.ts` imports manifestjs **type** paths (the existing `core/src/index.ts` `LeaseState`/`leaseStateFromJSON`/`leaseStateToJSON` **value** re-export is a runtime enum, not a type path — reconciling whether it also routes through the chokepoint is a **named deferral to the boundary-guards plan**, not a §8 violation); (a′) **both** brand-producer families (`parse*` and `as*`, §5.0) are declared only in `core/src/brands.ts` and re-exported, the lone `as Brand` cast only there; (b) only `core` constructs the LCD/RPC client; (c) the whole DAG `edge → agent-core → core → manifestjs`. Semantic "narrower re-declaration" relies on the single-source type + `tsc` (not a grep). The guard ships meta-tests (known-bad fixtures: duplicate manifest-type **and** duplicate `Brand`). A further `dependency-cruiser`/lint rule pins the trust boundary positively: **the lcd-adapter read path brands chain/codegen reads via the `as*` trust-cast family only — never `parse*`** (chain output is the source of truth; a re-validating `parse*` there both costs perf and violates the parse-once / ENG-258 invariant — and would throw on non-canonical ids). Public API surface is governed for P0 by a **hand-curated barrel + plain `@beta` TSDoc** on unstable symbols + `tsc` + the `dependency-cruiser` surface guard; **Microsoft API Extractor release-tag/`.api.md` enforcement is deferred** to the first out-of-monorepo publish / 1.0 prep (§14).

## 9. Testing & acceptance

- Unit tests per building block; **branded-type** tests (`parse*` round-trip/reject; tsd negative fixture for the `LeaseUuid`/`ProviderUuid`/`SkuUuid` trio; a **read-boundary fixture** that `ReturnType<getLease>.uuid` is `LeaseUuid` not `string`); **cross-face equivalence** (same input → equivalent result; a malformed id rejected by BOTH faces with the same `ManifestMCPErrorCode`).
- **Cross-face test scope — classify every P0a read/tx as PASSTHROUGH or COMPOSITE** (so the equivalence test is neither over- nor under-applied): a **PASSTHROUGH** building block (1:1 over a single `cosmosQuery`/`cosmosTx` subcommand — e.g. `getLeasesByTenant`, `getLease`, `fundCredits`, `setItemCustomDomain`, `stopApp`) **gets** the cross-face equivalence test, where "equivalent" treats **brand erasure as equal** (`LeaseUuid` → `string` in JSON is the same value); a **COMPOSITE** building block (fans out / adds derived fields — e.g. `getBalance` = bank + credit + estimate + runway, `browseCatalog`, `subscribeLeaseStatus`) is **typed-face only and has NO stringly equivalent by design**, so it gets unit tests but **no** equivalence test. The plan author tags each P0a fn at definition time.
- **The acceptance test (single tracked metric, P0):** an in-repo example app composing **only** `@manifest-network/manifest-sdk` + `manifestjs`, run **end-to-end against the existing `e2e/docker-compose.yml` (live chain + providerd + faucet)** via the `e2e/deploy-roundtrip` harness — exercising **deploy → query → getLeaseConnectionInfo → setItemCustomDomain → restart/update/getLogs → executeTx batch → subscribeLeaseStatus (poll) → stopApp**, covering single-service *and* a multi-service stack. **Additionally** build the same example **for the browser** and assert the emitted chunk has no node builtins (`node:`/`async_hooks`/`undici`/`ws`/`fs`) + a bundle-size budget. (Two distinct claims: it *deploys* — e2e; it *bundles for browser* — build.) The annotation/`_meta` matrix + converted-server behavioral suites stay green. **Phasing:** this e2e gates **P0a** (the spine); **P0b** deliverables (the no-consumer reads §5.4) land incrementally and are **not** part of the single tracked acceptance metric.

## 10. Migration & back-compat

- **Additive:** new `manifest-sdk` + new `core` modules; existing packages keep working. Brands are structurally `string`, so existing `string` call sites keep compiling during incremental migration.
- `fred` re-exports relocated types; `agent-core` narrow types coexist until P1.
- Servers convert to thin callers incrementally (P0 proves the pattern, P2 finishes), gated by §5.8.
- **Barney** migrates to the SDK in P3 (we accept it adopts the SDK surface directly rather than special-casing its in-flight ENG-279 work) and may opt into the orchestration tier; the **plugin** consumes the orchestration tier via the MCP adapter.

## 11. Risks & mitigations

- **Browser-bundle regression** (node leak incl. `ws`) → example browser build (no-node-builtins + size budget) + `dependency-cruiser` + `publint`/`attw`.
- **Branded-type friction** → one-way `string`-assignable, incremental; the cast is contained.
- **WS-SSRF + hostile frame** → deferred `ctx.events` node factory reuses the `ipaddr.js` unicast guard + the same frame parse as poll.
- **Upstream codegen/fork coupling (public-SDK stability risk):** "reuse never re-declare" makes the public type surface a passthrough of `manifestjs` (Telescope codegen) + the `@manifest-network/stargate` CosmJS fork — a codegen bump can break public types with no insulation. Mitigate via TSDoc release-tag conventions + a hand-curated barrel review + staying 0.x (§14; API-Extractor `.api.md` enforcement deferred to external-publish/1.0 so its diff doesn't become noise churned by upstream codegen bumps), pin manifestjs/fork exactly, track the elliptic/protobufjs CVE posture from the earlier review, and gate bumps on the acceptance e2e.
- **Signer-abstraction upstream drift:** the ecosystem is migrating cosmjs→InterchainJS (Telescope 2.0 default). The `Signer` port is kept **shallow** (`getSigner(): OfflineSigner` confines the coupling to one method) and is the **planned migration seam** (§5.3); cosmjs signer ergonomics are not over-invested.
- **`core` god-package pressure** (it owns connection + brands + the manifest-types chokepoint + ~all reads/txs + `executeTx`/mutex + pricing + ports + Logger): contained for P0 by scoped subpaths + `"sideEffects": false` + tree-shaking (the **proven viem shape** — a browser app importing `…/reads` drags in zero tx/mutex/node code) and the `dependency-cruiser` DAG. The residual risk is change-blast-radius, not bundle size. **Tripwire (write into the scorecard):** if a 6th provider-domain concern lands in `core`, split a chain-focused `manifest-core` from a provider-focused `fred-core` rather than growing one god-core.
- **Type-relocation churn**, **dual-face drift**, **ENG-282** → as before (chokepoint re-exports; cross-face equivalence test; canonical `PortConfig`).

## 12. Open questions (resolved)

1. `browseCatalog` stays in `fred`; pricing helpers pure. 2. `SkuSpecSource` memoized union w/ `ctx`. 3. One `…/node`. 4. Streaming: poll-backed surface P0, WS transport deferred (`@beta`). 5. Branding: hand-rolled `Brand` (Zod/type-fest declined). 6. **Versioning/stability:** lockstep + 0.x + TSDoc release-tag *conventions* (`@public`/`@beta`/`@internal`); API-Extractor `.api.md` *enforcement* deferred to external-publish/1.0 (§14). 7. **Logging:** silent-by-default injectable `Logger` port (§5.3). 8. **React bindings:** a later-phase `manifest-sdk-react` package (§3). 9. Linear epic + per-phase issues filed once approved (mind the free-tier issue cap — file the epic + per-phase issues; keep per-deliverable items as checklist entries, not issues).

## 13. Phase 0 deliverables checklist

Items are **P0a** (the acceptance-test spine — gated on the e2e §9) unless tagged **[P0b]** (anticipatory surface — lands incrementally, not gated on the acceptance metric).

- [ ] `@manifest-network/manifest-sdk` — barrel + scoped subpaths + `…/node` (`"default": null`) + `sideEffects:false` + release wiring; internal packages `private:true`
- [ ] Branded domain types (`core/src/brands.ts`) — **scoped set: Address/Tenant, Lease/Provider/Sku UUID, Fqdn (`tierName`/`denom`/`chainId` stay plain `string`)** + the **`parse*`** validate-at-untrusted-boundary constructors (`parseAddress`/`parseLeaseUuid`/`parseProviderUuid`/`parseSkuUuid`/`parseFqdn`); new `INVALID_ARGUMENT` code; `validateAddress` relocated to `validation.ts`; `parseFqdn` consolidates `agent-core`'s `FQDN_RE` (normalize case, reject IPv4 literals); cast only here; type-distinctness via `expectTypeOf` in `*.test-d.ts`; boundary policy by trust. **(The `as*` trust-cast family for chain reads — §5.0 family #2 — is added in Plan 3b alongside the first `DeployResult` branding.)**
- [ ] Canonical types → `core/src/manifest-types.ts` (chokepoint, type-only); **data-vs-behavior split** (canonical specs are data-only; `onLeaseCreated`/`abortSignal`/`pollOptions`/`gasMultiplier` move to a fred call-options bag, `PollOptions` stays in fred); `SkuIntent` unified; `PortConfig` net-new; `ConnectionDetails`/`InstanceInfo` + `FredLeaseStatus` relocated; `DeployResult` snake_case wire DTO, id-fields branded via the producer **`as*` trust-cast** (Plan 3b; Plan 3a relocates it verbatim with plain `string` ids) (agent-core keeps its camelCase projection)
- [ ] `CapabilityCtx`/`QueryCtx` + bound-method **`ManifestClient`/`ManifestReadClient`** (thin `.bind(ctx)` over the tree-shakable free fns; `client.chain`/`client.query` are honest cosmjs/Telescope drop-downs) + the **two named async factories** `createManifestClient`/`createManifestReadClient`; `CallOptions`/`TxCallOptions` (fee-wins precedence; `AbortSignal.any` merge) threaded through every typed read/tx/subscribe; `EventTransport` forward-declared (`@beta`)
- [ ] `TxSigner`/`AuthSigner` (`OfflineSigner` = `@cosmjs/proto-signing`) + `requireAuthSigner` + `Signer` adapter over `WalletProvider` + `createAuthTokens(signer,{chainId})`; `fetch` on `ctx`
- [ ] **`Logger` port** (silent `noopLogger` default, per-ctx level, injectable, isomorphic) + node-bootstrap adapter over the legacy singleton
- [ ] Value-added typed reads — the **spine read surface**: balances/credit/account, leases (`getLeasesByTenant`/`getLease`/`getWithdrawableAmount`/`getBillingParams`), sku/provider (+singles), **custom-domain reads** (`getLeaseItemsForLease`/`getDomainAssignments`/`getDomainForService`/`getDomainCount`/`getReservedDomainSuffixes`), `paginateAll`
- [ ] **[P0b]** anticipatory reads — `getLeasesByProvider`/`getLeasesBySKU`/`getProviderWithdrawable`/`getAllLeases`/`getAllCredits` (no live consumer; land when a provider/dashboard needs them)
- [ ] Typed txs (fee/gas/memo preserved) + **`executeTx` multi-message** + **per-signer broadcast serialization** + faucet
- [ ] `selectCheapest`/`normalizeHourlyPrice`/tier-spec join (pure; memoized `SkuSpecSource`); `getProviderHealth` standalone
- [ ] Fred ops incl. **`validateManifest`/`buildManifestPreview`/`checkDeploymentReadiness`** + **`getLeaseConnectionInfo`/`getLeaseProvision`/`getLeaseReleases`/`getLeaseInfo`**
- [ ] **`subscribeLeaseStatus`** (poll-backed; signer slice; parse-each-emit; `ctx.events?` deferred)
- [ ] `dependency-cruiser` boundary + brands.ts chokepoint + **no-`parse*`-in-lcd-adapter** rule + DAG guard (meta-tests) + `publint`/`attw` (browser no-node-builtins bundle assert) — **API Extractor release-tag enforcement deferred** to external-publish/1.0 (§14)
- [ ] Cross-face equivalence + branded-type negative + read-boundary fixtures
- [ ] Example app + **e2e acceptance** against `e2e/docker-compose` (deploy/query/connection/domain/restart/update/logs/batch/subscribe/stop, single + stack) + browser-build (no-node-builtins + size budget)
- [ ] Servers refactored to thin callers — **fred + lease in P0** (rest P2); behavioral suites + matrix green; JSON snapshots; `inputSchema` thin
- [ ] SDK author guide **+ fix the stale docs debt** (`SECURITY.md`/`docs` "four servers"; agent README `PLAN.md` 404)
- [ ] Versioning/stability policy applied (§14): 0.x lockstep, **TSDoc release-tag conventions + hand-curated barrel (API Extractor enforcement deferred)**, `EventTransport` `@beta`

## 14. Versioning & stability policy

`manifest-sdk` ships **lockstep-versioned** with the monorepo (cosmjs/Angular model; idiomatic for a tightly-coupled facade) and remains **0.x through P0**, making **no SemVer guarantee** at the package level — exactly the cover the forward-declared `EventTransport` needs (SemVer §4). Per-symbol stability is documented with **TSDoc release-tag *conventions*** (orthogonal to the package version): **`@public`** = supported (post-1.0, no breaking change without a major bump) — the ~30 settled fns, `CapabilityCtx`/`ManifestClient`, branded types, `Logger`; **`@beta`** = unstable preview that may change or be removed at any minor/patch — the `EventTransport` streaming shape ships `@beta` until finalized (use only `@alpha`/`@beta`/`@public`/`@internal`; `@experimental` is **not** a release tag); **`@internal`** = cross-package, never for third parties.

**Enforcement is right-sized to 0.x-with-one-in-repo-consumer (v7 YAGNI finding).** For P0 the gate is a **plain `@beta` TSDoc comment on unstable symbols (`EventTransport`) + a hand-curated barrel review + `tsc` + the `dependency-cruiser` surface guard** — at 0.x with one in-monorepo consumer, an API change is already a reviewed PR touching the barrel, so a `.api.md` diff would mostly re-encode what `tsc` + review give while churning on upstream `manifestjs`/Telescope codegen bumps. **Microsoft API Extractor (`.api.md` report diff + release-tag gating) is DEFERRED** to the phase where the SDK is first published **out-of-monorepo** (or 1.0 prep), where it earns its keep governing a public contract for external SemVer-pinning consumers; when added, scope its gate to the SDK's **own value-added surface** (the settled fns, `CapabilityCtx`/`ManifestClient`, ports), not the raw re-exported `manifestjs`/cosmjs types whose churn is upstream-driven. **`publint` + `attw`** (real ESM/types-resolution bugs that bite browser consumers) and **`dependency-cruiser`** (the load-bearing DAG/boundary invariants) stay in CI from P0 — they catch consumer-visible breakage that review misses; API Extractor does not, yet.

Public symbols are removed only via a **`@deprecated` grace period of ≥1 minor release** (never deleted in the same release they're deprecated) — a self-imposed courtesy during 0.x (SemVer compels nothing) that becomes binding at 1.0. The deferred `EventTransport` graduates `@beta`→`@public` **before** we cut a **1.0** (which turns `@public` into a binding SemVer contract) — and API Extractor enforcement lands no later than that 1.0 prep. Internal-only packages stay `private:true` so the public SDK can later be cut onto an independent changesets `fixed` group without churn, and the install graph must resolve **one** copy of `core`/`fred`.
