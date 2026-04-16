import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { TxOverrides } from '../types.js';

export interface FundCreditsResult {
  readonly sender: string;
  readonly tenant: string;
  readonly amount: string;
  readonly transactionHash: string;
  readonly code: number;
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
    sender,
    tenant: recipient,
    amount,
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
