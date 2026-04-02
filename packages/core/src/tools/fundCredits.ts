import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { CosmosTxResult, TxOverrides } from '../types.js';

export async function fundCredits(
  clientManager: CosmosClientManager,
  amount: string,
  overrides?: TxOverrides,
): Promise<CosmosTxResult> {
  const address = await clientManager.getAddress();
  return cosmosTx(
    clientManager,
    'billing',
    'fund-credit',
    [address, amount],
    true,
    overrides,
  );
}
