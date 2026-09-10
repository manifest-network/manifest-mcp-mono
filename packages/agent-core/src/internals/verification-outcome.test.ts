import {
  asFqdn,
  asLeaseUuid,
  isRetryableError,
  type jsonResponse,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SetItemCustomDomainResult,
  type StopAppResult,
  withErrorHandling,
  withRetry,
} from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  verificationQueryError,
  withVerificationOutcome,
} from './verification-outcome.js';

const LEASE = asLeaseUuid('11111111-1111-4111-8111-111111111111');
const HASH = 'A'.repeat(64);
const RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 };
const STOPPED = Object.freeze({
  lease_uuid: LEASE,
  outcome: 'stopped',
  lease_state: 'LEASE_STATE_CLOSED',
  transactionHash: HASH,
  confirmed: true,
  code: 0,
} satisfies StopAppResult);
const DOMAIN = Object.freeze({
  lease_uuid: LEASE,
  service_name: 'web',
  custom_domain: asFqdn('app.example.com'),
  transactionHash: HASH,
  confirmed: true,
  code: 0,
} satisfies SetItemCustomDomainResult);

async function rejectedError(
  operation: () => Promise<unknown>,
): Promise<ManifestMCPError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (error instanceof ManifestMCPError) return error;
    throw error;
  }
  throw new Error('Expected the operation to reject');
}

function causeOf(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
  expect(descriptor?.enumerable).toBe(false);
  return descriptor?.value;
}

async function projectError(error: ManifestMCPError) {
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  const handler = withErrorHandling(
    'verification_outcome_probe',
    async (
      _args: Record<string, unknown>,
      _extra: object,
    ): Promise<ReturnType<typeof jsonResponse>> => {
      throw error;
    },
  );
  const result = await handler({ blob: 'input'.repeat(20_000) }, {});
  expect(result.isError).toBe(true);
  const content = result.content[0];
  if (content?.type !== 'text')
    throw new Error('Expected an MCP text response');
  // Assert the public boundary's documented budget independently of its constant.
  expect(content.text.length).toBeLessThanOrEqual(8_000);
  return { text: content.text, body: JSON.parse(content.text) };
}

