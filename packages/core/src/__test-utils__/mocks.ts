import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { vi } from 'vitest';
import type { ManifestQueryClient } from '../client.js';
import type {
  ManifestMCPConfig,
  SignArbitraryResult,
  WalletProvider,
} from '../types.js';

/**
 * Create a mock ManifestMCPConfig with sensible defaults.
 */
export function makeMockConfig(
  overrides?: Partial<ManifestMCPConfig>,
): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    addressPrefix: 'manifest',
    ...overrides,
  };
}

/**
 * Create a mock WalletProvider.
 * Pass `signArbitrary: true` to include a signArbitrary stub.
 */
export function makeMockWallet(opts?: {
  signArbitrary?: boolean;
}): WalletProvider {
  const wallet: WalletProvider = {
    getAddress: vi.fn().mockResolvedValue('manifest1abc'),
    getSigner: vi.fn().mockResolvedValue({}),
  };
  if (opts?.signArbitrary) {
    wallet.signArbitrary = vi.fn().mockResolvedValue({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'mockPubKey' },
      signature: 'mockSignature',
    } satisfies SignArbitraryResult);
  }
  return wallet;
}

/**
 * Billing mock data defaults
 */
interface BillingOverrides {
  balances?: { denom: string; amount: string }[];
  creditAccount?: {
    activeLeaseCount: bigint;
    pendingLeaseCount: bigint;
    reservedAmounts: { denom: string; amount: string }[];
  } | null;
  creditAccountBalances?: { denom: string; amount: string }[];
  creditAccountAvailableBalances?: { denom: string; amount: string }[];
  creditEstimate?: {
    currentBalance: { denom: string; amount: string }[];
    totalRatePerSecond: { denom: string; amount: string }[];
    estimatedDurationSeconds: bigint;
    activeLeaseCount: bigint;
  } | null;
  lease?: {
    uuid: string;
    state: LeaseState;
    providerUuid: string;
    createdAt?: Date;
    closedAt?: Date;
  } | null;
  activeLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
  pendingLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
  closedLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
  rejectedLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
  expiredLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
}

interface SkuOverrides {
  providers?: {
    uuid: string;
    address: string;
    apiUrl: string;
    active: boolean;
  }[];
  skus?: {
    uuid?: string;
    name: string;
    providerUuid: string;
    basePrice?: { amount: string; denom: string };
  }[];
  providerLookup?: Record<string, { provider: { apiUrl: string } }>;
}

/**
 * Create a mock ManifestQueryClient with configurable billing, bank, and SKU data.
 */
