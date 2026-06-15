# SDK P0 — Plan 4b: CapabilityCtx + createManifestClient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the **`CapabilityCtx`/`QueryCtx`** types, the **two named async factories** `createManifestClient` (full/signing) + `createManifestReadClient` (query-only), and the **`ManifestClient`/`ManifestReadClient`** bound-method interface DECLARATIONS to `core`. The factory builds the ctx (validates config, calls `CosmosClientManager.getInstance` ONCE, wires the 4a `createSignerAdapter` in full mode, resolves `fetch`/`logger`, awaits the query client once). **Additive** — new types + factory + `dispose()` lifecycle; existing flows untouched. Second of the **CapabilityCtx keystone (4a→4b→4c→4d)**.

**Decisions locked (2026-06-15, the `idiom-research-4b-factory` online study):**
- **ASYNC factory.** Construction is `await createManifestClient(...)`, awaiting `chain.getQueryClient()` ONCE so `ctx.query` is a concrete, ready client. Grounded in the wrapped stack: cosmjs `StargateClient.connect`/`SigningStargateClient.connectWithSigner` are async (constructors `protected`), and Telescope/manifestjs `createRPCQueryClient` — the literal source of `ctx.query` — is `async` (awaits `connectComet`). The universal Cosmos flow is **await-once-then-read**. (EVM factories are sync only because their transports connect lazily — the imported-idiom trap; Cosmos wins because we wrap it.)
- **TWO NAMED factories**, not one overloaded factory whose return flips on a signer arg. Unanimous across the wrapped + corroborating ecosystems: cosmjs (`StargateClient` vs `SigningStargateClient`, the signing class EXTENDS the read class), manifestjs (`createRPCQueryClient` vs `getSigning*Client`), viem (`createPublicClient`/`createWalletClient`), ethers (`Provider`/`Signer`). `ManifestClient extends ManifestReadClient, CapabilityCtx` (strict superset, mirroring `SigningStargateClient extends StargateClient`).

