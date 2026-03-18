import type { ManifestQueryClient } from '../client.js';
import { ManifestMCPError } from '../types.js';

function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    // Never suppress structured infrastructure errors
    if (err instanceof ManifestMCPError) throw err;
    if (!(err instanceof Error)) throw err;
    const msg = err.message;
    // Match Cosmos SDK / gRPC NOT_FOUND patterns (key not found, account not found, etc.)
    if (
      /key not found/i.test(msg) ||
      /account.*not found/i.test(msg) ||
      /credit.*not found/i.test(msg)
    ) {
      return null;
    }
    throw err;
  });
}

export async function getBalance(
  queryClient: ManifestQueryClient,
  address: string,
) {
  const bank = queryClient.cosmos.bank.v1beta1;
  const billing = queryClient.liftedinit.billing.v1;

  const [balancesResult, creditResult, estimateResult] = await Promise.all([
    bank.allBalances({ address, resolveDenom: false }),
    catchNotFound(billing.creditAccount({ tenant: address })),
    catchNotFound(billing.creditEstimate({ tenant: address })),
  ]);

  const credits = creditResult?.creditAccount
    ? {
        active_leases: creditResult.creditAccount.activeLeaseCount.toString(),
        pending_leases: creditResult.creditAccount.pendingLeaseCount.toString(),
        reserved_amounts: creditResult.creditAccount.reservedAmounts.map(
          (c) => ({
            denom: c.denom,
            amount: c.amount,
          }),
        ),
      }
    : null;

  const estimate = estimateResult
    ? {
        current_balance: estimateResult.currentBalance.map((c) => ({
          denom: c.denom,
          amount: c.amount,
        })),
        spending_per_hour: estimateResult.totalRatePerSecond.map((c) => ({
          denom: c.denom,
          amount: (BigInt(c.amount) * 3600n).toString(),
        })),
        hours_remaining:
          estimateResult.estimatedDurationSeconds > 0n
            ? (Number(estimateResult.estimatedDurationSeconds) / 3600).toFixed(
                1,
              )
            : '0',
        running_apps: estimateResult.activeLeaseCount.toString(),
      }
    : null;

  return {
    credits,
    ...(estimate && {
      spending_per_hour: estimate.spending_per_hour,
      hours_remaining: estimate.hours_remaining,
      running_apps: estimate.running_apps,
    }),
    balances: balancesResult.balances.map((c) => ({
      denom: c.denom,
      amount: c.amount,
    })),
  };
}