export function makeMockQueryClient(overrides?: {
  billing?: BillingOverrides;
  sku?: SkuOverrides;
}) {
  const billing = overrides?.billing ?? {};
  const sku = overrides?.sku ?? {};

  const balances = billing.balances ?? [{ denom: 'umfx', amount: '1000000' }];
  const creditAccount = billing.creditAccount ?? null;
  const creditAccountBalances = billing.creditAccountBalances ?? [];
  const creditAccountAvailableBalances =
    billing.creditAccountAvailableBalances ?? [];
  const creditEstimate = billing.creditEstimate ?? null;
  const lease = billing.lease ?? null;
  const activeLeases = billing.activeLeases ?? [];
  const pendingLeases = billing.pendingLeases ?? [];
  const closedLeases = billing.closedLeases ?? [];
  const rejectedLeases = billing.rejectedLeases ?? [];
  const expiredLeases = billing.expiredLeases ?? [];

  const providers = sku.providers ?? [];
  const skus = sku.skus ?? [];
  const providerLookup = sku.providerLookup ?? {};

  return {
    cosmos: {
      bank: {
        v1beta1: {
          allBalances: vi.fn().mockResolvedValue({ balances }),
        },
      },
    },
    cosmwasm: {
      wasm: {
        v1: {
          contractInfo: vi.fn().mockResolvedValue({}),
          contractHistory: vi
            .fn()
            .mockResolvedValue({ entries: [], pagination: null }),
          contractsByCode: vi
            .fn()
            .mockResolvedValue({ contracts: [], pagination: null }),
          allContractState: vi
            .fn()
            .mockResolvedValue({ models: [], pagination: null }),
          rawContractState: vi
            .fn()
            .mockResolvedValue({ data: new Uint8Array() }),
          smartContractState: vi
            .fn()
            .mockResolvedValue({ data: new Uint8Array() }),
          code: vi
            .fn()
            .mockResolvedValue({ codeInfo: null, data: new Uint8Array() }),
          codes: vi.fn().mockResolvedValue({ codeInfos: [], pagination: null }),
          codeInfo: vi.fn().mockResolvedValue({
            codeId: BigInt(0),
            creator: '',
            checksum: new Uint8Array(),
            instantiatePermission: { permission: 0, addresses: [] },
          }),
          pinnedCodes: vi
            .fn()
            .mockResolvedValue({ codeIds: [], pagination: null }),
          params: vi.fn().mockResolvedValue({ params: null }),
          contractsByCreator: vi
            .fn()
            .mockResolvedValue({ contractAddresses: [], pagination: null }),
          wasmLimitsConfig: vi.fn().mockResolvedValue({ config: '{}' }),
          buildAddress: vi.fn().mockResolvedValue({ address: '' }),
        },
      },
    },
    liftedinit: {
      billing: {
        v1: {
          creditAccount: vi.fn().mockImplementation(async () => {
            if (creditAccount === null) throw new Error('key not found');
            return {
              creditAccount,
              balances: creditAccountBalances,
              availableBalances: creditAccountAvailableBalances,
            };
          }),
          creditEstimate: vi.fn().mockImplementation(async () => {
            if (creditEstimate === null) throw new Error('credit not found');
            return creditEstimate;
          }),
          lease: vi.fn().mockImplementation(async () => {
            return { lease };
          }),
          leasesByTenant: vi
            .fn()
            .mockImplementation(
              async ({ stateFilter }: { stateFilter: LeaseState }) => {
                if (stateFilter === LeaseState.LEASE_STATE_UNSPECIFIED) {
                  return {
                    leases: [
                      ...activeLeases.map((l) => ({
                        state: LeaseState.LEASE_STATE_ACTIVE,
                        ...l,
                      })),
                      ...pendingLeases.map((l) => ({
                        state: LeaseState.LEASE_STATE_PENDING,
                        ...l,
                      })),
                      ...closedLeases.map((l) => ({
                        state: LeaseState.LEASE_STATE_CLOSED,
                        ...l,
                      })),
                      ...rejectedLeases.map((l) => ({
                        state: LeaseState.LEASE_STATE_REJECTED,
                        ...l,
                      })),
                      ...expiredLeases.map((l) => ({
                        state: LeaseState.LEASE_STATE_EXPIRED,
                        ...l,
                      })),
                    ],
                  };
                }
                if (stateFilter === LeaseState.LEASE_STATE_ACTIVE)
                  return {
                    leases: activeLeases.map((l) => ({
                      state: LeaseState.LEASE_STATE_ACTIVE,
                      ...l,
                    })),
                  };
                if (stateFilter === LeaseState.LEASE_STATE_PENDING)
                  return {
                    leases: pendingLeases.map((l) => ({
                      state: LeaseState.LEASE_STATE_PENDING,
                      ...l,
                    })),
                  };
                if (stateFilter === LeaseState.LEASE_STATE_CLOSED)
                  return {
                    leases: closedLeases.map((l) => ({
                      state: LeaseState.LEASE_STATE_CLOSED,
                      ...l,
                    })),
                  };
                if (stateFilter === LeaseState.LEASE_STATE_REJECTED)
                  return {
                    leases: rejectedLeases.map((l) => ({
                      state: LeaseState.LEASE_STATE_REJECTED,
                      ...l,
                    })),
                  };
                if (stateFilter === LeaseState.LEASE_STATE_EXPIRED)
                  return {
                    leases: expiredLeases.map((l) => ({
                      state: LeaseState.LEASE_STATE_EXPIRED,
                      ...l,
                    })),
                  };
                return { leases: [] };
              },
            ),
        },
      },
      sku: {
        v1: {
          providers: vi.fn().mockResolvedValue({ providers }),
          sKUs: vi.fn().mockResolvedValue({ skus }),
          provider: vi
            .fn()
            .mockImplementation(async ({ uuid }: { uuid: string }) => {
              if (providerLookup[uuid]) return providerLookup[uuid];
              throw new Error(`provider ${uuid} not found`);
            }),
        },
      },
    },
  } as unknown as ManifestQueryClient;
}

/**
 * Create a mock CosmosClientManager.
 */
export function makeMockClientManager(overrides?: {
  queryClient?: ManifestQueryClient;
  address?: string;
  config?: ManifestMCPConfig;
}) {
  const queryClient = overrides?.queryClient ?? makeMockQueryClient();
  const address = overrides?.address ?? 'manifest1abc';
  const config = overrides?.config ?? makeMockConfig();

  return {
    getQueryClient: vi.fn().mockResolvedValue(queryClient),
    getSigningClient: vi.fn().mockResolvedValue({}),
    getAddress: vi.fn().mockResolvedValue(address),
    getConfig: vi.fn().mockReturnValue(config),
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
}
