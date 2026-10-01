import { restartApp, updateApp } from '@manifest-network/manifest-sdk/deploy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  submitDevnetMaintenance,
  submitLegacyDevnetMaintenance,
} from './maintenance-admission.js';

// Fred's tenant body for every maintenance 503, including backend contention.
const UNAVAILABLE = 'service temporarily unavailable';

function refusal(
  key: string | undefined,
  body: string,
  details = {},
  status = 409,
  code = status === 409
    ? 'MAINTENANCE_REQUEST_FAILED'
    : 'RESTART_INDETERMINATE',
) {
  return Object.assign(
    new Error(
      `Diagnostic. Cause: ${JSON.stringify({ error: body, code: status })}`,
    ),
    {
      code,
      details: {
        provider_status: status,
        provider_error_kind: 'http',
        idempotency_key: key,
        operation: 'restart',
        outcome: 'unknown',
        ...details,
      },
    },
  );
}

const pending = (key: string) => refusal(key, UNAVAILABLE, {}, 503);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('legacy devnet admission recovery', () => {
  it('resubmits only a definitive invalid-state refusal without command keys', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid state for restart', code: 409 }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'restarting' }), { status: 202 }),
      );
    const providerToken = vi
      .fn()
      .mockResolvedValueOnce('legacy-auth-1')
      .mockResolvedValueOnce('legacy-auth-2');
    const ctx = {
      fetch,
      providerAuth: { providerToken },
      fredCompatibility: 'v0.13',
    } as unknown as Parameters<typeof restartApp>[0];
    const reconcile = vi.fn().mockResolvedValue(true);
    const result = submitLegacyDevnetMaintenance({
      operation: 'restart',
      submit: () =>
        restartApp(
          ctx,
          { address: 'tenant', leaseUuid: 'lease' },
          {
            providerUrl: 'https://provider.example',
            pollOptions: false,
          },
        ),
      reconcile,
    });
    await vi.runAllTimersAsync();
    expect(await result).not.toHaveProperty('idempotency_key');
    expect(providerToken).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('Idempotency-Key'),
      ),
    ).toEqual([null, null]);
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('Authorization'),
      ),
    ).toEqual(['Bearer legacy-auth-1', 'Bearer legacy-auth-2']);
  });

  it.each([
    ['invalid state for restart', { provider_status: 503 }],
    ['invalid state for restart', { provider_error_kind: 'network' }],
    ['invalid state for restart', { outcome: 'accepted' }],
    ['invalid state for restart', { idempotency_key: 'unexpected-key' }],
    ['lease is already undergoing a lifecycle operation', {}],
    ['unrecognized conflict', {}],
  ])(
    'never retries an uncertain legacy response: %s %j',
    async (body, details) => {
      const error = refusal(undefined, body, details);
      const submit = vi.fn().mockRejectedValue(error);
      const reconcile = vi.fn();
      await expect(
        submitLegacyDevnetMaintenance({
          operation: 'restart',
          submit,
          reconcile,
        }),
      ).rejects.toBe(error);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it('never retries a legacy 503 without command deduplication', async () => {
    const error = refusal(undefined, UNAVAILABLE, {}, 503);
    const submit = vi.fn().mockRejectedValue(error);
    const reconcile = vi.fn();
    await expect(
      submitLegacyDevnetMaintenance({
        operation: 'restart',
        submit,
        reconcile,
      }),
    ).rejects.toBe(error);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('stops legacy recovery when release history or readiness changed', async () => {
    const error = refusal(undefined, 'invalid state for restart');
    const submit = vi.fn().mockRejectedValue(error);
    const result = submitLegacyDevnetMaintenance({
      operation: 'restart',
      submit,
      reconcile: async () => false,
    });
    const rejection = expect(result).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejection;
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('pinned devnet admission recovery', () => {
  it('recognizes the real SDK error body and mints fresh authentication per attempt', async () => {
    const keys = [
      'a11ce000-0000-4000-8000-000000000001',
      'a11ce000-0000-4000-8000-000000000002',
    ];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid state for restart', code: 409 }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'restarting' }), { status: 202 }),
      );
    const providerToken = vi
      .fn()
      .mockResolvedValueOnce('auth-1')
      .mockResolvedValueOnce('auth-2');
    const ctx = {
      fredCompatibility: 'pr240',
      fetch,
      providerAuth: { providerToken },
    } as unknown as Parameters<typeof restartApp>[0];
    let nextKey = 0;
    const result = submitDevnetMaintenance({
      operation: 'restart',
      createKey: () => keys[nextKey++],
      submit: (idempotencyKey) =>
        restartApp(
          ctx,
          { address: 'tenant', leaseUuid: 'lease' },
          {
            providerUrl: 'https://provider.example',
            idempotencyKey,
            pollOptions: false,
          },
        ),
      reconcile: async () => true,
    });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ idempotency_key: keys[1] });
    expect(providerToken).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('Authorization'),
      ),
    ).toEqual(['Bearer auth-1', 'Bearer auth-2']);
    expect(
      fetch.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('Idempotency-Key'),
      ),
    ).toEqual(keys);
  });

  it.each([
    ['restart', 'restarting'],
    ['update', 'updating'],
  ] as const)(
    'joins a pending %s 503 with the same key, bytes, and fresh authentication',
    async (operation, status) => {
      const key = 'a11ce000-0000-4000-8000-000000000003';
      const unavailable = () =>
        new Response(JSON.stringify({ error: UNAVAILABLE, code: 503 }), {
          status: 503,
        });
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(unavailable())
        .mockResolvedValueOnce(unavailable())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status }), { status: 202 }),
        );
      let token = 0;
      const providerToken = vi.fn(async () => `auth-${++token}`);
      const ctx = {
        fredCompatibility: 'pr240',
        fetch,
        providerAuth: { providerToken },
      } as unknown as Parameters<typeof restartApp>[0];
      const createKey = vi.fn(() => key);
      // Recovery may already be running the command, so history can change.
      const reconcile = vi.fn().mockResolvedValue(false);
      const options = {
        providerUrl: 'https://provider.example',
        idempotencyKey: key,
        pollOptions: false,
      } as const;
      const result = submitDevnetMaintenance({
        operation,
        createKey,
        submit: (idempotencyKey) =>
          operation === 'restart'
            ? restartApp(
                ctx,
                { address: 'tenant', leaseUuid: 'lease' },
                { ...options, idempotencyKey },
              )
            : updateApp(
                ctx,
                {
                  address: 'tenant',
                  leaseUuid: 'lease',
                  manifest: JSON.stringify({
                    image: 'nginxinc/nginx-unprivileged:alpine',
                    ports: { '8080/tcp': {} },
                  }),
                },
                { ...options, idempotencyKey },
              ),
        reconcile,
      });
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ idempotency_key: key, status });
      expect(createKey).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
      expect(
        fetch.mock.calls.map(([url]) => new URL(url).pathname.split('/').pop()),
      ).toEqual([operation, operation, operation]);
      expect(
        fetch.mock.calls.map(([, init]) =>
          new Headers(init.headers).get('Idempotency-Key'),
        ),
      ).toEqual([key, key, key]);
      expect(
        fetch.mock.calls.map(([, init]) =>
          new Headers(init.headers).get('Authorization'),
        ),
      ).toEqual(['Bearer auth-1', 'Bearer auth-2', 'Bearer auth-3']);
      // An exact retry resends the same command bytes, never a new update.
      expect(new Set(fetch.mock.calls.map(([, init]) => init.body)).size).toBe(
        1,
      );
    },
  );

  it.each([
    [
      'lease is already undergoing a lifecycle operation',
      ['command-1', 'command-1'],
    ],
    ['invalid state for restart', ['command-1', 'command-2']],
  ] as const)('reconciles %s with the appropriate key', async (body, keys) => {
    let serial = 0;
    const createKey = vi.fn(() => `command-${++serial}`);
    const reconcile = vi.fn().mockResolvedValue(true);
    const submit = vi
      .fn()
      .mockImplementationOnce((key) => Promise.reject(refusal(key, body)))
      .mockImplementationOnce((key) =>
        Promise.resolve({ idempotency_key: key }),
      );
    const result = submitDevnetMaintenance({
      operation: 'restart',
      createKey,
      submit,
      reconcile,
    });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ idempotency_key: keys[1] });
    expect(submit.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(createKey).toHaveBeenCalledTimes(new Set(keys).size);
  });

  it('replaces a pending key only after its terminal refusal and reconciliation', async () => {
    let serial = 0;
    const createKey = vi.fn(() => `command-${++serial}`);
    const reconcile = vi.fn().mockResolvedValue(true);
    const submit = vi
      .fn()
      .mockImplementationOnce((key) => Promise.reject(pending(key)))
      .mockImplementationOnce((key) =>
        Promise.reject(refusal(key, 'invalid state for restart')),
      )
      .mockImplementationOnce((key) =>
        Promise.resolve({ idempotency_key: key }),
      );
    const result = submitDevnetMaintenance({
      operation: 'restart',
      createKey,
      submit,
      reconcile,
    });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ idempotency_key: 'command-2' });
    expect(submit.mock.calls.map(([key]) => key)).toEqual([
      'command-1',
      'command-1',
      'command-2',
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Idempotency-Key conflicts with a prior maintenance command', {}],
    ['invalid state for update', {}],
    ['invalid state for restart', { provider_status: 503 }],
    ['invalid state for restart', { provider_status: 401 }],
    ['invalid state for restart', { provider_error_kind: 'timeout' }],
    ['invalid state for restart', { outcome: 'accepted' }],
    ['invalid state for restart', { idempotency_key: 'earlier-command' }],
    // Fred never forwards the backend envelope; only its own body is known.
    ['admitted lifecycle work remains pending', {}, 503],
    [UNAVAILABLE, { provider_error_kind: 'timeout' }, 503],
    [UNAVAILABLE, { provider_error_kind: 'body_cap' }, 503],
    [UNAVAILABLE, { outcome: 'accepted' }, 503],
    [UNAVAILABLE, { operation: 'update' }, 503],
    [UNAVAILABLE, { idempotency_key: 'earlier-command' }, 503],
    [UNAVAILABLE, {}, 503, 'MAINTENANCE_REQUEST_FAILED'],
    [UNAVAILABLE, {}, 503, 'UPDATE_INDETERMINATE'],
    [UNAVAILABLE, {}, 500],
  ] as const)(
    'does not retry unrelated or uncertain failure %s %j %s %s',
    async (body, details, status?: number, code?: string) => {
      const error = refusal('command-1', body, details, status, code);
      const submit = vi.fn().mockRejectedValue(error);
      const reconcile = vi.fn();
      const createKey = vi.fn(() => 'command-1');
      await expect(
        submitDevnetMaintenance({
          operation: 'restart',
          createKey,
          submit,
          reconcile,
        }),
      ).rejects.toBe(error);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(createKey).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each([false, new Error('status read unavailable')])(
    'stops if readiness/history reconciliation fails: %s',
    async (observed) => {
      const error = refusal('command-1', 'invalid state for restart');
      const createKey = vi.fn(() => 'command-1');
      const submit = vi.fn().mockRejectedValue(error);
      const reconcile = vi.fn(() =>
        observed instanceof Error
          ? Promise.reject(observed)
          : Promise.resolve(observed),
      );
      const result = submitDevnetMaintenance({
        operation: 'restart',
        createKey,
        submit,
        reconcile,
      }).catch((cause) => cause);
      await vi.runAllTimersAsync();
      expect(await result).toBe(error);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(createKey).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds persistent refusal to five attempts and ten seconds of backoff', async () => {
    let serial = 0;
    const createKey = vi.fn(() => `command-${++serial}`);
    const reconcile = vi.fn().mockResolvedValue(true);
    const submit = vi.fn((key) =>
      Promise.reject(refusal(key, 'invalid state for restart')),
    );
    const started = Date.now();
    const result = submitDevnetMaintenance({
      operation: 'restart',
      createKey,
      submit,
      reconcile,
    }).catch((cause) => cause);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      details: { idempotency_key: 'command-5' },
    });
    expect(submit).toHaveBeenCalledTimes(5);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(Date.now() - started).toBe(10000);
  });

  it('bounds a persistently pending command without replacing its key', async () => {
    const createKey = vi.fn(() => 'command-1');
    const reconcile = vi.fn().mockResolvedValue(true);
    const submit = vi.fn((key) => Promise.reject(pending(key)));
    const started = Date.now();
    const result = submitDevnetMaintenance({
      operation: 'restart',
      createKey,
      submit,
      reconcile,
    }).catch((cause) => cause);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      code: 'RESTART_INDETERMINATE',
      details: { idempotency_key: 'command-1', provider_status: 503 },
    });
    expect(submit.mock.calls.map(([key]) => key)).toEqual(
      Array(5).fill('command-1'),
    );
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(Date.now() - started).toBe(10000);
  });

  it.each([
    ['invalid state for restart', 409, '{"error":"invalid state for restart"'],
    [
      'invalid state for restart',
      409,
      '{"error":"invalid state for restart","code":500}',
    ],
    [UNAVAILABLE, 503, '<html>503 Service Temporarily Unavailable</html>'],
    [UNAVAILABLE, 503, `{"error":"${UNAVAILABLE}"`],
    [UNAVAILABLE, 503, `{"error":"${UNAVAILABLE}","code":409}`],
  ] as const)(
    'refuses malformed or mismatched provider body %s %s %s',
    async (body, status, raw) => {
      const error = refusal('command-1', body, {}, status);
      error.message = `Diagnostic. Cause: ${raw}`;
      const submit = vi.fn().mockRejectedValue(error);
      const reconcile = vi.fn();
      await expect(
        submitDevnetMaintenance({
          operation: 'restart',
          createKey: () => 'command-1',
          submit,
          reconcile,
        }),
      ).rejects.toBe(error);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );
});
