# ENG-556 — Absolute Gas-Limit Ceiling on Generic Tx Broadcast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an absolute gas-limit ceiling (`COSMOS_MAX_GAS`, default 50,000,000, `-1` = disabled) that aborts a transaction *before* broadcast when the node's `simulate()` estimate × the gas multiplier exceeds the ceiling — bounding the fee a compromised/hostile RPC (or an injected `gas_multiplier`) can make the wallet pay.

**Architecture:** The ceiling is enforced in `buildGasFee` (the single fee-computation funnel every tx handler routes through). To cover the default `cosmos_tx` path — which today returns `'auto'` and lets cosmjs compute the fee internally, out of reach of any clamp — `cosmosTx` and `executeTx` are changed to **always resolve** `TxOptions` (with `maxGas` from config) on the non-explicit-fee path, so `buildGasFee` always computes an explicit `StdFee` and the ceiling always bites — the cosmjs-documented "compute your own `StdFee`" pattern ([#1134](https://github.com/cosmos/cosmjs/issues/1134); mirrors Hermes' `max_gas`). Fee math is behavior-preserving up to a **≤1-gas-unit** rounding difference: `buildGasFee` uses `Math.ceil(simulate × multiplier)` (its existing behavior), while cosmjs's `'auto'` uses `Math.round` (verified in the installed fork `@manifest-network/stargate@0.32.4-ll.3`, `signingstargateclient.js:176,197`). `ceil ≥ round`, so the resolved default-path fee is at most one gas unit higher — negligible and strictly safer (never under-provisions); the override path already used `ceil` and is unchanged. Config plumbs through `ManifestMCPConfig.maxGas` → `createConfig`/`validateConfig` → node `COSMOS_MAX_GAS`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `@cosmjs/stargate` (overridden to `@manifest-network/stargate`), vitest, biome, tsdown. Monorepo: `packages/core` + `packages/node`. Spec: `docs/superpowers/specs/2026-07-17-eng556-gas-ceiling-design.md`.

**Design invariants (read before starting):**
- `TxOptions.maxGas` is **optional** (`readonly maxGas?: number`). This keeps the change additive — it does NOT break the 3 existing `TxOptions` literals (`cosmos.ts:251`, `executeTx.ts:57`, `transactions/wasm.test.ts:39`) nor the existing `buildGasFee` test literals. The two real resolver sites (`cosmosTx`/`executeTx`) always populate it; `buildGasFee` guards `undefined`.
- Sentinel: `maxGas = -1` means **disabled** (mirrors the chain's `block.max_gas = -1`). `buildGasFee`'s `options.maxGas > 0` guard short-circuits for `-1` and `undefined`.
- Default: `DEFAULT_MAX_GAS = 50_000_000` (~4× the observed all-time mainnet high-water gasLimit of ~12.5M).
- Enforcement is **fail-closed** (throw `GAS_LIMIT_EXCEEDED`), never clamp-down. `GAS_LIMIT_EXCEEDED` is **non-retryable**.
- **Out of scope (do NOT touch):** the explicit-fee (`txExtras.fee` / FEE-WINS) path; `cosmosEstimateFee`'s inline gas math at `cosmos.ts:405-412` (read-only preview, stays uncapped — documented asymmetry).

**Before you start:** this is a fresh worktree. Run `npm install` (done) and `npm run build` once so cross-package tsc resolves siblings via `dist`. Run the FULL-repo `npm run lint` (not just core) after type changes — a `TxOptions`/enum change ripples into consumer packages and vitest passes while tsc fails (memory: *branded-type-changes-ripple-run-full-lint*).

---

### Task 1: Config layer — `DEFAULT_MAX_GAS`, `ManifestMCPConfig.maxGas`, `createConfig` default, `validateConfig`

**Files:**
- Modify: `packages/core/src/types.ts` (add `maxGas?` to `ManifestMCPConfig`, ~line 198)
- Modify: `packages/core/src/config.ts` (add `DEFAULT_MAX_GAS`; `createConfig` return ~line 117; `validateConfig` ~line 255)
- Test: `packages/core/src/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/config.test.ts`. Put the createConfig pair inside the existing `describe('createConfig', ...)` block (starts line 9) and the validation block as a new `describe` sibling of `describe('validateConfig gasMultiplier', ...)`:

```typescript
  // --- inside describe('createConfig', ...) ---
  it('should apply default maxGas', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(config.maxGas).toBe(50_000_000);
  });

  it('should preserve provided maxGas', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      maxGas: 10_000_000,
    });

    expect(config.maxGas).toBe(10_000_000);
  });

  it('should preserve maxGas of -1 (disabled sentinel)', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      maxGas: -1,
    });

    expect(config.maxGas).toBe(-1);
  });
```

```typescript
// --- new top-level describe, next to describe('validateConfig gasMultiplier', ...) ---
describe('validateConfig maxGas', () => {
  const base = {
    chainId: 'test',
    rpcUrl: 'https://example.com',
    gasPrice: '1.0umfx',
  } as const;

  it('accepts a positive integer', () => {
    expect(validateConfig({ ...base, maxGas: 50_000_000 }).valid).toBe(true);
  });

  it('accepts -1 (disabled sentinel)', () => {
    expect(validateConfig({ ...base, maxGas: -1 }).valid).toBe(true);
  });

  it('accepts undefined (unset)', () => {
    expect(validateConfig({ ...base, maxGas: undefined }).valid).toBe(true);
  });

  it('rejects 0', () => {
    const result = validateConfig({ ...base, maxGas: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxGas'))).toBe(true);
  });

  it('rejects negative values other than -1', () => {
    const result = validateConfig({ ...base, maxGas: -5 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxGas'))).toBe(true);
  });

  it('rejects non-integer values', () => {
    const result = validateConfig({ ...base, maxGas: 1.5 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxGas'))).toBe(true);
  });

  it('rejects NaN', () => {
    const result = validateConfig({ ...base, maxGas: Number.NaN });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxGas'))).toBe(true);
  });

  it('rejects Infinity', () => {
    const result = validateConfig({
      ...base,
      maxGas: Number.POSITIVE_INFINITY,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxGas'))).toBe(true);
  });

  it('rejects a non-number via createValidatedConfig', () => {
    expect(() =>
      createValidatedConfig({ ...base, maxGas: 0 }),
    ).toThrow(ManifestMCPError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/config.test.ts -t maxGas`
Expected: FAIL — `config.maxGas` is `undefined` (no default applied); `validateConfig` accepts the bad values (no `maxGas` branch), so the reject cases fail.

- [ ] **Step 3: Add `maxGas` to `ManifestMCPConfig`**

In `packages/core/src/types.ts`, add the field as the new last member of `ManifestMCPConfig` (immediately after the `gasMultiplier` field, before the closing `}` on line 199):

```typescript
  /** Gas simulation multiplier (default: 1.5, minimum: 1). A value of 1.0 uses the exact simulation result with no safety margin. Increase if transactions fail with out-of-gas errors. */
  readonly gasMultiplier?: number;
  /**
   * Absolute per-transaction gas-limit ceiling (default: 50_000_000). A broadcast
   * whose `ceil(simulate() * gasMultiplier)` exceeds this is aborted with
   * `GAS_LIMIT_EXCEEDED` before signing — defense-in-depth against a hostile RPC
   * inflating the simulated gas. Must be a positive integer, or `-1` to disable
   * the ceiling (mirrors the chain's `block.max_gas = -1` "unlimited" convention).
   */
  readonly maxGas?: number;
}
```

- [ ] **Step 4: Add `DEFAULT_MAX_GAS` and apply it in `createConfig`**

In `packages/core/src/config.ts`, add the constant right after `DEFAULT_GAS_MULTIPLIER` (line 23):

```typescript
export const DEFAULT_GAS_MULTIPLIER = 1.5;

/**
 * Default absolute gas-limit ceiling (~4x the observed all-time mainnet
 * high-water gasLimit of ~12.5M). A broadcast whose ceil(simulate * multiplier)
 * exceeds this aborts with GAS_LIMIT_EXCEEDED. `-1` disables the ceiling. (ENG-556)
 */
export const DEFAULT_MAX_GAS = 50_000_000;
```

Then add `maxGas` as the new last field of the `createConfig` return object (after `gasMultiplier`, line 117):

```typescript
    gasMultiplier: input.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER,
    maxGas: input.maxGas ?? DEFAULT_MAX_GAS,
  };
}
```

- [ ] **Step 5: Add the `maxGas` validation block in `validateConfig`**

In `packages/core/src/config.ts`, insert immediately after the `gasMultiplier` validation block (after line 255, before the `return { valid: ... }` at line 257):

```typescript
  if (config.maxGas !== undefined) {
    if (
      typeof config.maxGas !== 'number' ||
      !Number.isInteger(config.maxGas) ||
      (config.maxGas <= 0 && config.maxGas !== -1)
    ) {
      errors.push(
        'maxGas must be a positive integer, or -1 to disable the ceiling',
      );
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/config.test.ts`
Expected: PASS (all existing + new `maxGas` cases).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/src/config.test.ts
git commit -F - <<'EOF'
feat(core): add maxGas config field + DEFAULT_MAX_GAS (ENG-556)

ManifestMCPConfig.maxGas (optional, default 50M via createConfig, -1 disables),
validated as a positive integer or the -1 disable sentinel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `GAS_LIMIT_EXCEEDED` error code + non-retryable classification

**Files:**
- Modify: `packages/core/src/types.ts` (`ManifestMCPErrorCode` enum, Transaction-errors section ~line 386)
- Modify: `packages/core/src/retry.ts` (`NON_RETRYABLE_ERROR_CODES`, ~line 42)
- Test: `packages/core/src/retry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/retry.test.ts`, inside `describe('isRetryableError') > describe('ManifestMCPError handling')` (near the `TX_FAILED` case at lines 52-58):

```typescript
    it('should not retry GAS_LIMIT_EXCEEDED errors', () => {
      // A pre-broadcast safety abort (ENG-556): the simulated gas exceeded the
      // configured ceiling. Retrying cannot lower a deterministic estimate.
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
        'Estimated gas limit 999999999 exceeds the configured ceiling 50000000',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('exposes GAS_LIMIT_EXCEEDED as a stable enum value', () => {
      expect(ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED).toBe(
        'GAS_LIMIT_EXCEEDED',
      );
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/retry.test.ts -t GAS_LIMIT_EXCEEDED`
Expected: FAIL — `ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED` does not exist (tsc/runtime error: `undefined`).

- [ ] **Step 3: Add the enum member**

In `packages/core/src/types.ts`, add to the `// Transaction errors` section, immediately after `SIMULATION_FAILED` (line 386):

```typescript
  // Transaction errors
  TX_FAILED = 'TX_FAILED',
  UNSUPPORTED_TX = 'UNSUPPORTED_TX',
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  /**
   * A pre-broadcast safety abort: `ceil(simulate() * gasMultiplier)` exceeded the
   * configured absolute ceiling (`COSMOS_MAX_GAS` / `config.maxGas`). Bounds the fee
   * a hostile/compromised RPC (or an injected gas_multiplier) can make the wallet pay.
   * Carries `{ simulatedGas, gasMultiplier, estimatedGas, maxGas }`. Non-retryable —
   * a deterministic estimate will not shrink on retry (ENG-556).
   */
  GAS_LIMIT_EXCEEDED = 'GAS_LIMIT_EXCEEDED',
```

- [ ] **Step 4: Add to `NON_RETRYABLE_ERROR_CODES`**

In `packages/core/src/retry.ts`, add immediately after the `TX_FAILED` entry (line 41), inside the same tx-rejection comment group:

```typescript
  // Transaction failures - on-chain rejection. Retrying could cause
  // double-spend for non-idempotent operations.
  ManifestMCPErrorCode.TX_FAILED,

  // Gas-ceiling breach - a deterministic pre-broadcast safety abort (ENG-556).
  // Retrying cannot lower the simulated gas; keep it envelope-free so it
  // short-circuits here and never reaches the grpcCode/httpStatus branches.
  ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/retry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/retry.ts packages/core/src/retry.test.ts
git commit -F - <<'EOF'
feat(core): add GAS_LIMIT_EXCEEDED error code (non-retryable) (ENG-556)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `TxOptions.maxGas` + the `buildGasFee` ceiling clamp

**Files:**
- Modify: `packages/core/src/types.ts` (`TxOptions`, ~line 214)
- Modify: `packages/core/src/transactions/utils.ts` (`buildGasFee`, lines 693-704)
- Test: `packages/core/src/transactions/utils.test.ts` (existing `describe('buildGasFee', ...)`, lines 1048-1117)

**Note:** `maxGas` is OPTIONAL on `TxOptions`, so the existing `buildGasFee` test literals (`{ gasMultiplier, gasPrice }`) and the 3 other `TxOptions` literals still compile unchanged. `buildGasFee` already imports `ManifestMCPError` + `ManifestMCPErrorCode` (utils.ts lines 8-9) — no new import needed.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('buildGasFee', ...)` block in `packages/core/src/transactions/utils.test.ts` (reuse its `makeMockClient`, `senderAddress`, `messages` fixtures):

```typescript
  it('throws GAS_LIMIT_EXCEEDED when ceil(estimate * multiplier) exceeds maxGas', async () => {
    const client = makeMockClient(40_000_000); // 40M * 1.5 = 60M > 50M
    const options = {
      gasMultiplier: 1.5,
      gasPrice: '0.025umfx',
      maxGas: 50_000_000,
    };

    await expect(
      buildGasFee(client, senderAddress, messages, options),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
      details: {
        estimatedGas: 60_000_000,
        maxGas: 50_000_000,
        gasMultiplier: 1.5,
        simulatedGas: 40_000_000,
      },
    });
  });

  it('computes the fee normally when the limit is at or below maxGas', async () => {
    const client = makeMockClient(100_000); // 100k * 1.5 = 150k <= 50M
    const options = {
      gasMultiplier: 1.5,
      gasPrice: '0.025umfx',
      maxGas: 50_000_000,
    };

    const fee = await buildGasFee(client, senderAddress, messages, options);

    expect((fee as { gas: string }).gas).toBe('150000');
  });

  it('does not clamp when maxGas is -1 (disabled)', async () => {
    const client = makeMockClient(40_000_000);
    const options = {
      gasMultiplier: 1.5,
      gasPrice: '0.025umfx',
      maxGas: -1,
    };

    const fee = await buildGasFee(client, senderAddress, messages, options);

    expect((fee as { gas: string }).gas).toBe('60000000');
  });

  it('does not clamp when maxGas is undefined (unset on TxOptions)', async () => {
    const client = makeMockClient(40_000_000);
    const options = { gasMultiplier: 1.5, gasPrice: '0.025umfx' };

    const fee = await buildGasFee(client, senderAddress, messages, options);

    expect((fee as { gas: string }).gas).toBe('60000000');
  });

  it('throws GAS_LIMIT_EXCEEDED on a non-finite (Infinity) gas estimate when a ceiling is set', async () => {
    const client = makeMockClient(Number.POSITIVE_INFINITY);
    const options = {
      gasMultiplier: 1.5,
      gasPrice: '0.025umfx',
      maxGas: 50_000_000,
    };

    await expect(
      buildGasFee(client, senderAddress, messages, options),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });
  });

  it('throws GAS_LIMIT_EXCEEDED on a NaN gas estimate when a ceiling is set', async () => {
    const client = makeMockClient(Number.NaN);
    const options = {
      gasMultiplier: 1.5,
      gasPrice: '0.025umfx',
      maxGas: 50_000_000,
    };

    await expect(
      buildGasFee(client, senderAddress, messages, options),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/transactions/utils.test.ts -t buildGasFee`
Expected: FAIL — the two exceed/non-finite cases resolve a fee instead of throwing; the `-1`/`undefined` cases already pass (no clamp exists yet), which is fine.

- [ ] **Step 3: Add `maxGas` to `TxOptions`**

In `packages/core/src/types.ts`, add the optional field to `TxOptions` (after `gasPrice`, line 214):

```typescript
export interface TxOptions {
  readonly gasMultiplier: number;
  readonly gasPrice: string;
  /**
   * Absolute gas-limit ceiling resolved from `config.maxGas` (default 50_000_000;
   * `-1` disables). `buildGasFee` throws `GAS_LIMIT_EXCEEDED` when
   * `ceil(simulate * gasMultiplier)` exceeds it. Optional so the additive change
   * does not break existing `TxOptions` literals; the resolvers (`cosmosTx`,
   * `executeTx`) always populate it. (ENG-556)
   */
  readonly maxGas?: number;
}
```

- [ ] **Step 4: Add the clamp in `buildGasFee`**

Replace the body of `buildGasFee` in `packages/core/src/transactions/utils.ts` (lines 700-703):

```typescript
export async function buildGasFee(
  client: SigningStargateClient,
  signerAddress: string,
  messages: readonly EncodeObject[],
  options?: TxOptions,
  memo?: string,
): Promise<StdFee | 'auto'> {
  if (!options) return 'auto';
  const gasEstimate = await client.simulate(signerAddress, messages, memo);
  const gasLimit = Math.ceil(gasEstimate * options.gasMultiplier);
  // Absolute ceiling (ENG-556): a hostile/compromised RPC can inflate simulate();
  // fail closed before signing rather than pay an unbounded fee. maxGas === -1 or
  // undefined disables the check. Running BEFORE calculateFee also pre-empts the
  // generic `new Uint53(gasLimit)` int53-range / non-finite throw inside calculateFee
  // on an astronomically inflated or NaN estimate — replacing an unclassified Error
  // with a clean GAS_LIMIT_EXCEEDED.
  if (
    options.maxGas !== undefined &&
    options.maxGas > 0 &&
    (!Number.isFinite(gasLimit) || gasLimit > options.maxGas)
  ) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
      `Estimated gas limit ${gasLimit} exceeds the configured ceiling ${options.maxGas} ` +
        `(COSMOS_MAX_GAS). A hostile or misconfigured RPC can inflate the simulated gas. ` +
        `Raise COSMOS_MAX_GAS if this transaction is legitimate, or set it to -1 to disable the ceiling.`,
      {
        simulatedGas: gasEstimate,
        gasMultiplier: options.gasMultiplier,
        estimatedGas: gasLimit,
        maxGas: options.maxGas,
      },
    );
  }
  return calculateFee(gasLimit, options.gasPrice);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/transactions/utils.test.ts -t buildGasFee`
Expected: PASS (all existing + 5 new cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/transactions/utils.ts packages/core/src/transactions/utils.test.ts
git commit -F - <<'EOF'
feat(core): enforce gas ceiling in buildGasFee (ENG-556)

buildGasFee throws GAS_LIMIT_EXCEEDED when ceil(simulate * multiplier) exceeds
options.maxGas (fail-closed, pre-broadcast). Optional TxOptions.maxGas keeps the
change additive; -1/undefined disable the clamp.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: `cosmosTx` — always resolve `TxOptions` so the ceiling covers the default path

**Files:**
- Modify: `packages/core/src/cosmos.ts` (`cosmosTx`, the txOptions-build block lines 232-252)
- Test: `packages/core/src/cosmos.test.ts` (`describe('cosmosTx', ...)`)

**Why:** today `txOptions` is built ONLY when a `gasMultiplier` override is present; the default `cosmos_tx` path leaves it `undefined` → `buildGasFee` returns `'auto'` → cosmjs computes the fee internally, bypassing the ceiling. Change it to always resolve `txOptions` (with `maxGas` from config) on the non-explicit-fee path whenever `gasPrice` is configured. Behavior-preserving: the resolved `gasMultiplier` (`override ?? config ?? DEFAULT_GAS_MULTIPLIER`) and `gasPrice` reproduce the exact fee cosmjs's `'auto'` produced (its `defaultGasMultiplier` is set to `config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER` in `client.ts:420`).

- [ ] **Step 1: Add the import**

`packages/core/src/cosmos.ts:3` **already** imports `DEFAULT_GAS_MULTIPLIER` from `./config.js`. Extend that exact line to add `DEFAULT_MAX_GAS`:

```typescript
import { DEFAULT_GAS_MULTIPLIER, DEFAULT_MAX_GAS } from './config.js';
```

(`calculateFee` is already imported at line 1. This is a one-line edit — no new import statement.)

- [ ] **Step 2: Write the failing tests**

Add to `packages/core/src/cosmos.test.ts` inside `describe('cosmosTx', ...)`. First, UPDATE the existing exact-match assertion in the `'passes resolved TxOptions to handler when gasMultiplier override provided'` test — the resolved object now carries `maxGas`:

```typescript
    // in 'passes resolved TxOptions to handler when gasMultiplier override provided':
    // clientManager.getConfig now must also carry maxGas (or rely on DEFAULT_MAX_GAS)
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
    });

    await cosmosTx(clientManager, 'bank', 'send', [], false, {
      gasMultiplier: 2.5,
    });

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      [],
      false,
      { gasMultiplier: 2.5, gasPrice: '1.0umfx', maxGas: 50_000_000 },
      undefined,
      undefined,
    );
```

Then ADD two new tests:

```typescript
  it('resolves TxOptions on the default path (no override) when gasPrice is configured', async () => {
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
      gasMultiplier: 1.5,
      maxGas: 50_000_000,
    });

    await cosmosTx(clientManager, 'bank', 'send', ['addr', '1umfx']);

    expect(mockHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'send',
      ['addr', '1umfx'],
      true,
      { gasMultiplier: 1.5, gasPrice: '1.0umfx', maxGas: 50_000_000 },
      undefined,
      undefined,
    );
  });

  it('threads config.maxGas into the resolved TxOptions', async () => {
    const mockHandler = vi.fn().mockResolvedValue({
      module: 'bank',
      subcommand: 'send',
      transactionHash: 'X',
      code: 0,
      height: '1',
    });
    mockGetTxHandler.mockReturnValue(mockHandler);
    clientManager.getConfig.mockReturnValue({
      retry: { maxRetries: 3 },
      gasPrice: '1.0umfx',
      gasMultiplier: 1.5,
      maxGas: 7_000_000,
    });

    await cosmosTx(clientManager, 'bank', 'send', ['addr', '1umfx']);

    const passedOptions = mockHandler.mock.calls[0][5];
    expect(passedOptions).toEqual({
      gasMultiplier: 1.5,
      gasPrice: '1.0umfx',
      maxGas: 7_000_000,
    });
  });
```

Note: the existing `'dispatches to the correct tx handler'` test uses the default mock config `{ retry: { maxRetries: 3 } }` (no `gasPrice`) → `txOptions` stays `undefined` → its 6th-arg `undefined` assertion still holds. Do NOT change it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/cosmos.test.ts -t cosmosTx`
Expected: FAIL — default-path tests get `undefined` as the 6th arg (txOptions not built without an override); the updated override test fails on the missing `maxGas` key.

- [ ] **Step 4: Rewrite the txOptions-build block**

In `packages/core/src/cosmos.ts`, replace the block at lines 232-252 (from `// Build fully-resolved gas options ...` through the closing `}` of the `if (overrides?.gasMultiplier !== undefined)`). Keep the mutual-exclusion check above it (lines 225-230) unchanged:

```typescript
  // Validate an explicit gasMultiplier override eagerly (unchanged semantics).
  if (overrides?.gasMultiplier !== undefined) {
    if (
      !Number.isFinite(overrides.gasMultiplier) ||
      overrides.gasMultiplier < 1
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${overrides.gasMultiplier}`,
      );
    }
  }

  // Resolve fully-resolved gas options for the SIMULATE path. Always build them on
  // the non-explicit-fee path (not just when an override is present) so the maxGas
  // ceiling in buildGasFee covers the default cosmos_tx path too (ENG-556). Skipped
  // when an explicit fee wins (FEE-WINS bypasses simulate). When gasPrice is not
  // configured this stays undefined → buildGasFee returns 'auto' → the broadcast
  // still fails downstream at getBroadcastClient (query-only mode), exactly as before.
  let txOptions: TxOptions | undefined;
  if (txExtras?.fee === undefined) {
    const config = clientManager.getConfig();
    const gasPrice = config.gasPrice;
    if (!gasPrice) {
      if (overrides?.gasMultiplier !== undefined) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'gasMultiplier override requires gasPrice configuration',
        );
      }
    } else {
      txOptions = {
        gasMultiplier:
          overrides?.gasMultiplier ??
          config.gasMultiplier ??
          DEFAULT_GAS_MULTIPLIER,
        gasPrice,
        maxGas: config.maxGas ?? DEFAULT_MAX_GAS,
      };
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/cosmos.test.ts`
Expected: PASS (existing dispatch/override/mutual-exclusion/txExtras tests + 2 new default-path tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cosmos.ts packages/core/src/cosmos.test.ts
git commit -F - <<'EOF'
feat(core): always resolve TxOptions in cosmosTx so the gas ceiling covers the default path (ENG-556)

Build resolved gas options (gasMultiplier/gasPrice/maxGas) on every non-explicit-fee
broadcast, not only when a gasMultiplier override is present, so buildGasFee computes
an explicit fee and the ceiling bites the default cosmos_tx path. Behavior-preserving
fee math (identical to cosmjs 'auto').

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: `executeTx` — always resolve `TxOptions` (multi-message path)

**Files:**
- Modify: `packages/core/src/tools/executeTx.ts` (txOptions block lines 42-58; add config import)
- Test: `packages/core/src/tools/executeTx.test.ts`

**Why:** `executeTx` (the SDK multi-message / deploy path) mirrors `cosmosTx` and today also only builds `txOptions` when `opts.gasMultiplier` is set. Apply the same always-resolve change so the ceiling covers it. Note `executeTx` reads config via `ctx.chain.getConfig()`.

- [ ] **Step 1: Add the import**

In `packages/core/src/tools/executeTx.ts`, add to the imports:

```typescript
import { DEFAULT_GAS_MULTIPLIER, DEFAULT_MAX_GAS } from '../config.js';
```

- [ ] **Step 2: Write the failing test**

Add to `packages/core/src/tools/executeTx.test.ts`. The default `makeMockConfig` sets `gasPrice: '1.0umfx'` (no `maxGas`), so the resolver defaults `maxGas` to 50M:

```typescript
  it('aborts with GAS_LIMIT_EXCEEDED when the simulated gas exceeds config.maxGas', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(40_000_000); // * 1.5 default = 60M > 50M
    const ctx = ctxWith(signAndBroadcast, simulate);

    await expect(executeTx(ctx, msgs)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it('drives the simulate path on the default call (no opts) and stays under the ceiling', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const ctx = ctxWith(signAndBroadcast, simulate);

    await executeTx(ctx, msgs);

    expect(simulate).toHaveBeenCalledTimes(1);
    const feeArg = signAndBroadcast.mock.calls[0][2];
    expect(feeArg).not.toBe('auto');
    expect(feeArg).toMatchObject({ gas: expect.any(String) });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/tools/executeTx.test.ts -t GAS_LIMIT_EXCEEDED`
Expected: FAIL — with no `opts.gasMultiplier`, `executeTx` currently leaves `txOptions` undefined → `buildGasFee` returns `'auto'` → no simulate, no ceiling; `signAndBroadcast` IS called with `'auto'`.

- [ ] **Step 4: Rewrite the txOptions block**

In `packages/core/src/tools/executeTx.ts`, replace lines 42-58 (the `let txOptions ...` through the closing `}` of the `if (opts?.gasMultiplier !== undefined)`), keeping the mutual-exclusion guard above (lines 36-41) unchanged:

```typescript
  // Validate an explicit gasMultiplier override eagerly (unchanged semantics).
  if (opts?.gasMultiplier !== undefined) {
    if (!Number.isFinite(opts.gasMultiplier) || opts.gasMultiplier < 1) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `gasMultiplier must be a finite number >= 1, got ${opts.gasMultiplier}`,
      );
    }
  }

  // Always resolve gas options on the non-explicit-fee path so the maxGas ceiling
  // (ENG-556) covers executeTx's default call, not only when a gasMultiplier override
  // is supplied. Skipped when opts.fee wins. Undefined gasPrice → 'auto' → downstream
  // INVALID_CONFIG at broadcast time, exactly as before.
  let txOptions: TxOptions | undefined;
  if (opts?.fee === undefined) {
    const config = ctx.chain.getConfig();
    const gasPrice = config.gasPrice;
    if (!gasPrice) {
      if (opts?.gasMultiplier !== undefined) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'gasMultiplier override requires gasPrice configuration',
        );
      }
    } else {
      txOptions = {
        gasMultiplier:
          opts?.gasMultiplier ??
          config.gasMultiplier ??
          DEFAULT_GAS_MULTIPLIER,
        gasPrice,
        maxGas: config.maxGas ?? DEFAULT_MAX_GAS,
      };
    }
  }
