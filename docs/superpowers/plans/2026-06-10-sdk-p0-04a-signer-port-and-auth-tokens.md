# SDK P0 — Plan 4a: Signer port + createAuthTokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Add the **`Signer` port** (`TxSigner`/`AuthSigner`/`Signer` + the `WalletProvider`→`Signer` `parseAddress`-once adapter + `requireAuthSigner`) to `core`, and the signer-bound **`createAuthTokens`** factory to `fred`. **Purely additive** — new types + small helpers, zero behavior change to existing flows. This is the first of the **CapabilityCtx keystone's 4 sub-plans (4a→4b→4c→4d)**; it establishes the ports that the `createManifestClient` factory (4b) and the ctx-ified building blocks (4c) depend on.

**Decomposition context (from the ctx-keystone surface map):** the keystone splits into **4a** (this — ports), **4b** (`CapabilityCtx`/`QueryCtx` + overloaded `createManifestClient` + the `ManifestClient`/`ManifestReadClient` interface declarations), **4c** (ctx-ify the ~12 P0a-spine building-block fns + thread `CallOptions`/`TxCallOptions`), **4d** (bind the `ManifestClient` methods + `executeTx` + `subscribeLeaseStatus` + the per-signer mutex). The split is forced by the crux: the typed building-block fns are **positional today** (`getBalance(queryClient, address)`, `fundCredits(clientManager, amount, overrides?, tenant?)`), so the bound-method client + `CallOptions`-threading must wait until the fns are ctx-ified (4c). 4a is additive and breaks nothing.

**Architecture:** spec §5.3. The `Signer` is an SDK-surface adapter over the concrete `WalletProvider` (whose `getAddress(): string`): the adapter `parseAddress`-es the address once (memoized) so the port exposes a branded `Address` while the edge impl stays `string`. `OfflineSigner` is **`@cosmjs/proto-signing`'s** (the `@manifest-network/stargate` fork overrides `@cosmjs/stargate`, NOT proto-signing). `signArbitrary` is **optional** on `WalletProvider`; the adapter narrows it and throws `INVALID_CONFIG` when absent (mirrors the existing `AuthTokenService.requireSignArbitrary` at `auth-token-service.ts:68-76`). `createAuthTokens` binds the address once and mints a **fresh** token per call via the existing `AuthTimestampTracker` — it reuses the same stateless ADR-036 builders `AuthTokenService` uses (`auth.ts`), so behavior matches the proven server path.

**Tech Stack:** TypeScript ESM (`.js` imports), vitest 4, tsdown, `tsc --noEmit` lint, Biome. Spec: §5.2/§5.3. Issue: ENG-309. Builds on Plans 1/2/3a/3b-1/3b-2.

**⚠️ FULL-LINT LESSON (bit 4×):** run the **full-repo `npm run lint`** at the gate, not just the touched package — a type change ripples to consumer tests, and vitest doesn't type-check.

---

## OPEN ITEMS (resolve at review; the plan picks a default)

