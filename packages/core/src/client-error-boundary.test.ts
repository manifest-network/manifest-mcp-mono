import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asLeaseUuid } from './brands.js';
import { CosmosClientManager } from './client.js';
import { cosmosEstimateFee, cosmosQuery, cosmosTx } from './cosmos.js';
import { noopLogger } from './logger.js';
import { getTxContextLoader } from './modules.js';
import { isRetryableError, withRetry } from './retry.js';
import { setItemCustomDomain } from './tools/setItemCustomDomain.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';

const { connect, handler, simulate, broadcast } = vi.hoisted(() => ({
  connect: vi.fn(),
  handler: vi.fn(),
  simulate: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('@cosmjs/stargate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cosmjs/stargate')>();
  return {
    ...actual,
    SigningStargateClient: { connectWithSigner: connect },
  };
});

vi.mock('./modules.js', () => ({
  getQueryHandler: () => handler,
  getTxHandler: () => handler,
  getTxContextLoader: vi.fn(),
  getTxMsgBuilder: () => handler,
}));

const retry = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 };
const SEAMS = [
  'REST identity',
  'RPC identity',
  'signer',
  'signing identity',
] as const;
type Seam = (typeof SEAMS)[number];
const OPERATIONS = ['query', 'tx', 'estimate', 'custom domain'] as const;
type Operation = (typeof OPERATIONS)[number];
const routes = OPERATIONS.flatMap((operation) =>
  SEAMS.filter(
    (seam) =>
      operation !== 'query' ||
      seam === 'RPC identity' ||
      seam === 'REST identity',
  ).map((seam) => ({ operation, seam })),
);

/** Real connection, operation attribution, and retry; all transport failures are injected. */
function run(
  original: unknown,
  operation: Operation,
  seam: Seam,
  outer = true,
) {
  const reject = vi.fn().mockRejectedValue(original);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error('Unexpected identity request'));
  const wallet: WalletProvider = {
    getAddress: vi.fn().mockResolvedValue('manifest1sender'),
    getSigner: seam === 'signer' ? reject : vi.fn().mockResolvedValue({}),
  };
  const identity = seam === 'REST identity' || seam === 'RPC identity';
  connect.mockResolvedValue({
    getChainId:
      seam === 'signing identity'
        ? reject
        : vi.fn().mockResolvedValue('test-chain'),
    disconnect: vi.fn(),
    simulate,
    signAndBroadcast: broadcast,
    signAndBroadcastSync: broadcast,
    defaultGasMultiplier: 1.5,
  });
  // Tx/estimate context acquisition lets the exact same identity failure cross
  // their real read boundary, before signer or broadcaster creation.
  vi.mocked(getTxContextLoader).mockReturnValue(
    identity && operation !== 'query' ? handler : undefined,
  );
  const manager = CosmosClientManager.getInstance(
    {
      chainId: 'test-chain',
      rpcUrl: 'https://rpc.example.com',
      restUrl:
        seam === 'REST identity' ? 'https://rest.example.com' : undefined,
      gasPrice: '0.001umfx',
      retry,
    },
    wallet,
    identity ? reject : fetch,
  );
  const invoke = (): Promise<unknown> => {
    switch (operation) {
      case 'query':
        return cosmosQuery(manager, 'bank', 'balances');
      case 'tx':
        return cosmosTx(manager, 'bank', 'send');
      case 'estimate':
        return cosmosEstimateFee(manager, 'bank', 'send');
      case 'custom domain':
        return setItemCustomDomain(
          { chain: manager, logger: noopLogger },
          {
            leaseUuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
            clear: true,
          },
        );
    }
  };
  return {
    reject,
    fetch,
    result: (outer ? withRetry(invoke, { config: retry }) : invoke()).then(
      () => {
        throw new Error('Expected the injected connection failure');
      },
      (error: unknown) => error,
    ),
  };
}

function sdkFailure() {
  return new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    'fetch failed',
    { httpStatus: 503 },
  );
}

function throwingField(error: Error, field: string) {
  return Object.defineProperty(error, field, {
    get() {
      throw new Error(`${field} unavailable`);
    },
  });
}