```

- [ ] **Step 5: Update the two existing tests broken by the default-path change**

Two pre-existing tests exercise the default (no-opts) path, which now computes an explicit `StdFee` instead of `'auto'`. Both MUST be updated (these are exact edits, not a "review"):

**(a) The SYNC-broadcast test** (`executeTx.test.ts`, ~lines 79-86) hard-codes `'auto'` as the fee arg to `signAndBroadcastSync`. Change it to a computed-fee matcher:

```typescript
    expect(signAndBroadcastSync).toHaveBeenCalledWith(
      expect.any(String),
      msgs,
      expect.objectContaining({ gas: expect.any(String) }),
      '',
    );
```

**(b) The concurrent-serialization test** (`executeTx.test.ts`, ~line 173) mocks `simulate: vi.fn()` (returns `undefined`). With the default path now simulating, `undefined` → `Math.ceil(undefined * 1.5)` = `NaN` → the clamp throws `GAS_LIMIT_EXCEEDED` before `signAndBroadcast` ever runs, breaking the `order` assertion. Give `simulate` a resolved value under the ceiling:

```typescript
    chain.getSigningClient = vi
      .fn()
      .mockResolvedValue({ signAndBroadcast, simulate: vi.fn().mockResolvedValue(100_000) });
```

(No other existing `executeTx.test.ts` case breaks: the multi-msg and TX_FAILED/no-double-broadcast tests assert `expect.anything()` for the fee or don't assert it; the `gasMultiplier`-set and fee-wins tests are unaffected.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/tools/executeTx.test.ts`
Expected: PASS (all 9 existing cases as updated + the 2 new cases).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/executeTx.ts packages/core/src/tools/executeTx.test.ts
git commit -F - <<'EOF'
feat(core): always resolve TxOptions in executeTx so the gas ceiling covers the default path (ENG-556)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Node env — `COSMOS_MAX_GAS` parsing + threading

