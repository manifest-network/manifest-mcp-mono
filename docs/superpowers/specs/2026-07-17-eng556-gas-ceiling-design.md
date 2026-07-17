# ENG-556 — Absolute gas-limit ceiling on generic tx broadcast

**Date:** 2026-07-17
**Issue:** [ENG-556](https://linear.app/liftedinit/issue/ENG-556/core-no-absolute-feegas-ceiling-on-generic-tx-broadcast-cosmos-tx)
**Worktree:** `eng-556-gas-ceiling` off `main@853a886`.
**Severity:** Low (defense-in-depth) · **Source:** multi-agent security audit 2026-07-17.

## Summary

`packages/core/src/transactions/utils.ts` `buildGasFee` takes the node's `simulate()` gas estimate, multiplies it, and pays it as the fee **with no upper bound**. Every `routeXxxTransaction` and the chain server's `cosmos_tx` reach it, and `cosmos_tx` broadcasts **headlessly** (no elicitation — only the agent orchestrator surfaces fees to a human). A compromised/hostile `COSMOS_RPC_URL`, or a malicious `simulate` response, can inflate the estimate arbitrarily; `gasLimit × gasPrice` becomes the fee the wallet actually pays. Manifest mainnet has **`block.max_gas = -1`** — no on-chain cap — so a client-side ceiling is the *only* backstop.

Add an absolute **gas-limit ceiling** (`COSMOS_MAX_GAS`, default **50,000,000**) enforced in the single fee funnel: if `ceil(simulate × multiplier) > maxGas`, **abort before broadcast** (fail-closed) with a new `GAS_LIMIT_EXCEEDED` error. Scope is the ceiling only (fix candidate 1). Fee-surfacing on `cosmos_tx` (candidate 2) is already served, in spirit, by the orchestrated path's elicitation and is out of scope.

## The threat, precisely

`fee = gasLimit × gasPrice` where `gasLimit = ceil(simulate() × gasMultiplier)`. `gasPrice` and `gasMultiplier` are operator-configured (trusted). The **untrusted** input is `simulate()`, returned by the RPC. Bounding `gasLimit` bounds the fee. The chain will not reject an over-large gas tx (`max_gas = -1`), and `cosmos_tx` has no human in the loop, so nothing else bounds blast radius today.

## Closing the `'auto'` bypass (the crux)

`buildGasFee` computes the fee itself **only when a caller passes an explicit `gasMultiplier` override**. On the default `cosmos_tx` path (no override), `options` is `undefined`, `buildGasFee` returns `'auto'`, and cosmjs computes `simulate × defaultGasMultiplier` **internally** (via the private `defaultGasMultiplier` we set in `client.ts:418-420`). A clamp added only to `buildGasFee`'s override branch would be a **no-op for the exact path the issue is about**.

Fix: `cosmosTx` / `executeTx` **always resolve gas options** (on the non-explicit-fee path), and `buildGasFee` **always computes an explicit `StdFee`** instead of delegating `'auto'`. This is cosmjs's own documented pattern for bounding fees ([cosmjs#1134](https://github.com/cosmos/cosmjs/issues/1134): "manually simulate → compute `StdFee` → pass explicit fee instead of the auto flag"); the Telescope/Hyperweb "Calculating Fees" docs present manual `calculateFee` as a normal first-class pattern. We keep the **identical** `ceil(simulate × multiplier)` + `calculateFee(gasLimit, gasPrice)` math cosmjs's `'auto'` runs — only relocated so the ceiling can bite. Behavior-preserving except for the added abort.

## The change

| file | change |
|---|---|
| `packages/core/src/config.ts` | add `export const DEFAULT_MAX_GAS = 50_000_000;` (next to `DEFAULT_GAS_MULTIPLIER`). In `createConfig`: `maxGas: input.maxGas ?? DEFAULT_MAX_GAS`. In `validateConfig`: `maxGas`, when set, must be a non-negative integer (`0` = disabled — see Decisions). |
| `packages/core/src/types.ts` | `ManifestMCPConfig`: add `readonly maxGas?: number`. `TxOptions`: add `readonly maxGas: number` (resolved). `ManifestMCPErrorCode`: add `GAS_LIMIT_EXCEEDED = 'GAS_LIMIT_EXCEEDED'` under *Transaction errors*. |
| `packages/core/src/transactions/utils.ts` | `buildGasFee`: when `options` present, compute `gasLimit = ceil(simulate × options.gasMultiplier)`; if `options.maxGas > 0 && gasLimit > options.maxGas` → throw `GAS_LIMIT_EXCEEDED` with `{ simulatedGas, gasMultiplier, estimatedGas: gasLimit, maxGas }`; else `return calculateFee(gasLimit, options.gasPrice)`. When `options` absent → `return 'auto'` (unchanged legacy direct-call path). |
| `packages/core/src/cosmos.ts` | `cosmosTx`: on the **non-explicit-fee** path (`txExtras?.fee === undefined`), **always** build `txOptions = { gasMultiplier: overrides?.gasMultiplier ?? cfg.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER, gasPrice: cfg.gasPrice, maxGas: cfg.maxGas ?? DEFAULT_MAX_GAS }` **when `cfg.gasPrice` is set** (guaranteed on every real broadcast; absent only in query-only mode, which still fails at `getBroadcastClient` exactly as today). Preserve the existing fee-vs-gasMultiplier mutual-exclusion check and the "gasMultiplier override requires gasPrice" check. |
| `packages/core/src/tools/executeTx.ts` | mirror the same always-resolve logic for the multi-message path. |
| `packages/core/src/retry.ts` | add `GAS_LIMIT_EXCEEDED` to `NON_RETRYABLE_ERROR_CODES` — the broadcast `withRetry` loop must not retry a deterministic over-ceiling abort. |
| `packages/node/src/config.ts` | parse `COSMOS_MAX_GAS` (positive integer, or `0` = disabled; reuse the `COSMOS_GAS_MULTIPLIER` validation shape) → `EnvConfig.maxGas`. |
| `packages/node/src/bootstrap.ts` | thread `maxGas: env.maxGas` into the `createConfig` input. |
| `CLAUDE.md` | add `COSMOS_MAX_GAS` to the env-var table (default `50000000`, `0` = disabled); one architecture/conventions line on the ceiling + the `'auto'`-bypass closure. |

## Why 50,000,000 — empirical, from the YACI indexer

Queried `https://indexer.manifest.network/transactions_main` (`fee.gasLimit`, all indexed history):

| band | observation |
|---|---|
| all-time max `gasLimit` | **~12.5M** (three txs: 12,503,887 / 12,504,671 / 12,507,787). Nothing ≥ 100M exists. |
| next heaviest | ~7.88M, then a cluster ~6.27M |
| typical | ~200k wanted, ≤188k used |

- **10M would false-abort real traffic** (the ~12.5M txs) — ruled out.
- **50M = ~4× headroom** over the real high-water mark: clears all observed legitimate traffic (incl. heavy group `MsgExec`, which is unbounded in message count) while still bounding a hostile `simulate()` that could otherwise return billions. Operators running known-heavy batch workloads raise `COSMOS_MAX_GAS`; the ceiling is defense-in-depth, not a hard operational limit.

## Error signal

New `ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED` (additive, 15→16 codes — non-breaking). Chosen over `TX_FAILED` (implies an on-chain DeliverTx failure; this aborts *before* broadcast) and `INVALID_CONFIG` (this is a runtime estimate exceeding a valid config, not a static misconfig). Message tells the operator the estimate, the ceiling, and that a legitimate heavy tx can raise `COSMOS_MAX_GAS`. Classified **non-retryable** (`retry.ts`) and **not** infrastructure (`server-utils.ts` `INFRASTRUCTURE_ERROR_CODES` unchanged).

## Decisions — settled

- **Gas-limit ceiling, not fee-amount.** Denom-free; `simulate()` (gas units) is the untrusted input while `gasPrice` is trusted, so a gas cap is the tightest fit and equals a fee cap up to the trusted constant. Matches the Cosmos "reasonable maximum gas limit" best practice.
- **Fail-closed (abort), not clamp-down.** Clamping gas *down* under-provisions → on-chain out-of-gas → the (reduced) fee is still burned on a failed tx. Refusing to broadcast is the security-correct behavior.
- **`0` = disabled escape hatch.** `COSMOS_MAX_GAS=0` turns the clamp off for operators who knowingly accept the unbounded-fee exposure (mirrors `MANIFEST_FRED_FETCH_GUARDED=0`). Default stays 50M / on. Documented as reintroducing the exposure.
- **Always-explicit-fee restructuring is idiomatic** (cosmjs#1134 pattern), not a workaround.

## Scope boundaries — explicit non-goals

- **Fee-surfacing / elicitation on `cosmos_tx`** (candidate 2) — the orchestrated path already surfaces fees to a human; bolting elicitation onto the raw headless escape hatch is a separate, larger protocol/UX change.
- **Explicit-fee path** (`billing.ts` FEE-WINS, `txExtras.fee`) — caller-provided and trusted; not clamped.
- **`cosmos_estimate_fee`** — read-only, no spend; stays non-throwing. (A hostile RPC inflates the preview number, but no fee is paid.)
- **Raw `routeXxxTransaction` called directly by a library consumer with no `options`** — keeps legacy `'auto'`; the clamp is guaranteed on the `cosmosTx` / `executeTx` broadcast surfaces, which is what `cosmos_tx` and the SDK's `/chain` `cosmosTx` use. Documented limitation, not a gap in the stated threat (which is `cosmos_tx`).

## Testing / verification

- **`buildGasFee` (unit):** throws `GAS_LIMIT_EXCEEDED` with correct metadata when `ceil(simulate×mult) > maxGas`; returns `calculateFee(...)` when `≤`; `maxGas: 0` disables the clamp; `options` absent still returns `'auto'`; **fee-parity** assertion that the computed `StdFee` equals what the old `'auto'` path produced for the same simulate/multiplier/gasPrice.
- **`cosmosTx` (unit):** default path (no override) now resolves `txOptions` and produces an explicit fee; mutual-exclusion and query-only error semantics preserved; over-ceiling estimate aborts and is **not retried** (retry-classification test).
- **`config` (unit):** `createConfig` applies `DEFAULT_MAX_GAS`; `validateConfig` rejects negative / non-integer `maxGas`, accepts `0`.
- **node `config` (unit):** `COSMOS_MAX_GAS` parse + validation (positive int / `0` / invalid).
- **Gate:** `npm run build`/`lint`/`test`/`check`/`size`/`depcruise` green (full repo — a core type/enum change ripples into consumer packages; `size` + `depcruise` are CI-gating).
- **E2E (optional):** set `COSMOS_MAX_GAS` low in one e2e and assert a normal tx aborts with `GAS_LIMIT_EXCEEDED`, proving the clamp fires end-to-end against a live chain.

## Breaking change

None to the API surface. The `GAS_LIMIT_EXCEEDED` enum member is additive. The `'auto'`→explicit-fee restructuring is behavior-preserving (identical math). The one observable behavior change is that a legitimate tx whose estimate exceeds **50M** now aborts instead of broadcasting — intentional, 4× above the observed real max, and configurable (`COSMOS_MAX_GAS`, or `0` to disable). Ships as a minor.
