/**
 * Convert chain-side coin amounts (always in the smallest unit) into the
 * human-readable display the user actually wants to see — e.g.
 * `1800000 factory/.../upwr` → `1.8 PWR`, `0.057738 PWR` built from
 * `57738 factory/.../upwr`, etc.
 *
 * The denom → symbol mapping is sourced from a chain registry JSON file
 * (`{ feeTokens: [{ denom, symbol, ... }] }` — every token the chain
 * accepts as gas). Callers pass the chain-data file path and forward the
 * resulting `DenomMap` to whichever helper renders balances; this module
 * just reads, parses, and looks up.
 *
 * Conversion factor: cosmos convention is 6 decimals for `u`-prefixed
 * tokens (umfx, upwr — including factory-wrapped variants). Anything else
 * is rendered untouched (denom kept as-is, amount printed as integer)
 * because we can't safely guess its exponent.
 *
 * **Dynamic node-import discipline** (mirrors `guarded-fetch.ts` +
 * `save-manifest.ts`): the `node:fs` import is deferred to call time so
 * module load doesn't violate the package's `platform: 'neutral'` build
 * target. `loadChainDenomMap` is therefore async; consumers must
 * `await` the result. The other 3 exports (`humanizeCoin`,
 * `humanizeBalances`, `denomToSymbol`) remain pure-sync since they take
 * a pre-loaded `DenomMap` as input.
 *
 * Exports (all 4 preserved per qa-engineer's review pin — PR 2's internal
 * callers use a subset; PR 3 will surface the rest):
 *   - `loadChainDenomMap(chainDataFilePath?)` (ASYNC) — returns
 *     `Promise<DenomMap>`. Missing / unreadable path → no-op map
 *     (lookup always returns `null`). Read failures emit `console.warn`
 *     matching the connection.ts precedent from PR 1.
 *   - `humanizeCoin(amount, denom, denomMap)` — `"<amount> <symbol>"` or
 *     `"<amount> <denom>"` on unknown denom.
 *   - `humanizeBalances(coins, denomMap)` — joins multiple coins with
 *     `", "`. Empty array → `"(empty)"` literal.
 *   - `denomToSymbol(denom, denomMap)` — bare symbol or raw denom fallback.
 */

import type { DenomLookup, DenomMap } from '../types.js';

// Re-export the public types for convenience to existing internal consumers
// (this file's pre-PR-3 history exported DenomLookup + DenomMap directly).
// Public consumers should import from `@manifest-network/manifest-agent-core`
// (which re-exports `../types.js`); internal consumers can use either path.
export type { DenomLookup, DenomMap };

const KNOWN_EXPONENT = 6;

/**
 * No-op `DenomMap` for callers without chain-data context. All lookups
 * return `null`; `humanizeCoin` falls back to raw on-chain denoms.
 * Exported so synchronous decision functions (e.g. `evaluateReadiness`)
 * can default to it without needing to invoke the async loader.
 */
export const EMPTY_DENOM_MAP: DenomMap = { lookup: () => null, raw: null };

