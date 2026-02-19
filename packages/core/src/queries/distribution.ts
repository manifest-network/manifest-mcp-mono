import { ManifestQueryClient } from '../client.js';
import {
  RewardsResult, CommissionResult, CommunityPoolResult, DistributionParamsResult,
  ValidatorOutstandingRewardsResult, SlashesResult, DelegatorValidatorsResult,
  DelegatorWithdrawAddressResult
} from '../types.js';
import { parseBigInt, requireArgs, extractPaginationArgs } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Distribution query result union type */
type DistributionQueryResult =
  | RewardsResult
  | CommissionResult
  | CommunityPoolResult
  | DistributionParamsResult
  | ValidatorOutstandingRewardsResult
  | SlashesResult
  | DelegatorValidatorsResult
  | DelegatorWithdrawAddressResult;

/**
 * Route distribution query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeDistributionQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<DistributionQueryResult> {
  const distribution = queryClient.cosmos.distribution.v1beta1;

  switch (subcommand) {
    case 'rewards': {
      requireArgs(args, 1, ['delegator-address'], 'distribution rewards');
      const [delegatorAddress] = args;
      // Optional: validator address for specific validator rewards
      const validatorAddress = args[1];

      if (validatorAddress) {
        // Get rewards from specific validator
        const result = await distribution.delegationRewards({
          delegatorAddress,
          validatorAddress,
        });
        return { rewards: result.rewards };
      } else {
        // Get rewards from all validators
        const result = await distribution.delegationTotalRewards({ delegatorAddress });
        return {
          rewards: result.rewards,
          total: result.total,
        };
      }
    }

    case 'commission': {
      requireArgs(args, 1, ['validator-address'], 'distribution commission');
      const [validatorAddress] = args;
      const result = await distribution.validatorCommission({ validatorAddress });
      return { commission: result.commission };
    }

    case 'community-pool': {
      const result = await distribution.communityPool({});
      return { pool: result.pool };
    }

    case 'params': {
      const result = await distribution.params({});
      return { params: result.params };
    }

    case 'validator-outstanding-rewards': {
      requireArgs(args, 1, ['validator-address'], 'distribution validator-outstanding-rewards');
      const [validatorAddress] = args;
      const result = await distribution.validatorOutstandingRewards({ validatorAddress });
      return { rewards: result.rewards };
    }

    case 'slashes': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'distribution slashes');
      requireArgs(remainingArgs, 1, ['validator-address'], 'distribution slashes');
      const [validatorAddress] = remainingArgs;
      // Optional: starting and ending height for filtering
      const startingHeight = remainingArgs[1] ? parseBigInt(remainingArgs[1], 'starting-height') : BigInt(0);
      const endingHeight = remainingArgs[2] ? parseBigInt(remainingArgs[2], 'ending-height') : BigInt(Number.MAX_SAFE_INTEGER);
      const result = await distribution.validatorSlashes({
        validatorAddress,
        startingHeight,
        endingHeight,
        pagination,
      });
      return { slashes: result.slashes, pagination: result.pagination };
    }

    case 'delegator-validators': {
      requireArgs(args, 1, ['delegator-address'], 'distribution delegator-validators');
      const [delegatorAddress] = args;
      const result = await distribution.delegatorValidators({ delegatorAddress });
      return { validators: result.validators };
    }

    case 'delegator-withdraw-address': {
      requireArgs(args, 1, ['delegator-address'], 'distribution delegator-withdraw-address');
      const [delegatorAddress] = args;
      const result = await distribution.delegatorWithdrawAddress({ delegatorAddress });
      return { withdrawAddress: result.withdrawAddress };
    }

    default:
      throwUnsupportedSubcommand('query', 'distribution', subcommand);
  }
}
