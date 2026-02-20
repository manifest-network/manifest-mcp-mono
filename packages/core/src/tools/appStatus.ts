import type { ManifestQueryClient } from '../client.js';
import type { AppRegistry } from '../registry.js';
import { getLeaseStatus, type FredLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo, type LeaseConnectionInfo } from '../http/provider.js';

export async function appStatus(
  queryClient: ManifestQueryClient,
  address: string,
  appName: string,
  appRegistry: AppRegistry,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  const app = appRegistry.getApp(address, appName);
  const billing = queryClient.liftedinit.billing.v1;

  const leaseResult = await billing.lease({ leaseUuid: app.leaseUuid });
  const lease = leaseResult.lease;

  const chainState = lease
    ? {
        state: lease.state,
        providerUuid: lease.providerUuid,
        createdAt: lease.createdAt?.toISOString(),
        closedAt: lease.closedAt?.toISOString(),
      }
    : null;

  let fredStatus: FredLeaseStatus | null = null;
  let connection: LeaseConnectionInfo | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  // LeaseState: 1 = PENDING, 2 = ACTIVE
  if (app.providerUrl && lease && (lease.state === 1 || lease.state === 2)) {
    // Let auth errors propagate — they indicate wallet configuration problems
    const authToken = await getAuthToken(address, app.leaseUuid);

    try {
      fredStatus = await getLeaseStatus(app.providerUrl, app.leaseUuid, authToken);
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }

    try {
      connection = await getLeaseConnectionInfo(app.providerUrl, app.leaseUuid, authToken);
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    name: app.name,
    status: app.status,
    ...(app.url && { url: app.url }),
    ...(connection && { connection }),
    chainState,
    ...(fredStatus && { fredStatus }),
    ...(providerError && { providerError }),
    ...(connectionError && { connectionError }),
  };
}
