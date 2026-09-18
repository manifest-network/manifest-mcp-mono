import {
  isRetryableError,
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
import { ProviderApiError } from '../http/provider.js';
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
    invoke: (ctx: FredAuthCtx, options: LifecycleCallOptions) =>
      restartApp(ctx, INPUT, options),
  },
  {
    name: 'update',
    status: 'updating',
    code: ManifestMCPErrorCode.UPDATE_INDETERMINATE,
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
  ({ name, status, code, invoke }) => {
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
        code: ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          reason: 'deadline',
        },
      });
      expect(ProviderApiError.isProviderApiError(error.cause)).toBe(true);
      expect(isRetryableError(error)).toBe(false);
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
            reason: 'UpdateFailed',
          },
        },
      );
      const error = await invoke(ctx, {
        ...options,
        idempotencyKey: COMMAND_KEY,
        pollOptions: {},
      }).catch((err) => err);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
        details: {
          idempotency_key: COMMAND_KEY,
          outcome: 'accepted',
          provider_error_kind: 'poll_verdict',
        },
      });
      expect(error.message).toContain('UpdateFailed');
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
