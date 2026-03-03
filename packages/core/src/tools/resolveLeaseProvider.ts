import type { ManifestQueryClient } from '../client.js';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

export interface LeaseProviderInfo {
  readonly providerUuid: string;
  readonly providerUrl: string;
  readonly leaseState: LeaseState;
  readonly leaseCreatedAt?: string;
  readonly leaseClosedAt?: string;
}

/**
 * Resolve the provider API URL for a given lease UUID by querying the chain.
 *
 * Chain path: billing.lease({leaseUuid}) → providerUuid
 *             → sku.v1.provider({uuid: providerUuid}) → apiUrl
 */
export async function resolveLeaseProvider(
  queryClient: ManifestQueryClient,
  leaseUuid: string,
): Promise<LeaseProviderInfo> {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({ leaseUuid });

  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }

  const lease = leaseResult.lease;

  if (!lease.providerUuid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" has no provider UUID`,
    );
  }

  const providerResult = await queryClient.liftedinit.sku.v1.provider({
    uuid: lease.providerUuid,
  });

  if (!providerResult.provider?.apiUrl) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Provider "${lease.providerUuid}" has no API URL`,
    );
  }

  return {
    providerUuid: lease.providerUuid,
    providerUrl: providerResult.provider.apiUrl,
    leaseState: lease.state,
    leaseCreatedAt: lease.createdAt?.toISOString(),
    leaseClosedAt: lease.closedAt?.toISOString(),
  };
}
