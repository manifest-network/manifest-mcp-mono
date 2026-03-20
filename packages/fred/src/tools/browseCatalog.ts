import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import {
  createPagination,
  INFRASTRUCTURE_ERROR_CODES,
  MAX_PAGE_LIMIT,
  ManifestMCPError,
} from '@manifest-network/manifest-mcp-core';
import { getProviderHealth, ProviderApiError } from '../http/provider.js';

/** Maximum concurrent outgoing health check requests to provider APIs */
const MAX_CONCURRENT_HEALTH_CHECKS = 5;

/**
 * Run an array of async functions with a concurrency limit.
 * Returns results in the same order as the input.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function browseCatalog(queryClient: ManifestQueryClient, fetchFn?: typeof globalThis.fetch) {
  const sku = queryClient.liftedinit.sku.v1;

  const pagination = createPagination(MAX_PAGE_LIMIT);

  const [providersResult, skusResult] = await Promise.all([
    sku.providers({ activeOnly: true, pagination }),
    sku.sKUs({ activeOnly: true, pagination }),
  ]);

  const providers = await mapWithConcurrency(
    providersResult.providers,
    MAX_CONCURRENT_HEALTH_CHECKS,
    async (p) => {
      let healthy = false;
      let providerUuid: string | undefined;
      let healthError: string | undefined;
      try {
        const health = await getProviderHealth(p.apiUrl, undefined, fetchFn);
        healthy = health.status === 'ok' || health.status === 'healthy';
        providerUuid = health.provider_uuid;
      } catch (err) {
        if (
          err instanceof ManifestMCPError &&
          INFRASTRUCTURE_ERROR_CODES.has(err.code)
        )
          throw err;
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
    },
  );

  const providerByUuid = new Map(
    providersResult.providers.map((p) => [p.uuid, p]),
  );

  const tiers: Record<
    string,
    Array<{ provider: string; price: string | null; unit: string | null }>
  > = {};
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
