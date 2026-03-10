import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { MAX_PAGE_LIMIT } from '@manifest-network/manifest-mcp-core';
import { getProviderHealth, ProviderApiError } from '../http/provider.js';

export async function browseCatalog(queryClient: ManifestQueryClient) {
  const sku = queryClient.liftedinit.sku.v1;

  const pagination = {
    key: new Uint8Array(),
    offset: BigInt(0),
    limit: MAX_PAGE_LIMIT,
    countTotal: false,
    reverse: false,
  };

  const [providersResult, skusResult] = await Promise.all([
    sku.providers({ activeOnly: true, pagination }),
    sku.sKUs({ activeOnly: true, pagination }),
  ]);

  const providers = await Promise.all(
    providersResult.providers.map(async (p) => {
      let healthy = false;
      let providerUuid: string | undefined;
      let healthError: string | undefined;
      try {
        const health = await getProviderHealth(p.apiUrl);
        healthy = health.status === 'ok' || health.status === 'healthy';
        providerUuid = health.provider_uuid;
      } catch (err) {
        if (err instanceof ProviderApiError) {
          healthError = `HTTP ${err.status}: ${err.message}`;
        } else {
          healthError = `Health check failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return {
        uuid: p.uuid,
        address: p.address,
        apiUrl: p.apiUrl,
        active: p.active,
        healthy,
        providerUuid,
        ...(healthError && { healthError }),
      };
    }),
  );

  const providerByUuid = new Map(
    providersResult.providers.map((p) => [p.uuid, p]),
  );

  const tiers: Record<string, Array<{ provider: string; price: string | null; unit: string | null }>> = {};
  for (const s of skusResult.skus) {
    const provider = providerByUuid.get(s.providerUuid);
    const entry = {
      provider: provider?.apiUrl ?? s.providerUuid,
      price: s.basePrice?.amount ?? null,
      unit: s.basePrice?.denom ?? null,
    };
    if (!tiers[s.name]) {
      tiers[s.name] = [];
    }
    tiers[s.name].push(entry);
  }

  return { providers, tiers };
}
