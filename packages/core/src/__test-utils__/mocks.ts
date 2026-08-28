import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { vi } from 'vitest';
import type { CosmosClientManager, ManifestQueryClient } from '../client.js';
import type { ReadCtx, TxCtx } from '../ctx.js';
import { noopLogger } from '../logger.js';
import type { Signer } from '../signer.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SignArbitraryResult,
  type WalletProvider,
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
    items?: unknown[];
    rejectionReason?: string;
  } | null;
  billingParams?: {
    maxLeasesPerTenant: bigint;
    allowedList: string[];
    maxItemsPerLease: bigint;
    minLeaseDuration: bigint;
    maxPendingLeasesPerTenant: bigint;
    pendingTimeout: bigint;
    reservedDomainSuffixes: string[];
  };
  withdrawableAmount?: { denom: string; amount: string }[];
  leaseByCustomDomain?: {
    lease: {
      uuid: string;
      tenant: string;
      providerUuid: string;
      items: unknown[];
      state: LeaseState;
      createdAt: Date;
    };
    serviceName: string;
  };
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
    payoutAddress?: string;
    apiUrl: string;
    active: boolean;
  }[];
  skus?: {
    uuid?: string;
    name: string;
    providerUuid: string;
    basePrice?: { amount: string; denom: string };
    active?: boolean;
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
  const billingParams = billing.billingParams ?? {
    maxLeasesPerTenant: 10n,
    allowedList: [],
    maxItemsPerLease: 5n,
    minLeaseDuration: 3600n,
    maxPendingLeasesPerTenant: 10n,
    pendingTimeout: 1800n,
    reservedDomainSuffixes: [],
  };
  const withdrawableAmount = billing.withdrawableAmount ?? [];
  const leaseByCustomDomain = billing.leaseByCustomDomain ?? {
    lease: {
      uuid: 'lease-uuid-1',
      tenant: 'manifest1tenant',
      providerUuid: 'provider-uuid-1',
      items: [],
      state: LeaseState.LEASE_STATE_ACTIVE,
      createdAt: new Date(0),
    },
    serviceName: 'web',
  };
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
            if (creditAccount === null)
              throw new ManifestMCPError(
                ManifestMCPErrorCode.NOT_FOUND,
                'credit account not found',
                {
                  httpStatus: 404,
                  grpcCode: 5,
                  grpcMessage: 'credit account not found',
                },
              );
            return {
              creditAccount,
              balances: creditAccountBalances,
              availableBalances: creditAccountAvailableBalances,
            };
          }),
          creditEstimate: vi.fn().mockImplementation(async () => {
            if (creditEstimate === null)
              throw new ManifestMCPError(
                ManifestMCPErrorCode.NOT_FOUND,
                'credit account not found',
                {
                  httpStatus: 404,
                  grpcCode: 5,
                  grpcMessage: 'credit account not found',
                },
              );
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
          params: vi.fn().mockResolvedValue({ params: billingParams }),
          withdrawableAmount: vi
            .fn()
            .mockResolvedValue({ amounts: withdrawableAmount }),
          leaseByCustomDomain: vi.fn().mockResolvedValue(leaseByCustomDomain),
        },
      },
      sku: {
        v1: {
          providers: vi.fn().mockResolvedValue({
            providers: providers.map((p) => ({
              payoutAddress: 'manifest1payout',
              ...p,
            })),
          }),
          sKUs: vi.fn().mockResolvedValue({
            skus: skus.map((s) => ({ active: true, ...s })),
          }),
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

  const cm = {
    getQueryClient: vi.fn().mockResolvedValue(queryClient),
    getSigningClient: vi.fn().mockResolvedValue({}),
    // The broadcast client delegates to getSigningClient at CALL time so a test that overrides
    // getSigningClient (its signing mock) is transparently used for broadcasts too. Real sequence
    // management (sequencedSigningClient) is unit-tested separately in internals/tx-sequence.test.ts.
    getBroadcastClient: vi.fn(() => cm.getSigningClient()),
    getAddress: vi.fn().mockResolvedValue(address),
    getConfig: vi.fn().mockReturnValue(config),
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    // Passthrough is enough for the non-concurrency tests; the serialization test overrides this with
    // the REAL promise-chain (or uses a real CosmosClientManager) to genuinely prove serialization.
    withBroadcastLock: <T>(
      _address: string,
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
    disconnect: vi.fn(),
  };
  return cm;
}

/** A ReadCtx for unit tests: a mock query client, a chain stub whose acquireRateLimit resolves, noopLogger. */
export function makeReadCtx(overrides?: {
  query?: ReturnType<typeof makeMockQueryClient>;
  chain?: Partial<CosmosClientManager>;
  logger?: typeof noopLogger;
}): ReadCtx {
  return {
    query: overrides?.query ?? makeMockQueryClient(),
    chain: (overrides?.chain ??
      ({
        acquireRateLimit: async () => {},
      } as unknown as CosmosClientManager)) as CosmosClientManager,
    logger: overrides?.logger ?? noopLogger,
  } as ReadCtx;
}

/**
 * A TxCtx for unit tests: a mock client manager whose getAddress/getSigningClient/acquireRateLimit
 * back the tx path, noopLogger. `signer` defaults to undefined — 4c sender comes from `ctx.chain` and
 * never reads `ctx.signer` (the field is plumbed so 4d's per-signer-mutex tests can populate it).
 */
export function makeTxCtx(overrides?: {
  chain?: Partial<CosmosClientManager>;
  signer?: Signer;
  logger?: typeof noopLogger;
}): TxCtx {
  return {
    chain: (overrides?.chain ?? makeMockClientManager()) as CosmosClientManager,
    signer: overrides?.signer,
    logger: overrides?.logger ?? noopLogger,
  } as TxCtx;
}

/**
 * Every public method of {@link CosmosClientManager}. The seal below covers all of them, and
 * `_SealCoversTheSeam` makes that a COMPILE-TIME claim: adding a public method to the class
 * without adding it here fails `npm run lint`, not a test somebody has to remember to run.
 *
 * Ten names is the whole point. The alternative — enumerating core's *broadcasting exports* —
 * is an open-ended set that rots the moment core grows a helper, and core's barrel has 85
 * runtime exports, so classifying all of them (ENG-715's approach for the small `provider.ts`
 * module) would be noise. One class, ten methods, checked by tsc. (ENG-713)
 */
export const SEALED_CHAIN_METHODS = [
  'getQueryClient',
  'getSigningClient',
  'getBroadcastClient',
  'getAddress',
  'getConfig',
  'setLogger',
  'acquireRateLimit',
  'withBroadcastLock',
  'disconnect',
  'disconnectWhenIdle',
] as const;

/**
 * Compile-time exhaustiveness for {@link SEALED_CHAIN_METHODS}. Resolves to `true` while the list
 * covers `keyof CosmosClientManager`, and to a string-literal tuple — which is not assignable to
 * `true` — the moment it does not, so the error text below is what the developer reads.
 */
type _SealCoversTheSeam =
  Exclude<
    keyof CosmosClientManager,
    (typeof SEALED_CHAIN_METHODS)[number]
  > extends never
    ? true
    : [
        'unsealed CosmosClientManager method — add it to SEALED_CHAIN_METHODS (ENG-713)',
      ];
const _sealCoversTheSeam: _SealCoversTheSeam = true;
void _sealCoversTheSeam;

/**
 * The message a sealed method throws. Exported so a test can assert on it exactly rather than
 * pattern-matching prose that drifts.
 */
export function sealedChainMessage(method: string): string {
  return (
    `ctx.chain.${method}() is sealed in this test (ENG-713). A REAL core broadcaster reached the ` +
    'client manager, which means a mock in this test file did not intercept it. The core tx ' +
    'helpers (setItemCustomDomain / stopApp / fundCredits) call cosmosTx through their own ' +
    "module-local '../cosmos.js' import, and executeTx reaches ctx.chain directly — neither is " +
    'reachable from a `vi.mock` of the core BARREL, because vitest does not rewrite intra-module ' +
    'references. Fix: stub the helper in the barrel factory of this file, or, if the call is ' +
    `intended, opt this method back in with makeSealedClientManager({ ${method}: ... }).`
  );
}

/**
 * A {@link CosmosClientManager} whose every method throws by name — the broadcast counterpart to
 * ENG-705's `globalThis.fetch` ban.
 *
 * WHY A SEAM AND NOT A LIST. Every core broadcast takes the client manager as an INJECTED
 * argument: `cosmosTx(clientManager, ...)`, and `executeTx` reaches `ctx.chain.getBroadcastClient()`
 * without importing `cosmosTx` at all. So `ctx.chain` is the one choke point every broadcast must
 * pass through, whichever helper is added to core later. CLAUDE.md ranks this first for exactly
 * this reason: "Prefer dependency injection at the transport seam."
 *
 * WHAT IT BUYS, MEASURED (ENG-713). With a real `setItemCustomDomain` call added to `restoreApp.ts`
 * and only `cosmosTx` stubbed, the `cosmosTx` spy recorded **0 calls** while a line inside the real
 * `cosmosTx` threw `TypeError: clientManager.getConfig is not a function` — loud, but naming
 * neither the mock nor the escape. Worse, the same escape arrives CLASSIFIED on other shapes: via
 * `stopApp` it surfaces as `ManifestMCPError: Failed to query lease ...` (QUERY_FAILED), and under
 * the permissive `makeMockClientManager` it surfaces as `ManifestMCPError: Tx billing
 * set-item-custom-domain failed: client.simulate is not a function` (TX_FAILED). A test asserting
 * either code would go GREEN on an escaped real broadcaster. This turns all three into one named
 * failure.
 *
 * `allow` opts individual methods back in — e.g. `acquireRateLimit` where a test asserts the
 * rate-limit acquisition. Note the deliberate `vi.fn(impl)` CONSTRUCTOR form below rather than
 * `mockImplementation`: `vi.clearAllMocks()` (common in a `beforeEach`) clears recorded calls but
 * not the constructor impl, so the seal survives it.
 */
export function makeSealedClientManager(
  allow?: Partial<CosmosClientManager>,
): CosmosClientManager {
  const sealed: Record<string, unknown> = {};
  for (const method of SEALED_CHAIN_METHODS) {
    sealed[method] = vi.fn(() => {
      throw new Error(sealedChainMessage(method));
    });
  }
  return { ...sealed, ...allow } as unknown as CosmosClientManager;
}