**Architecture:** spec §5.2 (updated 2026-06-15 for the two locked decisions). `CapabilityCtx` is the 6-field capability bundle; `QueryCtx = Omit<CapabilityCtx,'signer'>`. The factory lives in platform-NEUTRAL `core`, so it must NOT statically import the node-only guarded fetch (ENG-281 browser-bundle hazard) — `ctx.fetch` is `opts.fetch ?? globalThis.fetch` (the node/fred edge injects the guarded fetch via `opts.fetch`, exactly as the servers inject today). `getInstance` REQUIRES a `WalletProvider` even in query-only mode, so `createManifestReadClient` passes a throwing **query-only wallet stub** and omits `ctx.signer`; the stub is never invoked (queries don't sign). The factory acquires one `getInstance` refCount, balanced by `dispose()` (implemented here) — including on a construction failure.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4 (runtime + `*.test-d.ts` typecheck, `typecheck.enabled` in `packages/core/vitest.config.ts`), tsdown (`unbundle: true` — per-file dist emit), `tsc --noEmit` lint (`noUnusedLocals: true`), Biome. Spec §5.2/§5.3. Issue: ENG-309. Builds on Plans 1/2/3a/3b/4a.

**⚠️ FULL-LINT LESSON (bit 4×):** run the **full-repo `npm run lint`** at every task gate — interface/type changes ripple to consumer-package tests, and vitest erases types so it stays green while `tsc` fails.

---

## OPEN ITEMS (resolved — defaults below; flag any disagreement at review)

- **OI-ASYNC — factory async (LOCKED above).** Returns `Promise<...>`; awaits `getQueryClient()` once. No sync escape-hatch in 4b (a sync "from an already-connected query client" variant — cosmjs's `create(cometClient)` precedent — is deferred as YAGNI for P0).
- **OI-SPLIT — two named factories (LOCKED above).** `createManifestClient` + `createManifestReadClient`; `ManifestClient extends ManifestReadClient, CapabilityCtx`.
- **OI-LOG — stays in 4c, NOT 4b.** 4b only PRODUCES `ctx.logger` (`opts.logger ?? noopLogger`) and changes ZERO `client.ts`/`lcd-adapter.ts` code. The 2 neutral-core `logger.warn` calls (`client.ts:404`, `lcd-adapter.ts:139`) are rewired in 4c via a NON-key `manager.setLogger(logger)` setter (a logger param on `getInstance` would fragment its refCount key `chainId:rpcUrl[:restUrl]` — FORBIDDEN). 4b must not touch `getInstance`. **Forward note for 4c:** that `setLogger` will have the same last-writer-wins blast radius as the existing config/walletProvider mutation (two ctxs sharing a key would fight over the single manager's logger sink); 4c should weigh whether the 2 internal `logger.warn` sites stay on the process-global singleton rather than routing through a shared mutable setter.
- **OI-DISPOSE — `dispose()` declared AND implemented in 4b.** The factory acquires one `getInstance` refCount (`client.ts:168`/`:216`); leaving it unbalanced leaks the shared manager. `dispose()` (idempotent, calls `chain.disconnect()` once) is declared on both interfaces and implemented now (trivial, self-contained, belongs with the factory that acquires the refCount). **Construction-failure release:** `getInstance` increments the refCount BEFORE `await chain.getQueryClient()` (which can reject, e.g. `RPC_CONNECTION_FAILED`, `client.ts:330`); a rejection there must NOT leak the acquire the caller never received a `dispose()` handle for. `buildClient` wraps everything after `getInstance` in `try/catch` and calls `chain.disconnect()` once on failure before re-throwing (NOT a bare `finally` — `dispose()` owns the success-path release). **Cross-ctx hazard (doc-only):** `getInstance` mutates the shared instance (`instance.walletProvider = …`, `client.ts:182-203`), so constructing a read client (with the wallet stub) against a config KEY a full client already holds would clobber its wallet/signing client. The common case is safe (read clients typically omit `rpcUrl` → a different key); the `buildClient` JSDoc notes it. The bound ACTION method bodies + `executeTx` + `subscribeLeaseStatus` + per-signer mutex remain 4d.
- **OI-BETA — `skuSpecs`/`events` are `@beta` placeholders.** `skuSpecs?: unknown` (§5.5, not a real core type yet) and `events?: EventTransport` (the forward-declared §5.9 stub) are accepted but NOT threaded in 4b. `logLevel?: LogLevel` is accepted and stored conceptually but the SDK level-gate itself is a later phase (4b just carries it; do NOT build the gate here).
- **OI-MEMBERS — interfaces declare ctx-extension + `dispose()` ONLY.** The bound read/tx action method SIGNATURES are NOT declared in 4b (they depend on the spine fns ctx-ified in 4c). Declaring them now would front-run 4c. 4b's interfaces = `extends` + `dispose(): void`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/ctx.ts` (create) | `CapabilityCtx` (6 readonly fields) + `QueryCtx = Omit<…,'signer'>` + the `@beta` `EventTransport` stub. Type-only imports (browser-safe). |
| `packages/core/src/client-factory.ts` (create) | `ManifestReadClient`/`ManifestClient` interface decls; `createManifestClient`/`createManifestReadClient` async factories + `buildClient` + `queryOnlyWalletStub`. NO guarded-fetch/undici/node:* imports. |
| `packages/core/src/ctx.test-d.ts` (create) | Type-level: `QueryCtx` lacks `signer`; `CapabilityCtx` has all 6; `ManifestClient` assignable to `ManifestReadClient` + `CapabilityCtx`; `ManifestReadClient` NOT assignable to `ManifestClient`; factory return types. |
| `packages/core/src/client-factory.test.ts` (create) | Runtime: config validated before keying; `getInstance` called once; query-only omits signer (`'signer' in client` false) + stub rejects on signing; full mode wires `createSignerAdapter` w/ prefix; fetch/logger coalesce; `ctx.query` === awaited `getQueryClient`; `dispose()` disconnects once (idempotent); **getQueryClient rejection releases the refCount once**. |
| `packages/core/src/index.ts` (modify) | Named barrel exports for the new ctx + factory symbols. |
| `packages/core/src/client.ts` | **DO NOT MODIFY** (OI-LOG). Pinned here as the no-touch boundary. |

---

## Task 0: Confirm baseline

- [ ] From the worktree root: `npm run build` (8, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green). HEAD has the 4a commits (`f6e7021`, `554597c`) + the spec reconciliation. If red, STOP.

---

## Task 1: `CapabilityCtx` + `QueryCtx` (`core/src/ctx.ts`)

**Files:** Create `packages/core/src/ctx.ts`, `packages/core/src/ctx.test-d.ts`.

- [ ] **Step 1: Failing type-test** — `packages/core/src/ctx.test-d.ts`:

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { CapabilityCtx, EventTransport, QueryCtx } from './ctx.js';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type { Logger } from './logger.js';
import type { Signer } from './signer.js';

describe('CapabilityCtx / QueryCtx (type-level)', () => {
  it('CapabilityCtx is exactly the 6 fields with the real types', () => {
    expectTypeOf<CapabilityCtx['chain']>().toEqualTypeOf<CosmosClientManager>();
    expectTypeOf<CapabilityCtx['query']>().toEqualTypeOf<ManifestQueryClient>();
    expectTypeOf<CapabilityCtx['signer']>().toEqualTypeOf<Signer | undefined>();
    expectTypeOf<CapabilityCtx['fetch']>().toEqualTypeOf<typeof globalThis.fetch>();
    expectTypeOf<CapabilityCtx['logger']>().toEqualTypeOf<Logger>();
    expectTypeOf<CapabilityCtx['events']>().toEqualTypeOf<EventTransport | undefined>();
  });
  it('QueryCtx drops only signer; the full ctx extends the query ctx', () => {
    expectTypeOf<QueryCtx>().toHaveProperty('query');
    expectTypeOf<QueryCtx>().not.toHaveProperty('signer');
    expectTypeOf<CapabilityCtx>().toExtend<QueryCtx>(); // full ctx assignable to query ctx
  });
});
```

- [ ] **Step 2: Run → fail** (`./ctx.js` missing). `(cd packages/core && npx vitest run src/ctx.test-d.ts)`.

- [ ] **Step 3: Implement `packages/core/src/ctx.ts`:**

```ts
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type { Logger } from './logger.js';
import type { Signer } from './signer.js';

/**
 * @beta — DEFERRED (§5.9). The WS transport + `subscribeLeaseStatus`'s push path land in a later
 * phase (poll-backed in P0). Forward-declared as an opaque stub so `CapabilityCtx` compiles without
 * the transport; absent `events` ⇒ poll fallback.
 */
export interface EventTransport {
  /** @beta — intentionally-empty placeholder; the real shape is defined when the §5.9 transport lands. */
  readonly __beta?: never;
}

/**
 * @public — the capability bundle every SDK action consumes (spec §5.2). Exactly 6 fields.
 *
 * `chain` is the keyed-singleton `CosmosClientManager` (NOT a `SigningStargateClient`): the cosmjs
 * drop-down is the async `chain.getSigningClient()`, and `chain.getQueryClient()` is the async/lazy
 * query accessor. `query` holds the concrete `ManifestQueryClient` the factory awaited ONCE at
 * construction (so raw-typed reads `ctx.query.<module>.<service>(...)` need no per-read await). In
 * REST mode a read over an LCD-unsupported module (`cosmos.orm`, `liftedinit.manifest`) throws
 * `UNSUPPORTED_QUERY` synchronously (the lcd-adapter proxy). `signer` (§5.3) is present in full mode
 * only. `fetch` is injected (guarded-undici at the node edge, providerFetch in browser; the factory
 * defaults it to `globalThis.fetch`). `logger` defaults to the frozen `noopLogger` (silent).
 */
export interface CapabilityCtx {
  readonly chain: CosmosClientManager;
  readonly query: ManifestQueryClient;
  readonly signer?: Signer;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: Logger;
  readonly events?: EventTransport;
}

/** @public — query-only capability subset; only `signer` drops (spec §5.2). */
export type QueryCtx = Omit<CapabilityCtx, 'signer'>;
```

- [ ] **Step 4: Run → pass.** `(cd packages/core && npx vitest run src/ctx.test-d.ts && npm run lint)` green.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/ctx.ts packages/core/src/ctx.test-d.ts
git add packages/core/src/ctx.ts packages/core/src/ctx.test-d.ts
git commit -m "feat(core): add CapabilityCtx + QueryCtx capability types (ENG-309)"
```

---

## Task 2: `ManifestClient`/`ManifestReadClient` interface declarations (`core/src/client-factory.ts`)

**Files:** Create `packages/core/src/client-factory.ts` (interfaces only this task). Extend `packages/core/src/ctx.test-d.ts`.

- [ ] **Step 1: Failing type-test** — append to `packages/core/src/ctx.test-d.ts`:

```ts
import type { ManifestClient, ManifestReadClient } from './client-factory.js';
// (Signer is already imported at the top of this file from Task 1.)

describe('ManifestClient / ManifestReadClient (type-level)', () => {
  it('ManifestReadClient extends QueryCtx — no signer, plus a dispose()', () => {
    expectTypeOf<ManifestReadClient>().toExtend<QueryCtx>();
    expectTypeOf<ManifestReadClient>().not.toHaveProperty('signer');
    expectTypeOf<ManifestReadClient['dispose']>().toEqualTypeOf<() => void>();
  });
  it('ManifestClient is a strict superset (extends read + ctx) with a REQUIRED signer', () => {
    expectTypeOf<ManifestClient>().toExtend<ManifestReadClient>();
    expectTypeOf<ManifestClient>().toExtend<CapabilityCtx>();
    expectTypeOf<ManifestClient['signer']>().toEqualTypeOf<Signer>(); // required — NOT Signer | undefined
  });
  it('a read client is NOT a full client (the read-vs-full guarantee holds because signer is required on the full client)', () => {
    expectTypeOf<ManifestReadClient>().not.toExtend<ManifestClient>();
  });
});
```

- [ ] **Step 2: Run → fail** (`./client-factory.js` missing). `(cd packages/core && npx vitest run src/ctx.test-d.ts)`.

- [ ] **Step 3: Implement `packages/core/src/client-factory.ts` (interfaces only — bodies/factory are Tasks 3-4):**

```ts
import type { CapabilityCtx, QueryCtx } from './ctx.js';
import type { Signer } from './signer.js';

/**
 * @public — query-only bound client. EXTENDS `QueryCtx`, so NO `signer`/tx/subscribe at the TYPE level
 * (the viem Public Client invariant; cosmjs `StargateClient`). The bound READ action methods are added
 * in Plan 4c/4d; 4b declares only the ctx extension + lifecycle. `client.query`/`client.chain` are honest
 * Telescope/cosmjs drop-downs.
 */
export interface ManifestReadClient extends QueryCtx {
  /**
   * Release this client's share of the underlying keyed `CosmosClientManager` (balances the single
   * `getInstance` refCount the factory acquired). Idempotent. Implemented in 4b; the manager tears the
   * shared clients down only once the last holder disposes.
   */
  dispose(): void;
}

/**
 * @public — full bound client. Strict SUPERSET of `ManifestReadClient` (mirrors cosmjs
 * `SigningStargateClient extends StargateClient`) AND a `CapabilityCtx`, so a full client is usable
 * anywhere a read client OR a ctx is expected. The bound TX/provider action methods + `executeTx` +
 * `subscribeLeaseStatus` + the per-signer broadcast mutex are added in Plan 4d.
 */
export interface ManifestClient extends ManifestReadClient, CapabilityCtx {
  /**
   * Full clients ALWAYS carry a signer (`createManifestClient` requires a `walletProvider`) — NARROWED
   * from `CapabilityCtx`'s optional `signer?` to REQUIRED. This is what makes a `ManifestReadClient`
   * NOT assignable to a `ManifestClient` at the type level (the read-vs-full guarantee; mirrors viem's
   * required write surface). `CapabilityCtx.signer` itself stays optional — the spine fns take a ctx and
   * narrow via `requireAuthSigner`.
   */
  readonly signer: Signer;
}
```

- [ ] **Step 4: Run → pass.** `(cd packages/core && npx vitest run src/ctx.test-d.ts && npm run lint)` green.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/client-factory.ts packages/core/src/ctx.test-d.ts
git add packages/core/src/client-factory.ts packages/core/src/ctx.test-d.ts
git commit -m "feat(core): declare ManifestClient/ManifestReadClient bound-client interfaces (ENG-309)"
```

---

## Task 3: The two async factory signatures + opts types (`client-factory.ts`)

**Files:** Modify `packages/core/src/client-factory.ts` (add opts types + factory declarations, no body yet → stub that throws). Extend `packages/core/src/ctx.test-d.ts`.

- [ ] **Step 1: Failing type-test** — append to `packages/core/src/ctx.test-d.ts`:

```ts
import {
  createManifestClient,
  createManifestReadClient,
  type FullClientOptions,
  type ReadClientOptions,
} from './client-factory.js';
import type { WalletProvider } from './types.js';

describe('createManifestClient / createManifestReadClient (type-level)', () => {
  it('both factories are async and resolve to the precise client type', () => {
    expectTypeOf(createManifestClient).returns.resolves.toEqualTypeOf<ManifestClient>();
    expectTypeOf(createManifestReadClient).returns.resolves.toEqualTypeOf<ManifestReadClient>();
  });
  it('full opts REQUIRE a walletProvider; read opts carry none', () => {
    expectTypeOf<FullClientOptions['walletProvider']>().toEqualTypeOf<WalletProvider>();
    expectTypeOf<ReadClientOptions>().not.toHaveProperty('walletProvider');
  });
});
```

- [ ] **Step 2: Run → fail** (factories/opts types missing). `(cd packages/core && npx vitest run src/ctx.test-d.ts)`.

- [ ] **Step 3: Add to `packages/core/src/client-factory.ts`** (above the interfaces is fine; Biome orders). Add the imports + opts types + factory signatures with a temporary throwing body:

```ts
import type { Logger, LogLevel } from './logger.js';
import type { ManifestMCPConfig, WalletProvider } from './types.js';
import type { EventTransport } from './ctx.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/** Shared factory inputs. `skuSpecs`/`events`/`logLevel` are accepted but NOT threaded in 4b (see plan OI-BETA). */
interface BaseClientOptions {
  config: ManifestMCPConfig;
  /** Injected at the edge (node: guarded-undici; browser: providerFetch). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-instance logging sink; defaults to the silent `noopLogger`. */
  logger?: Logger;
  /** @beta — carried for the later SDK-side level gate; the gate is NOT built in 4b. */
  logLevel?: LogLevel;
  /** @beta — §5.5 placeholder; not a real core type yet, not threaded in 4b. */
  skuSpecs?: unknown;
  /** @beta — §5.9 forward-declared transport stub; not threaded in 4b. */
  events?: EventTransport;
}

/** @public — inputs to {@link createManifestClient} (full/signing). A `walletProvider` is REQUIRED. */
export interface FullClientOptions extends BaseClientOptions {
  walletProvider: WalletProvider;
}

/** @public — inputs to {@link createManifestReadClient} (query-only). No `walletProvider`. */
export type ReadClientOptions = BaseClientOptions;

/**
 * @public — construct a FULL (signing) Manifest client. ASYNC: awaits the underlying query client once
 * so `client.query` is concrete (the Cosmos await-once-then-read idiom). Throws `INVALID_CONFIG` on bad
 * config or a wallet lacking `signArbitrary` (the latter at first auth use).
 */
export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // Body lands in Task 4. Temporary throw keeps the signature honest under tsc.
  void opts;
  throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'not implemented');
}

/**
 * @public — construct a QUERY-ONLY Manifest client (no signer/tx/subscribe at the type level). ASYNC.
 */
export async function createManifestReadClient(
  opts: ReadClientOptions,
): Promise<ManifestReadClient> {
  void opts;
  throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'not implemented');
}
```

- [ ] **Step 4: Run → pass** (type-tests compile; the throwing bodies satisfy the return types). `(cd packages/core && npx vitest run src/ctx.test-d.ts && npm run lint)` green.

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/client-factory.ts packages/core/src/ctx.test-d.ts
git add packages/core/src/client-factory.ts packages/core/src/ctx.test-d.ts
git commit -m "feat(core): add createManifestClient/createManifestReadClient async factory signatures (ENG-309)"
```

