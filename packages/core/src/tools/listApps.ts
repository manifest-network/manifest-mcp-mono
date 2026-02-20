import type { ManifestQueryClient } from '../client.js';
import type { AppRegistry } from '../registry.js';

export async function listApps(
  queryClient: ManifestQueryClient,
  address: string,
  appRegistry: AppRegistry,
) {
  const billing = queryClient.liftedinit.billing.v1;

  // Fetch active (2) and pending (1) leases
  const [activeResult, pendingResult] = await Promise.all([
    billing.leasesByTenant({ tenant: address, stateFilter: 2 }),
    billing.leasesByTenant({ tenant: address, stateFilter: 1 }),
  ]);

  const activeLeaseUuids = new Set(activeResult.leases.map((l) => l.uuid));
  const pendingLeaseUuids = new Set(pendingResult.leases.map((l) => l.uuid));

  // Reconcile registry: mark apps whose leases are no longer active/pending as stopped
  const registeredApps = appRegistry.getApps(address);
  for (const app of registeredApps) {
    if (
      app.status !== 'stopped' &&
      !activeLeaseUuids.has(app.leaseUuid) &&
      !pendingLeaseUuids.has(app.leaseUuid)
    ) {
      appRegistry.updateApp(address, app.leaseUuid, { status: 'stopped' });
    }
  }

  // Merge chain leases with registry
  const allLeases = [...activeResult.leases, ...pendingResult.leases];
  for (const lease of allLeases) {
    const existing = appRegistry.getAppByLease(address, lease.uuid);
    if (!existing) {
      appRegistry.addApp(address, {
        name: lease.uuid.slice(0, 8),
        leaseUuid: lease.uuid,
        providerUuid: lease.providerUuid,
        createdAt: lease.createdAt?.toISOString(),
        status: activeLeaseUuids.has(lease.uuid) ? 'active' : 'pending',
      });
    } else {
      appRegistry.updateApp(address, lease.uuid, {
        status: activeLeaseUuids.has(lease.uuid) ? 'active' : 'pending',
      });
    }
  }

  const apps = appRegistry.getApps(address).map((app) => ({
    name: app.name,
    status: app.status,
    leaseUuid: app.leaseUuid,
    ...(app.size && { size: app.size }),
    ...(app.url && { url: app.url }),
    ...(app.createdAt && { created: app.createdAt }),
  }));

  return { apps, count: apps.length };
}
