import type { CosmosClientManager, ManifestQueryClient } from '../client.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode, type CosmosTxResult } from '../types.js';
import { uploadLeaseData, getLeaseConnectionInfo } from '../http/provider.js';
import { pollLeaseUntilReady } from '../http/fred.js';
import type { FredLeaseStatus } from '../http/fred.js';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(new Uint8Array(hashBuffer));
}

function extractLeaseUuid(txResult: CosmosTxResult): string {
  if (!txResult.events) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'No events in transaction result; cannot extract lease UUID',
    );
  }

  for (const event of txResult.events) {
    if (!event.type.includes('lease') && !event.type.includes('Lease')) continue;
    for (const attr of event.attributes) {
      if (attr.key === 'lease_uuid' || attr.key === 'uuid') {
        return attr.value.replace(/^"|"$/g, '');
      }
    }
  }

  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    'Could not find lease UUID in transaction events',
    { events: txResult.events as unknown as Record<string, unknown>[] },
  );
}

async function findSkuUuid(
  queryClient: ManifestQueryClient,
  size: string,
): Promise<{ skuUuid: string; providerUuid: string }> {
  const result = await queryClient.liftedinit.sku.v1.sKUs({ activeOnly: true });

  for (const sku of result.skus) {
    if (sku.name === size) {
      return { skuUuid: sku.uuid, providerUuid: sku.providerUuid };
    }
  }

  const available = result.skus.map((s) => s.name);
  throw new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `SKU tier "${size}" not found. Available: ${available.join(', ')}`,
  );
}

async function getProviderUrl(
  queryClient: ManifestQueryClient,
  providerUuid: string,
): Promise<string> {
  const result = await queryClient.liftedinit.sku.v1.provider({ uuid: providerUuid });
  if (!result.provider?.apiUrl) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Provider ${providerUuid} has no API URL`,
    );
  }
  return result.provider.apiUrl;
}

export interface DeployAppInput {
  image: string;
  port: number;
  size: string;
  env?: Record<string, string>;
}

export interface DeployAppResult {
  readonly lease_uuid: string;
  readonly provider_uuid: string;
  readonly provider_url: string;
  readonly status: string;
  readonly url?: string;
  readonly connection?: Record<string, unknown>;
  readonly connectionError?: string;
}

export async function deployApp(
  clientManager: CosmosClientManager,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  getLeaseDataAuthToken: (address: string, leaseUuid: string, metaHashHex: string) => Promise<string>,
  input: DeployAppInput,
): Promise<DeployAppResult> {
  const address = await clientManager.getAddress();
  const queryClient = await clientManager.getQueryClient();

  // 1. Build manifest
  const manifest: Record<string, unknown> = {
    image: input.image,
    ports: { [`${input.port}/tcp`]: {} },
  };
  if (input.env) {
    manifest.env = input.env;
  }
  const manifestJson = JSON.stringify(manifest);

  // 2. SHA-256 hash of manifest
  const metaHashHex = await sha256(manifestJson);

  // 3. Find matching SKU
  const { skuUuid, providerUuid } = await findSkuUuid(queryClient, input.size);

  // 4. Get provider URL
  const providerUrl = await getProviderUrl(queryClient, providerUuid);

  // 5. Create lease
  const txResult = await cosmosTx(
    clientManager,
    'billing',
    'create-lease',
    ['--meta-hash', metaHashHex, `${skuUuid}:1`],
    true,
  );

  // 6. Extract lease UUID
  const leaseUuid = extractLeaseUuid(txResult);

  // Steps 7-9 run after the lease is created on-chain. If any fail, include the
  // lease UUID in the error so the caller can close the orphaned lease.
  let status: FredLeaseStatus;
  try {
    // 7. Upload manifest with lease-data auth token
    const leaseDataToken = await getLeaseDataAuthToken(address, leaseUuid, metaHashHex);
    await uploadLeaseData(providerUrl, leaseUuid, manifestJson, leaseDataToken);

    // 8. Poll until ready (pass token factory so tokens refresh during long polls)
    status = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => getAuthToken(address, leaseUuid),
    );
  } catch (err) {
    // Preserve the original error code (e.g. WALLET_NOT_CONNECTED) so callers can
    // distinguish auth/config problems from transient deploy failures. For unknown
    // errors, use TX_FAILED which is non-retryable — retrying would create a duplicate lease.
    const code = err instanceof ManifestMCPError ? err.code : ManifestMCPErrorCode.TX_FAILED;
    const details = err instanceof ManifestMCPError
      ? { ...err.details, lease_uuid: leaseUuid, provider_uuid: providerUuid, provider_url: providerUrl }
      : { lease_uuid: leaseUuid, provider_uuid: providerUuid, provider_url: providerUrl };
    throw new ManifestMCPError(
      code,
      `Deploy partially succeeded: lease ${leaseUuid} was created but subsequent steps failed. ` +
      `Close this lease with stop_app if needed. Error: ${err instanceof Error ? err.message : String(err)}`,
      details,
    );
  }

  // 9. Get connection info (best-effort — surface the error but don't fail the deploy)
  let connection: Record<string, unknown> | undefined;
  let url: string | undefined;
  let connectionError: string | undefined;
  try {
    const authToken = await getAuthToken(address, leaseUuid);
    const connInfo = await getLeaseConnectionInfo(providerUrl, leaseUuid, authToken);
    connection = connInfo as unknown as Record<string, unknown>;
    if (connInfo.host && connInfo.ports) {
      const firstPort = Object.values(connInfo.ports)[0];
      if (firstPort) {
        url = `${connInfo.host}:${firstPort}`;
      }
    }
  } catch (err) {
    connectionError = err instanceof Error ? err.message : String(err);
  }

  return {
    lease_uuid: leaseUuid,
    provider_uuid: providerUuid,
    provider_url: providerUrl,
    status: status.status,
    ...(url && { url }),
    ...(connection && { connection }),
    ...(connectionError && { connectionError }),
  };
}