---

## Task 4: Complete factory body + runtime tests (`client-factory.ts`)

**Files:** Modify `packages/core/src/client-factory.ts` (replace the throwing stubs with the full body). Create `packages/core/src/client-factory.test.ts`.

> **Single red→green** — write the full runtime suite, then the COMPLETE `buildClient` body in one pass. No intermediate WIP commit with failing tests. (Task 3 left the two factories throwing `'not implemented'`; their type-tests passed because no runtime test ran them. This task adds the runtime suite + the real body together.)

- [ ] **Step 1: Failing tests** — `packages/core/src/client-factory.test.ts`:

```ts
import { toBech32 } from '@cosmjs/encoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CosmosClientManager, type ManifestQueryClient } from './client.js';
import {
  createManifestClient,
  createManifestReadClient,
} from './client-factory.js';
import { noopLogger } from './logger.js';
import { ManifestMCPErrorCode, type ManifestMCPConfig } from './types.js';

// REST-mode config; getInstance is mocked so no real client/network is built.
const READ_CONFIG: ManifestMCPConfig = {
  chainId: 'test-1',
  restUrl: 'http://localhost:1317',
};
const FULL_CONFIG: ManifestMCPConfig = {
  chainId: 'test-1',
  rpcUrl: 'http://localhost:26657',
  gasPrice: '0.025umfx',
  restUrl: 'http://localhost:1317',
};
const ADDR = toBech32('manifest', new Uint8Array(20)); // checksum-valid (mirrors signer.test.ts)
const SENTINEL_QUERY = { __sentinel: 'query' } as unknown as ManifestQueryClient;

function fakeManager(over: Partial<CosmosClientManager> = {}): CosmosClientManager {
  return {
    getQueryClient: vi.fn(async () => SENTINEL_QUERY),
    getSigningClient: vi.fn(),
    disconnect: vi.fn(),
    ...over,
  } as unknown as CosmosClientManager;
}
function fakeWallet() {
  return {
    getAddress: async () => ADDR,
    getSigner: async () => ({}) as never,
    signArbitrary: async () => ({ pub_key: { type: 't', value: 'v' }, signature: 's' }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('createManifestReadClient / createManifestClient', () => {
  it('validates config BEFORE keying an instance (invalid → INVALID_CONFIG, getInstance not called)', async () => {
    const spy = vi.spyOn(CosmosClientManager, 'getInstance');
    await expect(
      createManifestReadClient({ config: { chainId: 'test-1' } as ManifestMCPConfig }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls getInstance exactly once and feeds ctx.query from the awaited getQueryClient', async () => {
    const mgr = fakeManager();
    const spy = vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const client = await createManifestReadClient({ config: READ_CONFIG });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mgr.getQueryClient).toHaveBeenCalledTimes(1);
    expect(client.query).toBe(SENTINEL_QUERY);
  });

  it('full mode passes the REAL walletProvider to getInstance and wires a prefix-pinned signer', async () => {
    const wallet = fakeWallet();
    const spy = vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const full = await createManifestClient({ config: FULL_CONFIG, walletProvider: wallet });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(wallet);
    expect(full.signer).toBeDefined();
    await expect(full.signer.getAddress()).resolves.toBe(ADDR); // signer REQUIRED on ManifestClient; adapter parses+brands
  });

  it('query-only mode passes a stub that REJECTS INVALID_CONFIG on signing access, and omits signer at runtime', async () => {
    let captured: { getSigner: () => Promise<unknown> } | undefined;
    vi.spyOn(CosmosClientManager, 'getInstance').mockImplementation((_cfg, wallet) => {
      captured = wallet as never;
      return fakeManager();
    });
    const read = await createManifestReadClient({ config: READ_CONFIG });
    expect('signer' in read).toBe(false); // truly omitted, not present-as-undefined
    expect(captured).toBeDefined();
    await expect(captured!.getSigner()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });

  it('coalesces fetch and logger to defaults, and uses injected ones when provided', async () => {
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const dflt = await createManifestReadClient({ config: READ_CONFIG });
    expect(dflt.fetch).toBe(globalThis.fetch);
    expect(dflt.logger).toBe(noopLogger);

    const myFetch = (async () => new Response()) as typeof globalThis.fetch;
    const myLogger = { debug() {}, info() {}, warn() {}, error() {} };
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const injected = await createManifestReadClient({
      config: READ_CONFIG,
      fetch: myFetch,
      logger: myLogger,
    });
    expect(injected.fetch).toBe(myFetch);
    expect(injected.logger).toBe(myLogger);
  });

  it('dispose() calls chain.disconnect() exactly once (idempotent)', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const client = await createManifestReadClient({ config: READ_CONFIG });
    client.dispose();
    client.dispose();
    expect(mgr.disconnect).toHaveBeenCalledTimes(1);
  });

  it('releases the refCount once if getQueryClient REJECTS during construction (no phantom holder)', async () => {
    const mgr = fakeManager({
      getQueryClient: vi.fn(async () => {
        throw new Error('RPC_CONNECTION_FAILED');
      }),
    });
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    await expect(
      createManifestReadClient({ config: READ_CONFIG }),
    ).rejects.toThrow('RPC_CONNECTION_FAILED');
    expect(mgr.disconnect).toHaveBeenCalledTimes(1); // construction-failure release balances the acquire
  });
});
```

