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
      // The connection endpoint enforces replay protection (status does not),
      // but we generate separate tokens for both to keep each request
      // independently authenticated.
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

    function handleRejection(label: string, reason: unknown): string {
      const rawMsg = reason instanceof Error ? reason.message : String(reason);
      logger.error(
        `[app_status] Failed to get ${label} for ${leaseUuid}: ${rawMsg}`,
      );
      return sanitizeForLogging(rawMsg) as string;
    }

    if (statusResult.status === 'fulfilled') {
      fredStatus = statusResult.value;
    } else {
      providerError = handleRejection('lease status', statusResult.reason);
    }

    if (connResult.status === 'fulfilled') {
      connection = connResult.value.connection;
    } else {
      connectionError = handleRejection('connection info', connResult.reason);
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
