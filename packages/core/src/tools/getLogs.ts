import type { AppRegistry } from '../registry.js';
import { getLeaseLogs } from '../http/fred.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const MAX_LOG_CHARS = 4000;

export async function getAppLogs(
  address: string,
  appName: string,
  appRegistry: AppRegistry,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  tail?: number,
) {
  const app = appRegistry.getApp(address, appName);

  if (!app.providerUrl) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `App "${appName}" has no provider URL`,
    );
  }

  const authToken = await getAuthToken(address, app.leaseUuid);
  const result = await getLeaseLogs(app.providerUrl, app.leaseUuid, authToken, tail);

  let truncated = false;
  const logs: Record<string, string> = {};
  let totalChars = 0;

  for (const [service, log] of Object.entries(result.logs)) {
    if (totalChars >= MAX_LOG_CHARS) {
      truncated = true;
      break;
    }
    const remaining = MAX_LOG_CHARS - totalChars;
    if (log.length > remaining) {
      logs[service] = log.slice(-remaining);
      truncated = true;
    } else {
      logs[service] = log;
    }
    totalChars += logs[service].length;
  }

  return {
    app_name: app.name,
    logs,
    truncated,
  };
}
