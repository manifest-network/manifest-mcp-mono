import {
  isRetryableError,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import {
  type ProbeScript,
  type ProbeStep,
  sealedFetchProbe,
} from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { guidanceFor } from '../failure-guidance.js';
import {
  isTransientProviderError,
  ProviderApiError,
} from '../http/provider.js';
import {
  LeaseReadinessUnconfirmedError,
  TerminalChainStateError,
} from '../readiness/poll-lease-readiness.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { restartApp } from './restartApp.js';
import { updateApp } from './updateApp.js';

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const COMMAND_KEY = '77228fd4-4149-4981-83a8-21b4f6a2f681';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT = { address: 'manifest1abc', leaseUuid: LEASE_UUID };
const MANIFEST = '{"image":"nginx"}';
const READY = { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' };

const operations = [
  {
    name: 'restart',
    status: 'restarting',
    code: ManifestMCPErrorCode.RESTART_INDETERMINATE,
    failureReason: 'RestartFailed',
    invoke: (ctx: FredAuthCtx, options: LifecycleCallOptions) =>
      restartApp(ctx, INPUT, options),
  },
  {
    name: 'update',
    status: 'updating',
    code: ManifestMCPErrorCode.UPDATE_INDETERMINATE,
    failureReason: 'UpdateFailed',
    invoke: (ctx: FredAuthCtx, options: LifecycleCallOptions) =>
      updateApp(ctx, { ...INPUT, manifest: MANIFEST }, options),
  },
] as const;

function fixture(
  operation: string,
  mutation: ProbeScript,
  status: ProbeScript = { json: READY },
) {
  const wire = sealedFetchProbe({
    [`/${operation}`]: mutation,
    '/status': status,
  });
  let token = 0;
  const providerToken = vi.fn(async () => `fresh-token-${++token}`);
  const ctx: FredAuthCtx = {
    query: {} as never,
    chain: {} as never,
    fetch: wire.fetch,
    logger: noopLogger,
    providerAuth: { providerToken, leaseDataToken: vi.fn() },
  };
  return { ctx, wire, providerToken };
}

describe.each(operations)(
  '$name maintenance commands',
  ({ name, status, code, failureReason, invoke }) => {
    const options = { providerUrl: PROVIDER_URL, pollOptions: false as const };

    it('generates and returns a canonical key, and starts each new call with a fresh key', async () => {
      const { ctx, wire } = fixture(name, { status: 202, json: { status } });
      const first = await invoke(ctx, options);
      const second = await invoke(ctx, options);
      expect(first.idempotency_key).toMatch(UUID_V4);
      expect(second.idempotency_key).toMatch(UUID_V4);
      expect(second.idempotency_key).not.toBe(first.idempotency_key);
      expect(
        new Headers(wire.calls[0].init.headers).get('Idempotency-Key'),
      ).toBe(first.idempotency_key);
      expect(
        new Headers(wire.calls[1].init.headers).get('Idempotency-Key'),
      ).toBe(second.idempotency_key);
    });

    it.each([
      '',
      COMMAND_KEY.toUpperCase(),
      '77228fd4-4149-5981-83a8-21b4f6a2f681',
      `${COMMAND_KEY},${COMMAND_KEY}`,
    ])(
      'rejects invalid key %j before auth or network access',
      async (idempotencyKey) => {
        const { ctx, wire, providerToken } = fixture(name, {
          json: { status },
        });
        await expect(
          invoke(ctx, { ...options, idempotencyKey }),
        ).rejects.toMatchObject({
          code: ManifestMCPErrorCode.INVALID_ARGUMENT,
        });
        expect(providerToken).not.toHaveBeenCalled();
        expect(wire.calls).toHaveLength(0);
      },
    );

    it('keeps a local URL refusal outside the uncertain-command error boundary', async () => {
      const { ctx, wire } = fixture(name, { json: { status } });
      await expect(
        invoke(ctx, { ...options, providerUrl: 'http://127.0.0.1' }),
      ).rejects.toMatchObject({ kind: 'invalid_url' });
      expect(wire.calls).toHaveLength(0);
    });

    it('retries a lost response with the returned key, exact payload, and a fresh token', async () => {
      const { ctx, wire, providerToken } = fixture(name, [
        { transportError: new Error('response lost after admission') },
        { status: 202, json: { status } },
      ]);
      const error = await invoke(ctx, options).catch((err) => err);
      expect(error).toMatchObject({
        code,
        details: { lease_uuid: LEASE_UUID, outcome: 'unknown' },
      });
      expect(wire.calls).toHaveLength(1);
      expect(isRetryableError(error)).toBe(false);
      expect(error.details).not.toHaveProperty('sent');
      expect(error.details).not.toHaveProperty('provider_status');
      expect(error.details).not.toHaveProperty('status');
      expect(error.cause).toBeInstanceOf(ProviderApiError);
      expect(error.stack).toBe(error.cause.stack);
      expect(Object.keys(error)).not.toContain('cause');
      const key = error.details.idempotency_key as string;
      expect(key).toMatch(UUID_V4);
      const result = await invoke(ctx, { ...options, idempotencyKey: key });
      expect(result.idempotency_key).toBe(key);
      expect(wire.calls).toHaveLength(2);
      expect(wire.calls[1].init.body).toBe(wire.calls[0].init.body);
      for (const call of wire.calls)
        expect(new Headers(call.init.headers).get('Idempotency-Key')).toBe(key);
      expect(new Headers(wire.calls[0].init.headers).get('Authorization')).toBe(
        'Bearer fresh-token-1',
      );
      expect(new Headers(wire.calls[1].init.headers).get('Authorization')).toBe(
        'Bearer fresh-token-2',
      );
      expect(providerToken).toHaveBeenCalledTimes(2);
    });

    const uncertain: Array<{ title: string; response: ProbeStep }> = [
      {
        title: 'connection refused before submission',
        response: {
          transportError: Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          }),
        },
      },
      {
        title: 'DNS lookup failure before submission',
        response: {
          transportError: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
            code: 'ENOTFOUND',
          }),
        },
      },
      { title: '500', response: { status: 500, text: 'persistence failed' } },
      {
        title: '503',
        response: {
          status: 503,
          text: 'dispatch blocked',
          headers: { 'retry-after': '3' },
        },
      },
      {
        title: 'malformed accepted response',
        response: { status: 202, json: {} },
      },
      {
        title: 'broken response stream',
        response: { streamError: new Error('body connection reset') },
      },
    ];
    it.each(uncertain)(
      '$title retains the recovery handle without automatic retries',
      async ({ response }) => {
        const { ctx, wire } = fixture(name, response);
        const error = await invoke(ctx, {
          ...options,
          idempotencyKey: COMMAND_KEY,
        }).catch((err) => err);
        expect(error).toMatchObject({
          code,
          details: {
            lease_uuid: LEASE_UUID,
            idempotency_key: COMMAND_KEY,
            operation: name,
            outcome: 'unknown',
          },
        });
        expect(error.message).toContain('executes later');
        expect(error.message).toContain(COMMAND_KEY);
        expect(error.details).not.toHaveProperty('sent');
        expect(isRetryableError(error)).toBe(false);
        expect(wire.calls).toHaveLength(1);
      },
    );

    it('409 retains the key and diagnostic without claiming the command was never adopted', async () => {
      const { ctx, wire } = fixture(name, {
        status: 409,
        text: 'Idempotency-Key conflicts with a prior maintenance command',
      });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'unknown',
          provider_status: 409,
        },
      });
      expect(error.message).toContain(
        'conflicts with a prior maintenance command',
      );
      expect(error.details).not.toHaveProperty('sent');
      expect(isRetryableError(error)).toBe(false);
      expect(wire.calls).toHaveLength(1);
    });

    it('poll deadline preserves command acceptance and the original readiness error', async () => {
      const { ctx, wire } = fixture(name, { status: 202, json: { status } });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: { timeoutMs: 0 },
      }).catch((err) => err);
      expect(error).toMatchObject({
        reason: 'deadline',
        timeoutMs: 0,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          reason: 'deadline',
          readiness: 'unconfirmed',
          sent: true,
        },
      });
      expect(error).toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect(ProviderApiError.isProviderApiError(error)).toBe(true);
      expect(error.message).toContain('This is NOT a reported failure');
      expect(error.message).toContain('before treating it as failed.');
      expect(error.details).not.toHaveProperty('provider_status');
      expect(isRetryableError(error)).toBe(false);
      expect(isTransientProviderError(error)).toBe(false);
      const enriched = error.withContext({
        providerUuid: 'provider-1',
        providerUrl: PROVIDER_URL,
      });
      expect(enriched).toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect(enriched.details).toMatchObject({
        idempotency_key: COMMAND_KEY,
        outcome: 'accepted',
        provider_uuid: 'provider-1',
      });
      expect(enriched.cause).toBe(error.cause);
      expect(enriched.stack).toBe(error.stack);
      expect(isRetryableError(enriched)).toBe(false);
      expect(wire.calls).toHaveLength(1);
    });

    it('poll failure verdict retains acceptance without reporting readiness', async () => {
      const { ctx } = fixture(
        name,
        { status: 202, json: { status } },
        {
          json: {
            ...READY,
            provision_status: 'failed',
            reason: failureReason,
            message: 'The requested operation failed.',
          },
        },
      );
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toMatchObject({
        kind: 'poll_verdict',
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          provider_error_kind: 'poll_verdict',
          readiness: 'failed',
          reason: failureReason,
          message: 'The requested operation failed.',
          next_step: guidanceFor(failureReason)?.nextStep,
        },
      });
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toContain(failureReason);
      expect(error.message).not.toContain('NOT a reported failure');
      expect(isRetryableError(error)).toBe(false);
    });

    it('unreachable readiness preserves the public error type, timing, and full guidance', async () => {
      const { ctx, wire } = fixture(
        name,
        { status: 202, json: { status } },
        {
          status: 503,
          text: 'temporary backend outage',
        },
      );
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: { maxConsecutiveFailures: 0 },
      }).catch((err) => err);
      expect(error).toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect(error).toMatchObject({
        reason: 'provider_unreachable',
        consecutiveFailures: 1,
        timeoutMs: 600_000,
        elapsedMs: expect.any(Number),
        details: {
          idempotency_key: COMMAND_KEY,
          readiness: 'unconfirmed',
          outcome: 'accepted',
          consecutive_failures: 1,
        },
      });
      expect(error.message).toContain('This is NOT a reported failure');
      expect(error.message).toContain(
        'app_status before treating it as failed.',
      );
      expect(error.stack).toBe(error.cause.stack);
      expect(error.details).not.toHaveProperty('provider_status');
      expect(isTransientProviderError(error)).toBe(false);
      expect(isRetryableError(error)).toBe(false);
      expect(
        wire.calls.filter((call) => call.url.endsWith(`/${name}`)),
      ).toHaveLength(1);
    });

    it('a terminal chain verdict keeps its concrete class and chain state', async () => {
      const { ctx, wire } = fixture(name, { status: 202, json: { status } });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: { checkChainState: async () => ({ state: 'closed' }) },
      }).catch((err) => err);
      expect(error).toBeInstanceOf(TerminalChainStateError);
      expect(error).toMatchObject({
        chainState: 'closed',
        leaseUuid: LEASE_UUID,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          readiness: 'terminal',
          chain_state: 'closed',
        },
      });
      expect(error.details).not.toHaveProperty('provider_status');
      const enriched = error
        .withContext({ providerUuid: 'provider-1' })
        .withContext({ providerUrl: PROVIDER_URL });
      expect(enriched).toBeInstanceOf(TerminalChainStateError);
      expect(enriched).toMatchObject({
        providerUuid: 'provider-1',
        providerUrl: PROVIDER_URL,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          readiness: 'terminal',
        },
      });
      expect(enriched.cause).toBe(error.cause);
      expect(isRetryableError(error)).toBe(false);
      expect(wire.calls).toHaveLength(1);
    });

    it('a token failure after acceptance retains its operational code, details, and stack', async () => {
      const { ctx, wire, providerToken } = fixture(name, {
        status: 202,
        json: { status },
      });
      const failure = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'HTTP 503 while refreshing token metadata',
        { httpStatus: 503, action: 'providerToken' },
      );
      providerToken
        .mockResolvedValueOnce('mutation-token')
        .mockRejectedValueOnce(failure);
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.QUERY_FAILED,
        message: failure.message,
        details: {
          httpStatus: 503,
          action: 'providerToken',
          outcome: 'accepted',
          sent: true,
          idempotency_key: COMMAND_KEY,
        },
      });
      expect(error.stack).toBe(failure.stack);
      expect(error.cause).toBe(failure);
      expect(isRetryableError(error)).toBe(false);
      expect(wire.calls).toHaveLength(1);
    });

    it('a foreign-core token error retains its operational code and accepted command identity', async () => {
      const { ctx, wire, providerToken } = fixture(name, {
        status: 202,
        json: { status },
      });
      // The public shape comes from another core package copy, so local
      // instanceof cannot recognize it.
      const failure = Object.assign(
        new Error('provider signer is unavailable'),
        {
          name: 'ManifestMCPError',
          code: ManifestMCPErrorCode.INVALID_CONFIG,
          details: { option: 'providerSigner' },
        },
      );
      expect(failure).not.toBeInstanceOf(ManifestMCPError);
      providerToken
        .mockResolvedValueOnce('mutation-token')
        .mockRejectedValueOnce(failure);
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: failure.message,
        details: {
          option: 'providerSigner',
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          sent: true,
        },
      });
      expect(error.cause).toBe(failure);
      expect(error.stack).toBe(failure.stack);
      expect(isRetryableError(error)).toBe(false);
      expect(wire.calls).toHaveLength(1);
    });

    it.each(['timeout', 'signal'] as const)(
      '%s deadline remains TimeoutError after acceptance',
      async (option) => {
        const controller = new AbortController();
        const deadline = new DOMException(
          'The operation timed out',
          'TimeoutError',
        );
        const timeout = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(controller.signal);
        try {
          const { ctx, wire } = fixture(
            name,
            { status: 202, json: { status } },
            {
              json: { ...READY, provision_status: status },
            },
          );
          const error = await invoke(ctx, {
            ...options,
            idempotencyKey: COMMAND_KEY,
            ...(option === 'timeout'
              ? { timeout: 1000 }
              : { signal: controller.signal }),
            pollOptions: { onProgress: () => controller.abort(deadline) },
          }).catch((err) => err);
          expect(error).toBeInstanceOf(DOMException);
          expect(error).toMatchObject({
            name: 'TimeoutError',
            code: deadline.code,
            details: {
              reason: 'deadline',
              readiness: 'unconfirmed',
              outcome: 'accepted',
              idempotency_key: COMMAND_KEY,
            },
          });
          expect(error.stack).toBe(deadline.stack);
          const details = { ...error.details, provider_url: PROVIDER_URL };
          Object.defineProperty(error, 'details', { value: details });
          expect(error.details).toBe(details);
          expect(isRetryableError(error)).toBe(false);
          expect(wire.calls).toHaveLength(2);
        } finally {
          timeout.mockRestore();
        }
      },
    );

    it('a genuine failure racing caller abort remains the reported failure verdict', async () => {
      const controller = new AbortController();
      const { ctx } = fixture(
        name,
        { status: 202, json: { status } },
        {
          json: { ...READY, provision_status: 'failed', reason: failureReason },
        },
      );
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        signal: controller.signal,
        pollOptions: {
          onProgress: () =>
            controller.abort(new Error('caller stopped waiting')),
        },
      }).catch((err) => err);
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error).toMatchObject({
        kind: 'poll_verdict',
        details: {
          readiness: 'failed',
          reason: failureReason,
          outcome: 'accepted',
        },
      });
      expect(error.code).not.toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    });

    it('401 on an exact retry retains uncertainty and recommends fresh authentication with the same key', async () => {
      const { ctx, wire } = fixture(name, {
        status: 401,
        text: 'token expired',
      });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED,
        details: {
          outcome: 'unknown',
          provider_status: 401,
          idempotency_key: COMMAND_KEY,
        },
      });
      expect(error.message).toContain('Refresh provider authentication');
      expect(error.message).toContain('reuse this key');
      expect(error.message).toContain('earlier attempt');
      expect(wire.calls).toHaveLength(1);
    });

    it('a callback error with unreadable diagnostics cannot lose the accepted command key', async () => {
      const failure = new Error();
      Object.defineProperty(failure, 'message', {
        get: () => {
          throw new Error('unreadable diagnostic');
        },
      });
      const { ctx } = fixture(name, { status: 202, json: { status } });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {
          onProgress: () => {
            throw failure;
          },
        },
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
        details: {
          lease_uuid: LEASE_UUID,
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
        },
      });
      expect(error.cause).toBe(failure);
      expect(error.message).toContain('Error details unavailable');
    });

    it('unreadable typed token diagnostics preserve the accepted command identity', async () => {
      const { ctx, providerToken } = fixture(name, {
        status: 202,
        json: { status },
      });
      const failure = new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'token configuration failed',
      );
      for (const field of ['message', 'details', 'code']) {
        Object.defineProperty(failure, field, {
          get: () => {
            throw new Error('unreadable');
          },
        });
      }
      providerToken
        .mockResolvedValueOnce('mutation-token')
        .mockRejectedValueOnce(failure);
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
        details: { outcome: 'accepted', idempotency_key: COMMAND_KEY },
      });
      expect(error.cause).toBe(failure);
    });

    it('a callback proxy with unreadable prototype cannot replace command recovery context', async () => {
      const failure = new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('unreadable prototype');
          },
        },
      );
      const { ctx } = fixture(name, { status: 202, json: { status } });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {
          onProgress: () => {
            throw failure;
          },
        },
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
        details: { outcome: 'accepted', idempotency_key: COMMAND_KEY },
      });
      expect(error.cause === failure).toBe(true);
    });

    it('unreadable nested request diagnostics cannot replace the original command key', async () => {
      const failure = new ManifestMCPError(
        ManifestMCPErrorCode.UPDATE_INDETERMINATE,
        'network error',
      );
      Object.defineProperty(failure, 'details', {
        get: () => {
          throw new Error('unreadable details');
        },
      });
      const { ctx, wire } = fixture(name, { transportError: failure });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
      }).catch((err) => err);
      expect(error).toMatchObject({
        code,
        details: { outcome: 'unknown', idempotency_key: COMMAND_KEY },
      });
      expect(wire.calls).toHaveLength(1);
    });

    it('cancellation after acceptance retains the key and the original cancellation reason', async () => {
      const controller = new AbortController();
      const reason = new Error('caller stopped waiting');
      const { ctx, wire } = fixture(name, () => {
        controller.abort(reason);
        return { status: 202, json: { status } };
      });
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        signal: controller.signal,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { idempotency_key: COMMAND_KEY, outcome: 'accepted' },
      });
      expect(error.cause).toBe(reason);
      expect(error.message).toContain('does not revoke');
      expect(wire.calls).toHaveLength(1);
    });
  },
);
