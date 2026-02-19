import { SigningStargateClient } from '@cosmjs/stargate';
import { ModuleInfo, AvailableModules, ManifestMCPError, ManifestMCPErrorCode, CosmosTxResult, QueryResult } from './types.js';
import { ManifestQueryClient } from './client.js';

// Import query handlers
import { routeBankQuery } from './queries/bank.js';
import { routeStakingQuery } from './queries/staking.js';
import { routeDistributionQuery } from './queries/distribution.js';
import { routeGovQuery } from './queries/gov.js';
import { routeAuthQuery } from './queries/auth.js';
import { routeBillingQuery } from './queries/billing.js';
import { routeSkuQuery } from './queries/sku.js';
import { routeGroupQuery } from './queries/group.js';

// Import transaction handlers
import { routeBankTransaction } from './transactions/bank.js';
import { routeStakingTransaction } from './transactions/staking.js';
import { routeDistributionTransaction } from './transactions/distribution.js';
import { routeGovTransaction } from './transactions/gov.js';
import { routeBillingTransaction } from './transactions/billing.js';
import { routeManifestTransaction } from './transactions/manifest.js';
import { routeSkuTransaction } from './transactions/sku.js';
import { routeGroupTransaction } from './transactions/group.js';

/**
 * Handler function type for query modules
 */
export type QueryHandler = (
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
) => Promise<QueryResult>;

/**
 * Handler function type for transaction modules
 */
export type TxHandler = (
  signingClient: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
) => Promise<CosmosTxResult>;

/**
 * Throw an error for an unsupported subcommand.
 * Automatically looks up available subcommands from the module registry.
 *
 * @param type - 'query' or 'tx'
 * @param module - The module name (e.g., 'bank', 'staking')
 * @param subcommand - The unsupported subcommand that was requested
 */
export function throwUnsupportedSubcommand(
  type: 'query' | 'tx',
  module: string,
  subcommand: string
): never {
  const registry = type === 'query' ? QUERY_MODULES : TX_MODULES;
  const moduleInfo = registry[module];
  const availableSubcommands = moduleInfo?.subcommands.map(s => s.name) ?? [];

  throw new ManifestMCPError(
    type === 'query' ? ManifestMCPErrorCode.UNSUPPORTED_QUERY : ManifestMCPErrorCode.UNSUPPORTED_TX,
    `Unsupported ${module} ${type === 'query' ? 'query' : 'transaction'} subcommand: ${subcommand}`,
    { availableSubcommands }
  );
}

/**
 * Static module registry for browser-compatible module discovery
 * All modules use manifestjs for full protobuf support
 */

interface SubcommandInfo {
  name: string;
  description: string;
  args?: string; // Usage hint for arguments
}

interface QueryModuleRegistry {
  [moduleName: string]: {
    description: string;
    subcommands: SubcommandInfo[];
    handler: QueryHandler;
  };
}

interface TxModuleRegistry {
  [moduleName: string]: {
    description: string;
    subcommands: SubcommandInfo[];
    handler: TxHandler;
  };
}

/**
 * Query modules registry
 * Each module includes metadata and its handler function
 */
