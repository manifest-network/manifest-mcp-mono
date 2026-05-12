import type { FeeEstimate } from '../types.js';
import {
  type DenomMap,
  humanizeBalances,
  humanizeCoin,
  loadChainDenomMap,
} from './humanize-denom.js';

/**
 * Convert a `cosmos_estimate_fee` (or `cosmos_tx`) fee response into the
 * frozen `FeeEstimate` shape.
 *
 * Port of `manifest-agent-plugin/scripts/humanize-fee.cjs` adapted to the
 * typed `FeeEstimate` contract from ENG-128. The plugin's CJS script emits
 * a bare human-readable string (e.g. `"0.0023 MFX"` or
 * `"0.0023 MFX, 100 upwr"` for multi-coin); this TS port returns the
 * structured `FeeEstimate` so PR 3's `render-deployment-plan.ts` can place
 * the same rendered string verbatim into `FeeEstimate.human` AND callers
 * can route the typed primary-coin `amount`/`denom` fields for non-display
 * use.
 *
 * `amount` + `denom` (singular fields) carry the FIRST coin from the
 * `amount` array — the cosmos convention is single-denom fees, so multi-
 * coin fee responses are rare in practice; the `human` field always
 * captures the full multi-coin string. Empty array → `amount: '0'`,
 * `denom: ''`, `human: '(empty)'` (CJS-parity for the human field).
 *
 * If both `opts.chainDataFile` and `opts.denomMap` are provided, the
 * pre-loaded `denomMap` wins (no double-load). If neither is provided,
 * the no-op map is used — rendering falls back to raw on-chain denoms.
 */

/** Multi-coin fee input shape. Wire-stable across chain versions. */
export interface FeeInput {
  /** Gas estimated/used for the transaction. */
  gasUsed: number;
  /** Fee amounts as `{denom, amount}` coin objects. May be empty. */
  amount: ReadonlyArray<{ denom: string; amount: string }>;
}

export interface HumanizeFeeOptions {
  /** Path to `$MANIFEST_PLUGIN_DATA/chains/<chain>.json`. Used only when `denomMap` is not supplied. */
  chainDataFile?: string;
  /** Pre-loaded denom map. Wins over `chainDataFile` when both are provided. */
  denomMap?: DenomMap;
}

export function humanizeFee(
  fee: FeeInput,
  opts: HumanizeFeeOptions = {},
): FeeEstimate {
  const denomMap = opts.denomMap ?? loadChainDenomMap(opts.chainDataFile);

  const human = humanizeBalances(fee.amount, denomMap);

  // Singular amount/denom carry the first coin (typical single-denom case).
  // Empty array uses '0' + '' so downstream consumers can rely on the
  // fields being present without an optional-chain dance.
  const first = fee.amount[0];
  if (first === undefined) {
    return {
      amount: '0',
      denom: '',
      gas: fee.gasUsed,
      human,
    };
  }
  // For the singular `amount` field, render the human-scaled representation
  // of the first coin so consumers don't have to re-scale. Matches the
  // semantic of the human field: a single decimal string in the friendly
  // denom (or raw `amount denom` for unknown denoms).
  const singularHuman = humanizeCoin(first.amount, first.denom, denomMap);
  return {
    amount: singularHuman,
    denom: first.denom,
    gas: fee.gasUsed,
    human,
  };
}