- [ ] **Step 2: Run → fail** (factories still throw `'not implemented'` from Task 3). `npx vitest run packages/core/src/client-factory.test.ts`.

- [ ] **Step 3: Replace the two throwing bodies** in `client-factory.ts` with the query-only stub + the shared `buildClient` + the rewired factories. Add the runtime imports (these are VALUE imports; `CapabilityCtx` is already imported from Task 2 and is not needed here):

```ts
import { CosmosClientManager } from './client.js';
import { createValidatedConfig } from './config.js';
import { noopLogger } from './logger.js';
import { createSignerAdapter } from './signer.js';
```

```ts
/**
 * A `WalletProvider` for query-only clients. `getInstance` requires a wallet even in query-only mode, but
 * queries never sign — so this stub is stored and never invoked. Every signing accessor REJECTS with
 * `INVALID_CONFIG` (a rejected promise, NOT a sync throw — the methods are `Promise`-returning, so a
 * consumer's `await wallet.getSigner()` must see a rejection) as a hard backstop. `signArbitrary` is
 * included (optional on `WalletProvider`) so the stub fails closed there too.
 */
function queryOnlyWalletStub(): WalletProvider {
  const fail = (): Promise<never> =>
    Promise.reject(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'This client was created in query-only mode (createManifestReadClient) and cannot sign or broadcast. Use createManifestClient with a walletProvider for transactions.',
      ),
    );
  return { getAddress: fail, getSigner: fail, signArbitrary: fail };
}

/**
 * Shared ctx builder. Returns the base `ManifestReadClient` (ctx fields + `dispose`); the full factory
 * up-casts to `ManifestClient` (sound — `withSigner=true` ⇒ a defined signer). NOTE (cross-ctx hazard,
 * OI-DISPOSE): `getInstance` mutates the shared instance for a given config key, so do not construct a
 * read client (wallet stub) against a key a full client already holds — the common case is safe because
 * read configs omit `rpcUrl` → a different key.
 */
async function buildClient(
  opts: BaseClientOptions,
  walletProvider: WalletProvider,
  withSigner: boolean,
): Promise<ManifestReadClient> {
  const config = createValidatedConfig(opts.config); // throws INVALID_CONFIG before any instance is keyed
  const chain = CosmosClientManager.getInstance(config, walletProvider); // ONCE; acquires one refCount
  try {
    const signer = withSigner
      ? createSignerAdapter(walletProvider, config.addressPrefix) // config.addressPrefix defaulted in createConfig
      : undefined;
    // NEUTRAL fetch resolution — never import the node-only guarded fetch (ENG-281 browser-bundle hazard).
    // The node/fred edge injects the guarded fetch via opts.fetch; default to the platform global.
    const fetch = opts.fetch ?? globalThis.fetch;
    const logger = opts.logger ?? noopLogger;
    // Await the query client ONCE so ctx.query is concrete (the await-once-then-read Cosmos idiom).
    const query = await chain.getQueryClient();

    // dispose: balance the single getInstance refCount; idempotent so a double-dispose is safe.
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      chain.disconnect();
    };

    // In query-only mode OMIT the signer key entirely (so `'signer' in client` is false — the runtime
    // matches the read type) rather than carrying `signer: undefined`. 4d binds the read/tx action
    // methods over this ctx; 4b returns the ctx + dispose shell. Structurally a ManifestReadClient; the
    // full factory up-casts to ManifestClient.
    const base = { chain, query, fetch, logger, dispose };
    const client = signer ? { ...base, signer } : base;
    return client as ManifestReadClient;
  } catch (err) {
    // getQueryClient (or signer construction) failed AFTER getInstance acquired the refCount, and the
    // caller never received a `dispose()` handle. Release the acquire once so a construction failure does
    // not leak a phantom holder (OI-DISPOSE failure path), then re-throw.
    chain.disconnect();
    throw err;
  }
}

export async function createManifestClient(
  opts: FullClientOptions,
): Promise<ManifestClient> {
  // withSigner=true → the returned client always has a defined signer, so the up-cast to the
  // required-signer ManifestClient is sound (mirrors SigningStargateClient.connectWithSigner's subtype).
  return (await buildClient(opts, opts.walletProvider, true)) as ManifestClient;
}

export async function createManifestReadClient(
  opts: ReadClientOptions,
): Promise<ManifestReadClient> {
  return buildClient(opts, queryOnlyWalletStub(), false);
}
```

