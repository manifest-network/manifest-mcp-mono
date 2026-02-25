import type { CosmosClientManager } from '../client.js';
import type { AppRegistry } from '../registry.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

export async function stopApp(
  clientManager: CosmosClientManager,
  address: string,
  appName: string,
  appRegistry: AppRegistry,
) {
  const app = appRegistry.getApp(address, appName);

  const result = await cosmosTx(
    clientManager,
    'billing',
    'close-lease',
    [app.leaseUuid],
    true,
  );

  if (result.code !== 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Close lease failed with code ${result.code}`,
      { rawLog: result.rawLog },
    );
  }

  appRegistry.updateApp(address, app.leaseUuid, { status: 'stopped' });

  return {
    app_name: app.name,
    status: 'stopped',
    transactionHash: result.transactionHash,
    code: result.code,
  };
}
