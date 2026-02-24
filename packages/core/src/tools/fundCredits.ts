import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { CosmosTxResult } from '../types.js';

export async function fundCredits(
  clientManager: CosmosClientManager,
  amount: string,
): Promise<CosmosTxResult> {
  const address = await clientManager.getAddress();
  return cosmosTx(clientManager, 'billing', 'fund-credit', [address, amount], true);
}
