import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from './client.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

vi.mock('./modules.js', () => ({
  getTxHandler: vi.fn(),
  getTxContextLoader: vi.fn(),
}));

import { cosmosTx } from './cosmos.js';
import { getTxContextLoader, getTxHandler } from './modules.js';

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function sdkError(): ManifestMCPError {
  return new ManifestMCPError(
    ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    'fetch failed',
    { module: 'billing', subcommand: 'set-domain' },
  );
}

const hostileErrors = [
  ...(['code', 'message', 'details'] as const).map((field) => ({
    name: `attributed SDK ${field} getter`,
    make: () =>
      Object.defineProperty(sdkError(), field, {
        get() {
          throw new Error('Unreadable diagnostic');
        },
      }),
  })),
  {
    name: 'attributed SDK enumerable details getter',
    make: () =>
      new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'fetch failed',
        {
          module: 'billing',
          get diagnostic() {
            throw new Error('Unreadable diagnostic');
          },
        },
      ),
  },
  {
    name: 'attributed SDK code symbol',
    make: () =>
      Object.defineProperty(sdkError(), 'code', { value: Symbol('code') }),
  },
  {
    name: 'attributed SDK revoked details',
    make: () =>
      Object.defineProperty(sdkError(), 'details', { value: revokedProxy() }),
  },
  {
    name: 'attributed SDK get trap',
    make: () =>
      new Proxy(sdkError(), {
        get() {
          throw new Error('Unreadable diagnostic');
        },
      }),
  },
  {
    name: 'message getter throwing a revoked proxy',
    make: () =>
      Object.defineProperty(new Error('fetch failed'), 'message', {
        get() {
          throw revokedProxy();
        },
      }),
  },
  { name: 'revoked proxy', make: revokedProxy },
  {
    name: 'throwing string coercion',
    make: () => ({
      [Symbol.toPrimitive]() {
        throw new Error('Unreadable diagnostic');
      },
    }),
  },
];

function fixture() {
  const signAndBroadcast = vi.fn();
  const handler = vi.fn(async () => signAndBroadcast());
  vi.mocked(getTxHandler).mockReturnValue(handler);
  const acquireRateLimit = vi.fn().mockResolvedValue(undefined);
  const manager = {
    getConfig: () => ({
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    getAddress: async () => 'manifest1sender',
    withBroadcastLock: <T>(_address: string, operation: () => Promise<T>) =>
      operation(),
    getBroadcastClient: async () => ({ signAndBroadcast }),
    acquireRateLimit,
  } as unknown as CosmosClientManager;
  return { manager, handler, signAndBroadcast, acquireRateLimit };
}

describe('cosmosTx error boundary with real retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTxContextLoader).mockReturnValue(undefined);
  });

  it.each(hostileErrors)(
    'normalizes $name without replay or losing attribution',
    async ({ make }) => {
      const f = fixture();
      const original = make();
      f.signAndBroadcast.mockRejectedValue(original);
      // A fulfilled wrapper prevents Promise resolution from inspecting hostile values.
      const outcome = await cosmosTx(f.manager, 'billing', 'set-domain', [
        'lease-1',
      ]).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      expect(outcome.error).toBeInstanceOf(ManifestMCPError);
      const error = outcome.error as ManifestMCPError;
      expect(error.code).toBe(ManifestMCPErrorCode.TX_FAILED);
      expect(error.message).toBe(
        'Tx billing set-domain failed: Error message unavailable',
      );
      expect(error.details).toStrictEqual({
        module: 'billing',
        subcommand: 'set-domain',
        args: ['lease-1'],
      });
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      expect(cause?.value).toBe(original);
      expect(cause?.enumerable).toBe(false);
      expect(f.handler).toHaveBeenCalledOnce();
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
      expect(f.acquireRateLimit).toHaveBeenCalledOnce();
    },
  );

  it('retains readable attributed transient errors and the configured retry bound', async () => {
    const f = fixture();
    const original = sdkError();
    f.signAndBroadcast.mockRejectedValue(original);
    await expect(cosmosTx(f.manager, 'billing', 'set-domain')).rejects.toBe(
      original,
    );
    expect(f.signAndBroadcast).toHaveBeenCalledTimes(3);
  });

  it('normalizes an SDK Symbol message into a readable string without changing its terminal code', async () => {
    const f = fixture();
    const original = Object.defineProperty(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'failure', {
        module: 'billing',
      }),
      'message',
      { value: Symbol('signer failure') },
    );
    f.signAndBroadcast.mockRejectedValue(original);
    await expect(
      cosmosTx(f.manager, 'billing', 'set-domain'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: 'Symbol(signer failure)',
      details: { module: 'billing' },
    });
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it.each([
    ['permanent', ManifestMCPErrorCode.TX_FAILED, {}],
    ['submitted', ManifestMCPErrorCode.QUERY_FAILED, { sent: true }],
    ['partial', ManifestMCPErrorCode.QUERY_FAILED, { partial: true }],
    ['cancellation', ManifestMCPErrorCode.OPERATION_CANCELLED, {}],
  ] as const)(
    'retains a readable %s verdict without replay',
    async (_name, code, details) => {
      const f = fixture();
      const original = new ManifestMCPError(code, 'fetch failed', {
        module: 'billing',
        ...details,
      });
      f.signAndBroadcast.mockRejectedValue(original);
      await expect(cosmosTx(f.manager, 'billing', 'set-domain')).rejects.toBe(
        original,
      );
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
    },
  );
});
