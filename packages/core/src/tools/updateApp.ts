import type { AppRegistry } from '../registry.js';
import { updateLease } from '../http/fred.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

export async function updateApp(
  address: string,
  appName: string,
  appRegistry: AppRegistry,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  updates: { image?: string; port?: number; env?: Record<string, string> },
) {
  const app = appRegistry.getApp(address, appName);

  if (!app.providerUrl) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `App "${appName}" has no provider URL`,
    );
  }

  // Parse existing manifest or start fresh
  let manifest: Record<string, unknown> = {};
  if (app.manifest) {
    try {
      manifest = JSON.parse(app.manifest);
    } catch (err) {
      console.warn('Invalid stored manifest, starting fresh:', err instanceof Error ? err.message : err);
    }
  }

  // Merge updates
  if (updates.image !== undefined) {
    manifest.image = updates.image;
  }
  if (updates.port !== undefined) {
    manifest.ports = { [`${updates.port}/tcp`]: {} };
  }
  if (updates.env !== undefined) {
    manifest.env = updates.env;
  }

  const manifestJson = JSON.stringify(manifest);

  const authToken = await getAuthToken(address, app.leaseUuid);
  const result = await updateLease(app.providerUrl, app.leaseUuid, manifestJson, authToken);

  appRegistry.updateApp(address, app.leaseUuid, { manifest: manifestJson });

  return {
    app_name: app.name,
    status: result.status,
  };
}
