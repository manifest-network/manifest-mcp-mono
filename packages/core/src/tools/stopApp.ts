import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { TxOverrides } from '../types.js';

export interface StopAppResult {
  readonly lease_uuid: string;
  readonly status: 'stopped';
  readonly transactionHash: string;
  readonly code: number;
}

export async function stopApp(
  clientManager: CosmosClientManager,
  leaseUuid: string,
  overrides?: TxOverrides,
): Promise<StopAppResult> {
  const result = await cosmosTx(
    clientManager,
    'billing',
    'close-lease',
    [leaseUuid],
    true,
    overrides,
  );

  return {
    lease_uuid: leaseUuid,
    status: 'stopped',
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