const QUERY_MODULES: QueryModuleRegistry = {
  bank: {
    description: 'Querying commands for the bank module',
    handler: routeBankQuery,
    subcommands: [
      { name: 'balance', description: 'Query account balance for a specific denom' },
      { name: 'balances', description: 'Query all balances for an account' },
      { name: 'spendable-balances', description: 'Query spendable balances for an account' },
      { name: 'total-supply', description: 'Query total supply of all tokens' },
      { name: 'total', description: 'Query total supply of all tokens (alias for total-supply)' },
      { name: 'supply-of', description: 'Query supply of a specific denom' },
      { name: 'params', description: 'Query bank parameters' },
      { name: 'denom-metadata', description: 'Query metadata for a specific denom' },
      { name: 'denoms-metadata', description: 'Query metadata for all denoms' },
      { name: 'send-enabled', description: 'Query send enabled status for denoms' },
    ],
  },
  staking: {
    description: 'Querying commands for the staking module',
    handler: routeStakingQuery,
    subcommands: [
      { name: 'delegation', description: 'Query a delegation' },
      { name: 'delegations', description: 'Query all delegations for a delegator' },
      { name: 'unbonding-delegation', description: 'Query an unbonding delegation' },
      { name: 'unbonding-delegations', description: 'Query all unbonding delegations for a delegator' },
      { name: 'redelegations', description: 'Query redelegations' },
      { name: 'validator', description: 'Query a validator' },
      { name: 'validators', description: 'Query all validators' },
      { name: 'validator-delegations', description: 'Query all delegations to a validator' },
      { name: 'validator-unbonding-delegations', description: 'Query all unbonding delegations from a validator' },
      { name: 'pool', description: 'Query staking pool' },
      { name: 'params', description: 'Query staking parameters' },
      { name: 'historical-info', description: 'Query historical info at a height' },
    ],
  },
  distribution: {
    description: 'Querying commands for the distribution module',
    handler: routeDistributionQuery,
    subcommands: [
      { name: 'rewards', description: 'Query distribution rewards for a delegator' },
      { name: 'commission', description: 'Query validator commission' },
      { name: 'community-pool', description: 'Query community pool coins' },
      { name: 'params', description: 'Query distribution parameters' },
      { name: 'validator-outstanding-rewards', description: 'Query validator outstanding rewards' },
      { name: 'slashes', description: 'Query slashes for a validator' },
      { name: 'delegator-validators', description: 'Query validators for a delegator' },
      { name: 'delegator-withdraw-address', description: 'Query delegator withdraw address' },
    ],
  },
  gov: {
    description: 'Querying commands for the governance module',
    handler: routeGovQuery,
    subcommands: [
      { name: 'proposal', description: 'Query a proposal by ID' },
      { name: 'proposals', description: 'Query all proposals' },
      { name: 'vote', description: 'Query a vote on a proposal' },
      { name: 'votes', description: 'Query all votes on a proposal' },
      { name: 'deposit', description: 'Query a deposit on a proposal' },
      { name: 'deposits', description: 'Query all deposits on a proposal' },
      { name: 'tally', description: 'Query tally of a proposal' },
      { name: 'params', description: 'Query governance parameters' },
    ],
  },
  auth: {
    description: 'Querying commands for the auth module',
    handler: routeAuthQuery,
    subcommands: [
      { name: 'account', description: 'Query account by address' },
      { name: 'accounts', description: 'Query all accounts' },
      { name: 'params', description: 'Query auth parameters' },
      { name: 'module-accounts', description: 'Query all module accounts' },
      { name: 'module-account-by-name', description: 'Query module account by name' },
      { name: 'address-bytes-to-string', description: 'Convert address bytes to string' },
      { name: 'address-string-to-bytes', description: 'Convert address string to bytes' },
      { name: 'bech32-prefix', description: 'Query bech32 prefix' },
      { name: 'account-info', description: 'Query account info' },
    ],
  },
  billing: {
    description: 'Querying commands for the Manifest billing module',
    handler: routeBillingQuery,
    subcommands: [
      { name: 'params', description: 'Query billing parameters' },
      { name: 'lease', description: 'Query a lease by UUID' },
      { name: 'leases', description: 'Query all leases' },
      { name: 'leases-by-tenant', description: 'Query leases by tenant address' },
      { name: 'leases-by-provider', description: 'Query leases by provider' },
      { name: 'leases-by-sku', description: 'Query leases by SKU UUID' },
      { name: 'credit-account', description: 'Query credit account for a tenant' },
      { name: 'credit-accounts', description: 'Query all credit accounts' },
      { name: 'credit-address', description: 'Query credit address for a tenant' },
      { name: 'withdrawable-amount', description: 'Query withdrawable amount for a lease' },
      { name: 'provider-withdrawable', description: 'Query withdrawable amount for a provider' },
      { name: 'credit-estimate', description: 'Query credit estimate for a tenant' },
    ],
  },
  sku: {
    description: 'Querying commands for the Manifest SKU module',
    handler: routeSkuQuery,
    subcommands: [
      { name: 'params', description: 'Query SKU module parameters' },
      { name: 'provider', description: 'Query a provider by UUID', args: '<provider-uuid>' },
      { name: 'providers', description: 'Query all providers', args: '[--active-only] [--limit N]' },
      { name: 'sku', description: 'Query a SKU by UUID', args: '<sku-uuid>' },
      { name: 'skus', description: 'Query all SKUs', args: '[--active-only] [--limit N]' },
      { name: 'skus-by-provider', description: 'Query SKUs by provider UUID', args: '<provider-uuid> [--active-only] [--limit N]' },
      { name: 'provider-by-address', description: 'Query providers by address', args: '<address> [--active-only] [--limit N]' },
    ],
  },
  group: {
    description: 'Querying commands for the group module',
    handler: routeGroupQuery,
    subcommands: [
      { name: 'group-info', description: 'Query group info by ID', args: '<group-id>' },
      { name: 'group-policy-info', description: 'Query group policy info by address', args: '<group-policy-address>' },
      { name: 'group-members', description: 'Query group members', args: '<group-id> [--limit N]' },
      { name: 'groups-by-admin', description: 'Query groups by admin address', args: '<admin-address> [--limit N]' },
      { name: 'group-policies-by-group', description: 'Query group policies by group ID', args: '<group-id> [--limit N]' },
      { name: 'group-policies-by-admin', description: 'Query group policies by admin address', args: '<admin-address> [--limit N]' },
      { name: 'proposal', description: 'Query a group proposal by ID', args: '<proposal-id>' },
      { name: 'proposals-by-group-policy', description: 'Query proposals by group policy address', args: '<group-policy-address> [--limit N]' },
      { name: 'vote', description: 'Query a vote by proposal ID and voter', args: '<proposal-id> <voter-address>' },
      { name: 'votes-by-proposal', description: 'Query votes by proposal ID', args: '<proposal-id> [--limit N]' },
      { name: 'votes-by-voter', description: 'Query votes by voter address', args: '<voter-address> [--limit N]' },
      { name: 'groups-by-member', description: 'Query groups by member address', args: '<member-address> [--limit N]' },
      { name: 'tally', description: 'Query tally result for a proposal', args: '<proposal-id>' },
      { name: 'groups', description: 'Query all groups', args: '[--limit N]' },
    ],
  },
};

