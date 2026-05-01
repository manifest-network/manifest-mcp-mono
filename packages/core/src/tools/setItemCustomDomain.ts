import type { CosmosClientManager } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import type { TxOverrides } from '../types.js';

export interface SetItemCustomDomainOptions {
  readonly serviceName?: string;
  readonly clear?: boolean;
}

export interface SetItemCustomDomainResult {
  readonly lease_uuid: string;
  readonly service_name: string;
  readonly custom_domain: string;
  readonly transactionHash: string;
  readonly code: number;
}

export async function setItemCustomDomain(
  clientManager: CosmosClientManager,
  leaseUuid: string,
  customDomain: string,
  options?: SetItemCustomDomainOptions,
  overrides?: TxOverrides,
): Promise<SetItemCustomDomainResult> {
  const clearing = options?.clear === true;
  const args: string[] = [leaseUuid];
  if (clearing) {
    args.push('--clear');
  } else {
    args.push(customDomain);
  }
  if (options?.serviceName) {
    args.push('--service-name', options.serviceName);
  }

  const result = await cosmosTx(
    clientManager,
    'billing',
    'set-item-custom-domain',
    args,
    true,
    overrides,
  );

  return {
    lease_uuid: leaseUuid,
    service_name: options?.serviceName ?? '',
    custom_domain: clearing ? '' : customDomain,
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