**Files:**
- Modify: `packages/node/src/config.ts` (`NodeMCPConfig` ~line 13; `loadConfig` parse ~line 71; return object ~line 100)
- Modify: `packages/node/src/bootstrap.ts` (`createValidatedConfig` input ~line 117)
- Test: `packages/node/src/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/node/src/config.test.ts`. FIRST extend the `beforeEach` delete-list (add after the `COSMOS_GAS_MULTIPLIER` delete):

```typescript
  delete process.env.COSMOS_GAS_MULTIPLIER;
  delete process.env.COSMOS_MAX_GAS;
```

Then add the parse/validation tests (mirror the `COSMOS_GAS_MULTIPLIER` block):

```typescript
  it('should parse COSMOS_MAX_GAS as a number', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '10000000';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBe(10_000_000);
  });

  it('should parse COSMOS_MAX_GAS of -1 (disabled)', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '-1';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBe(-1);
  });

  it('should leave maxGas undefined when COSMOS_MAX_GAS is not set', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBeUndefined();
  });

  it('should leave maxGas undefined when COSMOS_MAX_GAS is empty string', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBeUndefined();
  });

  it('should throw for non-numeric COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = 'abc';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for zero COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '0';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for a non-integer COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '1.5';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for a negative COSMOS_MAX_GAS other than -1', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '-5';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/node/src/config.test.ts -t COSMOS_MAX_GAS`
