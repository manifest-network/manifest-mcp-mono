import {
  type CosmosClientManager,
  ManifestMCPError,
  ManifestMCPErrorCode,
  MAX_PAGE_LIMIT,
  createPagination,
} from '@manifest-network/manifest-mcp-core';

/**
 * Resolve a SKU-tier name (e.g. `'docker-micro'`, `'small'`) to its on-chain
 * UUID + the UUID of its publishing provider. Mirrors fred's internal
 * `findSkuUuid` helper at `packages/fred/src/tools/deployApp.ts:L62`.
 *
 * Used by `deploy-app.ts`'s pre-broadcast fee-estimation step (the
 * `cosmosEstimateFee('billing', 'create-lease', ...)` call needs the SKU
 * UUID as part of the item-arg string format `sku-uuid:quantity[:service-name]`).
 *
 * **Why duplicated (not imported from fred):** fred's `findSkuUuid` is an
 * internal helper, not re-exported from `packages/fred/src/index.ts`.
 * Per team-lead-2's Path 2 verdict (vs Path 1 export-from-fred), the
 * helper is duplicated here because:
 *
 *   1. Stateless query helper — zero cross-instance drift risk
 *      (unlike `AuthTimestampTracker` which has cross-call state).
 *   2. fred's barrel deliberately keeps this helper internal; making it
 *      public would be an architectural decision, not an oversight fix.
 *   3. The duplicated logic uses only already-exported core symbols
 *      (`createPagination`, `MAX_PAGE_LIMIT`, `ManifestMCPError`).
 *   4. Drift bounded by the shared `@manifest-network/manifestjs@2.4.1`
 *      proto pin — both fred and agent-core import the same SKU types.
 *
 * Throws `ManifestMCPError(QUERY_FAILED)` when no active SKU matches
 * the requested `size`. Error message includes the available SKU names
 * for caller-side debugging.
 */
export interface SkuResolution {
  /** On-chain SKU UUID. Used in `create-lease` item-arg construction. */
  readonly skuUuid: string;
  /** Publishing provider's UUID. Required by some downstream chain queries. */
  readonly providerUuid: string;
}

export async function findSkuUuid(
  clientManager: CosmosClientManager,
  size: string,
): Promise<SkuResolution> {
  const queryClient = await clientManager.getQueryClient();
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({
    activeOnly: true,
    pagination,
  });

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
