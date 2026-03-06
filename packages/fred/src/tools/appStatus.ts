import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { getLeaseStatus, type FredLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo, type LeaseConnectionInfo } from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const INFRASTRUCTURE_ERROR_CODES = new Set([
  ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
  ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
  ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
  ManifestMCPErrorCode.INVALID_MNEMONIC,
  ManifestMCPErrorCode.INVALID_CONFIG,
  ManifestMCPErrorCode.CLIENT_NOT_INITIALIZED,
]);

export async function appStatus(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  fetchFn?: typeof globalThis.fetch,
) {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({ leaseUuid });

  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }

  const lease = leaseResult.lease;
  const chainState = {
    state: lease.state,
    providerUuid: lease.providerUuid,
    createdAt: lease.createdAt?.toISOString(),
    closedAt: lease.closedAt?.toISOString(),
  };

  let fredStatus: FredLeaseStatus | null = null;
  let connection: LeaseConnectionInfo | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  if (lease.state === LeaseState.LEASE_STATE_PENDING || lease.state === LeaseState.LEASE_STATE_ACTIVE) {
    let providerUrl: string;
    try {
      providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
    } catch (err) {
      if (err instanceof ManifestMCPError && INFRASTRUCTURE_ERROR_CODES.has(err.code)) throw err;
      return {
        lease_uuid: leaseUuid,
        chainState,
        providerError: `Could not resolve provider: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let authToken: string;
    try {
      authToken = await getAuthToken(address, leaseUuid);
    } catch (err) {
      if (err instanceof ManifestMCPError && INFRASTRUCTURE_ERROR_CODES.has(err.code)) throw err;
      return {
        lease_uuid: leaseUuid,
        chainState,
        providerError: `Auth token error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const [statusResult, connResult] = await Promise.allSettled([
      getLeaseStatus(providerUrl, leaseUuid, authToken, fetchFn),
      getLeaseConnectionInfo(providerUrl, leaseUuid, authToken, fetchFn),
    ]);

    if (statusResult.status === 'fulfilled') {
      fredStatus = statusResult.value;
    } else {
      providerError = statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason);
    }

    if (connResult.status === 'fulfilled') {
      connection = connResult.value;
    } else {
      connectionError = connResult.reason instanceof Error ? connResult.reason.message : String(connResult.reason);
    }
  }

  return {
    lease_uuid: leaseUuid,
    ...(connection && { connection }),
    chainState,
    ...(fredStatus && { fredStatus }),
    ...(providerError && { providerError }),
    ...(connectionError && { connectionError }),
  };
}
