import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';

export interface StopAppResult {
  readonly lease_uuid: string;
  readonly status: 'stopped';
  readonly transactionHash: string;
  readonly code: number;
}

export async function stopApp(
  clientManager: CosmosClientManager,
  leaseUuid: string,
): Promise<StopAppResult> {
  const result = await cosmosTx(
    clientManager,
    'billing',
    'close-lease',
    [leaseUuid],
    true,
  );

  return {
    lease_uuid: leaseUuid,
    status: 'stopped',
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