Delete the two temporary `void opts; throw … 'not implemented'` bodies from Task 3 — they are replaced by the `createManifestClient`/`createManifestReadClient` above.

- [ ] **Step 4: Run → pass.** `npx vitest run packages/core/src/client-factory.test.ts` (all 7 green). `(cd packages/core && npm run lint)` exit 0 (note: `noUnusedLocals` is on — confirm no stray unused import lingers from the deleted throwing bodies; `ManifestMCPError`/`ManifestMCPErrorCode` are still used by the stub).

- [ ] **Step 5: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/client-factory.ts packages/core/src/client-factory.test.ts
git add packages/core/src/client-factory.ts packages/core/src/client-factory.test.ts
git commit -m "feat(core): implement createManifestClient/createManifestReadClient factory body + tests (ENG-309)"
```

---

## Task 5: Barrel exports + browser-safety verification + full gate

**Files:** Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Add named barrel exports** to `packages/core/src/index.ts` (a bare `export * from './types.js'` will NOT surface the new modules; add explicit blocks — Biome sorts):

```ts
export {
  type CapabilityCtx,
  type EventTransport,
  type QueryCtx,
} from './ctx.js';
export {
  createManifestClient,
  createManifestReadClient,
  type FullClientOptions,
  type ManifestClient,
  type ManifestReadClient,
  type ReadClientOptions,
} from './client-factory.js';
```

- [ ] **Step 2: Biome.** `npx @biomejs/biome check --write packages/core/src/index.ts` (sorts the export blocks).

- [ ] **Step 3: Build core + verify browser-safety (ENG-281/287).** Under tsdown `unbundle: true`, each source file emits its OWN dist file and `dist/index.js` holds only re-export EDGES — so a node-only leak in the new code would land in `dist/ctx.js` / `dist/client-factory.js`, NOT in `dist/index.js`. Grep the actual EMITTED files for a STATIC node-only import (the `from "…"` form excludes the legitimate dynamic `import("undici")` inside `guarded-fetch.js`):

```bash
(cd packages/core && npm run build)
grep -rnE 'from "(undici|node:[^"]+)"' packages/core/dist/ctx.js packages/core/dist/client-factory.js
```

Expected: **no matches** (exit 1). If anything matches, a static import leaked a node-only dep — STOP and fix (use type-only imports; resolve fetch via `globalThis.fetch`). The DURABLE guard is `packages/core/src/index.test.ts`'s existing ENG-281 bundle assertion — optionally extend it to cover the new `ctx.ts`/`client-factory.ts` surface.

- [ ] **Step 4: Full gate.** From the worktree root:
  - `npm run build` (8 packages, exit 0)
  - **`npm run lint` (ALL packages, exit 0)** — the real type gate (the new types ripple to consumer tsc)
  - `npx vitest run packages/` (all pass — incl. `ctx.test-d.ts` typecheck + the 7 `client-factory.test.ts` cases)
  - `npm run check` (biome, exit 0)

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): barrel-export CapabilityCtx + createManifestClient surface; verify browser-safety (ENG-309)"
```