describe('verification outcome through retry and MCP boundaries', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a frozen receipt authoritative over frozen conflicting query details without replay', async () => {
    const details = Object.freeze({
      httpStatus: 408,
      lease_uuid: 'unrelated-lease',
      sent: false,
      transaction_hash: 'UNRELATED-HASH',
      transaction_confirmed: false,
      transaction_code: 99,
      stop_outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_PENDING',
    });
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Opaque query failure',
        details,
      ),
    );
    expect(isRetryableError(original)).toBe(true);
    const verify = vi.fn(async () => {
      throw original;
    });
    const operation = vi.fn(() => withVerificationOutcome(STOPPED, verify));
    const error = await rejectedError(() =>
      withRetry(operation, { config: RETRY }),
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(error).not.toBe(original);
    expect(causeOf(error)).toBe(original);
    expect(error.code).toBe(original.code);
    expect(error.message).toBe(original.message);
    expect(error.details).toMatchObject({
      httpStatus: 408,
      lease_uuid: LEASE,
      sent: true,
      transaction_hash: HASH,
      transaction_confirmed: true,
      transaction_code: 0,
      stop_outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
    });
    expect(original.details).toBe(details);
    expect(original.details).toMatchObject({
      sent: false,
      transaction_hash: 'UNRELATED-HASH',
    });
    expect(Object.getOwnPropertyDescriptor(original, 'cause')).toBeUndefined();
    expect(isRetryableError(error)).toBe(false);

    const { body } = await projectError(error);
    expect(body).toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: { sent: true, transaction_hash: HASH, lease_uuid: LEASE },
    });
    expect(body).not.toHaveProperty('cause');
  });

  it.each([
    {
      name: 'confirmed stop',
      receipt: STOPPED,
      metadata: {
        transaction_confirmed: true,
        transaction_code: 0,
        stop_outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
      },
    },
    {
      name: 'confirmed domain change',
      receipt: DOMAIN,
      metadata: {
        transaction_confirmed: true,
        transaction_code: 0,
        service_name: 'web',
        custom_domain: 'app.example.com',
      },
    },
    {
      name: 'unconfirmed cancellation',
      receipt: {
        lease_uuid: LEASE,
        outcome: 'cancelled',
        lease_state: 'LEASE_STATE_REJECTED',
        transactionHash: HASH,
        confirmed: false,
      } satisfies StopAppResult,
      metadata: {
        transaction_confirmed: false,
        stop_outcome: 'cancelled',
        lease_state: 'LEASE_STATE_REJECTED',
      },
    },
  ])(
    'preserves the $name receipt ahead of oversized upstream diagnostics in real MCP output',
    async ({ receipt, metadata }) => {
      const rawLog = '\\"\n'.repeat(30_000);
      const details = Object.freeze({
        // These names receive the projection's recovery priority too. They must
        // not consume the entire budget ahead of the actual receipt fields.
        message: 'query diagnostic '.repeat(5_000),
        source_lease_uuid: 'upstream-source '.repeat(5_000),
        orphaned_lease_uuid: 'upstream-orphan '.repeat(5_000),
        provider_uuid: 'upstream-provider '.repeat(5_000),
        rawLog,
        httpStatus: 503,
        password: 'do-not-return-this-secret',
        noisy: Array.from({ length: 200 }, () => 'noise'.repeat(500)),
      });
      const original = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Verification unavailable',
          details,
        ),
      );
      const error = await rejectedError(() =>
        withVerificationOutcome(receipt, async () => {
          throw original;
        }),
      );

      const { body, text } = await projectError(error);
      expect(body).toMatchObject({
        code: ManifestMCPErrorCode.QUERY_FAILED,
        truncated: true,
        details: {
          sent: true,
          transaction_hash: HASH,
          lease_uuid: LEASE,
          ...metadata,
        },
      });
      expect(text).not.toContain('do-not-return-this-secret');
      expect(error.details?.rawLog).toBe(rawLog);
      expect(causeOf(error)).toBe(original);
      expect(original.details).toBe(details);
      if (!('code' in receipt))
        expect(body.details).not.toHaveProperty('transaction_code');
    },
  );

  it.each([false, true])(
    'preserves an unexpected decoder failure and stops retry (pre-normalized: %s)',
    async (normalized) => {
      const original = Object.freeze(
        new TypeError('Decoder callback failed: ECONNRESET'),
      );
      expect(isRetryableError(original)).toBe(true);
      const failure = normalized
        ? verificationQueryError(
            'Verification response could not be decoded',
            original,
          )
        : original;
      const operation = vi.fn(() =>
        withVerificationOutcome(DOMAIN, async () => {
          throw failure;
        }),
      );
      const error = await rejectedError(() =>
        withRetry(operation, { config: RETRY }),
      );

      expect(operation).toHaveBeenCalledOnce();
      expect(error.details).toMatchObject({
        sent: true,
        lease_uuid: LEASE,
        transaction_hash: HASH,
        transaction_confirmed: true,
        transaction_code: 0,
      });
      const wrapped = causeOf(error);
      expect(wrapped).toBeInstanceOf(ManifestMCPError);
      expect(causeOf(wrapped)).toBe(original);
      expect(isRetryableError(error)).toBe(false);
      const { body } = await projectError(error);
      expect(body.details).toMatchObject({
        sent: true,
        transaction_hash: HASH,
      });
      expect(body).not.toHaveProperty('cause');
    },
  );

  it('preserves a non-Error verification rejection as the nested cause', async () => {
    const original = Object.freeze({
      problem: 'decoder returned an unexpected payload',
    });
    const error = await rejectedError(() =>
      withVerificationOutcome(DOMAIN, async () => {
        throw original;
      }),
    );
    expect(causeOf(causeOf(error))).toBe(original);
    expect(error.details).toMatchObject({ sent: true, transaction_hash: HASH });
    expect(isRetryableError(error)).toBe(false);
  });

  it('does not invent submission evidence for an already-inactive receipt or change its read retry policy', async () => {
    const inactive = Object.freeze({
      lease_uuid: LEASE,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: 'provider-authored reason is not receipt metadata',
    } satisfies StopAppResult);
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'Opaque query failure',
      {
        httpStatus: 408,
      },
    );
    const success = Object.freeze({
      leaseUuid: LEASE,
      finalState: 'LEASE_STATE_REJECTED',
    });
    const verify = vi
      .fn()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(success);
    const onRetry = vi.fn();

    await expect(
      withRetry(() => withVerificationOutcome(inactive, verify), {
        config: RETRY,
        onRetry,
      }),
    ).resolves.toBe(success);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    const error: unknown = onRetry.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError))
      throw new Error('Expected SDK error');
    expect(causeOf(error)).toBe(original);
    expect(error.details).toMatchObject({
      lease_uuid: LEASE,
      stop_outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      httpStatus: 408,
    });
    for (const key of [
      'sent',
      'partial',
      'transaction_hash',
      'transaction_confirmed',
      'transaction_code',
      'rejection_reason',
    ]) {
      expect(error.details).not.toHaveProperty(key);
    }
    const { body, text } = await projectError(error);
    expect(body.details).toMatchObject({
      stop_outcome: 'already_inactive',
      lease_uuid: LEASE,
    });
    expect(body.details).not.toHaveProperty('sent');
    expect(body.details).not.toHaveProperty('transaction_hash');
    expect(text).not.toContain(inactive.rejection_reason);
  });
});