Expected: FAIL — `config.maxGas` is `undefined` for the parse cases; invalid values don't throw (no parse block).

- [ ] **Step 3: Add `maxGas` to `NodeMCPConfig`**

In `packages/node/src/config.ts`, add after the `gasMultiplier` field (line 14):

```typescript
  /** Gas simulation multiplier parsed from COSMOS_GAS_MULTIPLIER (minimum: 1). When undefined, a default of 1.5 is applied downstream by createConfig. */
  readonly gasMultiplier?: number;
  /** Absolute gas-limit ceiling parsed from COSMOS_MAX_GAS (positive integer, or -1 to disable). When undefined, a default of 50_000_000 is applied downstream by createConfig. */
  readonly maxGas?: number;
```

- [ ] **Step 4: Parse `COSMOS_MAX_GAS` in `loadConfig`**

In `packages/node/src/config.ts`, add immediately after the `gasMultiplier` parse block (after line 71, before the endpoint validation at line 73):

```typescript
  const maxGasRaw = process.env.COSMOS_MAX_GAS;
  let maxGas: number | undefined;
  if (maxGasRaw !== undefined && maxGasRaw !== '') {
    maxGas = Number(maxGasRaw);
    if (!Number.isInteger(maxGas) || (maxGas <= 0 && maxGas !== -1)) {
      throw new Error(
        `COSMOS_MAX_GAS must be a positive integer, or -1 to disable, got "${maxGasRaw}"`,
      );
    }
  }
```

