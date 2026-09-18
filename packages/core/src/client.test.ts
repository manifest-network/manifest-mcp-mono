import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// Mock external dependencies
vi.mock('@manifest-network/manifestjs/dist/codegen/cosmos/client.js', () => ({
  cosmosProtoRegistry: [],
  cosmosAminoConverters: {},
}));

vi.mock('@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js', () => ({
  cosmwasm: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ cosmwasm: {} }),
    },
  },
}));

vi.mock('@manifest-network/manifestjs/dist/codegen/cosmwasm/client.js', () => ({
  cosmwasmProtoRegistry: [],
  cosmwasmAminoConverters: {},
}));

vi.mock('@manifest-network/manifestjs/dist/codegen/ibc/bundle.js', () => ({
  ibc: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ ibc: {} }),
    },
  },
}));

vi.mock('@manifest-network/manifestjs/dist/codegen/ibc/client.js', () => ({
  ibcProtoRegistry: [],
  ibcAminoConverters: {},
}));

vi.mock(
  '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js',
  () => ({
    liftedinit: { ClientFactory: { createRPCQueryClient: vi.fn() } },
  }),
);

vi.mock(
  '@manifest-network/manifestjs/dist/codegen/liftedinit/client.js',
  () => ({
    liftedinitProtoRegistry: [],
    liftedinitAminoConverters: {},
  }),
);

vi.mock('@manifest-network/manifestjs/dist/codegen/osmosis/bundle.js', () => ({
  osmosis: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ osmosis: {} }),
    },
  },
}));

vi.mock('@manifest-network/manifestjs/dist/codegen/osmosis/client.js', () => ({
  osmosisProtoRegistry: [],
  osmosisAminoConverters: {},
}));

vi.mock(
  '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/bundle.js',
  () => ({
    strangelove_ventures: {
      ClientFactory: {
        createRPCQueryClient: vi
          .fn()
          .mockResolvedValue({ strangelove_ventures: {} }),
      },
    },
  }),
);

vi.mock(
  '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/client.js',
  () => ({
    strangeloveVenturesProtoRegistry: [],
    strangeloveVenturesAminoConverters: {},
  }),
);

vi.mock('@cosmjs/stargate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cosmjs/stargate')>();
  return {
    ...actual,
    SigningStargateClient: {
      connectWithSigner: vi.fn().mockResolvedValue({
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      }),
    },
    GasPrice: {
      fromString: vi.fn().mockReturnValue({}),
    },
    AminoTypes: class MockAminoTypes {},
  };
});

vi.mock('@cosmjs/proto-signing', () => ({
  Registry: class MockRegistry {},
}));

vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn().mockResolvedValue({ mock: 'lcdClient' }),
}));

vi.mock('./modules.js', () => ({
  getQueryHandler: vi.fn(),
  getTxHandler: vi.fn(),
  getTxContextLoader: vi.fn(),
  getTxMsgBuilder: vi.fn(),
}));

vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  return {
    ...actual,
    withRetry: vi
      .fn()
      .mockImplementation(async (operation: () => Promise<unknown>) => {
        return operation();
      }),
  };
});

import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmwasm as cosmwasmNs } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js';
import { liftedinit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js';
import { CosmosClientManager } from './client.js';
import { cosmosQuery } from './cosmos.js';
import { createLCDQueryClient } from './lcd-adapter.js';
import { noopLogger } from './logger.js';
import { isRetryableError, withRetry } from './retry.js';
import type { ManifestMCPConfig, WalletProvider } from './types.js';

const mockCreateLCDQueryClient = vi.mocked(createLCDQueryClient);

const mockCreateRPCQueryClient = vi.mocked(
  liftedinit.ClientFactory.createRPCQueryClient,
);
const mockCreateCosmwasmRPCQueryClient = vi.mocked(
  cosmwasmNs.ClientFactory.createRPCQueryClient,
);
const mockConnectWithSigner = vi.mocked(
  SigningStargateClient.connectWithSigner,
);

function makeConfig(overrides?: Partial<ManifestMCPConfig>): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    ...overrides,
  };
}

