import type { LeaseUuid } from '../brands.js';
import { cosmosTx } from '../cosmos.js';
import type { TxCtx } from '../ctx.js';
import { withTxConfirmation } from '../internals/tx-confirmation.js';
import { txExtrasFrom, txOverridesFrom } from '../internals/tx-opts.js';
import type { TxCallOptions } from '../options.js';

export interface StopAppResult {
  readonly lease_uuid: LeaseUuid;
  readonly status: 'stopped';
  readonly transactionHash: string;
  readonly code: number;
}

export async function stopApp(
  ctx: TxCtx,
  input: { leaseUuid: LeaseUuid },
  opts?: TxCallOptions,
): Promise<StopAppResult> {
  // NO requireAuthSigner: the wallet is on ctx.chain (not ctx.signer, which is unset here); the query-only
  // INVALID_CONFIG guard is provided downstream by cosmosTx → ctx.chain.getSigningClient(). See OI-SENDER.
  const result = await withTxConfirmation(
    () =>
      cosmosTx(
        ctx.chain,
        'billing',
        'close-lease',
        [input.leaseUuid],
        true,
        txOverridesFrom(opts),
        txExtrasFrom(opts),
      ),
    opts,
  );

  return {
    lease_uuid: input.leaseUuid,
    status: 'stopped',
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