/**
 * Transaction modules registry
 * Each module includes metadata and its handler function
 */
const TX_MODULES: TxModuleRegistry = {
  bank: {
    description: 'Bank transaction subcommands',
    handler: routeBankTransaction,
    subcommands: [
      { name: 'send', description: 'Send tokens to another account', args: '<to-address> <amount> (e.g., manifest1abc... 1000000umfx)' },
      { name: 'multi-send', description: 'Send tokens to multiple accounts', args: '<to-address:amount>... (e.g., manifest1a:1000umfx manifest1b:2000umfx)' },
    ],
  },
  staking: {
    description: 'Staking transaction subcommands',
    handler: routeStakingTransaction,
    subcommands: [
      { name: 'delegate', description: 'Delegate tokens to a validator' },
      { name: 'unbond', description: 'Unbond tokens from a validator' },
      { name: 'undelegate', description: 'Unbond tokens from a validator (alias for unbond)' },
      { name: 'redelegate', description: 'Redelegate tokens from one validator to another' },
    ],
  },
  distribution: {
    description: 'Distribution transaction subcommands',
    handler: routeDistributionTransaction,
    subcommands: [
      { name: 'withdraw-rewards', description: 'Withdraw rewards from a validator' },
      { name: 'set-withdraw-addr', description: 'Set withdraw address' },
      { name: 'fund-community-pool', description: 'Fund the community pool' },
    ],
  },
  gov: {
    description: 'Governance transaction subcommands',
    handler: routeGovTransaction,
    subcommands: [
      { name: 'vote', description: 'Vote on a proposal' },
      { name: 'weighted-vote', description: 'Weighted vote on a proposal' },
      { name: 'deposit', description: 'Deposit tokens for a proposal' },
    ],
  },
  billing: {
    description: 'Manifest billing transaction subcommands',
    handler: routeBillingTransaction,
    subcommands: [
      { name: 'fund-credit', description: 'Fund credit for a tenant', args: '<tenant-address> <amount> (e.g., manifest1abc... 1000000umfx)' },
      { name: 'create-lease', description: 'Create a new lease', args: '[--meta-hash <hex>] <sku-uuid:quantity[:service-name]>... (e.g., sku-123:1 or sku-123:1:web sku-123:1:db)' },
      { name: 'close-lease', description: 'Close one or more leases', args: '[--reason <text>] <lease-uuid>... (e.g., lease-123 lease-456)' },
      { name: 'withdraw', description: 'Withdraw earnings from leases', args: '<lease-uuid>... OR --provider <provider-uuid> [--limit <1-100>]' },
      { name: 'create-lease-for-tenant', description: 'Create a lease on behalf of a tenant', args: '<tenant-address> [--meta-hash <hex>] <sku-uuid:quantity[:service-name]>...' },
      { name: 'acknowledge-lease', description: 'Acknowledge one or more pending leases', args: '<lease-uuid>...' },
      { name: 'reject-lease', description: 'Reject one or more pending leases', args: '[--reason <text>] <lease-uuid>...' },
      { name: 'cancel-lease', description: 'Cancel one or more pending leases', args: '<lease-uuid>...' },
      { name: 'update-params', description: 'Update billing module parameters (governance)', args: '<max-leases-per-tenant> <max-items-per-lease> <min-lease-duration> <max-pending-leases-per-tenant> <pending-timeout> [<allowed-address>...]' },
    ],
  },
  manifest: {
    description: 'Manifest module transaction subcommands',
    handler: routeManifestTransaction,
    subcommands: [
      { name: 'payout', description: 'Execute a payout to multiple addresses' },
      { name: 'burn-held-balance', description: 'Burn held balance' },
    ],
  },
  sku: {
    description: 'Manifest SKU module transaction subcommands',
    handler: routeSkuTransaction,
    subcommands: [
      { name: 'create-provider', description: 'Create a new provider', args: '<address> <payout-address> <api-url> [--meta-hash <hex>]' },
      { name: 'update-provider', description: 'Update an existing provider', args: '<provider-uuid> <address> <payout-address> <api-url> [--meta-hash <hex>] [--active <true|false>]' },
      { name: 'deactivate-provider', description: 'Deactivate a provider', args: '<provider-uuid>' },
      { name: 'create-sku', description: 'Create a new SKU', args: '<provider-uuid> <name> <unit (per-hour|per-day)> <base-price> [--meta-hash <hex>]' },
      { name: 'update-sku', description: 'Update an existing SKU', args: '<sku-uuid> <provider-uuid> <name> <unit (per-hour|per-day)> <base-price> [--meta-hash <hex>] [--active <true|false>]' },
      { name: 'deactivate-sku', description: 'Deactivate a SKU', args: '<sku-uuid>' },
      { name: 'update-params', description: 'Update SKU module parameters (governance)', args: '<allowed-address>...' },
    ],
  },
  group: {
    description: 'Group module transaction subcommands',
    handler: routeGroupTransaction,
    subcommands: [
      { name: 'create-group', description: 'Create a new group', args: '<metadata> <address:weight>...' },
      { name: 'update-group-members', description: 'Update group members', args: '<group-id> <address:weight>...' },
      { name: 'update-group-admin', description: 'Update group admin', args: '<group-id> <new-admin-address>' },
      { name: 'update-group-metadata', description: 'Update group metadata', args: '<group-id> <metadata>' },
      { name: 'create-group-policy', description: 'Create a group policy', args: '<group-id> <metadata> <policy-type> <threshold-or-pct> <voting-period-secs> <min-execution-period-secs>' },
      { name: 'update-group-policy-admin', description: 'Update group policy admin', args: '<group-policy-address> <new-admin-address>' },
      { name: 'create-group-with-policy', description: 'Create a group with policy', args: '<group-metadata> <group-policy-metadata> <policy-type> <threshold-or-pct> <voting-period-secs> <min-execution-period-secs> [--group-policy-as-admin] <address:weight>...' },
      { name: 'update-group-policy-decision-policy', description: 'Update group policy decision policy', args: '<group-policy-address> <policy-type> <threshold-or-pct> <voting-period-secs> <min-execution-period-secs>' },
      { name: 'update-group-policy-metadata', description: 'Update group policy metadata', args: '<group-policy-address> <metadata>' },
      { name: 'submit-proposal', description: 'Submit a group proposal', args: '<group-policy-address> <title> <summary> [--exec try] [--metadata <text>] [<message-json>...]' },
      { name: 'withdraw-proposal', description: 'Withdraw a group proposal', args: '<proposal-id>' },
      { name: 'vote', description: 'Vote on a group proposal', args: '<proposal-id> <option (yes|no|abstain|no_with_veto)> [--metadata <text>] [--exec try]' },
      { name: 'exec', description: 'Execute a passed group proposal', args: '<proposal-id>' },
      { name: 'leave-group', description: 'Leave a group', args: '<group-id>' },
    ],
  },
};

