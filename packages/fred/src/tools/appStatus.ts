import {
  INFRASTRUCTURE_ERROR_CODES,
  LeaseState,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestQueryClient,
  sanitizeForLogging,
} from '@manifest-network/manifest-mcp-core';
import { type FredLeaseStatus, getLeaseStatus } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
} from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function appStatus(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  fetchFn?: typeof globalThis.fetch,
) {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({
    leaseUuid,
  });

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
  let connection: ConnectionDetails | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  if (
    lease.state === LeaseState.LEASE_STATE_PENDING ||
    lease.state === LeaseState.LEASE_STATE_ACTIVE
  ) {
    let providerUrl: string;
    try {
      providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
    } catch (err) {
      if (
        err instanceof ManifestMCPError &&
        INFRASTRUCTURE_ERROR_CODES.has(err.code)
      )
        throw err;
      const rawMsg = `Could not resolve provider: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[app_status] ${rawMsg}`);
      return {
        lease_uuid: leaseUuid,
        chainState,
        providerError: sanitizeForLogging(rawMsg) as string,
      };
    }

    let statusToken: string;
    let connToken: string;
    try {
      // The connection endpoint checks replay; using separate tokens avoids
      // sharing a signature across concurrent requests.
      statusToken = await getAuthToken(address, leaseUuid);
      connToken = await getAuthToken(address, leaseUuid);
    } catch (err) {
      if (
        err instanceof ManifestMCPError &&
        INFRASTRUCTURE_ERROR_CODES.has(err.code)
      )
        throw err;
      const rawMsg = `Auth token error: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[app_status] ${rawMsg}`);
      return {
        lease_uuid: leaseUuid,
        chainState,
        providerError: sanitizeForLogging(rawMsg) as string,
      };
    }

    const [statusResult, connResult] = await Promise.allSettled([
      getLeaseStatus(providerUrl, leaseUuid, statusToken, fetchFn),
      getLeaseConnectionInfo(providerUrl, leaseUuid, connToken, fetchFn),
    ]);

    function rejectionMessage(reason: unknown): string {
      const raw = reason instanceof Error ? reason.message : String(reason);
      return sanitizeForLogging(raw) as string;
    }

    if (statusResult.status === 'fulfilled') {
      fredStatus = statusResult.value;
    } else {
      providerError = rejectionMessage(statusResult.reason);
      logger.error(
        `[app_status] Failed to get lease status for ${leaseUuid}: ${providerError}`,
      );
    }

    if (connResult.status === 'fulfilled') {
      connection = connResult.value.connection;
    } else {
      connectionError = rejectionMessage(connResult.reason);
      logger.error(
        `[app_status] Failed to get connection info for ${leaseUuid}: ${connectionError}`,
      );
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