export async function loadChainDenomMap(
  chainDataFilePath?: string,
): Promise<DenomMap> {
  if (!chainDataFilePath) return EMPTY_DENOM_MAP;
  if (
    typeof process === 'undefined' ||
    typeof process.versions?.node !== 'string'
  ) {
    // Lazy node-only dep — refuse outside Node-like runtimes rather than
    // silently no-op'ing (which would hide a misconfiguration).
    throw new Error(
      'loadChainDenomMap: chainDataFilePath requires a Node.js runtime (node:fs unavailable in this environment)',
    );
  }
  let raw: unknown;
  try {
    const { readFileSync } = await import('node:fs');
    raw = JSON.parse(readFileSync(chainDataFilePath, 'utf8'));
  } catch (err) {
    // CJS parity: warn loudly when a path was passed but read/parse failed.
    // A corrupted chain file silently downgrades all balance/fee rendering to
    // raw chain denoms across the package, and the user only notices because
    // the DeploymentPlan looks weird ("0.000037 PWR" vs "37 upwr"). Matches
    // connection.ts's `console.warn` default established in PR 1.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `humanize-denom: failed to load ${chainDataFilePath}: ${message}; ` +
        `balances and fees will render with raw on-chain denoms.`,
    );
    return EMPTY_DENOM_MAP;
  }

  // Normalize the feeTokens list into a denom → { symbol, exponent } map.
  // Every Manifest fee token uses 6 decimals (the leading `u` is the micro
  // prefix). Tokens not in feeTokens are unknown to us; the fallback branch
  // in humanizeCoin handles them.
  const map = new Map<string, DenomLookup>();
  if (raw !== null && typeof raw === 'object') {
    const feeTokens = (raw as { feeTokens?: unknown }).feeTokens;
    if (Array.isArray(feeTokens)) {
      for (const t of feeTokens) {
        if (
          t !== null &&
          typeof t === 'object' &&
          typeof (t as { denom?: unknown }).denom === 'string' &&
          typeof (t as { symbol?: unknown }).symbol === 'string'
        ) {
          const token = t as { denom: string; symbol: string };
          map.set(token.denom, {
            symbol: token.symbol,
            exponent: KNOWN_EXPONENT,
          });
        }
      }
    }
  }

  return {
    lookup: (denom) => {
      if (typeof denom !== 'string') return null;
      return map.get(denom) ?? null;
    },
    raw,
  };
}

/**
 * Convert a smallest-unit amount string → human decimal string with up to
 * `exponent` decimals, trimming trailing zeros for readability. Uses BigInt
 * for the integer part so precision survives large balances; only the
 * fractional remainder is divided.
 *
 * Exported for unit testing of the scaling logic in isolation (mirrors the
 * CJS's `_fmtScaledAmount` test hook).
 */
export function _fmtScaledAmount(amount: string, exponent: number): string {
  let digits: bigint;
  try {
    digits = BigInt(amount);
  } catch {
    return String(amount);
  }
  const negative = digits < 0n;
  if (negative) digits = -digits;
  const divisor = 10n ** BigInt(exponent);
  const whole = digits / divisor;
  const frac = digits % divisor;
  const fracStr = frac.toString().padStart(exponent, '0').replace(/0+$/, '');
  let out = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  if (negative) out = `-${out}`;
  return out;
}

/**
 * Render a single coin as `"<amount> <symbol>"` (when the denom is in the
 * map) or `"<amount> <denom>"` verbatim (when unknown). Falls back to
 * `"<amount>"` only when `denom` is null/undefined.
 */
export function humanizeCoin(
  amount: string,
  denom: string | null | undefined,
  denomMap: DenomMap,
): string {
  if (denom === undefined || denom === null) return `${amount}`;
  const lookup = denomMap.lookup(denom);
  if (lookup) {
    return `${_fmtScaledAmount(amount, lookup.exponent)} ${lookup.symbol}`;
  }
  // Best-effort unknown-denom rendering — keep the raw denom so the user
  // can still identify it, and don't guess at scaling.
  return `${amount} ${denom}`;
}

/**
 * Join multiple coins with `", "` (space after comma). Empty array →
 * literal `"(empty)"` per CJS parity.
 */
export function humanizeBalances(
  balances: ReadonlyArray<{ denom?: string; amount?: string | null }> | unknown,
  denomMap: DenomMap,
): string {
  if (!Array.isArray(balances) || balances.length === 0) return '(empty)';
  return balances
    .map((b) => {
      const amount =
        b !== null && typeof b === 'object' && 'amount' in b && b.amount != null
          ? String(b.amount)
          : '0';
      const denom =
        b !== null && typeof b === 'object' && 'denom' in b
          ? (b.denom as string | null | undefined)
          : undefined;
      return humanizeCoin(amount, denom, denomMap);
    })
    .join(', ');
}

/**
 * Return the friendly symbol for a chain denom (`"umfx"` → `"MFX"`) via
 * the same lookup `humanizeCoin` uses. Falls back to the raw denom on
 * unknown input. Avoids the brittle pattern of formatting `"0 MFX"` and
 * string-splitting to recover `"MFX"`.
 */
export function denomToSymbol(
  denom: string | null | undefined,
  denomMap: DenomMap,
): string {
  if (!denom) return String(denom ?? '');
  const lookup = denomMap.lookup(denom);
  return lookup?.symbol ?? denom;
}