describe('connection retry verdicts survive operation attribution', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => CosmosClientManager.clearInstances());

  it.each(
    (['RPC identity', 'signer'] as const).flatMap((seam) =>
      [
        {
          kind: 'transient',
          message:
            'the upstream node returned service unavailable while the chain was syncing retry',
          retryable: true,
        },
        {
          kind: 'permanent',
          message:
            'the upstream enotfound returned service unavailable while the chain was syncing retry',
          retryable: false,
        },
        {
          kind: 'ordinary',
          message:
            'the upstream node returned another answer while the chain was syncing again',
          retryable: false,
        },
      ].map((example) => ({ seam, ...example })),
    ),
  )(
    '$seam retains a redacted $kind verdict through connection repair',
    async ({ seam, kind, message, retryable }) => {
      // Obtain private lexical provenance from a real Cosmos normalization rather
      // than importing the metadata writer into the test fixture.
      handler.mockRejectedValueOnce(new Error(message));
      const manager = {
        getQueryClient: async () => ({}),
        getConfig: () => ({ retry: { maxRetries: 0 } }),
        acquireRateLimit: async () => {},
      } as unknown as CosmosClientManager;
      const original = await cosmosQuery(manager, 'bank', 'balances').then(
        () => {
          throw new Error('Expected initial query failure');
        },
        (error: unknown) => error as ManifestMCPError,
      );
      expect(original.message).toContain('[REDACTED - possible mnemonic]');
      expect(original.message).not.toContain(message);
      delete original.details?.module;
      if (kind === 'permanent') {
        // Textual NXDOMAIN must still veto a competing transient status after
        // connection repair drops the failing incidental property.
        Object.assign(original.details ?? {}, { httpStatus: 503 });
      }
      Object.defineProperty(original.details, 'extra', {
        enumerable: true,
        get() {
          throw new Error('extra unavailable');
        },
      });
      expect(isRetryableError(original)).toBe(retryable);
      handler.mockClear();
      const f = run(
        original,
        seam === 'signer' ? 'custom domain' : 'query',
        seam,
      );
      const error = await f.result;
      expect((error as Error).message).toBe(original.message);
      expect(isRetryableError(error)).toBe(retryable);
      expect(f.reject).toHaveBeenCalledTimes(
        retryable ? (seam === 'signer' ? 2 : 4) : 1,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(simulate).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  for (const { operation, seam } of routes) {
    it.each(['name', 'cause'])(
      `${operation} / ${seam}: unreadable %s stays terminal`,
      async (field) => {
        const original = throwingField(sdkFailure(), field);
        expect(isRetryableError(original)).toBe(false);
        const f = run(original, operation, seam);
        const error = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as Error).message).toContain('Error message unavailable');
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
        expect(simulate).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        expect(f.fetch).not.toHaveBeenCalled();
      },
    );

    it.each(
      ['AbortError', 'TimeoutError'].flatMap((name) =>
        ['extra', 'details'].map((unreadable) => ({ name, unreadable })),
      ),
    )(
      `${operation} / ${seam}: repaired $name with unreadable $unreadable stays terminal`,
      async ({ name, unreadable }) => {
        const original = sdkFailure();
        original.name = name;
        Object.defineProperty(
          unreadable === 'details' ? original : original.details,
          unreadable,
          {
            enumerable: true,
            get() {
              throw new Error(`${unreadable} unavailable`);
            },
          },
        );
        expect(isRetryableError(original)).toBe(false);
        const f = run(original, operation, seam);
        const error = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as ManifestMCPError).code).toBe(
          ManifestMCPErrorCode.QUERY_FAILED,
        );
        expect((error as Error).message).toBe('fetch failed');
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
        expect(simulate).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
      },
    );

    it.each([
      Symbol('fetch failed'),
      ['fetch failed'],
      { toString: () => 'fetch failed' },
    ])(
      `${operation} / ${seam}: malformed Error.message (%s) stays terminal`,
      async (message) => {
        const original = Object.defineProperty(new Error(), 'message', {
          value: message,
        });
        expect(isRetryableError(original)).toBe(false);
        const f = run(original, operation, seam);
        const error = await f.result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect((error as Error).message).toContain('Error message unavailable');
        expect(isRetryableError(error)).toBe(false);
        expect(f.reject).toHaveBeenCalledOnce();
        expect(handler).not.toHaveBeenCalled();
        expect(simulate).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      `${operation} / ${seam}: readable transient control (outer retry %s)`,
      async (outer) => {
        const original = sdkFailure();
        const f = run(original, operation, seam, outer);
        const error = await f.result;
        expect(isRetryableError(error)).toBe(true);
        const innerAttempts = seam === 'signer' ? 1 : 2;
        expect(f.reject).toHaveBeenCalledTimes(innerAttempts * (outer ? 2 : 1));
        expect(handler).not.toHaveBeenCalled();
        expect(simulate).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
      },
    );
  }

  it.each([false, true])(
    'does not keep a cause whose nested diagnostics throw (incidental details failure %s)',
    async (incidental) => {
      const original = Object.assign(sdkFailure(), {
        cause: throwingField(new Error('fetch failed'), 'name'),
      });
      if (incidental) {
        Object.defineProperty(original.details, 'extra', {
          enumerable: true,
          get() {
            throw new Error('extra unavailable');
          },
        });
      }
      const f = run(original, 'query', 'RPC identity');
      const error = await f.result;
      expect((error as Error).message).toContain('Error message unavailable');
      expect(isRetryableError(error)).toBe(false);
      expect(f.reject).toHaveBeenCalledOnce();
    },
  );
});
