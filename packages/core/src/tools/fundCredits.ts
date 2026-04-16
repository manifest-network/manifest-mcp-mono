import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { CosmosTxResult, TxOverrides } from '../types.js';

export interface FundCreditsResult extends CosmosTxResult {
  readonly sender: string;
  readonly tenant: string;
  readonly amount: string;
}

export async function fundCredits(
  clientManager: CosmosClientManager,
  amount: string,
  overrides?: TxOverrides,
  tenant?: string,
): Promise<FundCreditsResult> {
  const sender = await clientManager.getAddress();
  const recipient = tenant ?? sender;
  const result = await cosmosTx(
    clientManager,
    'billing',
    'fund-credit',
    [recipient, amount],
    true,
    overrides,
  );
  return {
    ...result,
    sender,
    tenant: recipient,
    amount,
  };
}
