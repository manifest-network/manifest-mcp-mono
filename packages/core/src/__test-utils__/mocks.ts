import { vi } from 'vitest';
import type { ManifestMCPConfig, WalletProvider, SignArbitraryResult } from '../types.js';
import type { AppRegistry } from '../registry.js';
import type { ManifestQueryClient } from '../client.js';

/**
 * Create a mock ManifestMCPConfig with sensible defaults.
 */
export function makeMockConfig(overrides?: Partial<ManifestMCPConfig>): ManifestMCPConfig {
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
export function makeMockWallet(
  opts?: { signArbitrary?: boolean },
): WalletProvider {
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
 * Create a mock AppRegistry (all vi.fn() stubs).
 */
export function makeMockAppRegistry(
  overrides?: Partial<AppRegistry>,
): AppRegistry {
  return {
    getApps: vi.fn().mockReturnValue([]),
    getApp: vi.fn().mockReturnValue({ name: 'test', leaseUuid: 'uuid', status: 'active' }),
    findApp: vi.fn().mockReturnValue(undefined),
    getAppByLease: vi.fn().mockReturnValue(undefined),
    addApp: vi.fn(),
    updateApp: vi.fn(),
    removeApp: vi.fn(),
    ...overrides,
  };
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
  creditEstimate?: {
    currentBalance: { denom: string; amount: string }[];
    totalRatePerSecond: { denom: string; amount: string }[];
    estimatedDurationSeconds: bigint;
    activeLeaseCount: bigint;
  } | null;
  lease?: { uuid: string; state: number; providerUuid: string; createdAt?: Date; closedAt?: Date } | null;
  activeLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
  pendingLeases?: { uuid: string; providerUuid: string; createdAt?: Date }[];
}

interface SkuOverrides {
  providers?: { uuid: string; address: string; apiUrl: string; active: boolean }[];
  skus?: { name: string; providerUuid: string; basePrice?: { amount: string; denom: string } }[];
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
  const creditEstimate = billing.creditEstimate ?? null;
  const lease = billing.lease ?? null;
  const activeLeases = billing.activeLeases ?? [];
  const pendingLeases = billing.pendingLeases ?? [];

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
    liftedinit: {
      billing: {
        v1: {
          creditAccount: vi.fn().mockImplementation(async () => {
            if (creditAccount === null) throw new Error('key not found');
            return { creditAccount };
          }),
          creditEstimate: vi.fn().mockImplementation(async () => {
            if (creditEstimate === null) throw new Error('credit not found');
            return creditEstimate;
          }),
          lease: vi.fn().mockImplementation(async () => {
            return { lease };
          }),
          leasesByTenant: vi.fn().mockImplementation(async ({ stateFilter }: { stateFilter: number }) => {
            if (stateFilter === 2) return { leases: activeLeases };
            if (stateFilter === 1) return { leases: pendingLeases };
            return { leases: [] };
          }),
        },
      },
      sku: {
        v1: {
          providers: vi.fn().mockResolvedValue({ providers }),
          sKUs: vi.fn().mockResolvedValue({ skus }),
          provider: vi.fn().mockImplementation(async ({ uuid }: { uuid: string }) => {
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