Then add `maxGas` to the returned object (after `gasMultiplier`, line 100):

```typescript
    gasMultiplier,
    maxGas,
    keyPassword: process.env.MANIFEST_KEY_PASSWORD,
  };
```

- [ ] **Step 5: Thread `maxGas` through `bootstrap.ts`**

In `packages/node/src/bootstrap.ts`, add to the `createValidatedConfig` input object (after `gasMultiplier: env.gasMultiplier,`, line 117):

```typescript
      gasMultiplier: env.gasMultiplier,
      maxGas: env.maxGas,
    });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/node/src/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/config.ts packages/node/src/bootstrap.ts packages/node/src/config.test.ts
git commit -F - <<'EOF'
feat(node): parse COSMOS_MAX_GAS and thread it into config (ENG-556)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Documentation — CLAUDE.md, package READMEs, `.env.example`, CHANGELOG, security doc

**Files:**
- Modify: `CLAUDE.md` (env table ~line 107; CosmosClientManager bullet ~line 54; error-handling count ~line 94)
- Modify: `packages/node/README.md` (published env table, ~line 164)
- Modify: `packages/node/.env.example` (commented sample, ~line 23)
- Modify: `packages/agent/README.md` (agent env matrix, ~line 44)
- Modify: `CHANGELOG.md` (`## [Unreleased]`, ~line 8)
- Modify: `docs/security.md` (config/tx validation section, ~line 108)