- **OI-A1 — `getAuthToken` signature:** spec §5.3 says `getAuthToken(leaseUuid)` with the address bound from the signer (vs the current `AuthTokenService.providerToken(address, leaseUuid)` which takes address explicitly). **DEFAULT: `getAuthToken(leaseUuid: LeaseUuid)`** — bind address from `signer.getAddress()` once (that's the whole point of the Signer port: parse-once). This improves on Barney's `getProviderAuthToken(address, leaseUuid, signArbitrary)`.
  - **4c-integration note (write this down so the 4c author expects it):** the existing deploy path types its callbacks `(address, leaseUuid) => Promise<string>` and invokes them as `getAuthToken(address, leaseUuid)` (`deployManifest.ts:302/359`) + `getLeaseDataAuthToken(address, leaseUuid, metaHash)` (`:283`). Since `createAuthTokens` binds the address, **4c adapts via an address-closing thunk** — `() => tokens.getAuthToken(uuid)` / `() => tokens.getLeaseDataAuthToken(uuid, metaHash)` — which is **exactly the idiom the real consumer already uses** (Barney's `compositeTransactions.ts:1187/1760/2222`: `() => getProviderAuthToken(address, leaseUuid, signArbitrary)`). So this is the right SDK shape, not a mismatch — but 4c expects the wrapper, not a signature match. (No 4a code change; 4a is additive and the deploy path is untouched until 4c.)
- **OI-CHAIN — `createAuthTokens`'s `{ chainId }` param is currently UNUSED.** The ADR-036 sign message (`createSignMessage` = `\`${tenant}:${leaseUuid}:${timestamp}\``, `auth.ts:47-53`) does not embed chainId, and `createAuthToken`'s payload doesn't either. The spec §5.3 signature is `createAuthTokens(signer, { chainId })`. **RESOLVED (review): KEEP `{ chainId }` in the signature** (spec-aligned + forward-compat: a future multi-chain token scope would need it), document it as reserved/not-yet-embedded, and silence `noUnusedParameters` with `void opts.chainId` (already in Task 2 Step 3). The factory docstring carries the "reserved" note. **Bundle the spec reconciliation with OI-CACHE below** (same spec line 168, same guards pass) — see there.
- **OI-CACHE — the spec says `createAuthTokens` is "lazily cached, re-signed on expiry"; this is UNSAFE and 4a does NOT cache tokens.** `AuthTimestampTracker`'s own doc (`auth.ts:3-12`) states ADR-036 signing is deterministic and **the provider's replay tracker rejects duplicate signatures on protected endpoints** — so a cached/reused token would be replay-rejected on a mutating call. The existing `AuthTokenService` mints a **fresh** token per call (serialized by the timestamp tracker) and does NOT cache. **DEFAULT: mint fresh per call (no token caching), matching `AuthTokenService`.** The plan reconciles the spec's "lazily cached" wording → "lazily binds the address once; mints a fresh token per call (caching a token is unsafe vs the replay tracker)." **Spec edit (guards pass): §5.3 line 168** — rewrite the parenthetical to "(binds the address once; mints a **fresh** token per call — caching is unsafe vs the provider replay tracker; wraps `fred`'s `AuthTokenService`)" **AND fold in the OI-CHAIN note** ("`chainId` reserved for a future chain-scoped token format, not yet embedded in the ADR-036 message") in the same edit. Both spec touch-ups land together at line 168.
- **OI-S1 — `requireAuthSigner(ctx)` arg type:** `CapabilityCtx` doesn't exist until 4b. **DEFAULT: type the arg structurally as `{ readonly signer?: Signer }`** so the auth flow is testable in 4a; 4b's `CapabilityCtx` satisfies it structurally.
- **OI-LOG — the logger→`ctx.logger` refactor is DEFERRED out of 4a (as honest tech debt, NOT a spec exemption).** The only 2 global-singleton uses in neutral core (`client.ts:404` + `lcd-adapter.ts:139`) are init-time diagnostics inside `CosmosClientManager`/the lcd-adapter, created by the refCount-keyed `getInstance` — there is **no DI seam to inject `ctx.logger` until `CapabilityCtx` exists (4b)**, and adding a logger param to `getInstance` would break its refCount keying. **DEFAULT: leave both warns for now and resolve them when ctx threading lands in 4b/4c.** ⚠️ Be precise about the spec: §5.3 does NOT sanction this — line 172 says the singleton stays "an internal detail of the MCP servers/CLI **only**" (i.e. *not* in neutral core), and line 179 says "the neutral core must never reference `console`/… — only `ctx.logger`." So these 2 `core` `logger.warn` calls **violate §5.3:179** and are **deferred technical debt** (blocked on the 4b ctx seam), not an exemption. (This also corrects the cumulative-review fold-forward #1's "refactor onto ctx.logger" — the refactor is right but can't land until 4b.)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/signer.ts` (create) | `TxSigner`/`AuthSigner`/`Signer` + `createSignerAdapter(wallet, expectedPrefix?)` + `requireAuthSigner(ctx)`. |
| `packages/core/src/signer.test.ts` (create) | Adapter parse-once + missing-`signArbitrary` throws; `requireAuthSigner` narrow/throw. |
| `packages/core/src/index.ts` (modify) | Re-export the signer surface. |
| `packages/fred/src/http/auth-tokens-factory.ts` (create) | `createAuthTokens(signer, { chainId })` over the stateless `auth.ts` builders. |
| `packages/fred/src/http/auth-tokens-factory.test.ts` (create) | Fresh-token-per-call, timestamp serialization, address-bound-once, missing-signArbitrary throws. |
| `packages/fred/src/index.ts` (modify) | Re-export `createAuthTokens`. |

---

## Task 0: Confirm baseline

- [ ] From the worktree root: `npm run build` (8, exit 0), `npm run lint` (exit 0), `npx vitest run packages/` (green, ~2023). Plans 1–3b-2 merged. If red, STOP.

---

## Task 1: The `Signer` port + adapter (`core/src/signer.ts`)

**Files:** Create `packages/core/src/signer.ts`, `packages/core/src/signer.test.ts`. Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Failing tests** — `packages/core/src/signer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toBech32 } from '@cosmjs/encoding';
import { createSignerAdapter, requireAuthSigner } from './signer.js';
import { ManifestMCPError, ManifestMCPErrorCode, type WalletProvider } from './types.js';

const ADDR = toBech32('manifest', new Uint8Array(20));
function fakeWallet(over: Partial<WalletProvider> = {}): WalletProvider {
  return {
    getAddress: async () => ADDR,
    getSigner: async () => ({}) as never,
    signArbitrary: async () => ({ pub_key: { type: 't', value: 'v' }, signature: 's' }),
    ...over,
  };
}

describe('createSignerAdapter', () => {
  it('parses the address once and returns the branded Address', async () => {
    let calls = 0;
    const signer = createSignerAdapter(fakeWallet({ getAddress: async () => { calls++; return ADDR; } }));
    const a1 = await signer.getAddress();
    const a2 = await signer.getAddress();
    expect(a1).toBe(ADDR);
    expect(a2).toBe(a1);
    expect(calls).toBe(1); // memoized — getAddress + parseAddress run once
  });
  it('enforces the prefix when given (throws INVALID_ADDRESS)', async () => {
    const signer = createSignerAdapter(fakeWallet(), 'cosmos');
    // parseAddress → validateAddress throws INVALID_ADDRESS on a prefix mismatch (validation.ts:115-119)
    await expect(signer.getAddress()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_ADDRESS,
    });
  });
  it('throws INVALID_CONFIG when the wallet lacks signArbitrary (ADR-036)', async () => {
    const signer = createSignerAdapter(fakeWallet({ signArbitrary: undefined }));
    const addr = await signer.getAddress();
    await expect(signer.signArbitrary(addr, 'msg')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });
});

describe('requireAuthSigner', () => {
  it('returns the signer when present', () => {
    const signer = createSignerAdapter(fakeWallet());
    expect(requireAuthSigner({ signer })).toBe(signer);
  });
  it('throws INVALID_CONFIG when absent (query-only ctx)', () => {
    expect(() => requireAuthSigner({})).toThrow(ManifestMCPError);
  });
});
```

- [ ] **Step 2: Run → fail** (`./signer.js` missing). `(cd packages/core && npx vitest run src/signer.test.ts)`.

- [ ] **Step 3: Implement `packages/core/src/signer.ts`:**

```ts
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { type Address, parseAddress } from './brands.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SignArbitraryResult,
  type WalletProvider,
} from './types.js';

/**
 * SDK Signer port (interface-segregated). `OfflineSigner` is `@cosmjs/proto-signing`'s
 * (the `@manifest-network/stargate` fork overrides `@cosmjs/stargate`, not proto-signing).
 * `TxSigner` covers tx broadcasting; `AuthSigner` adds ADR-036 `signArbitrary` for off-chain auth.
 */
export interface TxSigner {
  getAddress(): Promise<Address>;
  getSigner(): Promise<OfflineSigner>;
}
export interface AuthSigner extends TxSigner {
  signArbitrary(address: Address, data: string): Promise<SignArbitraryResult>;
}
export type Signer = AuthSigner;

/**
 * Adapt a concrete `WalletProvider` (whose `getAddress(): string`) to the `Signer` port.
 * `parseAddress`-once: the branded `Address` is memoized so the bech32 validation runs a single
 * time (parse-once; ENG-258). `signArbitrary` is OPTIONAL on `WalletProvider` — the adapter throws
 * `INVALID_CONFIG` when absent (mirrors `fred`'s `AuthTokenService.requireSignArbitrary`).
 */
export function createSignerAdapter(
  wallet: WalletProvider,
  expectedPrefix?: string,
): Signer {
  let addressPromise: Promise<Address> | undefined;
  const getAddress = (): Promise<Address> => {
    addressPromise ??= wallet
      .getAddress()
      .then((a) => parseAddress(a, expectedPrefix));
    return addressPromise;
  };
  return {
    getAddress,
    getSigner: () => wallet.getSigner(),
    async signArbitrary(address, data) {
      if (!wallet.signArbitrary) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Wallet does not support signArbitrary (ADR-036). Required for provider/auth-token operations; use a wallet that implements signArbitrary.',
        );
      }
      return wallet.signArbitrary(address, data);
    },
  };
}

/**
 * Narrow a client/ctx carrying an optional signer to a guaranteed `AuthSigner`, or throw
 * `INVALID_CONFIG` (query-only mode). Arg is typed structurally so this module does not depend on
 * `CapabilityCtx` (Plan 4b) — 4b's `CapabilityCtx` satisfies `{ signer?: Signer }`.
 */
export function requireAuthSigner(ctx: { readonly signer?: Signer }): AuthSigner {
  if (!ctx.signer) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'This operation requires a signer (wallet); the client was created in query-only mode.',
    );
  }
  return ctx.signer;
}
```

- [ ] **Step 4: Run → pass.** `(cd packages/core && npx vitest run src/signer.test.ts && npm run lint)` green.

- [ ] **Step 5: Barrel.** Add to `packages/core/src/index.ts`: `export { type AuthSigner, createSignerAdapter, requireAuthSigner, type Signer, type TxSigner } from './signer.js';` (Biome sorts).

- [ ] **Step 6: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/core/src/signer.ts packages/core/src/signer.test.ts packages/core/src/index.ts
git add packages/core/src/signer.ts packages/core/src/signer.test.ts packages/core/src/index.ts
git commit -m "feat(core): add the Signer port + WalletProvider adapter + requireAuthSigner (ENG-309)"
```

---

## Task 2: `createAuthTokens` (`fred/src/http/auth-tokens-factory.ts`)

**Files:** Create `packages/fred/src/http/auth-tokens-factory.ts`, `auth-tokens-factory.test.ts`. Modify `packages/fred/src/index.ts`.

**Sequencing:** Task 2 depends on Task 1 — both the test and the impl import `type AuthSigner` (and the test imports `parseLeaseUuid`) from `@manifest-network/manifest-mcp-core`, so the core **barrel re-export must already be in place (Task 1 Step 5)** and `core` rebuilt. Run Task 1 fully (through its commit) before starting Task 2.

- [ ] **Step 1: Failing test** — `auth-tokens-factory.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { toBech32 } from '@cosmjs/encoding';
import { type AuthSigner, parseLeaseUuid } from '@manifest-network/manifest-mcp-core';
import { createAuthTokens } from './auth-tokens-factory.js';

const ADDR = toBech32('manifest', new Uint8Array(20));
const LEASE = parseLeaseUuid('550e8400-e29b-41d4-a716-446655440000');

function fakeSigner(): AuthSigner {
  return {
    getAddress: vi.fn(async () => ADDR as never),
    getSigner: async () => ({}) as never,
    signArbitrary: vi.fn(async () => ({ pub_key: { type: 't', value: 'pk' }, signature: 'sig' })),
  };
}

describe('createAuthTokens', () => {
  it('binds the address once and mints a token (base64 JSON payload)', async () => {
    const signer = fakeSigner();
    const tokens = createAuthTokens(signer, { chainId: 'manifest-1' });
    const t1 = await tokens.getAuthToken(LEASE);
    await tokens.getAuthToken(LEASE);
    expect(signer.getAddress).toHaveBeenCalledTimes(1); // address bound once
    expect(typeof t1).toBe('string');
    const payload = JSON.parse(Buffer.from(t1, 'base64').toString());
    expect(payload).toMatchObject({ tenant: ADDR, lease_uuid: LEASE, pub_key: 'pk', signature: 'sig' });
  });
  it('mints a FRESH token per call (no caching — replay-tracker safety): distinct timestamps', async () => {
    const signer = fakeSigner();
    const tokens = createAuthTokens(signer, { chainId: 'manifest-1' });
    const a = JSON.parse(Buffer.from(await tokens.getAuthToken(LEASE), 'base64').toString());
    const b = JSON.parse(Buffer.from(await tokens.getAuthToken(LEASE), 'base64').toString());
    expect(signer.signArbitrary).toHaveBeenCalledTimes(2); // re-signed, not cached
    expect(b.timestamp).toBeGreaterThanOrEqual(a.timestamp); // serialized timestamps
  });
  it('getLeaseDataAuthToken embeds meta_hash', async () => {
    const tokens = createAuthTokens(fakeSigner(), { chainId: 'manifest-1' });
    const t = await tokens.getLeaseDataAuthToken(LEASE, 'abc123');
    const payload = JSON.parse(Buffer.from(t, 'base64').toString());
    expect(payload.meta_hash).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run packages/fred/src/http/auth-tokens-factory.test.ts`.

- [ ] **Step 3: Implement `packages/fred/src/http/auth-tokens-factory.ts`:**

```ts
import type { AuthSigner, LeaseUuid } from '@manifest-network/manifest-mcp-core';
import {
  AuthTimestampTracker,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

/**
 * Signer-bound ADR-036 auth-token factory. Replaces the per-call `makeFredAuthTokens` closures
 * (Barney's `getProviderAuthToken`). Binds the address from `signer.getAddress()` ONCE, then mints a
 * FRESH token per call (serialized by `AuthTimestampTracker`). It does NOT cache tokens: ADR-036
 * signing is deterministic, so a reused token is a duplicate signature the provider's replay tracker
 * rejects on protected endpoints (see `auth.ts` AuthTimestampTracker doc). Reuses the same stateless
 * builders `AuthTokenService` uses, so behavior matches the proven server path.
 *
 * The returned `getAuthToken(leaseUuid)` is ADDRESS-BOUND (the address is closed over here, not a
 * param). The deploy path's callbacks are `(address, leaseUuid) =>`, so when 4c wires this in it
 * wraps with an address-closing thunk — `() => tokens.getAuthToken(uuid)` — the same idiom the real
 * consumer (Barney `compositeTransactions.ts`) already uses. This is the intended SDK shape, not a
 * mismatch. See plan OI-A1.
 *
 * `chainId` is accepted for forward-compat / API symmetry (spec §5.3); it is NOT yet embedded in the
 * ADR-036 message — reserved for a future chain-scoped token format. See plan OI-CHAIN.
 */
export function createAuthTokens(
  signer: AuthSigner,
  opts: { chainId: string },
): {
  getAuthToken(leaseUuid: LeaseUuid): Promise<string>;
  getLeaseDataAuthToken(leaseUuid: LeaseUuid, metaHashHex: string): Promise<string>;
} {
  void opts.chainId; // reserved (OI-CHAIN); silences noUnusedParameters
  const timestamps = new AuthTimestampTracker();
  const addressPromise = signer.getAddress(); // bound once

  return {
    async getAuthToken(leaseUuid) {
      const address = await addressPromise;
      const timestamp = await timestamps.next();
      const message = createSignMessage(address, leaseUuid, timestamp);
      const { pub_key, signature } = await signer.signArbitrary(address, message);
      return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature);
    },
    async getLeaseDataAuthToken(leaseUuid, metaHashHex) {
      const address = await addressPromise;
      const timestamp = await timestamps.next();
      const message = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);
      const { pub_key, signature } = await signer.signArbitrary(address, message);
      return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature, metaHashHex);
    },
  };
}
```

  Note: `address` is a branded `Address` (assignable to the `string` params of `createSignMessage`/`createAuthToken`); `leaseUuid` is `LeaseUuid` (assignable to `string`). No casts needed.

- [ ] **Step 4: Run → pass.** `npx vitest run packages/fred/src/http/auth-tokens-factory.test.ts`; `(cd packages/fred && npm run lint)` exit 0.

- [ ] **Step 5: Barrel.** Add `createAuthTokens` to the appropriate `export` block in `packages/fred/src/index.ts`.

- [ ] **Step 6: Biome + commit.**

```bash
npx @biomejs/biome check --write packages/fred/src/http/auth-tokens-factory.ts packages/fred/src/http/auth-tokens-factory.test.ts packages/fred/src/index.ts
git add packages/fred/src/http/auth-tokens-factory.ts packages/fred/src/http/auth-tokens-factory.test.ts packages/fred/src/index.ts
git commit -m "feat(fred): add signer-bound createAuthTokens factory (ENG-309)"
```

---

## Task 3: Full gate

- [ ] (1) `npm run build` (8, exit 0). (2) **`npm run lint` (ALL 8 packages, exit 0)** — additive, but confirm no ripple. (3) `npx vitest run packages/` (all pass — the new signer + auth-tokens suites + no regression). (4) `npm run check` biome exit 0.
- [ ] All green ⇒ 4a done. Pure additive ports; existing flows (the MCP servers still use `AuthTokenService` directly) are untouched. The logger decision (OI-LOG) is documented, no code change.

---

## Self-Review (completed)

- **Spec coverage (§5.3):** `TxSigner`/`AuthSigner`/`Signer` + the `WalletProvider`→`Signer` parse-once adapter + `requireAuthSigner` ✓; `createAuthTokens(signer, {chainId})` ✓ (built on the stateless ADR-036 builders, behavior-matching `AuthTokenService`). **Deferred:** `CapabilityCtx`/`createManifestClient` (4b), ctx-ifying the fns + `CallOptions` threading (4c), bound `ManifestClient` + `executeTx`/`subscribeLeaseStatus` (4d).
- **Findings (resolved at review):** OI-CACHE (no token caching — replay-tracker safety; reconcile spec §5.3:168 "lazily cached" in the guards pass); OI-CHAIN (KEEP `chainId`, reserved/not-yet-embedded; spec note bundled with OI-CACHE at line 168); OI-LOG (the 2 core `logger.warn`s are **deferred debt that violates §5.3:179**, blocked on the 4b ctx seam — NOT a spec exemption; no 4a code change); OI-A1 (`getAuthToken(leaseUuid)`, address bound; 4c wraps via an address-closing thunk — the Barney idiom); OI-S1 (`requireAuthSigner` structural arg).
- **Additive / no behavior change:** new files + barrel exports only; `AuthTokenService` + the MCP servers are untouched (they migrate to `createAuthTokens` when ctx-ified in 4c).
- **`as*`/`parse*`:** the adapter uses `parseAddress` (validate the wallet address at the trust boundary — wallet-in is parse-once per §5.0); no `as Brand` outside brands.ts.

## Next plan

→ **Plan 4b:** `CapabilityCtx` + `QueryCtx` + the overloaded `createManifestClient` factory (builds the ctx via `CosmosClientManager.getInstance` called ONCE + held in ctx; `createSignerAdapter` for `ctx.signer`; resolves `fetch`/`logger`); declare `ManifestClient`/`ManifestReadClient` interfaces (bodies in 4d). `ctx.chain.getSigningClient()` is the documented cosmjs drop-down (already public, async/lazy). Then 4c (ctx-ify the spine fns + thread `CallOptions`) and 4d (bind methods + `executeTx` + `subscribeLeaseStatus` + per-signer mutex).
