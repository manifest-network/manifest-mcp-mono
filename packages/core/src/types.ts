import type { EncodeObject, OfflineSigner } from '@cosmjs/proto-signing';
// Auth module types
import type {
  Params as AuthParams,
  BaseAccount,
  ModuleAccount,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/auth/v1beta1/auth.js';
// Authz module types
import type {
  Grant as AuthzGrant,
  GrantAuthorization as AuthzGrantAuthorization,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/authz/v1beta1/authz.js';
// Bank module types
import type {
  Metadata as BankMetadata,
  Params as BankParams,
  SendEnabled,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/bank/v1beta1/bank.js';

// Distribution module types
import type {
  DelegationDelegatorReward,
  Params as DistributionParams,
  ValidatorAccumulatedCommission,
  ValidatorOutstandingRewards,
  ValidatorSlashEvent,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/distribution/v1beta1/distribution.js';
// Feegrant module types
import type { Grant as FeegrantGrant } from '@manifest-network/manifestjs/dist/codegen/cosmos/feegrant/v1beta1/feegrant.js';
// Gov module types (v1 for newer chains)
import type {
  DepositParams,
  Deposit as GovDeposit,
  Params as GovParams,
  Proposal as GovProposal,
  TallyResult as GovTallyResult,
  Vote as GovVote,
  TallyParams,
  VotingParams,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/gov/v1/gov.js';
// Group module types
import type {
  GroupInfo,
  GroupMember,
  GroupPolicyInfo,
  Proposal as GroupProposal,
  TallyResult as GroupTallyResult,
  Vote as GroupVote,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/group/v1/types.js';
// Mint module types
import type { Params as MintParams } from '@manifest-network/manifestjs/dist/codegen/cosmos/mint/v1beta1/mint.js';
// Staking module types
import type {
  DelegationResponse,
  HistoricalInfo,
  RedelegationResponse,
  Params as StakingParams,
  Pool as StakingPool,
  UnbondingDelegation,
  Validator,
} from '@manifest-network/manifestjs/dist/codegen/cosmos/staking/v1beta1/staking.js';
import type { CodeInfoResponse } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/wasm/v1/query.js';
// CosmWasm module types
import type {
  ContractCodeHistoryEntry,
  ContractInfo,
  Model,
  Params as WasmParams,
} from '@manifest-network/manifestjs/dist/codegen/cosmwasm/wasm/v1/types.js';
// Protobuf Any type for polymorphic account types
import type { Any } from '@manifest-network/manifestjs/dist/codegen/google/protobuf/any.js';
// IBC transfer types
import type {
  DenomTrace,
  Params as IbcTransferParams,
} from '@manifest-network/manifestjs/dist/codegen/ibc/applications/transfer/v1/transfer.js';
// Billing credit estimate response
import type { QueryCreditEstimateResponse } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/query.js';
import type { LeaseItemInput } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';
// Billing module types (Manifest-specific)
import type {
  Params as BillingParams,
  CreditAccount,
  Lease,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
// SKU module types (Manifest-specific)
import type {
  Provider,
  SKU,
  Params as SkuParams,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types.js';
// Tokenfactory types (Osmosis)
import type { DenomAuthorityMetadata } from '@manifest-network/manifestjs/dist/codegen/osmosis/tokenfactory/v1beta1/authorityMetadata.js';
import type { Params as TokenfactoryParams } from '@manifest-network/manifestjs/dist/codegen/osmosis/tokenfactory/v1beta1/params.js';
// Proof-of-Authority (strangelove-ventures) types
import type { StakingParams as PoAStakingParams } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/poa/v1/params.js';
import type { Validator as PoAValidator } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/poa/v1/validator.js';

// Re-export commonly used protobuf types for consumers
export type {
  Any,
  AuthParams,
  AuthzGrant,
  AuthzGrantAuthorization,
  BankMetadata,
  BankParams,
  BaseAccount,
  BillingParams,
  CodeInfoResponse,
  ContractCodeHistoryEntry,
  ContractInfo,
  CreditAccount,
  DelegationDelegatorReward,
  DelegationResponse,
  DenomAuthorityMetadata,
  DenomTrace,
  DepositParams,
  DistributionParams,
  FeegrantGrant,
  GovDeposit,
  GovParams,
  GovProposal,
  GovTallyResult,
  GovVote,
  GroupInfo,
  GroupMember,
  GroupPolicyInfo,
  GroupProposal,
  GroupTallyResult,
  GroupVote,
  HistoricalInfo,
  IbcTransferParams,
  Lease,
  LeaseItemInput,
  MintParams,
  Model,
  ModuleAccount,
  PoAStakingParams,
  PoAValidator,
  Provider,
  QueryCreditEstimateResponse,
  RedelegationResponse,
  SendEnabled,
  SKU,
  SkuParams,
  StakingParams,
  StakingPool,
  TallyParams,
  TokenfactoryParams,
  UnbondingDelegation,
  Validator,
  ValidatorAccumulatedCommission,
  ValidatorOutstandingRewards,
  ValidatorSlashEvent,
  VotingParams,
  WasmParams,
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
 * Configuration for the Manifest MCP server
 */
export interface ManifestMCPConfig {
  /** Chain ID (e.g., "manifest-ledger-testnet") */
  readonly chainId: string;
  /** RPC endpoint URL (required for transactions; optional if restUrl provided for query-only mode) */
  readonly rpcUrl?: string;
  /** Gas price with denomination (e.g., "1.0umfx"); required when rpcUrl is provided */
  readonly gasPrice?: string;
  /** REST/LCD endpoint URL for queries (e.g., "http://localhost:1317") */
  readonly restUrl?: string;
  /** Address prefix (e.g., "manifest") */
  readonly addressPrefix?: string;
  /** Rate limiting configuration */
  readonly rateLimit?: RateLimitConfig;
  /** Retry configuration for transient failures */
  readonly retry?: RetryConfig;
  /** Gas simulation multiplier (default: 1.5, minimum: 1). A value of 1.0 uses the exact simulation result with no safety margin. Increase if transactions fail with out-of-gas errors. */
  readonly gasMultiplier?: number;
}

/**
 * Per-transaction overrides supplied by external callers (MCP tools, library consumers).
 */
export interface TxOverrides {
  readonly gasMultiplier?: number;
}

/**
 * Fully-resolved gas options passed to transaction handlers.
 * Constructed by `cosmosTx()` from caller-supplied `TxOverrides` and server config.
 */
export interface TxOptions {
  readonly gasMultiplier: number;
  readonly gasPrice: string;
}

/**
 * Wallet provider interface for different wallet implementations
 *
 * Any wallet that provides an OfflineSigner works (Keplr, Web3Auth, Leap, cosmos-kit, etc.)
 */
export interface SignArbitraryResult {
  readonly pub_key: { readonly type: string; readonly value: string };
  readonly signature: string;
}

export interface WalletProvider {
  /** Get the wallet's address */
  getAddress(): Promise<string>;
  /** Get the offline signer for signing transactions */
  getSigner(): Promise<OfflineSigner>;
  /** Optional: Sign arbitrary data (ADR-036) for off-chain authentication */
  signArbitrary?(address: string, data: string): Promise<SignArbitraryResult>;
  /** Optional: Connect to the wallet */
  connect?(): Promise<void>;
  /** Optional: Disconnect from the wallet */
  disconnect?(): Promise<void>;
}

/**
 * Messages built by a transaction module's message builder, ready for
 * simulation or signing/broadcasting.
 */
export interface BuiltMessages {
  readonly messages: readonly EncodeObject[];
  /**
   * Memo string (default ''). Required (not optional) for type cleanliness:
   * call sites get a guaranteed string and don't need `?? ''` coalescing.
   * (At the protobuf encoding layer, '' and undefined are byte-equivalent,
   * so this is purely a type-design choice, not a behavior fix.)
   */
  readonly memo: string;
  /**
   * Canonical subcommand name when the input was an alias.
   * E.g., staking accepts both 'unbond' and 'undelegate' and reports 'unbond' for both.
   * When omitted, callers should use the original subcommand they passed in.
   */
  readonly canonicalSubcommand?: string;
}

/**
 * Result from a fee estimation (simulation without broadcast)
 */
export interface FeeEstimateResult {
  readonly module: string;
  /** Canonical subcommand name (e.g., 'undelegate' is normalized to 'unbond'). */
  readonly subcommand: string;
  /**
   * Raw gas estimate from simulation, stringified for serialization consistency
   * with `CosmosTxResult.gasUsed` / `gasWanted`.
   */
  readonly gasEstimate: string;
  readonly fee: {
    readonly amount: readonly {
      readonly denom: string;
      readonly amount: string;
    }[];
    /** Gas limit, equal to ceil(gasEstimate * gasMultiplier). */
    readonly gas: string;
  };
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
    readonly attributes: readonly {
      readonly key: string;
      readonly value: string;
    }[];
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

  // Wallet errors
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  WALLET_CONNECTION_FAILED = 'WALLET_CONNECTION_FAILED',
  INVALID_MNEMONIC = 'INVALID_MNEMONIC',

  // Client errors
  RPC_CONNECTION_FAILED = 'RPC_CONNECTION_FAILED',

  // Query errors
  QUERY_FAILED = 'QUERY_FAILED',
  UNSUPPORTED_QUERY = 'UNSUPPORTED_QUERY',
  INVALID_ADDRESS = 'INVALID_ADDRESS',

  // Transaction errors
  TX_FAILED = 'TX_FAILED',
  UNSUPPORTED_TX = 'UNSUPPORTED_TX',
  SIMULATION_FAILED = 'SIMULATION_FAILED',

  // Module errors
  UNKNOWN_MODULE = 'UNKNOWN_MODULE',
}

/**
 * Custom error class for Manifest MCP errors
 */
export class ManifestMCPError extends Error {
  public readonly code: ManifestMCPErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ManifestMCPErrorCode,
    message: string,
    details?: Record<string, unknown>,
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
  readonly balances: readonly Coin[];
  readonly availableBalances: readonly Coin[];
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
  readonly leaseCount: bigint;
  readonly hasMore: boolean;
}

export interface CreditEstimateResult {
  readonly estimate: QueryCreditEstimateResponse;
}

export interface LeaseByCustomDomainResult {
  readonly lease?: Lease;
  readonly serviceName: string;
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

// CosmWasm query results
export interface WasmContractInfoResult {
  readonly address: string;
  readonly contractInfo?: ContractInfo;
}

export interface WasmContractHistoryResult extends PaginatedResult {
  readonly entries: readonly ContractCodeHistoryEntry[];
}

export interface WasmContractsByCodeResult extends PaginatedResult {
  readonly contracts: readonly string[];
}

export interface WasmAllContractStateResult extends PaginatedResult {
  readonly models: readonly Model[];
}

export interface WasmRawContractStateResult {
  readonly data: string; // base64-encoded
}

export interface WasmSmartContractStateResult {
  readonly data: unknown;
}

/** JSON-safe representation of CodeInfoResponse with dataHash encoded as base64. */
export interface WasmCodeInfo {
  readonly codeId: bigint;
  readonly creator: string;
  readonly dataHash: string; // base64-encoded
  readonly instantiatePermission: {
    readonly permission: number;
    readonly addresses: readonly string[];
  };
}

export interface WasmCodeResult {
  readonly codeInfo?: WasmCodeInfo;
  readonly data: string; // base64-encoded wasm bytecode
}

export interface WasmCodesResult extends PaginatedResult {
  readonly codeInfos: readonly WasmCodeInfo[];
}

export interface WasmCodeInfoResult {
  readonly codeInfo?: WasmCodeInfo;
}

export interface WasmPinnedCodesResult extends PaginatedResult {
  readonly codeIds: readonly bigint[];
}

export interface WasmParamsResult {
  readonly params?: WasmParams;
}

export interface WasmContractsByCreatorResult extends PaginatedResult {
  readonly contractAddresses: readonly string[];
}

export interface WasmLimitsConfigResult {
  readonly config: string;
}

export interface WasmBuildAddressResult {
  readonly address: string;
}

// Proof-of-Authority (strangelove_ventures) query results
export interface PoAAuthorityResult {
  readonly authority: string;
}

export interface PoAConsensusPowerResult {
  readonly consensusPower: bigint;
}

export interface PoAPendingValidatorsResult {
  readonly pending: readonly PoAValidator[];
}

// Tokenfactory (osmosis) query results
export interface TokenfactoryParamsResult {
  readonly params?: TokenfactoryParams;
}

export interface DenomAuthorityMetadataResult {
  readonly authorityMetadata?: DenomAuthorityMetadata;
}

export interface DenomsFromCreatorResult {
  readonly denoms: readonly string[];
}

export interface DenomsFromAdminResult {
  readonly denoms: readonly string[];
}

// Authz query results
export interface AuthzGrantsResult extends PaginatedResult {
  readonly grants: readonly AuthzGrant[];
}

export interface AuthzGranterGrantsResult extends PaginatedResult {
  readonly grants: readonly AuthzGrantAuthorization[];
}

export interface AuthzGranteeGrantsResult extends PaginatedResult {
  readonly grants: readonly AuthzGrantAuthorization[];
}

// Feegrant query results
export interface FeegrantAllowanceResult {
  readonly allowance?: FeegrantGrant;
}

export interface FeegrantAllowancesResult extends PaginatedResult {
  readonly allowances: readonly FeegrantGrant[];
}

// Mint query results
export interface MintParamsResult {
  readonly params?: MintParams;
}

export interface MintInflationResult {
  readonly inflation: string;
}

export interface MintAnnualProvisionsResult {
  readonly annualProvisions: string;
}

// IBC transfer query results
export interface IbcDenomTraceResult {
  readonly denomTrace?: DenomTrace;
}

export interface IbcDenomTracesResult extends PaginatedResult {
  readonly denomTraces: readonly DenomTrace[];
}

export interface IbcTransferParamsResult {
  readonly params?: IbcTransferParams;
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
  | AuthzGrantsResult
  | AuthzGranterGrantsResult
  | AuthzGranteeGrantsResult
  | FeegrantAllowanceResult
  | FeegrantAllowancesResult
  | MintParamsResult
  | MintInflationResult
  | MintAnnualProvisionsResult
  | BillingParamsResult
  | LeaseResult
  | LeasesResult
  | CreditAccountResult
  | CreditAccountsResult
  | CreditAddressResult
  | WithdrawableAmountResult
  | ProviderWithdrawableResult
  | CreditEstimateResult
  | LeaseByCustomDomainResult
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
  | GroupTallyQueryResult
  | WasmContractInfoResult
  | WasmContractHistoryResult
  | WasmContractsByCodeResult
  | WasmAllContractStateResult
  | WasmRawContractStateResult
  | WasmSmartContractStateResult
  | WasmCodeResult
  | WasmCodesResult
  | WasmCodeInfoResult
  | WasmPinnedCodesResult
  | WasmParamsResult
  | WasmContractsByCreatorResult
  | WasmLimitsConfigResult
  | WasmBuildAddressResult
  | PoAAuthorityResult
  | PoAConsensusPowerResult
  | PoAPendingValidatorsResult
  | TokenfactoryParamsResult
  | DenomAuthorityMetadataResult
  | DenomsFromCreatorResult
  | DenomsFromAdminResult
  | IbcDenomTraceResult
  | IbcDenomTracesResult
  | IbcTransferParamsResult;

/**
 * Result from a Cosmos query
 */
export interface CosmosQueryResult {
  readonly module: string;
  readonly subcommand: string;
  readonly result: QueryResult;
}
