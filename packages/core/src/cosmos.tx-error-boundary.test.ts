import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from './client.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

vi.mock('./modules.js', () => ({
  getTxHandler: vi.fn(),
  getTxContextLoader: vi.fn(),
  getQueryHandler: vi.fn(),
  getTxMsgBuilder: vi.fn(),
}));

import { cosmosEstimateFee, cosmosQuery, cosmosTx } from './cosmos.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';

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

const hostileErrors: { name: string; message?: string; make: () => unknown }[] =
  [
    ...(['code', 'message', 'details'] as const).map((field) => ({
      name: `attributed SDK ${field} getter`,
      message:
        field === 'message' ? 'Error message unavailable' : 'fetch failed',
      make: () =>
        Object.defineProperty(sdkError(), field, {
          get() {
            throw new Error('Unreadable diagnostic');
          },
        }),
    })),
    {
      name: 'attributed SDK enumerable details getter',
      message: 'fetch failed',
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
      message: 'fetch failed',
      make: () =>
        Object.defineProperty(sdkError(), 'code', { value: Symbol('code') }),
    },
    {
      name: 'attributed SDK revoked details',
      message: 'fetch failed',
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
  const simulate = vi.fn();
  const getAddress = vi.fn().mockResolvedValue('manifest1sender');
  const manager = {
    getConfig: () => ({
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      gasPrice: '0.001umfx',
    }),
    getAddress,
    getQueryClient: async () => ({}),
    getSigningClient: async () => ({ simulate, defaultGasMultiplier: 1.5 }),
    withBroadcastLock: <T>(_address: string, operation: () => Promise<T>) =>
      operation(),
    getBroadcastClient: async () => ({ signAndBroadcast }),
    acquireRateLimit,
  } as unknown as CosmosClientManager;
  return {
    manager,
    handler,
    signAndBroadcast,
    acquireRateLimit,
    simulate,
    getAddress,
  };
}

describe('cosmosTx error boundary with real retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTxContextLoader).mockReturnValue(undefined);
  });

  it.each(hostileErrors)(
    'normalizes $name without replay or losing attribution',
    async ({ make, message }) => {
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
        `Tx billing set-domain failed: ${message ?? 'Error message unavailable'}`,
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

  it('keeps unrelated non-enumerable diagnostics inert while preserving readable SDK identity', async () => {
    const f = fixture();
    const diagnostic = vi.fn(() => {
      throw new Error('not a consumer field');
    });
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'keyfile locked',
      Object.defineProperty({ module: 'billing' }, 'extra', {
        get: diagnostic,
      }),
    );
    f.signAndBroadcast.mockRejectedValue(original);
    await expect(cosmosTx(f.manager, 'billing', 'set-domain')).rejects.toBe(
      original,
    );
    expect(diagnostic).not.toHaveBeenCalled();
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'hidden HTTP status',
      () => Object.defineProperty({}, 'httpStatus', { value: 503 }),
    ],
    ['inherited gRPC status', () => Object.create({ grpcCode: 14 })],
    [
      'inherited transport timeout',
      () => Object.create({ transportCode: 'ETIMEDOUT' }),
    ],
  ] as const)(
    'does not promote a readable %s into the attributed retry envelope',
    async (_label, makeDetails) => {
      const f = fixture();
      const original = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation ended',
        makeDetails(),
      );
      f.signAndBroadcast.mockRejectedValue(original);
      const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.QUERY_FAILED,
      );
      expect((error as Error).message).toBe('operation ended');
      expect((error as ManifestMCPError).details).toStrictEqual({
        module: 'billing',
        subcommand: 'set-domain',
        args: [],
      });
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
    },
  );

  it('normalizes an SDK Symbol message into a readable permanent envelope with context and cause', async () => {
    const f = fixture();
    const original = Object.defineProperty(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'failure', {
        module: 'billing',
      }),
      'message',
      { value: Symbol('signer failure') },
    );
    f.signAndBroadcast.mockRejectedValue(original);
    const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect((error as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((error as Error).message).toBe(
      'Tx billing set-domain failed: Symbol(signer failure)',
    );
    expect((error as ManifestMCPError).details).toStrictEqual({
      module: 'billing',
      subcommand: 'set-domain',
      args: [],
    });
    expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
      value: original,
      enumerable: false,
    });
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it.each(['extra getter', 'ownKeys trap', 'hidden module getter'])(
    'keeps readable submission and recovery evidence despite a details %s',
    async (kind) => {
      const f = fixture();
      const facts = {
        sent: true,
        partial: true,
        transactionHash: 'AB'.repeat(32),
        code: 12,
        height: '42',
        confirmed: true,
        lease_uuid: 'lease-1',
      };
      const details =
        kind === 'ownKeys trap'
          ? new Proxy(
              { module: 'original', ...facts },
              {
                ownKeys() {
                  throw new Error('unavailable');
                },
              },
            )
          : Object.defineProperty(
              { ...facts },
              kind === 'hidden module getter' ? 'module' : 'extra',
              {
                enumerable: kind === 'extra getter',
                get() {
                  throw new Error('unavailable');
                },
              },
            );
      const original = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'insufficient funds',
        details,
      );
      f.signAndBroadcast.mockRejectedValue(original);
      const { error } = await cosmosTx(f.manager, 'billing', 'set-domain', [
        'lease-1',
      ]).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
      expect((error as Error).message).toBe(
        'Tx billing set-domain failed: insufficient funds',
      );
      expect((error as ManifestMCPError).details).toStrictEqual({
        ...facts,
        module: 'billing',
        subcommand: 'set-domain',
        args: ['lease-1'],
      });
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      expect(cause?.value).toBe(original);
      expect(cause?.enumerable).toBe(false);
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
    },
  );

  it('does not invent receipt facts or invoke evidence getters again during recovery', async () => {
    const f = fixture();
    const hashGetter = vi.fn(() => {
      throw new Error('unavailable');
    });
    const details = Object.defineProperty(
      { code: 0, height: '42', confirmed: true, lease_uuid: 'lease-1' },
      'transactionHash',
      { enumerable: true, get: hashGetter },
    );
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'insufficient funds',
      details,
    );
    f.signAndBroadcast.mockRejectedValue(original);
    const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect((error as ManifestMCPError).details).toStrictEqual({
      lease_uuid: 'lease-1',
      module: 'billing',
      subcommand: 'set-domain',
      args: [],
    });
    expect(hashGetter).toHaveBeenCalledOnce();
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it('keeps a readable raw-error wrapper unchanged, without introducing a diagnostic cause or details', async () => {
    const f = fixture();
    const original = Object.assign(new Error('insufficient funds'), {
      details: { sent: true, transactionHash: 'AB'.repeat(32) },
    });
    f.signAndBroadcast.mockRejectedValue(original);
    const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect((error as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((error as Error).message).toBe(
      'Tx billing set-domain failed: insufficient funds',
    );
    expect((error as ManifestMCPError).details).toStrictEqual({
      module: 'billing',
      subcommand: 'set-domain',
      args: [],
    });
    expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it.each([Symbol('code'), 12, undefined])(
    'keeps readable text and evidence for malformed code %s without replay',
    async (code) => {
      const f = fixture();
      const facts = {
        sent: true,
        transactionHash: '01'.repeat(32),
        note: 'readable',
      };
      const original = Object.defineProperty(
        new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          'fetch failed',
          { module: 'original', ...facts },
        ),
        'code',
        { value: code },
      );
      f.signAndBroadcast.mockRejectedValue(original);
      const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
      expect((error as Error).message).toBe(
        'Tx billing set-domain failed: fetch failed',
      );
      expect((error as ManifestMCPError).details).toStrictEqual({
        ...facts,
        module: 'billing',
        subcommand: 'set-domain',
        args: [],
      });
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      expect(cause?.value).toBe(original);
      expect(cause?.enumerable).toBe(false);
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
    },
  );

  it('does not turn custom message coercion into a transient transaction retry', async () => {
    const f = fixture();
    const original = Object.defineProperty(sdkError(), 'message', {
      value: { toString: () => 'fetch failed', toLowerCase: () => 'benign' },
    });
    f.signAndBroadcast.mockRejectedValue(original);
    const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect((error as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((error as Error).message).toBe(
      'Tx billing set-domain failed: fetch failed',
    );
    expect((error as ManifestMCPError).details).toStrictEqual({
      module: 'billing',
      subcommand: 'set-domain',
      args: [],
    });
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    expect(cause?.value).toBe(original);
    expect(cause?.enumerable).toBe(false);
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

describe('all cosmos attribution boundaries with real retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTxContextLoader).mockReturnValue(undefined);
    vi.mocked(getTxMsgBuilder).mockReturnValue(
      vi.fn(() => ({ messages: [], memo: '' })),
    );
  });

  for (const boundary of [
    'query',
    'estimate',
    'estimate wallet',
    'build context',
  ] as const) {
    it.each([
      'message getter',
      'revoked proxy',
      'attributed SDK message getter',
    ])(
      `${boundary} retains a readable attributed envelope for %s`,
      async (kind) => {
        const f = fixture();
        const failure =
          kind === 'revoked proxy'
            ? revokedProxy()
            : Object.defineProperty(
                kind === 'attributed SDK message getter'
                  ? new ManifestMCPError(
                      ManifestMCPErrorCode.INVALID_CONFIG,
                      'unavailable',
                      { module: 'original' },
                    )
                  : new Error('unavailable'),
                'message',
                {
                  get() {
                    throw revokedProxy();
                  },
                },
              );
        const reject = vi.fn().mockRejectedValue(failure);
        let operation: Promise<unknown>;
        let prefix: string;
        let fallback: ManifestMCPErrorCode;
        let details: Record<string, unknown>;
        if (boundary === 'query') {
          vi.mocked(getQueryHandler).mockReturnValue(reject);
          operation = cosmosQuery(f.manager, 'bank', 'balances');
          prefix = 'Query bank balances failed: ';
          fallback = ManifestMCPErrorCode.QUERY_FAILED;
          details = { module: 'bank', subcommand: 'balances' };
        } else if (boundary === 'build context') {
          vi.mocked(getTxContextLoader).mockReturnValue(reject);
          operation = cosmosTx(f.manager, 'billing', 'update-params');
          prefix = 'Failed to load build context for billing update-params: ';
          fallback = ManifestMCPErrorCode.QUERY_FAILED;
          details = { module: 'billing', subcommand: 'update-params' };
        } else {
          if (boundary === 'estimate wallet')
            f.getAddress.mockImplementation(reject);
          else f.simulate.mockImplementation(reject);
          operation = cosmosEstimateFee(f.manager, 'bank', 'send', [
            'receiver',
          ]);
          prefix = 'Fee estimation for bank send failed: ';
          fallback = ManifestMCPErrorCode.SIMULATION_FAILED;
          details = { module: 'bank', subcommand: 'send', args: ['receiver'] };
        }
        const { error } = await operation.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as ManifestMCPError).code).toBe(
          kind === 'attributed SDK message getter'
            ? ManifestMCPErrorCode.INVALID_CONFIG
            : fallback,
        );
        expect((error as Error).message).toBe(
          `${prefix}Error message unavailable`,
        );
        expect((error as ManifestMCPError).details).toStrictEqual(details);
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        expect(cause?.value).toBe(failure);
        expect(cause?.enumerable).toBe(false);
        expect(reject).toHaveBeenCalledOnce();
        expect(f.signAndBroadcast).not.toHaveBeenCalled();
      },
    );
  }

  it.each(['query', 'estimate', 'build context'] as const)(
    'preserves readable SDK identity and transient retry semantics in %s',
    async (boundary) => {
      const f = fixture();
      const original = sdkError();
      const reject = vi.fn().mockRejectedValue(original);
      let operation: Promise<unknown>;
      if (boundary === 'query') {
        vi.mocked(getQueryHandler).mockReturnValue(reject);
        operation = cosmosQuery(f.manager, 'bank', 'balances');
      } else if (boundary === 'estimate') {
        f.simulate.mockImplementation(reject);
        operation = cosmosEstimateFee(f.manager, 'bank', 'send');
      } else {
        vi.mocked(getTxContextLoader).mockReturnValue(reject);
        operation = cosmosTx(f.manager, 'billing', 'update-params');
      }
      await expect(operation).rejects.toBe(original);
      expect(reject).toHaveBeenCalledTimes(3);
    },
  );
});

describe('transaction evidence validation during diagnostic recovery', () => {
  const hash = 'ab'.repeat(32);
  const valid = {
    sent: true,
    partial: true,
    transactionHash: hash,
    code: 0,
    height: '00042',
    confirmed: false,
    lease_uuid: 'lease-1',
  };
  const cases = [
    { name: 'zero code and false confirmation', facts: valid, expected: valid },
    {
      name: 'invalid hash',
      facts: { ...valid, transactionHash: 'x'.repeat(64) },
      expected: {
        sent: true,
        partial: true,
        code: 0,
        height: '00042',
        confirmed: false,
        lease_uuid: 'lease-1',
      },
    },
    {
      name: 'truthy submission and partial markers',
      facts: { ...valid, sent: 1, partial: 'yes' },
      expected: { transactionHash: hash, lease_uuid: 'lease-1' },
    },
    {
      name: 'negative code and non-digit height',
      facts: {
        ...valid,
        code: -1,
        height: '42x',
        confirmed: 'yes',
        lease_uuid: 42,
      },
      expected: { sent: true, partial: true, transactionHash: hash },
    },
    {
      name: 'fractional code and empty height',
      facts: { ...valid, code: 1.5, height: '' },
      expected: {
        sent: true,
        partial: true,
        transactionHash: hash,
        confirmed: false,
        lease_uuid: 'lease-1',
      },
    },
    {
      name: 'unsafe code and overlong height',
      facts: {
        ...valid,
        code: Number.MAX_SAFE_INTEGER + 1,
        height: '1'.repeat(21),
      },
      expected: {
        sent: true,
        partial: true,
        transactionHash: hash,
        confirmed: false,
        lease_uuid: 'lease-1',
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTxContextLoader).mockReturnValue(undefined);
  });

  it.each(cases)(
    'retains only validated facts for $name',
    async ({ facts, expected }) => {
      const f = fixture();
      const original = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation failed',
        Object.defineProperty({ ...facts }, 'extra', {
          enumerable: true,
          get() {
            throw new Error('unavailable');
          },
        }),
      );
      f.signAndBroadcast.mockRejectedValue(original);
      const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
      expect((error as ManifestMCPError).details).toStrictEqual({
        ...expected,
        module: 'billing',
        subcommand: 'set-domain',
        args: [],
      });
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      expect(cause?.value).toBe(original);
      expect(cause?.enumerable).toBe(false);
      expect(f.signAndBroadcast).toHaveBeenCalledOnce();
    },
  );

  it('recovers validated own data when all ordinary SDK property reads throw', async () => {
    const f = fixture();
    const original = new Proxy(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation failed',
        valid,
      ),
      {
        get() {
          throw new Error('unavailable');
        },
      },
    );
    f.signAndBroadcast.mockRejectedValue(original);
    const { error } = await cosmosTx(f.manager, 'billing', 'set-domain').then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect((error as ManifestMCPError).details).toStrictEqual({
      ...valid,
      module: 'billing',
      subcommand: 'set-domain',
      args: [],
    });
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBe(
      original,
    );
    expect(f.signAndBroadcast).toHaveBeenCalledOnce();
  });
});
