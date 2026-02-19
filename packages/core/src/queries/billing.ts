import { ManifestQueryClient } from '../client.js';
import {
  BillingParamsResult, LeaseResult, LeasesResult, CreditAccountResult,
  CreditAccountsResult, CreditAddressResult, WithdrawableAmountResult,
  ProviderWithdrawableResult, CreditEstimateResult
} from '../types.js';
import { parseBigInt, requireArgs, extractPaginationArgs } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Billing query result union type */
type BillingQueryResult =
  | BillingParamsResult
  | LeaseResult
  | LeasesResult
  | CreditAccountResult
  | CreditAccountsResult
  | CreditAddressResult
  | WithdrawableAmountResult
  | ProviderWithdrawableResult
  | CreditEstimateResult;

/**
 * Route billing module query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeBillingQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<BillingQueryResult> {
  const billing = queryClient.liftedinit.billing.v1;

  switch (subcommand) {
    case 'params': {
      const result = await billing.params({});
      return { params: result.params };
    }

    case 'lease': {
      requireArgs(args, 1, ['lease-uuid'], 'billing lease');
      const [leaseUuid] = args;
      const result = await billing.lease({ leaseUuid });
      return { lease: result.lease };
    }

    case 'leases': {
      const { pagination } = extractPaginationArgs(args, 'billing leases');
      // stateFilter: 0 = LEASE_STATE_UNSPECIFIED (returns all)
      const result = await billing.leases({ stateFilter: 0, pagination });
      return { leases: result.leases, pagination: result.pagination };
    }

    case 'leases-by-tenant': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'billing leases-by-tenant');
      requireArgs(remainingArgs, 1, ['tenant-address'], 'billing leases-by-tenant');
      const [tenant] = remainingArgs;
      const result = await billing.leasesByTenant({ tenant, stateFilter: 0, pagination });
      return { leases: result.leases, pagination: result.pagination };
    }

    case 'leases-by-provider': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'billing leases-by-provider');
      requireArgs(remainingArgs, 1, ['provider-uuid'], 'billing leases-by-provider');
      const [providerUuid] = remainingArgs;
      const result = await billing.leasesByProvider({ providerUuid, stateFilter: 0, pagination });
      return { leases: result.leases, pagination: result.pagination };
    }

    case 'leases-by-sku': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'billing leases-by-sku');
      requireArgs(remainingArgs, 1, ['sku-uuid'], 'billing leases-by-sku');
      const [skuUuid] = remainingArgs;
      const result = await billing.leasesBySKU({ skuUuid, stateFilter: 0, pagination });
      return { leases: result.leases, pagination: result.pagination };
    }

    case 'credit-account': {
      requireArgs(args, 1, ['tenant-address'], 'billing credit-account');
      const [tenant] = args;
      const result = await billing.creditAccount({ tenant });
      return { creditAccount: result.creditAccount };
    }

    case 'credit-accounts': {
      const { pagination } = extractPaginationArgs(args, 'billing credit-accounts');
      const result = await billing.creditAccounts({ pagination });
      return { creditAccounts: result.creditAccounts, pagination: result.pagination };
    }

    case 'credit-address': {
      requireArgs(args, 1, ['tenant-address'], 'billing credit-address');
      const [tenant] = args;
      const result = await billing.creditAddress({ tenant });
      return { creditAddress: result.creditAddress };
    }

    case 'withdrawable-amount': {
      requireArgs(args, 1, ['lease-uuid'], 'billing withdrawable-amount');
      const [leaseUuid] = args;
      const result = await billing.withdrawableAmount({ leaseUuid });
      return { amounts: result.amounts };
    }

    case 'provider-withdrawable': {
      requireArgs(args, 1, ['provider-uuid'], 'billing provider-withdrawable');
      const [providerUuid] = args;
      // Optional: limit for max leases to process (default 100, max 1000)
      const limit = args[1] ? parseBigInt(args[1], 'limit') : BigInt(100);
      const result = await billing.providerWithdrawable({ providerUuid, limit });
      return { amounts: result.amounts };
    }

    case 'credit-estimate': {
      requireArgs(args, 1, ['tenant-address'], 'billing credit-estimate');
      const [tenant] = args;
      const result = await billing.creditEstimate({ tenant });
      return { estimate: result };
    }

    default:
      throwUnsupportedSubcommand('query', 'billing', subcommand);
  }
}
