import type { PlannedLeaseItem } from '../types.js';

/** Sum catalog prices exactly, preserving a known subtotal when some items are unpriced. */
export function summarizeRecurringCosts(items: readonly PlannedLeaseItem[]): {
  unit: 'hour' | 'day';
  totals: { denom: string; amount: bigint }[];
  unpricedItemCount: number;
} {
  // Hours convert exactly to days in integer base units; the reverse may round.
  const unit = items.some((item) => item.sku.billingUnit === 'day')
    ? 'day'
    : 'hour';
  const totals = new Map<string, bigint>();
  let unpricedItemCount = 0;
  for (const { sku, quantity } of items) {
    const { price, billingUnit } = sku;
    if (
      !price?.amount.match(/^\d+$/) ||
      !price.denom.trim() ||
      (billingUnit !== 'hour' && billingUnit !== 'day') ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      unpricedItemCount += 1;
      continue;
    }
    const multiplier = unit === 'day' && billingUnit === 'hour' ? 24n : 1n;
    const amount = BigInt(price.amount) * BigInt(quantity) * multiplier;
    totals.set(price.denom, (totals.get(price.denom) ?? 0n) + amount);
  }
  return {
    unit,
    totals: [...totals].map(([denom, amount]) => ({ denom, amount })),
    unpricedItemCount,
  };
}