function makeWallet(overrides?: Partial<WalletProvider>): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('manifest1test'),
    getSigner: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeSpyLogger() {
  return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe('CosmosClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CosmosClientManager.clearInstances();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async (input) =>
        Response.json(
          new URL(input instanceof Request ? input.url : input).pathname ===
            '/cosmos/base/tendermint/v1beta1/node_info'
            ? { default_node_info: { network: 'test-chain' } }
            : {
                jsonrpc: '2.0',
                id: 'manifest-chain-identity',
                result: { node_info: { network: 'test-chain' } },
              },
        ),
      ),
    );
    // Restore default mock return values after clearAllMocks
    mockCreateRPCQueryClient.mockResolvedValue({ mock: 'defaultQC' } as any);
    mockCreateCosmwasmRPCQueryClient.mockResolvedValue({
      cosmwasm: {},
    } as any);
    mockConnectWithSigner.mockResolvedValue({
      getChainId: vi.fn().mockResolvedValue('test-chain'),
      disconnect: vi.fn(),
    } as any);
  });

  afterEach(() => {
    CosmosClientManager.clearInstances();
    vi.unstubAllGlobals();
  });

  describe.each(['REST', 'RPC', 'signing', 'wallet'] as const)(
    '%s initialization error normalization',
    (boundary) => {
      beforeEach(async () => {
        const actual =
          await vi.importActual<typeof import('./retry.js')>('./retry.js');
        vi.mocked(withRetry).mockImplementation(actual.withRetry);
      });

      afterEach(() => {
        vi.mocked(withRetry).mockImplementation((operation) => operation());
      });

      function failInitialization(
        error: unknown,
        identityFetch = false,
        maxRetries = 2,
      ) {
        const wallet = makeWallet();
        const getChainId = vi.fn().mockResolvedValue('test-chain');
        if (boundary === 'signing' && identityFetch) {
          mockConnectWithSigner.mockResolvedValueOnce({
            getChainId,
            disconnect: vi.fn(),
          } as unknown as SigningStargateClient);
        }
        const config = makeConfig({
          restUrl: boundary === 'REST' ? 'https://lcd.example.com' : undefined,
          retry: { maxRetries, baseDelayMs: 0, maxDelayMs: 0 },
        });
        const operation =
          boundary === 'wallet'
            ? vi.mocked(wallet.getSigner)
            : identityFetch
              ? boundary === 'signing'
                ? getChainId
                : vi.mocked(globalThis.fetch)
              : boundary === 'REST'
                ? mockCreateLCDQueryClient
                : boundary === 'RPC'
                  ? mockCreateRPCQueryClient
                  : mockConnectWithSigner;
        operation.mockRejectedValueOnce(error);
        const manager = CosmosClientManager.getInstance(config, wallet);
        const query = boundary === 'REST' || boundary === 'RPC';
        const callsBefore = operation.mock.calls.length;
        return {
          operation,
          callsBefore,
          invoke: () =>
            query ? manager.getQueryClient() : manager.getSigningClient(),
          pending: query
            ? manager.getQueryClient()
            : manager.getSigningClient(),
          messagePrefix: query
            ? `Failed to connect to ${boundary} endpoint`
            : 'Failed to connect signing client',
          details: query
            ? { url: config.restUrl ?? config.rpcUrl }
            : { rpcUrl: config.rpcUrl },
        };
      }

      async function expectConnectionError(
        pending: Promise<unknown>,
        message: string,
        details: Record<string, unknown>,
      ) {
        await pending.then(
          () => {
            throw new Error('Expected initialization to fail');
          },
          (error: unknown) => {
            expect(error).toBeInstanceOf(ManifestMCPError);
            const normalized = error as ManifestMCPError;
            expect(normalized.code).toBe(
              ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            );
            expect(normalized.message).toBe(message);
            expect(normalized.details).toStrictEqual(details);
            expect('cause' in normalized).toBe(false);
          },
        );
      }

      it.each([
        {
          name: 'throwing message getter',
          create: () =>
            Object.defineProperty(new Error('fetch failed'), 'message', {
              get() {
                throw new Error('diagnostic inspection failed');
              },
            }),
        },
        {
          name: 'revoked proxy',
          create: () => {
            const { proxy, revoke } = Proxy.revocable(new Error(), {});
            revoke();
            return proxy;
          },
        },
        {
          name: 'throwing string coercion',
          create: () => ({
            [Symbol.toPrimitive]() {
              throw new Error('diagnostic coercion failed');
            },
          }),
        },
      ])('normalizes a $name without another attempt', async ({ create }) => {
        const { pending, operation, messagePrefix, details } =
          failInitialization(create());

        await expectConnectionError(
          pending,
          `${messagePrefix}: Error message unavailable`,
          details,
        );
        expect(operation).toHaveBeenCalledOnce();
        expect(withRetry).toHaveBeenCalledTimes(boundary === 'wallet' ? 0 : 1);
      });

      it.each([
        ...(['code', 'message', 'details'] as const).map((property) => ({
          name: `throwing SDK ${property} getter`,
          create: () =>
            Object.defineProperty(
              new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                'fetch failed',
              ),
              property,
              {
                get() {
                  throw new Error(`SDK ${property} inspection failed`);
                },
              },
            ),
        })),
        ...(
          [
            ['code', Symbol('connection code')],
            ['message', Symbol('connection message')],
            ['code', 503],
          ] as const
        ).map(([property, value]) => ({
          name: `non-string SDK ${property} (${typeof value})`,
          create: () =>
            Object.defineProperty(
              new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                'fetch failed',
              ),
              property,
              { value },
            ),
        })),
        {
          name: 'SDK get-trap proxy',
          create: () =>
            new Proxy(
              new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                'fetch failed',
              ),
              {
                get(target, property, receiver) {
                  // Promise machinery must be able to deliver this rejection.
                  if (property === 'then') return undefined;
                  if (property === 'code') {
                    throw new Error('SDK get trap failed');
                  }
                  return Reflect.get(target, property, receiver);
                },
              },
            ),
        },
        ...[
          'module',
          'partial',
          'sent',
          'httpStatus',
          'grpcCode',
          'transportCode',
        ].flatMap((property) =>
          ['hidden getter', 'omitted proxy key'].map((kind) => ({
            name: `SDK details ${property} ${kind}`,
            create: () => {
              const details =
                kind === 'hidden getter'
                  ? Object.defineProperty({}, property, {
                      get() {
                        throw new Error(`SDK ${property} inspection failed`);
                      },
                    })
                  : new Proxy(
                      {},
                      {
                        ownKeys: () => [],
                        get(_target, key) {
                          if (key === property) {
                            throw new Error(
                              `SDK ${property} inspection failed`,
                            );
                          }
                        },
                      },
                    );
              return new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                'fetch failed',
                details,
              );
            },
          })),
        ),
      ])(
        'normalizes a $name at the connection boundary',
        async ({ create }) => {
          const { pending, operation, messagePrefix, details } =
            failInitialization(create(), true, 0);

          await expectConnectionError(
            pending,
            `${messagePrefix}: Error message unavailable`,
            details,
          );
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it.each(['AbortError', 'TimeoutError', 'unreadable'])(
        'does not turn a %s name into an outer connection retry',
        async (name) => {
          const original = new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'fetch failed',
            {
              get extra() {
                throw new Error('extra unavailable');
              },
            },
          );
          Object.defineProperty(
            original,
            'name',
            name === 'unreadable'
              ? {
                  get() {
                    throw new Error('name unavailable');
                  },
                }
              : { value: name },
          );
          expect(isRetryableError(original)).toBe(false);
          const { pending, invoke, operation, messagePrefix, details } =
            failInitialization(original, true);
          let attempts = 0;
          const outer = withRetry<unknown>(
            () => (++attempts === 1 ? pending : invoke()),
            {
              config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
            },
          );
          await outer.then(
            () => {
              throw new Error('Expected a terminal connection failure');
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(ManifestMCPError);
              const normalized = error as ManifestMCPError;
              expect(normalized.code).toBe(
                name === 'unreadable'
                  ? ManifestMCPErrorCode.RPC_CONNECTION_FAILED
                  : ManifestMCPErrorCode.QUERY_FAILED,
              );
              expect(normalized.message).toBe(
                name === 'unreadable'
                  ? `${messagePrefix}: Error message unavailable`
                  : 'fetch failed',
              );
              expect(normalized.name).toBe(
                name === 'unreadable' ? 'ManifestMCPError' : name,
              );
              expect(normalized.details).toStrictEqual(details);
              expect('cause' in normalized).toBe(false);
              expect(isRetryableError(normalized)).toBe(false);
            },
          );
          expect(attempts).toBe(1);
          expect(operation).toHaveBeenCalledOnce();
        },
      );

      it.each(
        [
          ManifestMCPErrorCode.INVALID_CONFIG,
          ManifestMCPErrorCode.OPERATION_CANCELLED,
        ].flatMap((code) =>
          ['module', 'partial', 'httpStatus', 'details', 'cause', 'name'].map(
            (field) => ({ code, field }),
          ),
        ),
      )(
        'retains the terminal $code verdict when $field is unreadable',
        async ({ code, field }) => {
          const metadata = {
            reason: 'keyfile locked',
            expected: 'chain-a',
            actual: 'chain-b',
          };
          const original = new ManifestMCPError(
            code,
            code === ManifestMCPErrorCode.OPERATION_CANCELLED
              ? 'user cancelled'
              : 'keyfile locked',
            metadata,
          );
          const get = () => {
            throw new Error(`${field} unavailable`);
          };
          if (field === 'details') {
            Object.defineProperty(original, field, { get });
          } else if (field === 'cause' || field === 'name') {
            Object.defineProperty(original, field, { get });
            Object.defineProperty(metadata, 'extra', { enumerable: true, get });
          } else {
            Object.defineProperty(metadata, field, { get });
          }
          const { pending, operation, details } = failInitialization(
            original,
            true,
          );
          await pending.then(
            () => {
              throw new Error('Expected a terminal SDK failure');
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(ManifestMCPError);
              const normalized = error as ManifestMCPError;
              expect(normalized.code).toBe(code);
              expect(normalized.message).toBe(original.message);
              expect(normalized.details).toStrictEqual({
                ...details,
                ...(field === 'details'
                  ? {}
                  : {
                      reason: 'keyfile locked',
                      expected: 'chain-a',
                      actual: 'chain-b',
                    }),
              });
              expect('cause' in normalized).toBe(false);
              expect(isRetryableError(normalized)).toBe(false);
            },
          );
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it('retains independently readable details and caller endpoint precedence during repair', async () => {
        const metadata = {
          reason: 'wallet locked',
          expected: 'chain-a',
          actual: 'chain-b',
          rpcUrl: 'https://supplied-rpc.example.com',
          url: 'https://supplied-query.example.com',
        };
        const original = new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'keyfile locked',
          Object.defineProperty({ ...metadata }, 'extra', {
            enumerable: true,
            get() {
              throw new Error('extra unavailable');
            },
          }),
        );
        const { pending, operation } = failInitialization(original, true);
        await pending.then(
          () => {
            throw new Error('Expected initialization to fail');
          },
          (error: unknown) => {
            expect(error).toBeInstanceOf(ManifestMCPError);
            const normalized = error as ManifestMCPError;
            expect(normalized.code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
            expect(normalized.message).toBe('keyfile locked');
            expect(normalized.details).toStrictEqual(metadata);
            expect('cause' in normalized).toBe(false);
          },
        );
        expect(operation).toHaveBeenCalledOnce();
      });

      it.each(['terminal', 'transient', 'getter', 'inherited'] as const)(
        'preserves an existing %s cause when repairing incidental details',
        async (kind) => {
          const cause =
            kind === 'transient'
              ? new Error('ECONNRESET')
              : new ManifestMCPError(
                  ManifestMCPErrorCode.TX_FAILED,
                  'do not replay',
                );
          const original = new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            kind === 'transient' ? 'query failed' : 'fetch failed',
            {
              get extra() {
                throw new Error('extra diagnostic unavailable');
              },
            },
          );
          if (kind === 'inherited') {
            Object.setPrototypeOf(
              original,
              Object.create(Object.getPrototypeOf(original), {
                cause: { value: cause },
              }),
            );
          } else {
            Object.defineProperty(
              original,
              'cause',
              kind === 'getter' ? { get: () => cause } : { value: cause },
            );
          }
          const retryable = kind === 'transient';
          expect(isRetryableError(original)).toBe(retryable);
          const { pending, operation, details } = failInitialization(
            original,
            true,
            retryable ? 0 : 2,
          );
          await pending.then(
            () => {
              throw new Error('Expected initialization to fail');
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(ManifestMCPError);
              const normalized = error as ManifestMCPError;
              expect(normalized.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
              expect(normalized.message).toBe(original.message);
              expect(normalized.details).toStrictEqual(details);
              const descriptor = Object.getOwnPropertyDescriptor(
                normalized,
                'cause',
              );
              expect(descriptor?.value === cause).toBe(true);
              expect(descriptor?.enumerable).toBe(false);
              expect(isRetryableError(normalized)).toBe(retryable);
            },
          );
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it('uses the conservative endpoint fallback when an existing cause cannot be read during repair', async () => {
        const original = Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'fetch failed',
            {
              get extra() {
                throw new Error('extra diagnostic unavailable');
              },
            },
          ),
          'cause',
          {
            get() {
              throw new Error('cause unavailable');
            },
          },
        );
        const { pending, operation, messagePrefix, details } =
          failInitialization(original, true);
        await expectConnectionError(
          pending,
          `${messagePrefix}: Error message unavailable`,
          details,
        );
        expect(operation).toHaveBeenCalledOnce();
        expect(withRetry).toHaveBeenCalledTimes(boundary === 'wallet' ? 0 : 1);
      });

      it.each([
        { kind: 'ordinary', standalone: false, transient: true, owned: true },
        {
          kind: 'AbortError',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'TimeoutError',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'abort cause',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'timeout cause',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'permanent code',
          standalone: false,
          transient: false,
          owned: false,
        },
        {
          kind: 'permanent cause',
          standalone: false,
          transient: false,
          owned: false,
        },
        {
          kind: 'transient cause',
          standalone: true,
          transient: true,
          owned: true,
        },
        { kind: 'HTTP 503', standalone: true, transient: true, owned: true },
        { kind: 'gRPC 14', standalone: true, transient: true, owned: true },
        { kind: 'HTTP 403', standalone: false, transient: false, owned: false },
        { kind: 'gRPC 2', standalone: false, transient: false, owned: false },
        {
          kind: 'unreadable status',
          standalone: false,
          transient: false,
          owned: false,
        },
        {
          kind: 'unreadable name',
          standalone: false,
          transient: false,
          owned: false,
        },
        {
          kind: 'unreadable cause',
          standalone: false,
          transient: false,
          owned: false,
        },
        {
          kind: 'module getter',
          standalone: false,
          transient: true,
          owned: true,
        },
        {
          kind: 'AbortError module getter',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'TimeoutError module getter',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'AbortError transport getter',
          standalone: false,
          transient: false,
          owned: true,
        },
        {
          kind: 'TimeoutError transport getter',
          standalone: false,
          transient: false,
          owned: true,
        },
      ])(
        'preserves nested retry semantics for a repaired $kind envelope through Cosmos attribution',
        async ({ kind, standalone, transient, owned }) => {
          const facts: Record<string, unknown> = {
            get extra() {
              throw new Error('incidental diagnostic unavailable');
            },
          };
          if (kind.startsWith('HTTP '))
            facts.httpStatus = Number(kind.slice(5));
          if (kind.startsWith('gRPC ')) facts.grpcCode = Number(kind.slice(5));
          const original = new ManifestMCPError(
            kind === 'permanent code'
              ? ManifestMCPErrorCode.INVALID_CONFIG
              : ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'connection ended',
            facts,
          );
          if (kind === 'AbortError' || kind === 'TimeoutError')
            original.name = kind;
          if (kind.endsWith(' getter')) {
            Object.defineProperty(
              facts,
              kind.endsWith('module getter') ? 'module' : 'transportCode',
              {
                get() {
                  throw new Error('unused diagnostic unavailable');
                },
              },
            );
            if (kind.startsWith('AbortError')) original.name = 'AbortError';
            if (kind.startsWith('TimeoutError')) original.name = 'TimeoutError';
          }
          if (kind.endsWith(' cause') && kind !== 'unreadable cause') {
            Object.defineProperty(original, 'cause', {
              value:
                kind === 'permanent cause'
                  ? new ManifestMCPError(
                      ManifestMCPErrorCode.TX_FAILED,
                      'reconcile',
                    )
                  : kind === 'transient cause'
                    ? new Error('ECONNRESET')
                    : new DOMException(
                        'operation ended',
                        kind === 'abort cause' ? 'AbortError' : 'TimeoutError',
                      ),
            });
          }
          if (kind.startsWith('unreadable ')) {
            Object.defineProperty(
              kind === 'unreadable status' ? facts : original,
              kind === 'unreadable status' ? 'httpStatus' : kind.slice(11),
              {
                get() {
                  throw new Error('retry diagnostic unavailable');
                },
              },
            );
          }
          const envelopes = (error: Error, afterAttribution = false) => [
            {
              error,
              // Attribution historically drops an already-retryable connection
              // error's cause. Repairing unrelated details must not add retries.
              retryable:
                kind === 'transient cause' && afterAttribution
                  ? false
                  : standalone,
            },
            {
              error: Object.defineProperty(new Error('fetch failed'), 'cause', {
                value: error,
                configurable: true,
                writable: true,
              }),
              retryable: transient,
            },
            {
              error: Object.assign(
                new ManifestMCPError(
                  ManifestMCPErrorCode.QUERY_FAILED,
                  'transport deadline',
                  { transportCode: 'ETIMEDOUT' },
                ),
                { cause: error },
              ),
              retryable: owned,
            },
          ];
          for (const { error, retryable } of envelopes(original)) {
            expect(isRetryableError(error)).toBe(retryable);
          }

          const { pending, operation } = failInitialization(original, true, 0);
          const normalized = await pending.then(
            () => {
              throw new Error('Expected initialization to fail');
            },
            (error: unknown) => error as ManifestMCPError,
          );
          expect(normalized === original).toBe(false);
          expect(operation).toHaveBeenCalledOnce();

          let current = normalized;
          for (let attribution = 0; attribution < 3; attribution += 1) {
            for (const { error, retryable } of envelopes(
              current,
              attribution > 0,
            )) {
              expect(isRetryableError(error)).toBe(retryable);
              const attempt = vi.fn().mockRejectedValue(error);
              await expect(
                withRetry(attempt, {
                  config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
                }),
              ).rejects.toBe(error);
              expect(attempt).toHaveBeenCalledTimes(retryable ? 3 : 1);
            }
            if (attribution === 2) break;
            if (current.details) delete current.details.module;
            const manager = {
              getQueryClient: vi.fn().mockRejectedValue(current),
            } as unknown as CosmosClientManager;
            const attributed = await cosmosQuery(
              manager,
              'bank',
              'balances',
            ).then(
              () => {
                throw new Error('Expected query acquisition to fail');
              },
              (error: unknown) => error as ManifestMCPError,
            );
            expect(attributed).not.toBe(current);
            expect(attributed.details?.module).toBe('bank');
            if (kind === 'transient cause')
              expect('cause' in attributed).toBe(false);
            current = attributed;
          }
        },
      );

      it.each(
        [
          'TX_FAILED',
          'sent',
          'partial',
          'INVALID_CONFIG',
          'NOT_FOUND',
          'ENOTFOUND',
          'HTTP 400',
          'gRPC 5',
          'AbortError',
          'TimeoutError',
        ].flatMap((causeKind) =>
          ['connection ended', 'fetch failed'].flatMap((message) =>
            ['module', 'extra'].map((field) => ({ causeKind, message, field })),
          ),
        ),
      )(
        'retains a $causeKind cause with $field unreadable and message "$message" through real connection attempts',
        async ({ causeKind, message, field }) => {
          const facts =
            causeKind === 'TX_FAILED' || causeKind === 'sent'
              ? { sent: true, transactionHash: 'A'.repeat(64) }
              : causeKind === 'partial'
                ? { partial: true, lease_uuid: 'paid-lease' }
                : causeKind === 'HTTP 400'
                  ? { httpStatus: 400 }
                  : causeKind === 'gRPC 5'
                    ? { httpStatus: 500, grpcCode: 5 }
                    : {};
          const cancellation =
            causeKind === 'AbortError' || causeKind === 'TimeoutError';
          const cause = cancellation
            ? new DOMException('operation ended', causeKind)
            : causeKind === 'ENOTFOUND'
              ? Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })
              : new ManifestMCPError(
                  causeKind === 'TX_FAILED'
                    ? ManifestMCPErrorCode.TX_FAILED
                    : causeKind === 'INVALID_CONFIG'
                      ? ManifestMCPErrorCode.INVALID_CONFIG
                      : causeKind === 'NOT_FOUND'
                        ? ManifestMCPErrorCode.NOT_FOUND
                        : ManifestMCPErrorCode.QUERY_FAILED,
                  'upstream operation ended',
                  facts,
                );
          const failedField = vi.fn(() => {
            throw new Error('diagnostic unavailable');
          });
          const original = Object.assign(
            new ManifestMCPError(
              ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
              message,
              Object.defineProperty({}, field, {
                enumerable: true,
                get: failedField,
              }),
            ),
            { cause },
          );
          expect(isRetryableError(original)).toBe(false);

          for (const enclosing of ['none', 'transient', 'owned deadline']) {
            const retryable = cancellation && enclosing === 'owned deadline';
            let finalFailure: Error | undefined;
            const attempt = vi.fn(async () => {
              const { pending, operation, callsBefore } = failInitialization(
                original,
                true,
                0,
              );
              const normalized = await pending.then(
                () => {
                  throw new Error('Expected initialization to fail');
                },
                (error: unknown) => error as ManifestMCPError,
              );
              expect(operation).toHaveBeenCalledTimes(callsBefore + 1);
              expect(normalized === original).toBe(false);
              expect(normalized.code).toBe(
                ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
              );
              expect(normalized.message).toBe(message);
              expect(normalized.name).toBe('ManifestMCPError');
              let current = normalized;
              for (let attribution = 0; attribution < 3; attribution += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(
                  current,
                  'cause',
                );
                expect(descriptor?.value === cause).toBe(true);
                expect(descriptor?.enumerable).toBe(false);
                if (cause instanceof ManifestMCPError)
                  expect(cause.details).toStrictEqual(facts);
                expect(isRetryableError(current)).toBe(false);
                if (attribution === 2) break;
                if (current.details) delete current.details.module;
                current = await cosmosQuery(
                  {
                    getQueryClient: vi.fn().mockRejectedValue(current),
                  } as unknown as CosmosClientManager,
                  'bank',
                  'balances',
                ).then(
                  () => {
                    throw new Error('Expected query acquisition to fail');
                  },
                  (error: unknown) => error as ManifestMCPError,
                );
                expect(current.details?.module).toBe('bank');
              }
              const failure =
                enclosing === 'none'
                  ? current
                  : Object.assign(
                      enclosing === 'transient'
                        ? new Error('fetch failed')
                        : new ManifestMCPError(
                            ManifestMCPErrorCode.QUERY_FAILED,
                            'transport deadline',
                            { transportCode: 'ETIMEDOUT' },
                          ),
                      { cause: current },
                    );
              expect(isRetryableError(failure)).toBe(retryable);
              finalFailure = failure;
              throw failure;
            });
            const rejection = await withRetry(attempt, {
              config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
            }).then(
              () => {
                throw new Error('Expected enclosing operation to fail');
              },
              (error: unknown) => error,
            );
            // Assertion failures inside an attempt must escape the retry harness.
            if (rejection !== finalFailure) throw rejection;
            expect(attempt).toHaveBeenCalledTimes(retryable ? 3 : 1);
          }
          expect(failedField).toHaveBeenCalled();
        },
      );

      it.each(['httpStatus', 'grpcCode', 'transportCode', 'partial', 'sent'])(
        'does not copy a transient cause when inspecting %s fails',
        async (field) => {
          const failedField = vi.fn(() => {
            throw new Error('classifier diagnostic unavailable');
          });
          const original = Object.assign(
            new ManifestMCPError(
              ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
              'connection ended',
              Object.defineProperty({}, field, { get: failedField }),
            ),
            { cause: new Error('fetch failed') },
          );
          let finalFailure: Error | undefined;
          const attempt = vi.fn(async () => {
            const { pending, operation, callsBefore } = failInitialization(
              original,
              true,
              0,
            );
            const normalized = await pending.then(
              () => {
                throw new Error('Expected initialization to fail');
              },
              (error: unknown) => error as ManifestMCPError,
            );
            expect(operation).toHaveBeenCalledTimes(callsBefore + 1);
            expect(
              Object.getOwnPropertyDescriptor(normalized, 'cause'),
            ).toBeUndefined();
            const attributed = await cosmosQuery(
              {
                getQueryClient: vi.fn().mockRejectedValue(normalized),
              } as unknown as CosmosClientManager,
              'bank',
              'balances',
            ).then(
              () => {
                throw new Error('Expected query acquisition to fail');
              },
              (error: unknown) => error as ManifestMCPError,
            );
            const wrapper = Object.assign(
              new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                'fetch failed',
                { transportCode: 'ETIMEDOUT' },
              ),
              { cause: attributed },
            );
            expect(isRetryableError(wrapper)).toBe(false);
            finalFailure = wrapper;
            throw wrapper;
          });
          const rejection = await withRetry(attempt, {
            config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
          }).then(
            () => {
              throw new Error('Expected enclosing operation to fail');
            },
            (error: unknown) => error,
          );
          if (rejection !== finalFailure) throw rejection;
          expect(attempt).toHaveBeenCalledOnce();
          expect(failedField).toHaveBeenCalled();
        },
      );

      it.each(['name', 'cause'])(
        'keeps a repaired %s that becomes unreadable terminal through later attribution',
        async (field) => {
          const original = new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'connection ended',
            {
              get extra() {
                throw new Error('incidental diagnostic unavailable');
              },
            },
          );
          const { pending, operation } = failInitialization(original, true, 0);
          const normalized = await pending.then(
            () => {
              throw new Error('Expected initialization to fail');
            },
            (error: unknown) => error as ManifestMCPError,
          );
          Object.defineProperty(normalized, field, {
            get() {
              throw new Error('changed diagnostic unavailable');
            },
          });
          const manager = {
            getQueryClient: vi.fn().mockRejectedValue(normalized),
          } as unknown as CosmosClientManager;
          const attributed = await cosmosQuery(
            manager,
            'bank',
            'balances',
          ).then(
            () => {
              throw new Error('Expected query acquisition to fail');
            },
            (error: unknown) => error as ManifestMCPError,
          );
          expect(attributed === normalized).toBe(false);
          expect(attributed.code).toBe(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          );
          expect(attributed.message).toBe('connection ended');
          expect(attributed.details?.module).toBe('bank');
          const wrapper = Object.assign(
            new ManifestMCPError(
              ManifestMCPErrorCode.QUERY_FAILED,
              'fetch failed',
              {
                transportCode: 'ETIMEDOUT',
              },
            ),
            { cause: attributed },
          );
          expect(isRetryableError(wrapper)).toBe(false);
          const attempt = vi.fn().mockRejectedValue(wrapper);
          await expect(
            withRetry(attempt, {
              config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
            }),
          ).rejects.toBe(wrapper);
          expect(attempt).toHaveBeenCalledOnce();
          expect(operation).toHaveBeenCalledOnce();
        },
      );

      it.each(['extra getter', 'ownKeys trap'])(
        'preserves the SDK verdict when only details %s is unreadable',
        async (kind) => {
          const facts = { sent: true, transactionHash: 'A'.repeat(64) };
          const details =
            kind === 'extra getter'
              ? Object.defineProperty({ ...facts }, 'extra', {
                  enumerable: true,
                  get() {
                    throw new Error('extra diagnostic unavailable');
                  },
                })
              : new Proxy(facts, {
                  ownKeys() {
                    throw new Error('details enumeration unavailable');
                  },
                });
          const original = new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'keyfile locked',
            details,
          );
          const {
            pending,
            operation,
            details: endpoint,
          } = failInitialization(original, true);

          await pending.then(
            () => {
              throw new Error('Expected initialization to fail');
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(ManifestMCPError);
              expect(error === original).toBe(false);
              const normalized = error as ManifestMCPError;
              expect(normalized.code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
              expect(normalized.message).toBe('keyfile locked');
              expect(normalized.details).toStrictEqual({
                ...facts,
                ...endpoint,
              });
              expect('cause' in normalized).toBe(false);
            },
          );
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it.each([
        { name: 'HTTP 403', status: { httpStatus: 403 } },
        { name: 'gRPC 2', status: { httpStatus: 500, grpcCode: 2 } },
        {
          name: 'HTTP 403 getter',
          status: {
            get httpStatus() {
              return 403;
            },
          },
        },
        {
          name: 'submitted getter',
          status: {
            get sent() {
              return true;
            },
          },
        },
        {
          name: 'partial getter',
          status: {
            get partial() {
              return true;
            },
          },
        },
      ])(
        'retains terminal $name when other details cannot be enumerated',
        async ({ status }) => {
          const original = new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'fetch failed',
            new Proxy(status, {
              ownKeys() {
                throw new Error('details enumeration unavailable');
              },
            }),
          );
          expect(isRetryableError(original)).toBe(false);
          const { pending, operation, details } = failInitialization(
            original,
            true,
          );
          await pending.then(
            () => {
              throw new Error('Expected initialization to fail');
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(ManifestMCPError);
              const normalized = error as ManifestMCPError;
              expect(normalized.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
              expect(normalized.message).toBe('fetch failed');
              expect(normalized.details).toStrictEqual({
                ...status,
                ...details,
              });
              expect(isRetryableError(normalized)).toBe(false);
              expect('cause' in normalized).toBe(false);
            },
          );
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it.each([Symbol('fetch failed'), ['fetch failed']])(
        'does not coerce a non-string Error message (%s) into a transient connection error',
        async (message) => {
          const original = Object.defineProperty(new Error(), 'message', {
            value: message,
          });
          const { pending, operation, messagePrefix, details } =
            failInitialization(original);

          await expectConnectionError(
            pending,
            `${messagePrefix}: Error message unavailable`,
            details,
          );
          await pending.catch((error: unknown) => {
            expect(isRetryableError(error)).toBe(false);
          });
          expect(operation).toHaveBeenCalledOnce();
          expect(withRetry).toHaveBeenCalledTimes(
            boundary === 'wallet' ? 0 : 1,
          );
        },
      );

      it('preserves the identity and details of a readable SDK error', async () => {
        const original = new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'custom configuration error',
          { source: boundary },
        );
        const { pending, operation } = failInitialization(original, true);

        await expect(pending).rejects.toBe(original);
        expect(operation).toHaveBeenCalledOnce();
        expect(withRetry).toHaveBeenCalledTimes(boundary === 'wallet' ? 0 : 1);
      });
    },
  );

  describe('getInstance', () => {
    it('returns same instance for same chainId:rpcUrl', () => {
      const config = makeConfig();
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
    });

    it('returns different instances for different rpcUrl', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: 'https://a.com' }),
        wallet,
      );
      const b = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: 'https://b.com' }),
        wallet,
      );
      expect(a).not.toBe(b);
    });

    it('returns different instances for different chainId', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'chain-a' }),
        wallet,
      );
      const b = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'chain-b' }),
        wallet,
      );
      expect(a).not.toBe(b);
    });

    it('isolates signing clients when gasPrice changes', async () => {
      const wallet = makeWallet();
      const client1 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      const client2 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '1.0umfx' }),
        wallet,
      );
      const sc1 = await instance.getSigningClient();
      expect(sc1).toBe(client1);
      // Pin the pair: a live client is NOT disconnected at init (pre-ENG-636 the always-taken
      // supersede branch disconnected it here), and IS disconnected when eviction evicts it.
      expect(client1.disconnect).not.toHaveBeenCalled();

      // A new policy gets a separate manager, preserving the existing client.
      const other = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '2.0umfx' }),
        wallet,
      );
      const sc2 = await other.getSigningClient();
      expect(sc2).toBe(client2);
      expect(await instance.getSigningClient()).toBe(client1);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
      expect(client1.disconnect).not.toHaveBeenCalled();
    });

    it('isolates signing clients when gasMultiplier changes', async () => {
      const wallet = makeWallet();
      const client1 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      const client2 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 1.5 }),
        wallet,
      );
      const sc1 = await instance.getSigningClient();
      expect(sc1).toBe(client1);

      const other = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.5 }),
        wallet,
      );
      const sc2 = await other.getSigningClient();
      expect(sc2).toBe(client2);
      expect(await instance.getSigningClient()).toBe(client1);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('isolates signing clients when walletProvider changes', async () => {
      const wallet1 = makeWallet();
      const wallet2 = makeWallet();

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet1);
      await instance.getSigningClient();

      const other = CosmosClientManager.getInstance(makeConfig(), wallet2);
      expect(other).not.toBe(instance);
      await other.getSigningClient();
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('does not invalidate signing client when only rate limit changes', async () => {
      const wallet = makeWallet();
      const config1 = makeConfig({ rateLimit: { requestsPerSecond: 10 } });
      const instance = CosmosClientManager.getInstance(config1, wallet);
      await instance.getSigningClient();

      const config2 = makeConfig({ rateLimit: { requestsPerSecond: 20 } });
      CosmosClientManager.getInstance(config2, wallet);
      await instance.getSigningClient();
      // Same signing client reused — only 1 call
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });
  });

  describe('getQueryClient', () => {
    it('creates and returns query client', async () => {
      const mockQC = { mock: 'queryClient' };
      mockCreateRPCQueryClient.mockResolvedValue(mockQC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client1 = await instance.getQueryClient();
      const client2 = await instance.getQueryClient();

      expect(client1).toMatchObject(mockQC);
      expect(client1).toHaveProperty('cosmwasm');
      expect(client2).toBe(client1); // cached
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
      expect(mockCreateCosmwasmRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      let resolveInit!: (value: any) => void;
      mockCreateRPCQueryClient.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve;
          }) as any,
      );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient();
      const p2 = instance.getQueryClient();

      await vi.waitFor(() =>
        expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce(),
      );
      resolveInit({ mock: 'queryClient' });

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toMatchObject({ mock: 'queryClient' });
      expect(c1).toHaveProperty('cosmwasm');
      expect(c2).toBe(c1);
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
      expect(mockCreateCosmwasmRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockCreateRPCQueryClient.mockRejectedValue(new Error('ECONNREFUSED'));

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('ECONNREFUSED'),
      });
    });

    it('re-throws ManifestMCPError as-is', async () => {
      const original = new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'custom',
      );
      mockCreateRPCQueryClient.mockRejectedValue(original);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toBe(original);
    });

    it('does not latch a rejected init — a transient failure recovers on the next call (ENG-636)', async () => {
      mockCreateRPCQueryClient
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ mock: 'qc-recovered' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );

      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });
      // Before ENG-636 the rejected promise stayed in queryClientPromise and every later
      // caller re-awaited it: one transient RPC blip was a permanent outage until restart.
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc-recovered',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });

    it('does not latch a rejected LCD init either (ENG-636)', async () => {
      mockCreateLCDQueryClient
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ mock: 'lcd-recovered' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: undefined, restUrl: 'https://lcd.example.com' }),
        makeWallet(),
      );

      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('REST'),
      });
      await expect(instance.getQueryClient()).resolves.toEqual({
        mock: 'lcd-recovered',
      });
      expect(mockCreateLCDQueryClient).toHaveBeenCalledTimes(2);
    });

    it('promotes the resolved client to the object cache and releases the slot (ENG-636)', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client = await instance.getQueryClient();

      // From the outside a latched resolved promise and a real object cache are
      // indistinguishable, so probe the private slots directly (the same private-state cast
      // the rateLimiter tests use). Before ENG-636 `queryClient` was never populated and the
      // promise slot was never released — the documented caching layer was dead code.
      const priv = instance as unknown as {
        queryClient: unknown;
        queryClientPromise: unknown;
      };
      expect(priv.queryClient).toBe(client);
      expect(priv.queryClientPromise).toBeNull();
    });

    it('supersedes an in-flight init when teardown lands mid-flight (ENG-636)', async () => {
      let resolveInit!: (value: any) => void;
      mockCreateRPCQueryClient.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve;
          }) as any,
      );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient(); // init #1 owns the slot
      await vi.waitFor(() =>
        expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce(),
      );
      instance.disconnect(); // refCount 1 -> 0 -> teardown() nulls the slot

      resolveInit({ mock: 'qc1' });
      // The caller that asked for it is still served: a query client is stateless HTTP with
      // nothing to release, so being superseded only means "not cached".
      await expect(p1).resolves.toMatchObject({ mock: 'qc1' });

      mockCreateRPCQueryClient.mockResolvedValueOnce({ mock: 'qc2' } as any);
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc2',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });

    it('identity guard is load-bearing: a stale init must not clobber a newer one (ENG-636)', async () => {
      let resolve1!: (value: any) => void;
      let resolve2!: (value: any) => void;
      mockCreateRPCQueryClient
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolve1 = resolve;
            }) as any,
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolve2 = resolve;
            }) as any,
        );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient(); // init #1 owns the slot
      await vi.waitFor(() =>
        expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce(),
      );
      instance.disconnect(); // teardown nulls the slot
      const p2 = instance.getQueryClient(); // init #2 owns the slot
      await vi.waitFor(() =>
        expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2),
      );

      // Settle the NEWER init first, then the stale one. That order is what makes this test
      // discriminating: if #1 settled first, #2's own handler would repair the damage and the
      // test would still pass with the guard deleted.
      resolve2({ mock: 'qc2' });
      await expect(p2).resolves.toMatchObject({ mock: 'qc2' });
      resolve1({ mock: 'qc1' });
      await expect(p1).resolves.toMatchObject({ mock: 'qc1' });

      // With the guard, #1's stale handler sees `slot !== p` and changes nothing. Without it,
      // the cache now holds qc1 and this assertion fails.
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc2',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSigningClient', () => {
    it.each(['native', 'broadcastTx', 'broadcastTxSync'] as const)(
      'reports broadcast guard support for %s methods once per connection',
      async (method) => {
        const actual =
          await vi.importActual<typeof import('@cosmjs/stargate')>(
            '@cosmjs/stargate',
          );
        const signingClient = await actual.SigningStargateClient.offline({
          getAccounts: async () => [],
          signDirect: async () => {
            throw new Error('Unexpected signing in client initialization test');
          },
        });
        vi.spyOn(signingClient, 'getChainId').mockResolvedValue('test-chain');
        if (method !== 'native') vi.spyOn(signingClient, method);
        const broadcast = signingClient.broadcastTx;
        const sync = signingClient.broadcastTxSync;
        mockConnectWithSigner.mockResolvedValue(signingClient);
        const spyLogger = makeSpyLogger();
        const instance = CosmosClientManager.getInstance(
          makeConfig(),
          makeWallet(),
        );
        instance.setLogger(spyLogger);

        await expect(instance.getSigningClient()).resolves.toBe(signingClient);
        await expect(instance.getSigningClient()).resolves.toBe(signingClient);

        if (method === 'native') {
          expect(spyLogger.warn).not.toHaveBeenCalled();
          expect(signingClient.broadcastTx).not.toBe(broadcast);
        } else {
          expect(spyLogger.warn).toHaveBeenCalledExactlyOnceWith(
            'Broadcast failure guard could not be installed: signing client broadcast methods differ from the supported native implementation. ' +
              'Failures after submission may omit sent and transactionHash diagnostics.',
          );
          expect(signingClient.broadcastTx).toBe(broadcast);
        }
        expect(signingClient.broadcastTxSync).toBe(sync);
        expect(mockConnectWithSigner).toHaveBeenCalledOnce();
      },
    );

    it('overrides defaultGasMultiplier when property exists', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
        defaultGasMultiplier: 1.4,
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

      expect(mockSC.defaultGasMultiplier).toBe(1.5);
    });

    it('applies custom gasMultiplier from config', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
        defaultGasMultiplier: 1.4,
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.5 }),
        makeWallet(),
      );
      await instance.getSigningClient();

      expect(mockSC.defaultGasMultiplier).toBe(2.5);
    });

    it('warns when defaultGasMultiplier is absent', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect((mockSC as any).defaultGasMultiplier).toBeUndefined();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not be applied'),
      );
    });

    it('warns with custom multiplier when defaultGasMultiplier is absent', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.0 }),
        makeWallet(),
      );
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('gasMultiplier 2 could not be applied'),
      );
    });

    it.each([
      { warning: 'gasMultiplier', defaultGasMultiplier: undefined },
      { warning: 'Broadcast failure guard', defaultGasMultiplier: 1.4 },
    ])(
      'releases the connected client if the $warning diagnostic throws',
      async ({ warning, defaultGasMultiplier }) => {
        const sinkError = new Error('diagnostic sink failed');
        const mockSC = {
          getChainId: vi.fn().mockResolvedValue('test-chain'),
          defaultGasMultiplier,
          disconnect: vi.fn(() => {
            throw new Error('cleanup also failed');
          }),
        };
        mockConnectWithSigner.mockResolvedValue(mockSC as any);
        const sink = makeSpyLogger();
        sink.warn.mockImplementation(() => {
          throw sinkError;
        });
        const manager = CosmosClientManager.getInstance(
          makeConfig(),
          makeWallet(),
        );
        manager.setLogger(sink);

        await expect(manager.getSigningClient()).rejects.toMatchObject({
          code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          message: 'Failed to connect signing client: diagnostic sink failed',
        });
        expect(sink.warn).toHaveBeenCalledWith(
          expect.stringContaining(warning),
        );
        expect(mockSC.disconnect).toHaveBeenCalledOnce();

        // Failed initialization is not cached; replacing the sink permits a fresh connection.
        manager.setLogger(makeSpyLogger());
        const fresh = { ...mockSC, disconnect: vi.fn() };
        mockConnectWithSigner.mockResolvedValue(fresh as any);
        await expect(manager.getSigningClient()).resolves.toBe(fresh);
        expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
        expect(fresh.disconnect).not.toHaveBeenCalled();
      },
    );

    it('setLogger is non-key and non-invalidating: same instance AND same cached signing client', async () => {
      // setLogger is not part of the getInstance key or the
      // invalidation gate — so calling it between two same-key getInstance calls must neither
      // fragment the singleton nor drop the cached signing client. SAME wallet reference both
      // calls: a fresh makeWallet() would trip the reference-equality wallet-invalidation gate
      // (client.ts getInstance). The caching half of this proof used to be unassertable because
      // getSigningClient() never populated `this.signingClient` (ENG-636); it is asserted now.
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const w = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig(), w);
      const sc1 = await a.getSigningClient();
      a.setLogger(makeSpyLogger());
      const b = CosmosClientManager.getInstance(makeConfig(), w);

      expect(b).toBe(a);
      expect(await b.getSigningClient()).toBe(sc1);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
      expect(mockSC.disconnect).not.toHaveBeenCalled();
    });

    it.each([
      { assignments: ['first', 'noop'], expected: 'first' },
      { assignments: ['noop', 'second'], expected: 'second' },
      { assignments: ['first', 'second', 'noop'], expected: 'second' },
    ] as const)(
      'shares the last configured sink after $assignments and a holder disconnects',
      async ({ assignments, expected }) => {
        const sinks = {
          first: makeSpyLogger(),
          second: makeSpyLogger(),
          noop: noopLogger,
        };
        const wallet = makeWallet();
        const manager = CosmosClientManager.getInstance(makeConfig(), wallet);
        for (const assignment of assignments) {
          const holder = CosmosClientManager.getInstance(makeConfig(), wallet);
          expect(holder).toBe(manager);
          holder.setLogger(sinks[assignment]);
          // Releasing this holder neither silences nor restores another sink;
          // the original holder keeps the shared manager alive.
          holder.disconnect();
        }

        await expect(manager.getSigningClient()).resolves.toBeDefined();

        expect(sinks[expected].warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'Broadcast failure guard could not be installed',
          ),
        );
        expect(
          sinks[expected === 'first' ? 'second' : 'first'].warn,
        ).not.toHaveBeenCalled();
        expect(mockConnectWithSigner).toHaveBeenCalledOnce();
        manager.disconnect();
      },
    );

    it('is SILENT by default when setLogger is never called (the warn goes to the frozen noopLogger)', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      }; // no defaultGasMultiplier → triggers the warn branch
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      // No setLogger → this.logger is the real frozen noopLogger; the warn must be swallowed, no throw.
      await expect(instance.getSigningClient()).resolves.toBeDefined();
    });

    it('creates and returns signing client', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client1 = await instance.getSigningClient();
      const client2 = await instance.getSigningClient();

      expect(client1).toBe(mockSC);
      expect(client2).toBe(mockSC);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      // Defer at the getSigner level to keep init #1 in flight while both calls are made.
      // (Post-ENG-636 the slot assignment is unconditionally synchronous inside the accessor,
      // so the deferral is no longer needed to win a race against it — it just holds the
      // window open long enough for the second call to observe the in-flight promise.)
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        getSigner: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSigner = resolve;
            }),
        ),
      });

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const p1 = instance.getSigningClient();
      const p2 = instance.getSigningClient();

      resolveSigner({});

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toBe(c2);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it('does not latch a rejected init — a transient failure recovers on the next call (ENG-636)', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );

      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });
      await expect(instance.getSigningClient()).resolves.toBe(mockSC);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('a successful init does NOT disconnect the client it returns, and caches it (ENG-636)', async () => {
      // Two assertions that cannot both hold on the pre-fix code: the supersede `else` branch
      // fired on EVERY successful init, disconnecting the client it was about to return, and
      // `this.signingClient` was never populated so teardown had nothing to disconnect. The
      // spurious init-time disconnect was inert only by accident — @cosmjs/tendermint-rpc's
      // HttpClient.disconnect() is a no-op — so a WebSocket endpoint would have been closed
      // the instant it was created.
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client = await instance.getSigningClient();

      expect(client).toBe(mockSC);
      expect(mockSC.disconnect).not.toHaveBeenCalled();

      instance.disconnect(); // refCount 1 -> 0 -> teardown()
      // Only reachable if `this.signingClient` was actually populated.
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('supersede: teardown mid-init releases the orphan and fails the caller (ENG-636)', async () => {
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        getSigner: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSigner = resolve;
            }),
        ),
      });
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const p1 = instance.getSigningClient(); // init in flight
      instance.disconnect(); // refCount 1 -> 0 -> teardown() nulls the slot

      resolveSigner({});

      // Unlike the query client this one owns a live transport, so the orphan must be released
      // and must NOT be handed back — the caller is told to retry for the current config.
      await expect(p1).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { reason: 'superseded' },
      });
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it.each(['message getter', 'revoked proxy', 'string coercion', 'logger'])(
      'preserves the superseded verdict when cleanup diagnostics fail via %s',
      async (failure) => {
        let cleanupError: unknown = new Error('cleanup failed');
        if (failure === 'message getter') {
          cleanupError = Object.defineProperty(new Error(), 'message', {
            get() {
              throw new Error('cleanup message inspection failed');
            },
          });
        } else if (failure === 'revoked proxy') {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          cleanupError = proxy;
        } else if (failure === 'string coercion') {
          cleanupError = {
            [Symbol.toPrimitive]() {
              throw new Error('cleanup coercion failed');
            },
          };
        }
        const signer = await makeWallet().getSigner();
        let releaseSigner!: () => void;
        const wallet = makeWallet({
          getSigner: vi.fn<WalletProvider['getSigner']>(
            () =>
              new Promise((resolve) => {
                releaseSigner = () => resolve(signer);
              }),
          ),
        });
        let disconnectCalls = 0;
        const orphan = {
          getChainId: vi.fn().mockResolvedValue('test-chain'),
          disconnect() {
            disconnectCalls++;
            throw cleanupError;
          },
        };
        mockConnectWithSigner.mockResolvedValue(
          orphan as unknown as SigningStargateClient,
        );
        const manager = CosmosClientManager.getInstance(makeConfig(), wallet);
        const logger = makeSpyLogger();
        if (failure === 'logger') {
          logger.debug.mockImplementation(() => {
            throw new Error('cleanup logger failed');
          });
        }
        manager.setLogger(logger);
        const pending = manager.getSigningClient();
        manager.disconnect();
        releaseSigner();

        await expect(pending).rejects.toMatchObject({
          code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          message: expect.stringContaining('superseded'),
          details: {
            rpcUrl: 'https://rpc.example.com',
            reason: 'superseded',
          },
        });
        expect(disconnectCalls).toBe(1);
        expect(mockConnectWithSigner).toHaveBeenCalledOnce();
      },
    );

    it('a new config cannot supersede another holder’s pending signing initialization', async () => {
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        // Defer only the FIRST getSigner so the retry below can complete.
        getSigner: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveSigner = resolve;
              }),
          )
          .mockResolvedValue({}),
      });
      const client1 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      const client2 = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '1.0umfx' }),
        wallet,
      );
      const p1 = instance.getSigningClient(); // init in flight on the OLD gasPrice
      const other = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '2.0umfx' }),
        wallet,
      );

      resolveSigner({});

      await expect(p1).resolves.toBe(client1);
      expect(client1.disconnect).not.toHaveBeenCalled();
      await expect(other.getSigningClient()).resolves.toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockConnectWithSigner.mockRejectedValue(new Error('timeout'));

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('timeout'),
      });
    });
  });

  describe('disconnect', () => {
    it('disconnects signing client and allows re-initialization', async () => {
      mockCreateRPCQueryClient
        .mockResolvedValueOnce({ mock: 'qc1' } as any)
        .mockResolvedValueOnce({ mock: 'qc2' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();
      const qc1 = await instance.getQueryClient();
      expect(qc1).toMatchObject({ mock: 'qc1' });

      instance.disconnect();

      // Subsequent calls should re-initialize
      const qc2 = await instance.getQueryClient();
      expect(qc2).toMatchObject({ mock: 'qc2' });
    });
  });

  describe('ref-counted disconnect', () => {
    // These tests drive the REAL getSigningClient() path. They used to seed `signingClient`
    // through a private-state cast, because the pre-ENG-636 init never cached the client and
    // disconnected it at init time — an artifact that would have confounded a spy measuring
    // ref-counted teardown. Now that the cache works, seeding would only hide a regression:
    // if caching broke again, these would still pass. `readSigningClient` stays as a read-only
    // probe of the slot teardown is supposed to null.
    const readSigningClient = (instance: CosmosClientManager) =>
      (instance as unknown as { signingClient: unknown }).signingClient;

    it('only tears down the shared signing client after the last holder disconnects', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const config = makeConfig();
      const wallet = makeWallet();
      // Two simulated servers acquire the same config key.
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
      expect(await a.getSigningClient()).toBe(mockSC);

      // First holder releases — the shared client must stay live.
      a.disconnect();
      expect(mockSC.disconnect).not.toHaveBeenCalled();
      // Still the same live client (no teardown, no reconnect).
      expect(readSigningClient(b)).toBe(mockSC);

      // Last holder releases — now it tears down.
      b.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
      expect(readSigningClient(b)).toBeNull();
    });

    it('single acquire still tears down on the first disconnect', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

      instance.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('evicts the manager when the final holder disconnects', () => {
      const config = makeConfig({ chainId: 'evict-on-release' });
      const wallet = makeWallet();
      const released = CosmosClientManager.getInstance(config, wallet);

      released.disconnect();

      const reacquired = CosmosClientManager.getInstance(config, wallet);
      expect(reacquired).not.toBe(released);
    });

    it('an old deferred release cannot evict a replacement', async () => {
      const config = makeConfig({ chainId: 'stale-deferred-release' });
      const wallet = makeWallet();
      const released = CosmosClientManager.getInstance(config, wallet);
      let finishBroadcast!: () => void;
      const broadcast = released.withBroadcastLock(
        'addr1',
        () =>
          new Promise<void>((resolve) => {
            finishBroadcast = resolve;
          }),
      );
      await Promise.resolve();
      const deferredRelease = released.disconnectWhenIdle();

      // Force-reset can replace a manager while its old broadcast settles.
      CosmosClientManager.clearInstances();
      const replacement = CosmosClientManager.getInstance(config, wallet);
      finishBroadcast();
      await broadcast;
      await deferredRelease;

      expect(CosmosClientManager.getInstance(config, wallet)).toBe(replacement);
    });

    it('clearInstances force-tears-down even when refCount > 1', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const config = makeConfig();
      const wallet = makeWallet();
      // Two holders → refCount is 2.
      const a = CosmosClientManager.getInstance(config, wallet);
      CosmosClientManager.getInstance(config, wallet);
      await a.getSigningClient();

      // Force reset ignores the outstanding holders and tears down immediately.
      CosmosClientManager.clearInstances();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();

      // Registry was cleared, so a fresh getInstance yields a new instance.
      const fresh = CosmosClientManager.getInstance(config, wallet);
      expect(fresh).not.toBe(a);
    });

    it('over-disconnect is safe: extra disconnect() does not throw or re-tear-down', async () => {
      const mockSC = {
        getChainId: vi.fn().mockResolvedValue('test-chain'),
        disconnect: vi.fn(),
      };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

      instance.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();

      // Extra disconnects beyond the acquisition count must be no-ops:
      // they neither throw nor tear down again (refCount stays at 0).
      expect(() => {
        instance.disconnect();
        instance.disconnect();
      }).not.toThrow();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('shared query client survives a non-last disconnect and re-inits only after the last (behavioral)', async () => {
      // Defense-in-depth: a purely behavioral check (no private-state access)
      // that exercises the query-client teardown path via re-initialization
      // count. The query client caches across getQueryClient() calls, so a
      // re-init signals teardown occurred.
      const config = makeConfig({ chainId: 'refcount-query-probe' });
      const wallet = makeWallet();
      const identityFetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 'manifest-chain-identity',
          result: { node_info: { network: config.chainId } },
        }),
      );
      const a = CosmosClientManager.getInstance(config, wallet, identityFetch);
      const b = CosmosClientManager.getInstance(config, wallet, identityFetch);

      await a.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();

      // First holder releases — the shared query client must NOT be torn down.
      a.disconnect();
      await b.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
      expect(identityFetch).toHaveBeenCalledOnce();

      // Last holder releases — torn down, so the next query re-initializes.
      b.disconnect();
      await b.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
      expect(identityFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearInstances', () => {
    it('removes all instances so new getInstance creates fresh ones', () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);

      CosmosClientManager.clearInstances();

      // New getInstance should create a fresh instance
      const newInstance = CosmosClientManager.getInstance(makeConfig(), wallet);
      expect(newInstance).not.toBe(instance);
    });
  });

  describe('getAddress', () => {
    it('delegates to walletProvider', async () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const address = await instance.getAddress();
      expect(address).toBe('manifest1test');
      expect(wallet.getAddress).toHaveBeenCalledOnce();
    });
  });

  describe('getConfig', () => {
    it('returns the current config', () => {
      const config = makeConfig({ chainId: 'my-chain' });
      const instance = CosmosClientManager.getInstance(config, makeWallet());
      expect(instance.getConfig().chainId).toBe('my-chain');
    });
  });

  describe('LCD/REST query-only mode', () => {
    it('uses LCD client when restUrl is configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          restUrl: 'https://rest.example.com',
          rpcUrl: undefined,
          gasPrice: undefined,
        }),
        makeWallet(),
      );
      const client = await instance.getQueryClient();
      expect(mockCreateLCDQueryClient).toHaveBeenCalledWith(
        'https://rest.example.com',
        noopLogger,
      );
      expect(mockCreateRPCQueryClient).not.toHaveBeenCalled();
      expect(client).toEqual({ mock: 'lcdClient' });
    });

    it('prefers LCD when both restUrl and rpcUrl are configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({ restUrl: 'https://rest.example.com' }),
        makeWallet(),
      );
      await instance.getQueryClient();
      expect(mockCreateLCDQueryClient).toHaveBeenCalledWith(
        'https://rest.example.com',
        noopLogger,
      );
      expect(mockCreateRPCQueryClient).not.toHaveBeenCalled();
    });

    it('throws INVALID_CONFIG from getSigningClient when rpcUrl is not configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          restUrl: 'https://rest.example.com',
          rpcUrl: undefined,
          gasPrice: undefined,
        }),
        makeWallet(),
      );
      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('query-only'),
      });
    });

    it('throws INVALID_CONFIG from getQueryClient when neither URL is configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          rpcUrl: undefined,
          gasPrice: undefined,
          restUrl: undefined,
        }),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('neither restUrl nor rpcUrl'),
      });
    });
  });

  describe('rate limiting', () => {
    it('acquireRateLimit resolves immediately while tokens are available', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({ rateLimit: { requestsPerSecond: 10 } }),
        makeWallet(),
      );
      const start = Date.now();
      // 5 acquisitions well below the 10/sec budget should not block.
      // We assert only that the budget did not force a refill wait
      // (which would be ~500 ms at 10 rps); a loose ceiling avoids
      // flakes on slow CI while still failing if throttling kicks in
      // when it shouldn't.
      await Promise.all([
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(400);
    });

    it('acquireRateLimit throttles when budget is exhausted', async () => {
      // 2/sec budget; 4 acquisitions should take >= ~1s for the latter pair to
      // earn fresh tokens. Use a generous lower bound to avoid flakiness on
      // slow CI, but tight enough that an unlimited budget would fail it.
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          chainId: 'rate-limit-test-2rps',
          rateLimit: { requestsPerSecond: 2 },
        }),
        makeWallet(),
      );
      const start = Date.now();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      const elapsed = Date.now() - start;
      // The 3rd and 4th acquisitions need to wait for refill; expect ~1s.
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it('isolates the rate limiter when requestsPerSecond changes', async () => {
      const config1 = makeConfig({
        chainId: 'rate-reconfig-test',
        rateLimit: { requestsPerSecond: 10 },
      });
      const config2 = {
        ...config1,
        rateLimit: { requestsPerSecond: 50 },
      };
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config1, wallet);
      const before = (a as unknown as { rateLimiter: unknown }).rateLimiter;
      const b = CosmosClientManager.getInstance(config2, wallet);
      const after = (b as unknown as { rateLimiter: unknown }).rateLimiter;
      expect(a).not.toBe(b); // independently owned policies
      expect(after).not.toBe(before); // limiter object replaced
    });

    it('does not replace the rate limiter when requestsPerSecond is unchanged', async () => {
      const config = makeConfig({
        chainId: 'rate-stable-test',
        rateLimit: { requestsPerSecond: 7 },
      });
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const before = (a as unknown as { rateLimiter: unknown }).rateLimiter;
      const b = CosmosClientManager.getInstance({ ...config }, wallet);
      const after = (b as unknown as { rateLimiter: unknown }).rateLimiter;
      expect(a).toBe(b);
      expect(after).toBe(before);
    });

    // ENG-710. Real timers throughout, matching the two timing tests above: `limiter` derives its
    // clock from `performance.now()` and the poll loop uses the global `setTimeout`, so a partial
    // `vi.useFakeTimers({ toFake: [...] })` would freeze one and not the other — and a poll loop
    // under `vi.runAllTimersAsync()` spins until sinon's timer cap. Give each test its own chainId:
    // getInstance is a keyed singleton.
    describe('cancellable acquisition', () => {
      it('rejects an already-aborted acquisition with the raw reason, spending no token', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-pre',
            rateLimit: { requestsPerSecond: 1 },
          }),
          makeWallet(),
        );
        const ac = new AbortController();
        ac.abort('user cancelled'); // the MCP wire shape: a bare string
        await expect(instance.acquireRateLimit(ac.signal)).rejects.toBe(
          'user cancelled',
        );
        // Budget intact. This is the assertion that catches the likeliest implementation bug —
        // a poll loop whose first `tryRemoveTokens` runs before it ever looks at the signal
        // would still reject, but would have eaten the only token first. The bound is loose on
        // purpose: at rps=1 the failure mode costs a full ~1000ms interval, so anything well
        // under that discriminates, and a tight bound would only buy CI flakes.
        const t0 = Date.now();
        await instance.acquireRateLimit();
        expect(Date.now() - t0).toBeLessThan(500);
      });

      it('an abort DURING the wait rejects at once and consumes no token', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-mid',
            rateLimit: { requestsPerSecond: 1 },
          }),
          makeWallet(),
        );
        await instance.acquireRateLimit(); // drain the single token
        const ac = new AbortController();
        const t0 = Date.now();
        const parked = instance.acquireRateLimit(ac.signal);
        setTimeout(() => ac.abort('cancelled mid-wait'), 50);
        await expect(parked).rejects.toBe('cancelled mid-wait');
        // (i) it surfaced promptly rather than at the ~1000ms token grant
        expect(Date.now() - t0).toBeLessThan(400);
        // (ii) and the token it did not take is still there for the next interval. A design that
        // merely RACES `removeTokens` also rejects promptly but leaves the abandoned wait to
        // consume the token, pushing this acquire out to ~2000ms.
        await instance.acquireRateLimit();
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(1800);
      });

      it('resolves normally when a token is available and the signal stays live', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-happy',
            rateLimit: { requestsPerSecond: 10 },
          }),
          makeWallet(),
        );
        const ac = new AbortController();
        const limiter = (
          instance as unknown as {
            rateLimiter: { getTokensRemaining(): number };
          }
        ).rateLimiter;
        const before = limiter.getTokensRemaining();
        await instance.acquireRateLimit(ac.signal);
        // Token accounting rather than wall clock: at rps=10 an interval IS 100ms, so a
        // "finished in under 100ms" bound would sit exactly on the discrimination boundary and
        // fail on scheduler jitter alone. What the fast path actually promises is that it
        // consumed exactly one token and did not park, which the budget shows directly.
        expect(limiter.getTokensRemaining()).toBeLessThan(before);
        expect(limiter.getTokensRemaining()).toBeGreaterThan(before - 2);
      });

      // A bucket that cannot hold one token is the one input where polling and `removeTokens`
      // disagree: `tryRemoveTokens` declines forever where `removeTokens` throws. Unguarded, the
      // poll turns a loud failure into a silent hang — so this is a hang-detector as much as an
      // assertion. Reachable because `getInstance` takes an UNVALIDATED config and is on the
      // public SDK barrel, while `validateConfig` would have rejected this rps.
      it.each([
        ['with a signal', true],
        ['without a signal', false],
      ])(
        'rejects INVALID_CONFIG instead of hanging when requestsPerSecond < 1 (%s)',
        async (_label, withSignal) => {
          const instance = CosmosClientManager.getInstance(
            makeConfig({
              chainId: `rl-sub-one-${withSignal}`,
              rateLimit: { requestsPerSecond: 0.5 },
            }),
            makeWallet(),
          );
          const signal = withSignal ? new AbortController().signal : undefined;
          await expect(instance.acquireRateLimit(signal)).rejects.toMatchObject(
            {
              code: ManifestMCPErrorCode.INVALID_CONFIG,
            },
          );
        },
      );

      it('another client’s undersized budget cannot replace a parked waiter’s valid budget', async () => {
        const config = makeConfig({
          chainId: 'rl-reconfig-invalid',
          rateLimit: { requestsPerSecond: 1 },
        });
        const wallet = makeWallet();
        const instance = CosmosClientManager.getInstance(config, wallet);
        await instance.acquireRateLimit();
        const ac = new AbortController();
        const parked = instance.acquireRateLimit(ac.signal);
        const other = CosmosClientManager.getInstance(
          { ...config, rateLimit: { requestsPerSecond: 0.5 } },
          wallet,
        );
        await expect(other.acquireRateLimit()).rejects.toMatchObject({
          code: ManifestMCPErrorCode.INVALID_CONFIG,
        });
        ac.abort(new Error('stop waiting'));
        await expect(parked).rejects.toThrow('stop waiting');
        expect(instance.getConfig().rateLimit?.requestsPerSecond).toBe(1);
      });
    });
  });

  describe('withBroadcastLock', () => {
    it('serializes same-address fns', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-serialize' }),
        makeWallet(),
      );
      const order: string[] = [];
      const slow = () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('a-end');
            r();
          }, 30),
        );
      const fast = () => {
        order.push('b-run');
        return Promise.resolve();
      };
      const p1 = mgr.withBroadcastLock('addr1', async () => {
        order.push('a-start');
        await slow();
      });
      const p2 = mgr.withBroadcastLock('addr1', fast);
      await Promise.all([p1, p2]);
      expect(order).toEqual(['a-start', 'a-end', 'b-run']); // b waited for a
      mgr.disconnect();
    });

    it('runs different addresses concurrently', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-concurrent' }),
        makeWallet(),
      );
      let bStarted = false;
      const p1 = mgr.withBroadcastLock(
        'addr1',
        () => new Promise<void>((r) => setTimeout(r, 30)),
      );
      const p2 = mgr.withBroadcastLock('addr2', async () => {
        bStarted = true;
      });
      await p2;
      expect(bStarted).toBe(true); // did not wait for addr1
      await p1;
      mgr.disconnect();
    });

    it('releases the lock on throw (next waiter still runs)', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-release' }),
        makeWallet(),
      );
      await expect(
        mgr.withBroadcastLock('a', () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      await expect(
        mgr.withBroadcastLock('a', () => Promise.resolve('ok')),
      ).resolves.toBe('ok');
      mgr.disconnect();
    });

    it('releases broadcast-lock entries as their chains drain (bounded map growth)', async () => {
      // Code-review PR #102 + Copilot: withBroadcastLock must release a
      // per-address entry once its queued chain drains, so a long-lived manager
      // broadcasting from many distinct addresses does not grow the map without
      // bound (the common single-signer case sits at size 0 between broadcasts).
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-bounded' }),
        makeWallet(),
      );
      const locks = (mgr as unknown as { broadcastLocks: Map<string, unknown> })
        .broadcastLocks;
      await mgr.withBroadcastLock('addr1', () => Promise.resolve());
      await mgr.withBroadcastLock('addr2', () => Promise.resolve());
      // delete-on-settle runs a microtask after each tail settles — flush them.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(locks.size).toBe(0); // drained entries released, not retained
      mgr.disconnect();
    });

    it('defers teardown and eviction until an in-flight broadcast settles', async () => {
      const wallet = makeWallet();
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-teardown' }),
        wallet,
      );
      const locks = (mgr as unknown as { broadcastLocks: Map<string, unknown> })
        .broadcastLocks;
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const inflight = mgr.withBroadcastLock('addr1', () => pending);
      expect(locks.size).toBe(1); // entry present while the broadcast is in flight
      let released = false;
      const idle = mgr.disconnectWhenIdle().then(() => {
        released = true;
      });
      await Promise.resolve();
      expect(locks.size).toBe(1);
      expect(released).toBe(false);

      // Reacquisition before the broadcast settles must retain the same lock
      // domain and cancel the pending final teardown.
      const reacquired = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-teardown' }),
        wallet,
      );
      expect(reacquired).toBe(mgr);
      let queuedStarted = false;
      const queued = reacquired.withBroadcastLock('addr1', async () => {
        queuedStarted = true;
      });
      await Promise.resolve();
      expect(queuedStarted).toBe(false);

      release();
      await Promise.all([inflight, queued, idle]);
      expect(queuedStarted).toBe(true);
      expect(locks.size).toBe(0);

      // The reacquired holder owns the surviving manager; its release now
      // performs final teardown and eviction.
      reacquired.disconnect();
      const replacement = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-teardown' }),
        wallet,
      );
      expect(replacement).not.toBe(mgr);
    });
  });
});
