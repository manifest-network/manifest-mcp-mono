import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode, type CosmosTxResult } from '../types.js';

export async function fundCredits(
  clientManager: CosmosClientManager,
  amount: string,
): Promise<CosmosTxResult> {
  const address = await clientManager.getAddress();
  const result = await cosmosTx(clientManager, 'billing', 'fund-credit', [address, amount], true);

  if (result.code !== 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Fund credits failed with code ${result.code}`,
      { rawLog: result.rawLog },
    );
  }

  return result;
}
