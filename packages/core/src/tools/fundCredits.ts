import { type Address, asAddress } from '../brands.js';
import { cosmosTx } from '../cosmos.js';
import type { TxCtx } from '../ctx.js';
import { withTxExecution } from '../internals/tx-confirmation.js';
import { txExtrasFrom, txOverridesFrom } from '../internals/tx-opts.js';
import { resolveCallSignal, type TxCallOptions } from '../options.js';
import type { CosmosTxResult } from '../types.js';

export interface FundCreditsResult extends CosmosTxResult {
  readonly sender: Address;
  readonly tenant: Address;
  readonly amount: string;
}

export async function fundCredits(
  ctx: TxCtx,
  input: { amount: string; tenant?: Address },
  opts?: TxCallOptions,
): Promise<FundCreditsResult> {
  // NO requireAuthSigner: the wallet is on ctx.chain (not ctx.signer, which is unset here); the query-only
  // INVALID_CONFIG guard is provided downstream by cosmosTx → ctx.chain.getSigningClient(). See OI-SENDER.
  const callOptions = { signal: resolveCallSignal(opts) };
  const sender = await withTxExecution(async (execution) => {
    const address = asAddress(await ctx.chain.getAddress());
    execution.checkpoint();
    return address;
  }, callOptions);
  const recipient = input.tenant ?? sender;
  const result = await cosmosTx(
    ctx.chain,
    'billing',
    'fund-credit',
    [recipient, input.amount],
    opts?.waitForConfirmation ?? true,
    txOverridesFrom(opts),
    txExtrasFrom(opts),
    callOptions,
  );
  return { ...result, sender, tenant: recipient, amount: input.amount };
}
