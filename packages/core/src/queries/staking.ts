import { ManifestQueryClient } from '../client.js';
import {
  DelegationResult, DelegationsResult, UnbondingDelegationResult, UnbondingDelegationsResult,
  RedelegationsResult, ValidatorResult, ValidatorsResult, StakingPoolResult,
  StakingParamsResult, HistoricalInfoResult
} from '../types.js';
import { parseBigInt, requireArgs, extractPaginationArgs } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Staking query result union type */
type StakingQueryResult =
  | DelegationResult
  | DelegationsResult
  | UnbondingDelegationResult
  | UnbondingDelegationsResult
  | RedelegationsResult
  | ValidatorResult
  | ValidatorsResult
  | StakingPoolResult
  | StakingParamsResult
  | HistoricalInfoResult;

/**
 * Route staking query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeStakingQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<StakingQueryResult> {
  const staking = queryClient.cosmos.staking.v1beta1;

  switch (subcommand) {
    case 'delegation': {
      requireArgs(args, 2, ['delegator-address', 'validator-address'], 'staking delegation');
      const [delegatorAddr, validatorAddr] = args;
      const result = await staking.delegation({
        delegatorAddr,
        validatorAddr,
      });
      return { delegationResponse: result.delegationResponse };
    }

    case 'delegations': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking delegations');
      requireArgs(remainingArgs, 1, ['delegator-address'], 'staking delegations');
      const [delegatorAddr] = remainingArgs;
      const result = await staking.delegatorDelegations({ delegatorAddr, pagination });
      return {
        delegationResponses: result.delegationResponses,
        pagination: result.pagination,
      };
    }

    case 'unbonding-delegation': {
      requireArgs(args, 2, ['delegator-address', 'validator-address'], 'staking unbonding-delegation');
      const [delegatorAddr, validatorAddr] = args;
      const result = await staking.unbondingDelegation({
        delegatorAddr,
        validatorAddr,
      });
      return { unbond: result.unbond };
    }

    case 'unbonding-delegations': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking unbonding-delegations');
      requireArgs(remainingArgs, 1, ['delegator-address'], 'staking unbonding-delegations');
      const [delegatorAddr] = remainingArgs;
      const result = await staking.delegatorUnbondingDelegations({ delegatorAddr, pagination });
      return {
        unbondingResponses: result.unbondingResponses,
        pagination: result.pagination,
      };
    }

    case 'redelegations': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking redelegations');
      requireArgs(remainingArgs, 1, ['delegator-address'], 'staking redelegations');
      const [delegatorAddr] = remainingArgs;
      // Optional: src and dst validator addresses for filtering
      const srcValidatorAddr = remainingArgs[1] || '';
      const dstValidatorAddr = remainingArgs[2] || '';
      const result = await staking.redelegations({
        delegatorAddr,
        srcValidatorAddr,
        dstValidatorAddr,
        pagination,
      });
      return {
        redelegationResponses: result.redelegationResponses,
        pagination: result.pagination,
      };
    }

    case 'validator': {
      requireArgs(args, 1, ['validator-address'], 'staking validator');
      const [validatorAddr] = args;
      const result = await staking.validator({ validatorAddr });
      return { validator: result.validator };
    }

    case 'validators': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking validators');
      // Optional: status filter
      const status = remainingArgs[0] || '';
      const result = await staking.validators({ status, pagination });
      return { validators: result.validators, pagination: result.pagination };
    }

    case 'validator-delegations': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking validator-delegations');
      requireArgs(remainingArgs, 1, ['validator-address'], 'staking validator-delegations');
      const [validatorAddr] = remainingArgs;
      const result = await staking.validatorDelegations({ validatorAddr, pagination });
      return {
        delegationResponses: result.delegationResponses,
        pagination: result.pagination,
      };
    }

    case 'validator-unbonding-delegations': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'staking validator-unbonding-delegations');
      requireArgs(remainingArgs, 1, ['validator-address'], 'staking validator-unbonding-delegations');
      const [validatorAddr] = remainingArgs;
      const result = await staking.validatorUnbondingDelegations({ validatorAddr, pagination });
      return {
        unbondingResponses: result.unbondingResponses,
        pagination: result.pagination,
      };
    }

    case 'pool': {
      const result = await staking.pool({});
      return { pool: result.pool };
    }

    case 'params': {
      const result = await staking.params({});
      return { params: result.params };
    }

    case 'historical-info': {
      requireArgs(args, 1, ['height'], 'staking historical-info');
      const height = parseBigInt(args[0], 'height');
      const result = await staking.historicalInfo({ height });
      return { hist: result.hist };
    }

    default:
      throwUnsupportedSubcommand('query', 'staking', subcommand);
  }
}
