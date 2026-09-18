import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeMockWallet,
  makeSealedClientManager,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import {
  CosmosClientManager,
  createFredClient,
  type FredClient,
  isRetryableError,
  ManifestMCPError,
  type ManifestQueryClient,
  ProviderApiError,
  withRetry,
} from '@manifest-network/manifest-sdk';
import {
  isTransientProviderError,
  restartLease,
  updateLease,
} from '@manifest-network/manifest-sdk/deploy';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the built public SDK and its bound methods with real provider HTTP
// adapters. The injected wire and sealed chain prevent all external I/O.
const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const COMMAND_KEY = 'f14751c4-e939-4e54-b6ce-d09376929e5e';
const INPUT = { address: 'manifest1tenant', leaseUuid: LEASE_UUID };
const MANIFEST = JSON.stringify({ image: 'nginx:1.27' });

afterEach(() => vi.restoreAllMocks());

async function clientWithFetch(fetch: typeof globalThis.fetch) {
  const chain = makeSealedClientManager({
    getQueryClient: vi.fn(
      async () => makeMockQueryClient() as unknown as ManifestQueryClient,
    ),
    getConfig: vi.fn(() => makeMockConfig()),
    setLogger: vi.fn(),
    disconnect: vi.fn(),
  });
  vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(chain);
  return createFredClient({
    config: makeMockConfig(),
    walletProvider: makeMockWallet({ signArbitrary: true }),
    fetch,
  });
}

const operations = [
  {
    name: 'restart',
    raw: (fetch: typeof globalThis.fetch) =>
      restartLease(PROVIDER_URL, LEASE_UUID, 'auth-token', fetch),
    run: (client: FredClient, idempotencyKey?: string) =>
      client.restartApp(INPUT, {
        providerUrl: PROVIDER_URL,
        pollOptions: false,
        idempotencyKey,
      }),
  },
  {
    name: 'update',
    raw: (fetch: typeof globalThis.fetch) =>
      updateLease(
        PROVIDER_URL,
        LEASE_UUID,
        new TextEncoder().encode(MANIFEST),
        'auth-token',
        fetch,
      ),
    run: (client: FredClient, idempotencyKey?: string) =>
      client.updateApp(
        { ...INPUT, manifest: MANIFEST },
        { providerUrl: PROVIDER_URL, pollOptions: false, idempotencyKey },
      ),
  },
] as const;

