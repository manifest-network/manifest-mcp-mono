import { ManifestQueryClient } from '../client.js';
import {
  BalanceResult, BalancesResult, TotalSupplyResult, SupplyOfResult,
  BankParamsResult, DenomMetadataResult, DenomsMetadataResult, SendEnabledResult
} from '../types.js';
import { requireArgs, extractPaginationArgs } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Bank query result union type */
type BankQueryResult =
  | BalanceResult
  | BalancesResult
  | TotalSupplyResult
  | SupplyOfResult
  | BankParamsResult
  | DenomMetadataResult
  | DenomsMetadataResult
  | SendEnabledResult;

/**
 * Route bank query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeBankQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<BankQueryResult> {
  const bank = queryClient.cosmos.bank.v1beta1;

  switch (subcommand) {
    case 'balance': {
      requireArgs(args, 2, ['address', 'denom'], 'bank balance');
      const [address, denom] = args;
      const result = await bank.balance({ address, denom });
      return { balance: result.balance };
    }

    case 'balances': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'bank balances');
      requireArgs(remainingArgs, 1, ['address'], 'bank balances');
      const [address] = remainingArgs;
      const result = await bank.allBalances({ address, resolveDenom: false, pagination });
      return { balances: result.balances, pagination: result.pagination };
    }

    case 'spendable-balances': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'bank spendable-balances');
      requireArgs(remainingArgs, 1, ['address'], 'bank spendable-balances');
      const [address] = remainingArgs;
      const result = await bank.spendableBalances({ address, pagination });
      return { balances: result.balances, pagination: result.pagination };
    }

    case 'total-supply':
    case 'total': {
      const { pagination } = extractPaginationArgs(args, 'bank total-supply');
      const result = await bank.totalSupply({ pagination });
      return { supply: result.supply, pagination: result.pagination };
    }

    case 'supply-of': {
      requireArgs(args, 1, ['denom'], 'bank supply-of');
      const [denom] = args;
      const result = await bank.supplyOf({ denom });
      return { amount: result.amount };
    }

    case 'params': {
      const result = await bank.params({});
      return { params: result.params };
    }

    case 'denom-metadata': {
      requireArgs(args, 1, ['denom'], 'bank denom-metadata');
      const [denom] = args;
      const result = await bank.denomMetadata({ denom });
      return { metadata: result.metadata };
    }

    case 'denoms-metadata': {
      const { pagination } = extractPaginationArgs(args, 'bank denoms-metadata');
      const result = await bank.denomsMetadata({ pagination });
      return { metadatas: result.metadatas, pagination: result.pagination };
    }

    case 'send-enabled': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'bank send-enabled');
      // Optional: denoms can be empty to query all
      const denoms = remainingArgs.length > 0 ? remainingArgs : [];
      const result = await bank.sendEnabled({ denoms, pagination });
      return { sendEnabled: result.sendEnabled, pagination: result.pagination };
    }

    default:
      throwUnsupportedSubcommand('query', 'bank', subcommand);
  }
}