**Why these:** every surface that documents `COSMOS_GAS_MULTIPLIER` must also list `COSMOS_MAX_GAS` or it goes stale. The agent server enforces the ceiling too — all its broadcasts (`deployApp` → `deployManifest.ts:261`, `manageDomain` → `setItemCustomDomain.ts:78`, `closeLease`) route through the now-capped `cosmosTx`. ENG-556 is a security control, so it belongs in `docs/security.md`; and the repo convention populates `CHANGELOG.md [Unreleased]` per ENG.

- [ ] **Step 1: Add the env-var table row**

In `CLAUDE.md`, insert immediately after the `COSMOS_GAS_MULTIPLIER` row (line 107), keeping gas-family vars contiguous, matching the 3-column backtick format exactly:

```markdown
| `COSMOS_GAS_MULTIPLIER` | No | `1.5` (must be >= 1) |
| `COSMOS_MAX_GAS` | No | `50000000` (absolute gas-limit ceiling; a broadcast whose `ceil(simulate × multiplier)` exceeds it aborts with `GAS_LIMIT_EXCEEDED`; `-1` disables) |
```

- [ ] **Step 2: Add the architecture note**

In `CLAUDE.md`, append one sentence to the end of the `CosmosClientManager` Key-components bullet (line 54, after the `clearInstances()` sentence):

