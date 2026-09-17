import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CosmosClientManager } from './client.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

vi.mock('./modules.js', () => ({
  getQueryHandler: vi.fn(),
  getTxHandler: vi.fn(),
  getTxContextLoader: vi.fn(),
  getTxMsgBuilder: vi.fn(),
}));

import { cosmosEstimateFee, cosmosQuery, cosmosTx } from './cosmos.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';
import { isRetryableError } from './retry.js';

const LEGS = [
  'query',
  'simulate',
  'estimate address',
  'build context',
] as const;
type Leg = (typeof LEGS)[number];

function read(error: unknown, leg: Leg) {
  const reject = vi.fn().mockRejectedValue(error);
  const broadcast = vi.fn();
  vi.mocked(getQueryHandler).mockReturnValue(reject);
  vi.mocked(getTxHandler).mockReturnValue(broadcast);
  vi.mocked(getTxMsgBuilder).mockReturnValue(
    vi.fn(() => ({ messages: [], memo: '' })),
  );
  vi.mocked(getTxContextLoader).mockReturnValue(
    leg === 'build context' ? reject : undefined,
  );
  const manager = {
    getConfig: () => ({
      gasPrice: '0.001umfx',
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    getAddress:
      leg === 'estimate address' ? reject : async () => 'manifest1sender',
    getQueryClient: async () => ({}),
    getSigningClient: async () => ({
      simulate: reject,
      defaultGasMultiplier: 1.5,
    }),
    acquireRateLimit: async () => {},
  } as unknown as CosmosClientManager;
  const promise =
    leg === 'query'
      ? cosmosQuery(manager, 'bank', 'balances')
      : leg === 'build context'
        ? cosmosTx(manager, 'billing', 'update-params')
        : cosmosEstimateFee(manager, 'bank', 'send');
  return {
    reject,
    broadcast,
    result: promise.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    ),
  };
}

function unreadableDetails(details: Record<string, unknown>) {
  return Object.defineProperty(details, 'extra', {
    enumerable: true,
    get() {
      throw new Error('unavailable');
    },
  });
}

const cases = [
  {
    name: 'own HTTP status',
    make: () =>
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation ended',
        unreadableDetails({ httpStatus: 503 }),
      ),
  },
  {
    name: 'hidden HTTP status',
    make: () =>
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation ended',
        unreadableDetails(
          Object.defineProperty({}, 'httpStatus', { value: 503 }),
        ),
      ),
  },
  {
    name: 'inherited gRPC status',
    make: () =>
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'operation ended',
        unreadableDetails(Object.create({ grpcCode: 14 })),
      ),
  },
  {
    name: 'AbortError with an owned-looking deadline',
    make: () =>
      Object.assign(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'operation ended',
          unreadableDetails({ transportCode: 'ETIMEDOUT' }),
        ),
        { name: 'AbortError' },
      ),
  },
  {
    name: 'raw Symbol message',
    make: () =>
      Object.defineProperty(new Error('unused'), 'message', {
        value: Symbol('fetch failed'),
      }),
  },
  {
    name: 'throwing coercion with transient classifier text',
    make: () =>
      Object.defineProperty(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'unused'),
        'message',
        {
          value: {
            toString() {
              throw new Error('unavailable');
            },
            toLowerCase: () => 'fetch failed',
          },
        },
      ),
  },
];

describe('read attribution does not synthesize retry permission', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const leg of LEGS) {
    it.each(cases)(
      `${leg} stops after one attempt for $name`,
      async ({ make }) => {
        const original = make();
        const f = read(original, leg);
        const { error } = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect(typeof (error as Error).message).toBe('string');
        expect(isRetryableError(error)).toBe(false);
        const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
        expect(descriptor?.value).toBe(original);
        expect(descriptor?.enumerable).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
        expect(f.broadcast).not.toHaveBeenCalled();
        // An ordinary wrapper must not erase the internal terminal verdict either.
        expect(
          isRetryableError(
            Object.assign(new Error('fetch failed'), { cause: error }),
          ),
        ).toBe(false);
      },
    );

    it.each([42, undefined])(
      `${leg} does not add a cause for readable malformed code %s`,
      async (code) => {
        const original = Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'operation ended',
            Object.defineProperty({}, 'httpStatus', { value: 503 }),
          ),
          'code',
          { value: code },
        );
        const f = read(original, leg);
        const { error } = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as ManifestMCPError).code).toBe(
          leg === 'simulate' || leg === 'estimate address'
            ? ManifestMCPErrorCode.SIMULATION_FAILED
            : ManifestMCPErrorCode.QUERY_FAILED,
        );
        expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
        expect((error as ManifestMCPError).details).not.toHaveProperty(
          'httpStatus',
        );
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
      },
    );

    it(`${leg} preserves readable transient retries`, async () => {
      const f = read(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          { module: 'original' },
        ),
        leg,
      );
      const { error } = await f.result;
      expect(isRetryableError(error)).toBe(true);
      expect(f.reject).toHaveBeenCalledTimes(3);
    });

    it.each([42, undefined])(
      `${leg} does not authorize HTTP 408 by repairing code %s`,
      async (code) => {
        const original = Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'operation ended',
            { module: 'original', httpStatus: 408 },
          ),
          'code',
          { value: code },
        );
        const f = read(original, leg);
        const { error } = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as ManifestMCPError).details?.httpStatus).toBe(408);
        expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
      },
    );

    it.each([42, undefined, Symbol('code')])(
      `${leg} conservatively stops transient text with malformed SDK code %s`,
      async (code) => {
        const original = Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            'fetch failed',
            { module: 'original' },
          ),
          'code',
          { value: code },
        );
        const f = read(original, leg);
        const { error } = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as Error).message).toContain('fetch failed');
        expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
      },
    );
  }

  it('does not accept diagnostic-looking public properties as the private retry veto', () => {
    const error = Object.assign(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'fetch failed', {
        unreadable: true,
        inspectionFailed: true,
      }),
      { unreadable: true, inspectionFailed: true },
    );
    expect(isRetryableError(error)).toBe(true);
  });
});
