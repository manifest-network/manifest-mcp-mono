import {
  asFqdn,
  asLeaseUuid,
  isRetryableError,
  type jsonResponse,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SetItemCustomDomainResult,
  type StopAppReconciliation,
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
const INACTIVE = Object.freeze({
  lease_uuid: LEASE,
  outcome: 'already_inactive',
  lease_state: 'LEASE_STATE_CLOSED',
} satisfies StopAppResult);
const FOREIGN_RECEIPT_DETAILS = Object.freeze({
  lease_uuid: 'unrelated-lease',
  sent: true,
  transaction_hash: 'UNRELATED-HASH',
  transaction_confirmed: true,
  transaction_code: 99,
  confirmed: true,
  outcome: 'cancelled',
  stop_outcome: 'unrelated-stop-outcome',
  lease_state: 'LEASE_STATE_PENDING',
  service_name: 'unrelated-service',
  custom_domain: 'unrelated.example.com',
  rejection_reason: 'unrelated native-shaped rejection reason',
  leaseUuid: 'unrelated-camel-lease',
  SENT: true,
  transactionHash: 'UNRELATED-CAMEL-HASH',
  'TRANSACTION-HASH': 'UNRELATED-UPPER-HYPHEN-HASH',
  txHash: 'UNRELATED-SHORT-CAMEL-HASH',
  tx_hash: 'UNRELATED-SHORT-SNAKE-HASH',
  transactionConfirmed: true,
  transactionCode: 98,
  stopOutcome: 'unrelated-camel-stop-outcome',
  leaseState: 'LEASE_STATE_ACTIVE',
  serviceName: 'unrelated-camel-service',
  customDomain: 'unrelated-camel.example.com',
  rejectionReason: 'unrelated camel-shaped rejection reason',
  CONFIRMED: true,
  'out-come': 'cancelled',
  // Display sanitization removes these zero-width, bidi and ANSI controls.
  'rejection_\u200breason': 'disguised upstream rejection reason',
  'transaction\u202eHash': 'DISGUISED-TRANSACTION-HASH',
  '\u001b[31mtxHash\u001b[0m': 'DISGUISED-ANSI-TX-HASH',
  'tx_\u200bhash': 'DISGUISED-ZERO-WIDTH-TX-HASH',
  'confi\u200brmed': true,
  'out\u202ecome': 'cancelled',
  '\u001b[31moutcome\u001b[0m': 'cancelled',
  reconciliation: { sent: true, transactionHash: 'FOREIGN-RECONCILIATION' },
  Reconciliation: { sent: true },
  're_con-ciliation': { sent: true },
  'recon\u200bciliation': { sent: true },
});
const READ_DIAGNOSTICS = Object.freeze({
  httpStatus: 408,
  grpcCode: 14,
  grpcMessage: 'Verification service unavailable',
  transportCode: 'ETIMEDOUT',
  code: 73,
  hash: 'verification-diagnostic-hash',
  committed: false,
  diagnostic: Object.freeze({ phase: 'verification', attempt: 1 }),
});

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

  it('retains a reconciled submission beside the later verification cause without replay or serialized errors', async () => {
    const earlier = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'earlier private broadcast diagnostic',
      ),
    );
    const reconciliation: StopAppReconciliation = Object.freeze(
      Object.defineProperty(
        {
          error: earlier,
          errorCode: ManifestMCPErrorCode.TX_FAILED,
          sent: true,
          transactionHash: HASH,
          transactionCode: 7,
          transactionHeight: '1234',
          transactionConfirmed: true,
        },
        'error',
        { enumerable: false },
      ),
    );
    const receipt = Object.freeze({
      ...INACTIVE,
      reconciliation,
    } satisfies StopAppResult);
    const later = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'later verification unavailable',
        Object.freeze({
          ...FOREIGN_RECEIPT_DETAILS,
          httpStatus: 503,
          sent: false,
        }),
      ),
    );
    const operation = vi.fn(() =>
      withVerificationOutcome(receipt, async () => {
        throw later;
      }),
    );
    const error = await rejectedError(() =>
      withRetry(operation, { config: RETRY }),
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(causeOf(error)).toBe(later);
    expect(error.details?.reconciliation).toBe(reconciliation);
    expect(reconciliation.error).toBe(earlier);
    expect(Object.isFrozen(reconciliation)).toBe(true);
    expect(later).not.toHaveProperty('cause');
    expect(earlier).not.toHaveProperty('cause');
    expect(error.details).toEqual({
      lease_uuid: LEASE,
      stop_outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
      reconciliation,
      sent: true,
      httpStatus: 503,
    });
    expect(isRetryableError(error)).toBe(false);
    const serializedSnapshot = {
      errorCode: ManifestMCPErrorCode.TX_FAILED,
      sent: true,
      transactionHash: HASH,
      transactionCode: 7,
      transactionHeight: '1234',
      transactionConfirmed: true,
    };
    const json = JSON.stringify(error);
    expect(JSON.parse(json).details.reconciliation).toEqual(serializedSnapshot);
    expect(json).not.toContain(earlier.message);
    const { body, text } = await projectError(error);
    expect(body.details.reconciliation).toEqual(serializedSnapshot);
    expect(body.details.sent).toBe(true);
    expect(body.details).not.toHaveProperty('transaction_hash');
    expect(body).not.toHaveProperty('cause');
    expect(text).not.toContain(earlier.message);
  });

  it.each([false, undefined])(
    'keeps reconciliation sent=%s distinct from the later retryable verification',
    async (sent) => {
      const earlier = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'earlier connection configuration failure',
        ),
      );
      const reconciliation: StopAppReconciliation = Object.freeze(
        Object.defineProperty(
          {
            error: earlier,
            errorCode: ManifestMCPErrorCode.INVALID_CONFIG,
            ...(sent === undefined ? {} : { sent }),
          },
          'error',
          { enumerable: false },
        ),
      );
      const receipt = Object.freeze({
        ...INACTIVE,
        reconciliation,
      } satisfies StopAppResult);
      const later = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'later HTTP 503',
          { httpStatus: 503 },
        ),
      );
      const error = await rejectedError(() =>
        withVerificationOutcome(receipt, async () => {
          throw later;
        }),
      );

      expect(error.details?.reconciliation).toBe(reconciliation);
      expect(causeOf(error)).toBe(later);
      expect(reconciliation.error).toBe(earlier);
      expect(error.details).not.toHaveProperty('sent');
      expect(error.details).not.toHaveProperty('transaction_hash');
      expect(isRetryableError(error)).toBe(true);
    },
  );

  it.each([
    {
      name: 'inactive',
      receipt: INACTIVE,
      expectedReceipt: {
        lease_uuid: LEASE,
        stop_outcome: 'already_inactive',
        lease_state: 'LEASE_STATE_CLOSED',
      },
    },
    {
      name: 'domain',
      receipt: DOMAIN,
      expectedReceipt: {
        lease_uuid: LEASE,
        sent: true,
        transaction_hash: HASH,
        transaction_confirmed: true,
        transaction_code: 0,
        service_name: 'web',
        custom_domain: 'app.example.com',
      },
    },
    {
      name: 'confirmed stop',
      receipt: STOPPED,
      expectedReceipt: {
        lease_uuid: LEASE,
        sent: true,
        transaction_hash: HASH,
        transaction_confirmed: true,
        transaction_code: 0,
        stop_outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
      },
    },
    {
      name: 'unconfirmed stop',
      receipt: Object.freeze({
        lease_uuid: LEASE,
        outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
        transactionHash: HASH,
        confirmed: false,
      } satisfies StopAppResult),
      expectedReceipt: {
        lease_uuid: LEASE,
        sent: true,
        transaction_hash: HASH,
        transaction_confirmed: false,
        stop_outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
      },
    },
  ])(
    'does not attribute foreign receipt fields or normalized aliases to the $name result in SDK or MCP errors',
    async ({ receipt, expectedReceipt }) => {
      const foreignNativeAliases = {
        confirmed: 'confirmed' in receipt ? !receipt.confirmed : true,
        outcome:
          'outcome' in receipt && receipt.outcome === 'stopped'
            ? 'cancelled'
            : 'stopped',
      };
      const details = Object.freeze({
        ...FOREIGN_RECEIPT_DETAILS,
        ...foreignNativeAliases,
        ...READ_DIAGNOSTICS,
      });
      const original = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Read failure carrying unrelated receipt metadata',
          details,
        ),
      );
      const operation = vi.fn(() =>
        withVerificationOutcome(receipt, async () => {
          throw original;
        }),
      );
      const error = await rejectedError(() =>
        withRetry(operation, { config: RETRY }),
      );

      expect(operation).toHaveBeenCalledOnce();
      expect(error).not.toBe(original);
      expect(causeOf(error)).toBe(original);
      expect(error.code).toBe(original.code);
      expect(error.message).toBe(original.message);
      // Exact comparison guards absent fields as well as authoritative values;
      // receipt variants must not inherit another operation's evidence.
      const expectedDetails = { ...expectedReceipt, ...READ_DIAGNOSTICS };
      expect.soft(error.details).toEqual(expectedDetails);
      // Bare native confirmed/outcome fields are reserved aliases. Generic
      // code/hash/committed diagnostics coexist with qualified receipt fields.
      expect(error.details).toMatchObject({
        code: 73,
        hash: 'verification-diagnostic-hash',
        committed: false,
      });
      expect.soft(error.details).not.toHaveProperty('confirmed');
      expect.soft(error.details).not.toHaveProperty('outcome');
      if ('transactionHash' in receipt) {
        expect(error.details?.transaction_hash).toBe(receipt.transactionHash);
        expect(error.details?.transaction_confirmed).toBe(receipt.confirmed);
        if ('code' in receipt) {
          expect(error.details?.transaction_code).toBe(receipt.code);
          expect(error.details?.code).not.toBe(receipt.code);
        }
      }
      if ('outcome' in receipt) {
        expect(error.details?.stop_outcome).toBe(receipt.outcome);
        expect(foreignNativeAliases.outcome).not.toBe(receipt.outcome);
      }
      expect(original.details).toBe(details);
      expect(original.details).toEqual({
        ...FOREIGN_RECEIPT_DETAILS,
        ...foreignNativeAliases,
        ...READ_DIAGNOSTICS,
      });
      expect(
        Object.getOwnPropertyDescriptor(original, 'cause'),
      ).toBeUndefined();
      expect(isRetryableError(error)).toBe(false);

      if (receipt === INACTIVE) {
        // No partial flag or permanent code can mask this guard: retry stays
        // prohibited solely because the retained original cause has sent:true.
        expect(error.details).not.toHaveProperty('sent');
        expect(error.details).not.toHaveProperty('partial');
        expect(original.details?.sent).toBe(true);
        expect(original.details).not.toHaveProperty('partial');
        expect(
          isRetryableError(
            new ManifestMCPError(error.code, error.message, error.details),
          ),
        ).toBe(true);
      }

      const { body } = await projectError(error);
      expect(body.code).toBe(original.code);
      expect.soft(body.details).toEqual(expectedDetails);
      expect(body).not.toHaveProperty('cause');
    },
  );

  it('preserves a partial-outcome veto independently of sent on an inactive receipt', async () => {
    const details = Object.freeze({
      ...FOREIGN_RECEIPT_DETAILS,
      ...READ_DIAGNOSTICS,
      sent: false,
      partial: true,
    });
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Verification encountered a partial outcome',
        details,
      ),
    );
    const operation = vi.fn(() =>
      withVerificationOutcome(INACTIVE, async () => {
        throw original;
      }),
    );
    const error = await rejectedError(() =>
      withRetry(operation, { config: RETRY }),
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(causeOf(error)).toBe(original);
    expect(original.details).toBe(details);
    expect(error.details).not.toHaveProperty('sent');
    expect(error.details).not.toHaveProperty('transaction_hash');
    expect(error.details).toMatchObject({ ...READ_DIAGNOSTICS, partial: true });
    expect(isRetryableError(error)).toBe(false);
    const { body } = await projectError(error);
    expect(body.details).toMatchObject({
      partial: true,
      stop_outcome: 'already_inactive',
    });
    expect(body.details).not.toHaveProperty('sent');
    expect(body.details).not.toHaveProperty('transaction_hash');
  });

  it('copies only enumerable metadata data properties without invoking getters or replaying a submitted mutation', async () => {
    const getter = vi.fn(() => {
      throw new Error('fetch failed while reading diagnostic metadata');
    });
    const details: Record<string, unknown> = { httpStatus: 503, grpcCode: 14 };
    Object.defineProperties(details, {
      diagnostic: { enumerable: true, get: getter },
      hiddenDiagnostic: {
        enumerable: false,
        value: 'non-enumerable diagnostic must stay private',
      },
    });
    Object.freeze(details);
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Verification query unavailable',
        details,
      ),
    );
    const operation = vi.fn(() =>
      withVerificationOutcome(STOPPED, async () => {
        throw original;
      }),
    );

    const error: unknown = await withRetry(operation, { config: RETRY }).catch(
      (error: unknown) => error,
    );
    expect.soft(operation).toHaveBeenCalledOnce();
    expect.soft(getter).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError))
      throw new Error(
        'Expected the submitted receipt to survive metadata copying',
      );
    expect(causeOf(error)).toBe(original);
    expect(original.details).toBe(details);
    expect(Object.getOwnPropertyDescriptor(details, 'diagnostic')?.get).toBe(
      getter,
    );
    expect(
      Object.getOwnPropertyDescriptor(details, 'hiddenDiagnostic')?.enumerable,
    ).toBe(false);
    const expectedDetails = {
      lease_uuid: LEASE,
      sent: true,
      transaction_hash: HASH,
      transaction_confirmed: true,
      transaction_code: 0,
      stop_outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      httpStatus: 503,
      grpcCode: 14,
    };
    expect(error.details).toEqual(expectedDetails);
    expect(isRetryableError(error)).toBe(false);
    const { body, text } = await projectError(error);
    expect(body.details).toEqual(expectedDetails);
    expect(text).not.toContain('non-enumerable diagnostic must stay private');
    expect(getter).not.toHaveBeenCalled();
  });

  it('retains the submitted receipt and cause when metadata reflection fails instead of replaying', async () => {
    const ownKeys = vi.fn(() => {
      throw new Error('fetch failed during metadata reflection');
    });
    const details = new Proxy(
      Object.freeze({ httpStatus: 503, grpcCode: 14 }),
      { ownKeys },
    );
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Verification query unavailable',
        details,
      ),
    );
    const operation = vi.fn(() =>
      withVerificationOutcome(DOMAIN, async () => {
        throw original;
      }),
    );

    const error: unknown = await withRetry(operation, { config: RETRY }).catch(
      (error: unknown) => error,
    );
    expect.soft(operation).toHaveBeenCalledOnce();
    expect(ownKeys).toHaveBeenCalled();
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError))
      throw new Error(
        'Expected the submitted receipt to survive reflection failure',
      );
    expect(causeOf(error)).toBe(original);
    expect(original.details).toBe(details);
    expect(error.code).toBe(original.code);
    expect(error.message).toBe(original.message);
    const expectedDetails = {
      lease_uuid: LEASE,
      sent: true,
      transaction_hash: HASH,
      transaction_confirmed: true,
      transaction_code: 0,
      service_name: 'web',
      custom_domain: 'app.example.com',
    };
    expect(error.details).toEqual(expectedDetails);
    expect(isRetryableError(error)).toBe(false);
    const { body } = await projectError(error);
    expect(body.details).toEqual(expectedDetails);
    expect(body).not.toHaveProperty('cause');
  });

  it.each([
    {
      name: 'SDK code accessor',
      create: (fail: () => never) =>
        Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'Verification service unavailable',
            { httpStatus: 503 },
          ),
          'code',
          { get: fail },
        ),
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: 'Verification service unavailable',
      sdk: true,
    },
    {
      name: 'SDK message accessor',
      create: (fail: () => never) =>
        Object.defineProperty(
          new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'Verification service unavailable',
            { httpStatus: 503 },
          ),
          'message',
          { get: fail },
        ),
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      message: 'Verification error message unavailable',
      sdk: true,
    },
    {
      name: 'raw message accessor',
      create: (fail: () => never) =>
        Object.defineProperty(new Error('Verification failed'), 'message', {
          get: fail,
        }),
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message:
        'Post-mutation verification failed: Verification error message unavailable',
      sdk: false,
    },
    {
      name: 'thrown value string conversion',
      create: (fail: () => never) => ({ [Symbol.toPrimitive]: fail }),
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message:
        'Post-mutation verification failed: Verification error message unavailable',
      sdk: false,
    },
  ])(
    'preserves the submitted receipt and original cause when the $name throws',
    async ({ create, code, message, sdk }) => {
      const fail = vi.fn((): never => {
        throw new Error('fetch failed while inspecting verification error');
      });
      const original = create(fail);
      const operation = vi.fn(() =>
        withVerificationOutcome(STOPPED, async () => {
          throw original;
        }),
      );
      const caught: unknown = await withRetry(operation, {
        config: RETRY,
      }).catch((error: unknown) => error);

      expect.soft(operation).toHaveBeenCalledOnce();
      expect(caught).toBeInstanceOf(ManifestMCPError);
      if (!(caught instanceof ManifestMCPError))
        throw new Error(
          'Expected the submitted receipt to survive error inspection',
        );
      expect(caught.code).toBe(code);
      expect(caught.message).toBe(message);
      expect(sdk ? causeOf(caught) : causeOf(causeOf(caught))).toBe(original);
      const expectedDetails = {
        lease_uuid: LEASE,
        sent: true,
        transaction_hash: HASH,
        transaction_confirmed: true,
        transaction_code: 0,
        stop_outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
        ...(sdk ? { httpStatus: 503 } : {}),
      };
      expect(caught.details).toEqual(expectedDetails);
      expect(isRetryableError(caught)).toBe(false);
      const { body } = await projectError(caught);
      expect(body.code).toBe(code);
      expect(body.message).toBe(message);
      expect(body.details).toEqual(expectedDetails);
      expect(body).not.toHaveProperty('cause');
    },
  );

  it('retains the receipt at the wrapper boundary if the thrown value cannot be inspected', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const error = await rejectedError(() =>
      withVerificationOutcome(DOMAIN, async () => {
        throw proxy;
      }),
    );

    expect(error.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(error.message).toBe(
      'Post-mutation verification failed: Verification error message unavailable',
    );
    expect(causeOf(causeOf(error))).toBe(proxy);
    expect(error.details).toEqual({
      lease_uuid: LEASE,
      sent: true,
      transaction_hash: HASH,
      transaction_confirmed: true,
      transaction_code: 0,
      service_name: 'web',
      custom_domain: 'app.example.com',
    });
    // This asserts construction only: downstream cause traversal has its own
    // inspection contract and does not accept arbitrary revoked proxies.
  });

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
    // This input supplies no evidence: these are no-fabrication checks.
    // Separate injected-evidence cases verify filtering and retained partial vetoes.
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

  it('omits both native and foreign rejection reasons while retaining transient read diagnostics and causes', async () => {
    const inactive = Object.freeze({
      lease_uuid: LEASE,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: 'Native provider rejection reason A',
    } satisfies StopAppResult);
    const readDiagnostics = Object.freeze({
      httpStatus: 503,
      grpcCode: 14,
      grpcMessage: 'Verification service unavailable',
    });
    const details = Object.freeze({
      ...readDiagnostics,
      rejection_reason: 'Foreign upstream rejection reason B',
    });
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Verification read unavailable',
        details,
      ),
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
        config: { ...RETRY, maxRetries: 1 },
        onRetry,
      }),
    ).resolves.toBe(success);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    const error: unknown = onRetry.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError))
      throw new Error('Expected SDK error');
    expect(isRetryableError(error)).toBe(true);
    expect(causeOf(error)).toBe(original);
    expect(original.details).toBe(details);
    expect(original.details?.rejection_reason).toBe(
      'Foreign upstream rejection reason B',
    );
    expect(inactive.rejection_reason).toBe(
      'Native provider rejection reason A',
    );

    const expectedDetails = {
      lease_uuid: LEASE,
      stop_outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      ...readDiagnostics,
    };
    const { body, text } = await projectError(error);
    expect.soft(error.details).toEqual(expectedDetails);
    expect.soft(body.details).toEqual(expectedDetails);
    expect.soft(text).not.toContain(inactive.rejection_reason);
    expect.soft(text).not.toContain(details.rejection_reason);
    expect(body).not.toHaveProperty('cause');
  });
});
