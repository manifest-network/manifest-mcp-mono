import type { OfflineSigner } from '@cosmjs/proto-signing';

// Bank module types
import type {
  Params as BankParams,
  Metadata as BankMetadata,
  SendEnabled,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/bank/v1beta1/bank';

// Staking module types
import type {
  Validator,
  DelegationResponse,
  UnbondingDelegation,
  RedelegationResponse,
  Pool as StakingPool,
  Params as StakingParams,
  HistoricalInfo,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/staking/v1beta1/staking';

// Distribution module types
import type {
  Params as DistributionParams,
  ValidatorAccumulatedCommission,
  ValidatorOutstandingRewards,
  ValidatorSlashEvent,
  DelegationDelegatorReward,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/distribution/v1beta1/distribution';

// Gov module types (v1 for newer chains)
import type {
  Proposal as GovProposal,
  Vote as GovVote,
  Deposit as GovDeposit,
  TallyResult as GovTallyResult,
  Params as GovParams,
  VotingParams,
  DepositParams,
  TallyParams,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/gov/v1/gov';

// Protobuf Any type for polymorphic account types
import type { Any } from '@manifest-network/manifestjs/dist/codegen/google/protobuf/any';

// Billing credit estimate response
import type { QueryCreditEstimateResponse } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/query';

// Auth module types
import type {
  BaseAccount,
  ModuleAccount,
  Params as AuthParams,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/auth/v1beta1/auth';

// Group module types
import type {
  GroupInfo,
  GroupPolicyInfo,
  GroupMember,
  Proposal as GroupProposal,
  Vote as GroupVote,
  TallyResult as GroupTallyResult,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/group/v1/types';

// Billing module types (Manifest-specific)
import type {
  Lease,
  CreditAccount,
  Params as BillingParams,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';

import type {
  LeaseItemInput,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx';

// SKU module types (Manifest-specific)
import type {
  Provider,
  SKU,
  Params as SkuParams,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types';

// Re-export commonly used protobuf types for consumers
export type {
  BankParams,
  BankMetadata,
  SendEnabled,
  Validator,
  DelegationResponse,
  UnbondingDelegation,
  RedelegationResponse,
  StakingPool,
  StakingParams,
  HistoricalInfo,
  DistributionParams,
  ValidatorAccumulatedCommission,
  ValidatorOutstandingRewards,
  ValidatorSlashEvent,
  DelegationDelegatorReward,
  GovProposal,
  GovVote,
  GovDeposit,
  GovTallyResult,
  GovParams,
  VotingParams,
  DepositParams,
  TallyParams,
  BaseAccount,
  ModuleAccount,
  AuthParams,
  Any,
  GroupInfo,
  GroupPolicyInfo,
  GroupMember,
  GroupProposal,
  GroupVote,
  GroupTallyResult,
  Lease,
  LeaseItemInput,
  CreditAccount,
  BillingParams,
  QueryCreditEstimateResponse,
  Provider,
  SKU,
  SkuParams,
};

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Maximum requests per second (default: 10) */
  readonly requestsPerSecond?: number;
}

/**
 * Retry configuration for transient RPC failures
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  readonly maxRetries?: number;
  /** Base delay in milliseconds before first retry (default: 1000) */
  readonly baseDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 10000) */
  readonly maxDelayMs?: number;
}

/**
 * Configuration for the Manifest MCP Browser server
 */
export interface ManifestMCPConfig {
  /** Chain ID (e.g., "manifest-ledger-testnet") */
  readonly chainId: string;
  /** RPC endpoint URL */
  readonly rpcUrl: string;
  /** Gas price with denomination (e.g., "1.0umfx") */
  readonly gasPrice: string;
  /** Address prefix (e.g., "manifest") */
  readonly addressPrefix?: string;
  /** Rate limiting configuration */
  readonly rateLimit?: RateLimitConfig;
  /** Retry configuration for transient failures */
  readonly retry?: RetryConfig;
}

/**
 * Wallet provider interface for different wallet implementations
 *
 * Any wallet that provides an OfflineSigner works (Keplr, Web3Auth, Leap, cosmos-kit, etc.)
 */
export interface WalletProvider {
  /** Get the wallet's address */
  getAddress(): Promise<string>;
  /** Get the offline signer for signing transactions */
  getSigner(): Promise<OfflineSigner>;
  /** Optional: Connect to the wallet */
  connect?(): Promise<void>;
  /** Optional: Disconnect from the wallet */
  disconnect?(): Promise<void>;
}

/**
 * Result from a Cosmos transaction
 */
export interface CosmosTxResult {
  readonly module: string;
  readonly subcommand: string;
  readonly transactionHash: string;
  readonly code: number;
  readonly height: string;
  readonly rawLog?: string;
  readonly confirmed?: boolean;
  readonly confirmationHeight?: string;
  readonly gasUsed?: string;
  readonly gasWanted?: string;
  readonly events?: readonly {
    readonly type: string;
    readonly attributes: readonly { readonly key: string; readonly value: string }[];
  }[];
}

/**
 * Module information for discovery
 */
export interface ModuleInfo {
  readonly name: string;
  readonly description: string;
  readonly args?: string; // Usage hint for arguments
}

/**
 * Available modules listing
 */
export interface AvailableModules {
  readonly queryModules: readonly ModuleInfo[];
  readonly txModules: readonly ModuleInfo[];
}

/**
 * Error codes for ManifestMCPError
 */
export enum ManifestMCPErrorCode {
  // Configuration errors
  INVALID_CONFIG = 'INVALID_CONFIG',
  MISSING_CONFIG = 'MISSING_CONFIG',

  // Wallet errors
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  WALLET_CONNECTION_FAILED = 'WALLET_CONNECTION_FAILED',
  KEPLR_NOT_INSTALLED = 'KEPLR_NOT_INSTALLED',
  INVALID_MNEMONIC = 'INVALID_MNEMONIC',

  // Client errors
  CLIENT_NOT_INITIALIZED = 'CLIENT_NOT_INITIALIZED',
  RPC_CONNECTION_FAILED = 'RPC_CONNECTION_FAILED',

  // Query errors
  QUERY_FAILED = 'QUERY_FAILED',
  UNSUPPORTED_QUERY = 'UNSUPPORTED_QUERY',
  INVALID_ADDRESS = 'INVALID_ADDRESS',

  // Transaction errors
  TX_FAILED = 'TX_FAILED',
  TX_SIMULATION_FAILED = 'TX_SIMULATION_FAILED',
  TX_BROADCAST_FAILED = 'TX_BROADCAST_FAILED',
  TX_CONFIRMATION_TIMEOUT = 'TX_CONFIRMATION_TIMEOUT',
  UNSUPPORTED_TX = 'UNSUPPORTED_TX',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',

  // Module errors
  UNKNOWN_MODULE = 'UNKNOWN_MODULE',
  UNKNOWN_SUBCOMMAND = 'UNKNOWN_SUBCOMMAND',

  // General errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Custom error class for Manifest MCP Browser errors
 */
export class ManifestMCPError extends Error {
  public readonly code: ManifestMCPErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ManifestMCPErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ManifestMCPError';
    this.code = code;
    this.details = details;

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ManifestMCPError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * Account information
 */
export interface AccountInfo {
  readonly address: string;
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Pagination response from Cosmos SDK queries
 */
export interface PaginationResponse {
  readonly nextKey?: Uint8Array;
  readonly total?: bigint;
}

/**
 * Base interface for paginated query results
 */
export interface PaginatedResult {
  readonly pagination?: PaginationResponse;
}

/**
 * Coin type from Cosmos SDK
 */
export interface Coin {
  readonly denom: string;
  readonly amount: string;
}

/**
 * DecCoin type from Cosmos SDK (for rewards, commission, etc.)
 *
 * DecCoin has the same structure as Coin but represents decimal amounts
 * used in distribution calculations. The amount string may contain decimals.
 */
export type DecCoin = Coin;

// Bank query results
export interface BalanceResult {
  readonly balance?: Coin;
}

export interface BalancesResult extends PaginatedResult {
  readonly balances: readonly Coin[];
}

export interface TotalSupplyResult extends PaginatedResult {
  readonly supply: readonly Coin[];
}

export interface SupplyOfResult {
  readonly amount?: Coin;
}

export interface DenomMetadataResult {
  readonly metadata?: BankMetadata;
}

export interface DenomsMetadataResult extends PaginatedResult {
  readonly metadatas: readonly BankMetadata[];
}

export interface SendEnabledResult extends PaginatedResult {
  readonly sendEnabled: readonly SendEnabled[];
}

export interface BankParamsResult {
  readonly params?: BankParams;
}

// Staking query results
export interface DelegationResult {
  readonly delegationResponse?: DelegationResponse;
}

export interface DelegationsResult extends PaginatedResult {
  readonly delegationResponses: readonly DelegationResponse[];
}

export interface UnbondingDelegationResult {
  readonly unbond?: UnbondingDelegation;
}

export interface UnbondingDelegationsResult extends PaginatedResult {
  readonly unbondingResponses: readonly UnbondingDelegation[];
}

export interface RedelegationsResult extends PaginatedResult {
  readonly redelegationResponses: readonly RedelegationResponse[];
}

export interface ValidatorResult {
  readonly validator?: Validator;
}

export interface ValidatorsResult extends PaginatedResult {
  readonly validators: readonly Validator[];
}

export interface StakingPoolResult {
  readonly pool?: StakingPool;
}

export interface StakingParamsResult {
  readonly params?: StakingParams;
}

export interface HistoricalInfoResult {
  readonly hist?: HistoricalInfo;
}

// Distribution query results
// Note: When querying all rewards, 'rewards' is DelegationDelegatorReward[] (per validator).
// When querying specific validator, 'rewards' is DecCoin[] (direct reward coins).
export interface RewardsResult {
  readonly rewards: readonly DecCoin[] | readonly DelegationDelegatorReward[];
  readonly total?: readonly DecCoin[];
}

export interface CommissionResult {
  readonly commission?: ValidatorAccumulatedCommission;
}

export interface CommunityPoolResult {
  readonly pool: readonly DecCoin[];
}

export interface DistributionParamsResult {
  readonly params?: DistributionParams;
}

export interface ValidatorOutstandingRewardsResult {
  readonly rewards?: ValidatorOutstandingRewards;
}

export interface SlashesResult extends PaginatedResult {
  readonly slashes: readonly ValidatorSlashEvent[];
}

export interface DelegatorValidatorsResult {
  readonly validators: readonly string[];
}

export interface DelegatorWithdrawAddressResult {
  readonly withdrawAddress: string;
}

// Gov query results
export interface ProposalResult {
  readonly proposal?: GovProposal;
}

export interface ProposalsResult extends PaginatedResult {
  readonly proposals: readonly GovProposal[];
}

export interface VoteResult {
  readonly vote?: GovVote;
}

export interface VotesResult extends PaginatedResult {
  readonly votes: readonly GovVote[];
}

export interface DepositResult {
  readonly deposit?: GovDeposit;
}

export interface DepositsResult extends PaginatedResult {
  readonly deposits: readonly GovDeposit[];
}

export interface TallyResult {
  readonly tally?: GovTallyResult;
}

export interface GovParamsResult {
  readonly votingParams?: VotingParams;
  readonly depositParams?: DepositParams;
  readonly tallyParams?: TallyParams;
  readonly params?: GovParams;
}

// Auth query results
// Note: Account types are polymorphic - the RPC can return BaseAccount, ModuleAccount, or other account types wrapped in Any
export interface AuthAccountResult {
  readonly account?: BaseAccount | ModuleAccount | Any;
}

export interface AuthAccountsResult extends PaginatedResult {
  readonly accounts: readonly (BaseAccount | Any)[];
}

export interface AuthParamsResult {
  readonly params?: AuthParams;
}

export interface ModuleAccountsResult {
  readonly accounts: readonly (ModuleAccount | Any)[];
}

export interface AddressBytesToStringResult {
  readonly addressString: string;
}

export interface AddressStringToBytesResult {
  readonly addressBytes: string;
}

export interface Bech32PrefixResult {
  readonly bech32Prefix: string;
}

export interface AccountInfoResult {
  readonly info?: BaseAccount;
}

// Billing query results
export interface BillingParamsResult {
  readonly params?: BillingParams;
}

export interface LeaseResult {
  readonly lease?: Lease;
}

export interface LeasesResult extends PaginatedResult {
  readonly leases: readonly Lease[];
}

export interface CreditAccountResult {
  readonly creditAccount?: CreditAccount;
}

export interface CreditAccountsResult extends PaginatedResult {
  readonly creditAccounts: readonly CreditAccount[];
}

export interface CreditAddressResult {
  readonly creditAddress: string;
}

export interface WithdrawableAmountResult {
  readonly amounts: readonly Coin[];
}

export interface ProviderWithdrawableResult {
  readonly amounts: readonly Coin[];
}

export interface CreditEstimateResult {
  readonly estimate: QueryCreditEstimateResponse;
}

// Group query results
export interface GroupInfoResult {
  readonly info?: GroupInfo;
}

export interface GroupPolicyInfoResult {
  readonly info?: GroupPolicyInfo;
}

export interface GroupMembersResult extends PaginatedResult {
  readonly members: readonly GroupMember[];
}

export interface GroupsResult extends PaginatedResult {
  readonly groups: readonly GroupInfo[];
}

export interface GroupPoliciesResult extends PaginatedResult {
  readonly groupPolicies: readonly GroupPolicyInfo[];
}

export interface GroupProposalResult {
  readonly proposal?: GroupProposal;
}

export interface GroupProposalsResult extends PaginatedResult {
  readonly proposals: readonly GroupProposal[];
}

export interface GroupVoteResult {
  readonly vote?: GroupVote;
}

export interface GroupVotesResult extends PaginatedResult {
  readonly votes: readonly GroupVote[];
}

export interface GroupTallyQueryResult {
  readonly tally?: GroupTallyResult;
}

// SKU query results
export interface SkuParamsResult {
  readonly params?: SkuParams;
}

export interface ProviderResult {
  readonly provider?: Provider;
}

export interface ProvidersResult extends PaginatedResult {
  readonly providers: readonly Provider[];
}

export interface SkuResult {
  readonly sku?: SKU;
}

export interface SkusResult extends PaginatedResult {
  readonly skus: readonly SKU[];
}

/**
 * Union type of all query results for type-safe handling
 */
export type QueryResult =
  | BalanceResult
  | BalancesResult
  | TotalSupplyResult
  | SupplyOfResult
  | DenomMetadataResult
  | DenomsMetadataResult
  | SendEnabledResult
  | BankParamsResult
  | DelegationResult
  | DelegationsResult
  | UnbondingDelegationResult
  | UnbondingDelegationsResult
  | RedelegationsResult
  | ValidatorResult
  | ValidatorsResult
  | StakingPoolResult
  | StakingParamsResult
  | HistoricalInfoResult
  | RewardsResult
  | CommissionResult
  | CommunityPoolResult
  | DistributionParamsResult
  | ValidatorOutstandingRewardsResult
  | SlashesResult
  | DelegatorValidatorsResult
  | DelegatorWithdrawAddressResult
  | ProposalResult
  | ProposalsResult
  | VoteResult
  | VotesResult
  | DepositResult
  | DepositsResult
  | TallyResult
  | GovParamsResult
  | AuthAccountResult
  | AuthAccountsResult
  | AuthParamsResult
  | ModuleAccountsResult
  | AddressBytesToStringResult
  | AddressStringToBytesResult
  | Bech32PrefixResult
  | AccountInfoResult
  | BillingParamsResult
  | LeaseResult
  | LeasesResult
  | CreditAccountResult
  | CreditAccountsResult
  | CreditAddressResult
  | WithdrawableAmountResult
  | ProviderWithdrawableResult
  | CreditEstimateResult
  | SkuParamsResult
  | ProviderResult
  | ProvidersResult
  | SkuResult
  | SkusResult
  | GroupInfoResult
  | GroupPolicyInfoResult
  | GroupMembersResult
  | GroupsResult
  | GroupPoliciesResult
  | GroupProposalResult
  | GroupProposalsResult
  | GroupVoteResult
  | GroupVotesResult
  | GroupTallyQueryResult;

/**
 * Result from a Cosmos query
 */
export interface CosmosQueryResult {
  readonly module: string;
  readonly subcommand: string;
  readonly result: QueryResult;
}
