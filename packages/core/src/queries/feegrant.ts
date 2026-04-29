import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  FeegrantAllowanceResult,
  FeegrantAllowancesResult,
} from '../types.js';
import { extractPaginationArgs, requireArgs } from './utils.js';

/** Feegrant query result union type */
type FeegrantQueryResult = FeegrantAllowanceResult | FeegrantAllowancesResult;

/**
 * Route feegrant query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeFeegrantQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<FeegrantQueryResult> {
  const feegrant = queryClient.cosmos.feegrant.v1beta1;

  switch (subcommand) {
    case 'allowance': {
      requireArgs(
        args,
        2,
        ['granter-address', 'grantee-address'],
        'feegrant allowance',
      );
      const [granter, grantee] = args;
      const result = await feegrant.allowance({ granter, grantee });
      return { allowance: result.allowance };
    }

    case 'allowances': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'feegrant allowances',
      );
      requireArgs(remainingArgs, 1, ['grantee-address'], 'feegrant allowances');
      const [grantee] = remainingArgs;
      const result = await feegrant.allowances({ grantee, pagination });
      return {
        allowances: result.allowances,
        pagination: result.pagination,
      };
    }

    case 'allowances-by-granter': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'feegrant allowances-by-granter',
      );
      requireArgs(
        remainingArgs,
        1,
        ['granter-address'],
        'feegrant allowances-by-granter',
      );
      const [granter] = remainingArgs;
      const result = await feegrant.allowancesByGranter({
        granter,
        pagination,
      });
      return {
        allowances: result.allowances,
        pagination: result.pagination,
      };
    }

    default:
      throwUnsupportedSubcommand('query', 'feegrant', subcommand);
  }
}