---

## Self-Review (completed)

- **Spec coverage (§5.2, updated 2026-06-15):** `CapabilityCtx`/`QueryCtx` ✓ (Task 1); `ManifestReadClient`/`ManifestClient` superset interfaces ✓ (Task 2); the two named async factories `createManifestClient`/`createManifestReadClient` ✓ (Tasks 3-4); barrel ✓ (Task 5). **Deferred:** bound action method bodies + `executeTx` + `subscribeLeaseStatus` + per-signer mutex (4d); CallOptions-threading into the spine fns + the OI-LOG `setLogger` rewire (4c).
- **Decisions honored:** ASYNC factory (awaits `getQueryClient` once); TWO NAMED factories (`ManifestClient extends ManifestReadClient, CapabilityCtx`, signer narrowed to required). Both locked by the `idiom-research-4b-factory` study; spec reconciled.
- **OI-LOG:** ZERO `client.ts`/`lcd-adapter.ts` edits (Task 5 pins the no-touch boundary). 4b only produces `ctx.logger`.
- **Browser isomorphism (ENG-281):** no `guarded-fetch`/`undici`/`node:*` import; `ctx.fetch = opts.fetch ?? globalThis.fetch`; Task 5 greps the EMITTED `dist/ctx.js`/`dist/client-factory.js` (NOT `dist/index.js`, which under tsdown `unbundle` holds only re-export edges and would falsely pass).
- **Additive / refCount-safe:** new files + barrel; the factory's single `getInstance` acquire is balanced by `dispose()` (idempotent) on the success path AND by a `try/catch` `chain.disconnect()` on a construction failure (`getQueryClient` rejection), so no path leaks the refCount.
- **`as*`/`parse*`:** the factory uses the 4a `createSignerAdapter` (which `parseAddress`-es the wallet addr); no `as Brand` outside brands.ts (the `as ManifestReadClient` shell cast in `buildClient` + the `as ManifestClient` up-cast in the full factory are interface shell/subtype casts for the 4d method fill-in — the up-cast is sound because `withSigner=true` ⇒ signer defined — not brand casts).

## Next plan

→ **Plan 4c:** ctx-ify the ~12 P0a-spine building-block fns (positional → `(ctx, input, opts?)`) + thread `CallOptions`/`TxCallOptions`; add the `CosmosClientManager.setLogger(logger)` non-key setter and rewire the 2 neutral-core `logger.warn` sites onto it (OI-LOG). Then 4d (bind the `ManifestClient`/`ManifestReadClient` action methods over the free fns + `executeTx` + `subscribeLeaseStatus` (poll-backed) + per-signer mutex).