```markdown
The tx-broadcast path enforces an absolute gas-limit ceiling (`COSMOS_MAX_GAS` / `config.maxGas`, default 50M, `-1` disables): `cosmosTx`/`executeTx` always resolve `TxOptions` on the non-explicit-fee path so `buildGasFee` computes an explicit fee instead of delegating `'auto'` to cosmjs, then aborts with `GAS_LIMIT_EXCEEDED` before signing when `ceil(simulate × multiplier)` exceeds the ceiling — bounding the fee a hostile/compromised RPC can make the wallet pay (ENG-556).
```

- [ ] **Step 3: Fix the stale enum count**

In `CLAUDE.md`, find the error-handling line (~line 94): `ManifestMCPError` with `ManifestMCPErrorCode` enum (15 codes, 8 categories). First verify the real post-change count:

Run: `grep -cE "^\s+[A-Z_]+ = '" packages/core/src/types.ts`
(or count members in the `ManifestMCPErrorCode` enum block directly). Confirm it is now **17** (16 pre-existing + `GAS_LIMIT_EXCEEDED`). Update the prose:

```markdown
`ManifestMCPError` with `ManifestMCPErrorCode` enum (17 codes, 8 categories).
```

- [ ] **Step 4: Add the row to `packages/node/README.md`**

Insert after the `COSMOS_GAS_MULTIPLIER` row (~line 164), matching the 4-column format (`| Variable | Required | Default | Description |`):

```markdown
| `COSMOS_MAX_GAS` | No | `50000000` | Absolute per-tx gas-limit ceiling; a broadcast whose `ceil(simulate × multiplier)` exceeds it aborts with `GAS_LIMIT_EXCEEDED`; `-1` disables |
```

- [ ] **Step 5: Add the commented sample to `packages/node/.env.example`**

Insert after the `COSMOS_GAS_MULTIPLIER` sample (~line 23):

```bash
# Optional — absolute per-transaction gas-limit ceiling (default: 50000000; -1 disables).
# A broadcast whose ceil(simulate × multiplier) exceeds it aborts with GAS_LIMIT_EXCEEDED.
# COSMOS_MAX_GAS=50000000
```

- [ ] **Step 6: Add the row to `packages/agent/README.md`**

Insert after the `COSMOS_GAS_MULTIPLIER` row (~line 44), matching the 4-column `| Variable | Required | Default | Notes |` format:

```markdown
| `COSMOS_MAX_GAS` | No | `50000000` | Absolute per-tx gas ceiling; a broadcast aborts with `GAS_LIMIT_EXCEEDED` when `ceil(simulate × multiplier)` exceeds it; `-1` disables. Enforced on deploy / manage-domain / close-lease. |
```

- [ ] **Step 7: Add the CHANGELOG entry**

In `CHANGELOG.md`, populate the `## [Unreleased]` section (~line 8):

```markdown
## [Unreleased]

### Added

- **core, node:** an absolute gas-limit ceiling — `COSMOS_MAX_GAS` / `config.maxGas` (default `50000000`, `-1` disables) + `ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED` (non-retryable). A broadcast whose `ceil(simulate × multiplier)` exceeds the ceiling aborts before signing, bounding the fee a hostile/compromised RPC can force via an inflated `simulate()`. (ENG-556)

### Changed

- **core:** `cosmosTx` / `executeTx` now always resolve `TxOptions` on the non-explicit-fee path, so the default broadcast computes an explicit fee instead of delegating `'auto'` to cosmjs. Behavior-preserving fee math (`ceil` vs cosmjs's `round`, ≤1 gas unit, strictly safer). (ENG-556)
```

- [ ] **Step 8: Add the security-doc note**

In `docs/security.md`, append to the Input-validation section (after the `INVALID_CONFIG` paragraph, ~line 108) a sentence describing the control:

```markdown
The tx-broadcast path enforces an absolute gas-limit ceiling (`COSMOS_MAX_GAS` / `config.maxGas`, default `50_000_000`; `-1` disables). `cosmosTx` / `executeTx` resolve an explicit fee rather than delegating `'auto'` to cosmjs, and `buildGasFee` aborts with `GAS_LIMIT_EXCEEDED` (non-retryable) before signing when `ceil(simulate() × gasMultiplier)` exceeds the ceiling — bounding the fee a hostile or compromised `COSMOS_RPC_URL` can force by inflating the simulated gas. `gasPrice` is operator config (trusted); `simulate()` is the untrusted input the ceiling constrains.
```

- [ ] **Step 9: Verify the docs build clean (biome)**

Run: `npm run check`
Expected: PASS (no markdown/format drift). If biome reports import/format drift on any file, run `npm run check:fix` (`check` is read-only; `check:fix` writes).

- [ ] **Step 10: Commit**

```bash
git add CLAUDE.md packages/node/README.md packages/node/.env.example packages/agent/README.md CHANGELOG.md docs/security.md
git commit -F - <<'EOF'
docs: document COSMOS_MAX_GAS ceiling across READMEs/env/CHANGELOG/security (ENG-556)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: (Optional) E2E — prove the ceiling aborts a live broadcast

**Files:**
- Modify: `e2e/helpers/mcp-client.ts` (`MCPTestClientOptions` interface; `connect()` env builder)
- Create: `e2e/gas-ceiling.e2e.test.ts`

**Note:** This runs nightly/on-tag via `e2e.yml` (full `npm run test:e2e`), NOT on a normal PR (`e2e-pr.yml` runs only the single sdk-acceptance variant). Requires a running devnet (`docker compose -f e2e/docker-compose.yml up -d --wait`). Skip this task if devnet is unavailable locally (memory: *local-e2e-blocked-cachyos-docker-dnat* — verify via `gh workflow run e2e.yml --ref <branch>` instead).

- [ ] **Step 1: Wire `maxGas` into the test MCP client**

In `e2e/helpers/mcp-client.ts`, add `maxGas?: string;` to `MCPTestClientOptions` (beside `gasPrice`). In `connect()`, add a hygiene delete in the delete block (with `delete env.COSMOS_GAS_PRICE;` etc.):

```typescript
  delete env.COSMOS_MAX_GAS;
```

and set it near the RPC block:

```typescript
  if (options.maxGas !== undefined) env.COSMOS_MAX_GAS = options.maxGas;