describe('SDK maintenance command identity', () => {
  it.each(operations)(
    'keeps raw $name recovery through a foreign-core adapter without replay',
    async ({ name, raw }) => {
      const wire = sealedFetchProbe({
        [`/${name}`]: { status: 503, text: 'HTTP 503 unavailable' },
      });
      const readDiagnostic = vi.fn(() => {
        throw new Error('unreadable foreign diagnostic cause');
      });
      let adapterError: ProviderApiError | undefined;
      const error = await withRetry(
        async () => {
          try {
            return await raw(wire.fetch);
          } catch (cause) {
            if (!(cause instanceof ProviderApiError)) throw cause;
            // Simulate another physical core copy: its public code/details remain
            // readable but instanceof our core class cannot establish ownership.
            const foreign = Object.assign(new Error('HTTP 503'), {
              code:
                name === 'restart'
                  ? 'RESTART_INDETERMINATE'
                  : 'UPDATE_INDETERMINATE',
              details: cause.details,
            });
            expect(foreign).not.toBeInstanceOf(ManifestMCPError);
            Object.defineProperty(foreign, 'cause', { get: readDiagnostic });
            adapterError = new ProviderApiError(cause.status, cause.message, {
              kind: cause.kind,
              details: { idempotency_key: cause.details?.idempotency_key },
              cause: Object.assign(new Error('adapter'), { cause: foreign }),
            });
            throw adapterError;
          }
        },
        {
          config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        },
      ).catch((cause: unknown) => cause);

      expect(wire.calls).toHaveLength(1);
      const key = new Headers(wire.calls[0].init.headers).get(
        'Idempotency-Key',
      );
      expect(error).toBe(adapterError);
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error).toMatchObject({
        details: { idempotency_key: key },
        cause: {
          cause: {
            details: {
              operation: name,
              outcome: 'unknown',
              idempotency_key: key,
            },
          },
        },
      });
      expect(isRetryableError(error)).toBe(false);
      expect(isTransientProviderError(error)).toBe(false);
      expect(readDiagnostic).not.toHaveBeenCalled();
    },
  );

  it.each(operations)(
    'preserves raw $name recovery when a response error has an unreadable cause',
    async ({ name, raw }) => {
      const failure = new Error('body read failed');
      const readCause = vi.fn(() => {
        throw new Error('unreadable diagnostic cause');
      });
      Object.defineProperty(failure, 'cause', { get: readCause });
      const wire = sealedFetchProbe({
        [`/${name}`]: { streamError: failure },
      });

      const error = await withRetry(() => raw(wire.fetch), {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      }).catch((cause: unknown) => cause);

      expect(wire.calls).toHaveLength(1);
      const key = new Headers(wire.calls[0].init.headers).get(
        'Idempotency-Key',
      );
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error).toMatchObject({
        details: {
          lease_uuid: LEASE_UUID,
          idempotency_key: key,
          operation: name,
          outcome: 'unknown',
        },
      });
      expect(isRetryableError(error)).toBe(false);
      expect(isTransientProviderError(error)).toBe(false);
      expect(readCause).not.toHaveBeenCalled();
    },
  );

  it.each(operations)(
    'retains raw $name recovery context without retrying with a new generated key',
    async ({ name, raw }) => {
      const wire = sealedFetchProbe({
        [`/${name}`]: { status: 503, text: 'HTTP 503 unavailable' },
      });
      const error = await withRetry(() => raw(wire.fetch), {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      }).catch((cause: unknown) => cause);
      expect(wire.calls).toHaveLength(1);
      const key = new Headers(wire.calls[0].init.headers).get(
        'Idempotency-Key',
      );
      expect(key).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error).toMatchObject({
        status: 503,
        kind: 'http',
        details: {
          lease_uuid: LEASE_UUID,
          idempotency_key: key,
          operation: name,
          outcome: 'unknown',
        },
      });
      expect(isRetryableError(error)).toBe(false);
      expect(isTransientProviderError(error)).toBe(false);
    },
  );

  it.each(operations)(
    'threads a supplied $name key from the bound client to HTTP and back',
    async ({ name, run }) => {
      const wire = sealedFetchProbe({
        [`/${name}`]: { status: 202, json: { status: 'accepted' } },
      });
      const client = await clientWithFetch(wire.fetch);
      try {
        await expect(run(client, COMMAND_KEY)).resolves.toEqual({
          lease_uuid: LEASE_UUID,
          idempotency_key: COMMAND_KEY,
          status: 'accepted',
        });
        expect(wire.calls).toHaveLength(1);
        const request = wire.calls[0];
        expect(request.url).toBe(
          `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/${name}`,
        );
        expect(request.init.method).toBe('POST');
        expect(new Headers(request.init.headers).get('Idempotency-Key')).toBe(
          COMMAND_KEY,
        );
        if (name === 'update') {
          const body = JSON.parse(String(request.init.body));
          expect(Buffer.from(body.payload, 'base64').toString('utf8')).toBe(
            MANIFEST,
          );
        }
      } finally {
        client.dispose();
      }
    },
  );

  it.each(operations)(
    'preserves a generated $name key after a lost response without automatic replay',
    async ({ name, run }) => {
      const wire = sealedFetchProbe({
        [`/${name}`]: { transportError: new Error('ECONNRESET') },
      });
      const client = await clientWithFetch(wire.fetch);
      try {
        const error = await withRetry(() => run(client), {
          config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        }).catch((cause: unknown) => cause);
        expect(wire.calls).toHaveLength(1);
        const key = new Headers(wire.calls[0].init.headers).get(
          'Idempotency-Key',
        );
        expect(key).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(error).toMatchObject({
          details: {
            lease_uuid: LEASE_UUID,
            idempotency_key: key,
            operation: name,
            outcome: 'unknown',
          },
        });
        expect(isRetryableError(error)).toBe(false);
      } finally {
        client.dispose();
      }
    },
  );
});
