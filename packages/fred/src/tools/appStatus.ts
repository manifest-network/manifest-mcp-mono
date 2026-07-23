import {
  INFRASTRUCTURE_ERROR_CODES,
  LeaseState,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  sanitizeForLogging,
} from '@manifest-network/manifest-mcp-core';
import type { FredAuthCtx } from '../ctx.js';
import { type FredLeaseStatus, getLeaseStatus } from '../http/fred.js';
import {
  type ConnectionDetails,
  getLeaseConnectionInfo,
} from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { sanitizeRetentionFields } from './sanitizeRetention.js';

export async function appStatus(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string },
) {
  const { address, leaseUuid } = input;
  const leaseResult = await ctx.query.liftedinit.billing.v1.lease({
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
    // Raw LeaseItem[] (per-service skuUuid/serviceName/customDomain), surfaced so
    // consumers can compute custom-domain assignments without a second getLease.
    // Consistent with the raw `state`/`providerUuid` above (ENG-489).
    // `?? []` runtime guard: a real lease always has items (protobuf repeated),
    // but partial fixtures may omit it — mirrors core `toBrandedLease` (tools/reads.ts)
    // + the handler's defensive `l.items?.map`. Guarantees consumers a real array.
    items: lease.items ?? [],
  };

  let fredStatus: FredLeaseStatus | null = null;
  let connection: ConnectionDetails | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  // ENG-600: query the provider for retention on CLOSED leases too (retained
  // volumes live only there). Connection info is meaningless for a non-running
  // lease, so it stays PENDING/ACTIVE-only.
  const st = lease.state;
  const wantsStatus =
    st === LeaseState.LEASE_STATE_PENDING ||
    st === LeaseState.LEASE_STATE_ACTIVE ||
    st === LeaseState.LEASE_STATE_CLOSED;
  const wantsConnection =
    st === LeaseState.LEASE_STATE_PENDING ||
    st === LeaseState.LEASE_STATE_ACTIVE;

  if (wantsStatus) {
    let providerUrl: string;
    try {
      providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
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
    let connToken: string | undefined;
    try {
      // Separate per-request tokens so each is independently authenticated. The
      // connection token is minted only when we actually query the connection.
      statusToken = await ctx.providerAuth.providerToken({
        address,
        leaseUuid,
      });
      if (wantsConnection) {
        connToken = await ctx.providerAuth.providerToken({
          address,
          leaseUuid,
        });
      }
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
      getLeaseStatus(
        providerUrl,
        leaseUuid,
        statusToken,
        ctx.fetch,
        undefined,
        ctx.allowLoopback,
      ),
      wantsConnection
        ? getLeaseConnectionInfo(
            providerUrl,
            leaseUuid,
            connToken as string,
            ctx.fetch,
            ctx.allowLoopback,
          )
        : Promise.resolve(null),
    ] as const);

    function handleRejection(label: string, reason: unknown): string {
      const rawMsg = reason instanceof Error ? reason.message : String(reason);
      logger.error(
        `[app_status] Failed to get ${label} for ${leaseUuid}: ${rawMsg}`,
      );
      return sanitizeForLogging(rawMsg) as string;
    }

    if (statusResult.status === 'fulfilled') {
      // Destructure `partition` OUT before the spread — fredStatus is a
      // looseObject, so a wholesale `...raw` would forward it to the model,
      // violating Decision 6. Sanitize the retention subset.
      const { partition: _partitionOmitted, ...rest } = statusResult.value;
      fredStatus = { ...rest, ...sanitizeRetentionFields(statusResult.value) };
    } else {
      providerError = handleRejection('lease status', statusResult.reason);
    }

    if (wantsConnection) {
      if (connResult.status === 'fulfilled') {
        connection = connResult.value?.connection ?? null;
      } else {
        connectionError = handleRejection('connection info', connResult.reason);
      }
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
