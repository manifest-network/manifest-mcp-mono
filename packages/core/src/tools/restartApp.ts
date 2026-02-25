import type { AppRegistry } from '../registry.js';
import { restartLease } from '../http/fred.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

export async function restartApp(
  address: string,
  appName: string,
  appRegistry: AppRegistry,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  const app = appRegistry.getApp(address, appName);

  if (!app.providerUrl) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `App "${appName}" has no provider URL`,
    );
  }

  const authToken = await getAuthToken(address, app.leaseUuid);
  const result = await restartLease(app.providerUrl, app.leaseUuid, authToken);

  return {
    app_name: app.name,
    status: result.status,
  };
}