```

- [ ] **Step 2: Write the e2e test**

Create `e2e/gas-ceiling.e2e.test.ts` (dedicated client with a low ceiling, mirroring `errors.e2e.test.ts`'s "second client with a different env" pattern):

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

// ENG-556: a low COSMOS_MAX_GAS must abort a normal broadcast with GAS_LIMIT_EXCEEDED
// before signing. Uses its OWN client (the shared chain-tools client has no ceiling).
describe('gas-limit ceiling (COSMOS_MAX_GAS)', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect({
      serverEntry: 'packages/node/dist/chain.js',
      maxGas: '1', // any real tx simulates well above 1 gas
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('aborts cosmos_tx with GAS_LIMIT_EXCEEDED when the estimate exceeds the ceiling', async () => {
    const { address } = await client.callTool<{ address: string }>(
      'get_account_info',
    );

    const err = await client.callToolExpectError('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
      wait_for_confirmation: true,
    });

    expect(err.code).toBe('GAS_LIMIT_EXCEEDED');
    expect(err.tool).toBe('cosmos_tx');
    const details = err.details as { maxGas?: number; estimatedGas?: number };
    expect(details?.maxGas).toBe(1);
    expect(typeof details?.estimatedGas).toBe('number');
  });
});
```

- [ ] **Step 3: Build + run against devnet**

Run:
```bash
npm run build
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npx vitest run --config e2e/vitest.config.ts e2e/gas-ceiling.e2e.test.ts
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```
Expected: PASS — `err.code === 'GAS_LIMIT_EXCEEDED'`.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers/mcp-client.ts e2e/gas-ceiling.e2e.test.ts
git commit -F - <<'EOF'
test(e2e): prove COSMOS_MAX_GAS aborts a live broadcast (ENG-556)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 9: Full CI-matching gate + runtime verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full local gate (matches CI `ci.yml`)**

Run:
```bash
npm run build && \
npm run build -w @manifest-network/manifest-sdk && \
npm run lint && \
npm run check && \
npm run depcruise && \
npm test && \
npm run test:types -w @manifest-network/manifest-sdk && \
npm run size
```
Expected: ALL green. `lint` is the load-bearing one for the `TxOptions`/enum change — it must pass across ALL packages (a type ripple into a consumer package fails tsc while vitest passes). `size` and `depcruise` are CI-gating too (memory: *match-local-gate-to-full-CI-job*).

- [ ] **Step 2: Verify against built `dist` (not just src)**

Confirm the enum member and default are present in the built output:

Run:
```bash
grep -r "GAS_LIMIT_EXCEEDED" packages/core/dist/ | head -2
grep -r "50000000\|50_000_000\|DEFAULT_MAX_GAS" packages/core/dist/config.js
```
Expected: both found (the feature is in the shipped artifact, not just source).

- [ ] **Step 3: Runtime smoke of the ceiling (drive the real seam)**

Prove the clamp fires through the real `buildGasFee` in the built artifact with a scripted mock client (no chain needed):

Run:
```bash
node --input-type=module -e "
import { buildGasFee } from './packages/core/dist/transactions/utils.js';
const client = { simulate: async () => 40000000 }; // 40M * 1.5 = 60M
try {
  await buildGasFee(client, 'manifest1x', [{ typeUrl: '/x', value: {} }], { gasMultiplier: 1.5, gasPrice: '0.025umfx', maxGas: 50000000 });
  console.error('FAIL: expected throw'); process.exit(1);
} catch (e) {
  console.log('OK code=' + e.code + ' estimatedGas=' + e.details?.estimatedGas);
  if (e.code !== 'GAS_LIMIT_EXCEEDED') process.exit(1);
}
"
```
Expected: `OK code=GAS_LIMIT_EXCEEDED estimatedGas=60000000`.

- [ ] **Step 4: Confirm the working tree is clean and all tasks committed**

Run: `git status --short && git log --oneline main..HEAD`
Expected: clean tree; commits for Tasks 1-9 present.

- [ ] **Step 5: Push and open the PR**

Push under the Linear branch name so the PR auto-links, then open the PR (hand off merge to the user per convention — do NOT `gh pr merge`):

```bash
git push -u origin HEAD:felix/eng-556-core-no-absolute-feegas-ceiling-on-generic-tx-broadcast
gh pr create --fill --title "feat(core): absolute gas-limit ceiling on generic tx broadcast (ENG-556)"
```

---

## Verification Notes / Gotchas

- **Full-repo lint is mandatory.** `TxOptions` and `ManifestMCPErrorCode` reach the SDK root barrel via `export type *` (types) and an explicit value re-export (the enum). `publint`/`attw` do NOT diff the API surface, so a surface regression is caught only by `tsc` (`npm run lint`) + hand review. No api-report snapshot exists.
- **Behavior-preservation of the `'auto'` → explicit-fee move:** the resolved `gasMultiplier` (`override ?? config ?? DEFAULT_GAS_MULTIPLIER`) and `gasPrice` reproduce the fee cosmjs computed for `'auto'` (its `defaultGasMultiplier` is set to `config.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER` in `client.ts:420`) **up to rounding**: `buildGasFee` uses `Math.ceil`, cosmjs's `'auto'` uses `Math.round` (`@manifest-network/stargate` `signingstargateclient.js:176,197`). The default-path gas limit is therefore at most **1 gas unit** higher than before — negligible, strictly safer (never under-provisions), and it aligns the default path with the override path (which already used `ceil`). The only material new outcome is the abort. No unit test asserts an exact default-path fee value (the handler is mocked), so nothing regresses on this.
- **Do NOT modify** the explicit-fee (FEE-WINS) path or `cosmosEstimateFee`'s inline gas math (`cosmos.ts:405-412`). The estimate path stays uncapped (read-only preview) — a documented asymmetry, not a bug.
- **Query-only mode unchanged:** when `gasPrice` is unset, `cosmosTx`/`executeTx` leave `txOptions` undefined (no override) → `buildGasFee` returns `'auto'` → the broadcast still fails downstream at `getBroadcastClient` exactly as today.
- Run `npm install` + `npm run build` in this fresh worktree before cross-package tsc/vitest (memory: *worktree-needs-build-before-cross-package-tests*).