/**
 * Get all available query and transaction modules
 */
export function getAvailableModules(): AvailableModules {
  const queryModules: ModuleInfo[] = Object.entries(QUERY_MODULES).map(
    ([name, info]) => ({
      name,
      description: info.description,
    })
  );

  const txModules: ModuleInfo[] = Object.entries(TX_MODULES).map(
    ([name, info]) => ({
      name,
      description: info.description,
    })
  );

  return {
    queryModules,
    txModules,
  };
}

/**
 * Get available subcommands for a specific module
 */
export function getModuleSubcommands(
  type: 'query' | 'tx',
  module: string
): ModuleInfo[] {
  const registry = type === 'query' ? QUERY_MODULES : TX_MODULES;
  const moduleInfo = registry[module];

  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown ${type} module: ${module}`,
      { availableModules: Object.keys(registry) }
    );
  }

  return moduleInfo.subcommands.map((sub) => ({
    name: sub.name,
    description: sub.description,
    args: sub.args,
  }));
}

/**
 * Check if a module/subcommand combination is supported
 */
export function isSubcommandSupported(
  type: 'query' | 'tx',
  module: string,
  subcommand: string
): boolean {
  const registry = type === 'query' ? QUERY_MODULES : TX_MODULES;
  const moduleInfo = registry[module];

  if (!moduleInfo) {
    return false;
  }

  return moduleInfo.subcommands.some((s) => s.name === subcommand);
}

/**
 * Get usage help for a specific subcommand
 * Returns the args string if available, or undefined
 */
export function getSubcommandUsage(
  type: 'query' | 'tx',
  module: string,
  subcommand: string
): string | undefined {
  const registry = type === 'query' ? QUERY_MODULES : TX_MODULES;
  const moduleInfo = registry[module];

  if (!moduleInfo) {
    return undefined;
  }

  const sub = moduleInfo.subcommands.find((s) => s.name === subcommand);
  return sub?.args;
}

/**
 * Get supported modules list
 */
export function getSupportedModules(): {
  query: { [module: string]: string[] };
  tx: { [module: string]: string[] };
} {
  const result = {
    query: {} as { [module: string]: string[] },
    tx: {} as { [module: string]: string[] },
  };

  for (const [module, info] of Object.entries(QUERY_MODULES)) {
    result.query[module] = info.subcommands.map((s) => s.name);
  }

  for (const [module, info] of Object.entries(TX_MODULES)) {
    result.tx[module] = info.subcommands.map((s) => s.name);
  }

  return result;
}

/**
 * Get the handler function for a query module
 * @throws ManifestMCPError if module is not found
 */
export function getQueryHandler(module: string): QueryHandler {
  const moduleInfo = QUERY_MODULES[module];
  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown query module: ${module}`,
      { availableModules: Object.keys(QUERY_MODULES) }
    );
  }
  return moduleInfo.handler;
}

/**
 * Get the handler function for a transaction module
 * @throws ManifestMCPError if module is not found
 */
export function getTxHandler(module: string): TxHandler {
  const moduleInfo = TX_MODULES[module];
  if (!moduleInfo) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.UNKNOWN_MODULE,
      `Unknown tx module: ${module}`,
      { availableModules: Object.keys(TX_MODULES) }
    );
  }
  return moduleInfo.handler;
}
