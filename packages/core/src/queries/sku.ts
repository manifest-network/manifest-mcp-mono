import { ManifestQueryClient } from '../client.js';
import {
  SkuParamsResult, ProviderResult, ProvidersResult,
  SkuResult, SkusResult
} from '../types.js';
import { requireArgs, extractPaginationArgs, extractBooleanFlag } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** SKU query result union type */
type SkuQueryResult =
  | SkuParamsResult
  | ProviderResult
  | ProvidersResult
  | SkuResult
  | SkusResult;

/**
 * Route SKU module query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 * Filterable queries support --active-only flag
 */
export async function routeSkuQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<SkuQueryResult> {
  const sku = queryClient.liftedinit.sku.v1;

  switch (subcommand) {
    case 'params': {
      const result = await sku.params({});
      return { params: result.params };
    }

    case 'provider': {
      requireArgs(args, 1, ['provider-uuid'], 'sku provider');
      const [uuid] = args;
      const result = await sku.provider({ uuid });
      return { provider: result.provider };
    }

    case 'providers': {
      const { value: activeOnly, remainingArgs: afterBool } = extractBooleanFlag(args, '--active-only');
      const { pagination } = extractPaginationArgs(afterBool, 'sku providers');
      const result = await sku.providers({ pagination, activeOnly });
      return { providers: result.providers, pagination: result.pagination };
    }

    case 'sku': {
      requireArgs(args, 1, ['sku-uuid'], 'sku sku');
      const [uuid] = args;
      const result = await sku.sKU({ uuid });
      return { sku: result.sku };
    }

    case 'skus': {
      const { value: activeOnly, remainingArgs: afterBool } = extractBooleanFlag(args, '--active-only');
      const { pagination } = extractPaginationArgs(afterBool, 'sku skus');
      const result = await sku.sKUs({ pagination, activeOnly });
      return { skus: result.skus, pagination: result.pagination };
    }

    case 'skus-by-provider': {
      const { value: activeOnly, remainingArgs: afterBool } = extractBooleanFlag(args, '--active-only');
      const { pagination, remainingArgs } = extractPaginationArgs(afterBool, 'sku skus-by-provider');
      requireArgs(remainingArgs, 1, ['provider-uuid'], 'sku skus-by-provider');
      const [providerUuid] = remainingArgs;
      const result = await sku.sKUsByProvider({ providerUuid, pagination, activeOnly });
      return { skus: result.skus, pagination: result.pagination };
    }

    case 'provider-by-address': {
      const { value: activeOnly, remainingArgs: afterBool } = extractBooleanFlag(args, '--active-only');
      const { pagination, remainingArgs } = extractPaginationArgs(afterBool, 'sku provider-by-address');
      requireArgs(remainingArgs, 1, ['address'], 'sku provider-by-address');
      const [address] = remainingArgs;
      const result = await sku.providerByAddress({ address, pagination, activeOnly });
      return { providers: result.providers, pagination: result.pagination };
    }

    default:
      throwUnsupportedSubcommand('query', 'sku', subcommand);
  }
}
