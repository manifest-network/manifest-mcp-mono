import type { ReadCtx } from '../ctx.js';
import { isNotFoundError } from '../internals/classify-query-error.js';
import { withReadSignal } from '../internals/read-signal.js';
import type { CallOptions } from '../options.js';

function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((err: unknown) => {
    // Keyed on the structured code, NOT message text. Pre-ENG-536 this rethrew
    // EVERY ManifestMCPError, and the LCD adapter wraps 404s into exactly that —
    // so this guard was dead code over REST and the regexes below never ran.
    // Real not-found messages also vary by keeper ("no lease with custom_domain X"
    // contains no "not found" at all).
    if (isNotFoundError(err)) return null;
    throw err;
  });
}

/**
 * Read an account's full funding picture in one call: its bank balances, its
 * billing credit account, and the credit estimate.
 *
 * This is a **composed** read, which is why it earns a typed wrapper rather
 * than being reached through `client.query`: it fans out to three chain queries
 * under a single abort signal and rate-limit acquisition, and it applies
 * not-found semantics that the raw wire calls do not. A tenant with no credit
 * account is a normal state, not an error — `creditAccount` and
 * `creditEstimate` are caught and folded to `null` rather than propagating, so
 * a brand-new address returns balances with `credits: null` instead of
 * throwing. The individual 1:1 queries underneath it are deliberately *not*
 * re-exported (ENG-537).
 *
 * @param ctx     read ctx — query client, rate limiter, retry policy
 * @param address bech32 account address to read
 * @param opts    `signal` / `timeout`; the deadline covers all three queries
 * @public
 */
export async function getBalance(
  ctx: ReadCtx,
  address: string,
  opts?: CallOptions,
) {
  const bank = ctx.query.cosmos.bank.v1beta1;
  const billing = ctx.query.liftedinit.billing.v1;

  const [balancesResult, creditResult, estimateResult] = await withReadSignal(
    ctx,
    () =>
      Promise.all([
        bank.allBalances({ address, resolveDenom: false }),
        catchNotFound(billing.creditAccount({ tenant: address })),
        catchNotFound(billing.creditEstimate({ tenant: address })),
      ]),
    opts,
  );

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
        balances: creditResult.balances.map((c) => ({
          denom: c.denom,
          amount: c.amount,
        })),
        available_balances: creditResult.availableBalances.map((c) => ({
          denom: c.denom,
          amount: c.amount,
        })),
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
      current_balance: estimate.current_balance,
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
