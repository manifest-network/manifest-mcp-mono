import { restartApp } from '@manifest-network/manifest-sdk/deploy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitDevnetMaintenance } from './maintenance-admission.js';

function refusal(key: string, body: string, details = {}) {
  return Object.assign(
    new Error(
      `Diagnostic. Cause: ${JSON.stringify({ error: body, code: 409 })}`,
    ),
    {
      code: 'MAINTENANCE_REQUEST_FAILED',
      details: {
        provider_status: 409,
        provider_error_kind: 'http',
        idempotency_key: key,
        operation: 'restart',
        outcome: 'unknown',
        ...details,
      },
    },
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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

  it.each([
    ['Idempotency-Key conflicts with a prior maintenance command', {}],
    ['invalid state for update', {}],
    ['invalid state for restart', { provider_status: 503 }],
    ['invalid state for restart', { provider_status: 401 }],
    ['invalid state for restart', { provider_error_kind: 'timeout' }],
    ['invalid state for restart', { outcome: 'accepted' }],
    ['invalid state for restart', { idempotency_key: 'earlier-command' }],
  ])(
    'does not retry unrelated or uncertain failure %s %j',
    async (body, details) => {
      const error = refusal('command-1', body as string, details);
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

  it.each([
    '{"error":"invalid state for restart"',
    '{"error":"invalid state for restart","code":500}',
  ])('refuses malformed or mismatched provider body %s', async (body) => {
    const error = refusal('command-1', 'invalid state for restart');
    error.message = `Diagnostic. Cause: ${body}`;
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
    expect(reconcile).not.toHaveBeenCalled();
  });
});
