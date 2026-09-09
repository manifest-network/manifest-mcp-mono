import {
  MockAgent,
  type RequestInit as UndiciRequestInit,
  fetch as undiciFetch,
} from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { restoreLease, updateLease } from './fred.js';
import {
  checkedFetch,
  isTransientProviderError,
  ProviderApiError,
} from './provider.js';

const PROVIDER = 'https://provider.example';
const LEASE = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'public-fixture-token';
const MANIFEST = 'public-fixture-manifest';

describe('provider redirect policy with real Undici fetch', () => {
  it.each(
    (['update', 'restore'] as const).flatMap((operation) =>
      [307, 308].flatMap((status) =>
        [
          ['HTTPS downgrade', 'http://provider.example/redirected'],
          ['cross-origin HTTPS', 'https://other.example/redirected'],
          ['same-origin HTTPS', `${PROVIDER}/redirected`],
        ].map(([destination, location]) => ({
          operation,
          status,
          destination,
          location,
        })),
      ),
    ),
  )(
    'refuses $operation $status $destination before replaying any body or credentials',
    async ({ operation, status, location }) => {
      const dispatcher = new MockAgent();
      dispatcher.disableNetConnect();
      // Only the network is replaced. The provider wrappers, manual redirect
      // handling, and Undici's actual redirect implementation all run unchanged.
      const fetchFn: typeof globalThis.fetch = async (input, init) =>
        (await undiciFetch(
          input as string,
          {
            ...init,
            dispatcher,
          } as UndiciRequestInit,
        )) as unknown as Response;
      const originalRequest = vi.fn(() => 'redirect');
      dispatcher
        .get(PROVIDER)
        .intercept({
          path: `/v1/leases/${LEASE}/${operation}`,
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(
            operation === 'update'
              ? { payload: Buffer.from(MANIFEST).toString('base64') }
              : { from_lease_uuid: SOURCE },
          ),
        })
        .reply(status, originalRequest, { headers: { location } });
      const forwardedRequest = vi.fn(() => ({ status: 'provisioning' }));
      const destination = new URL(location);
      dispatcher
        .get(destination.origin)
        .intercept({
          path: destination.pathname,
          method: 'POST',
        })
        .reply(202, forwardedRequest);

      try {
        const request =
          operation === 'update'
            ? updateLease(
                PROVIDER,
                LEASE,
                new TextEncoder().encode(MANIFEST),
                TOKEN,
                fetchFn,
              )
            : restoreLease(PROVIDER, LEASE, SOURCE, TOKEN, fetchFn);
        const err = await request.catch((error: unknown) => error);

        expect(err).toBeInstanceOf(ProviderApiError);
        expect(err).toMatchObject({ status, kind: 'redirect' });
        expect(isTransientProviderError(err)).toBe(false);
        expect(originalRequest).toHaveBeenCalledOnce();
        expect(forwardedRequest).not.toHaveBeenCalled();
        expect(dispatcher.pendingInterceptors()).toHaveLength(1);
      } finally {
        await dispatcher.close();
      }
    },
  );

  it('does not allow a RequestInit override to enable redirect following', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'http://other.example' },
      }),
    );
    await expect(
      checkedFetch(PROVIDER, { redirect: 'follow' }, 1000, fetchFn),
    ).rejects.toMatchObject({ kind: 'redirect' });
    expect(fetchFn).toHaveBeenCalledWith(
      PROVIDER,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('refuses the opaque redirect response exposed by browsers', async () => {
    const response = Response.error();
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response);
    await expect(
      checkedFetch(PROVIDER, undefined, 1000, fetchFn),
    ).rejects.toMatchObject({ status: 0, kind: 'redirect' });
  });
});
