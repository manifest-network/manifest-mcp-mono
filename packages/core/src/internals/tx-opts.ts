import type { StdFee } from '@cosmjs/stargate'; // type-only
import type { TxCallOptions } from '../options.js';
import type { TxOverrides } from '../types.js';

export function txOverridesFrom(opts?: TxCallOptions): TxOverrides | undefined {
  return opts?.gasMultiplier !== undefined
    ? { gasMultiplier: opts.gasMultiplier }
    : undefined;
}

export function txExtrasFrom(
  opts?: TxCallOptions,
): { fee?: StdFee; memo?: string } | undefined {
  // `{ fee: opts.fee, memo: opts.memo }` is sound because exactOptionalPropertyTypes is OFF (tsconfig.base.json)
  // and cosmosTx keys off `value !== undefined`, not key-presence; the explicit-undefined values are benign.
  return opts?.fee !== undefined || opts?.memo !== undefined
    ? { fee: opts.fee, memo: opts.memo }
    : undefined;
}
