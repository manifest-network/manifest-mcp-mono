import { describe, expect, it } from 'vitest';
import {
  BACKEND_STORAGE_LOST,
  CAPACITY_RESERVED,
  KEY_REQUIRED,
  MAINTENANCE_EXPIRED,
} from '../__test-utils__/fred-error-bodies.js';
import { ProviderApiError, type ProviderErrorKind } from './provider.js';
import {
  isBackendStorageLost,
  isIdempotencyKeyRequired,
  providerErrorReason,
} from './provider-error-reason.js';

/** The error the transport builds for a non-2xx answer: the body is the message. */
function answer(
  status: number,
  body: string,
  kind: ProviderErrorKind = 'http',
): ProviderApiError {
  return new ProviderApiError(status, body, { kind });
}

describe('providerErrorReason', () => {
  it.each([
    [MAINTENANCE_EXPIRED, 'maintenance_expired'],
    [BACKEND_STORAGE_LOST, 'backend_storage_lost'],
    [CAPACITY_RESERVED, 'maintenance_capacity_reserved'],
  ])('reads the reason from Fred body %#', (response, reason) => {
    expect(providerErrorReason(answer(response.status, response.text))).toBe(
      reason,
    );
  });

  it('reports an unknown, well-formed reason verbatim (the set is open)', () => {
    expect(
      providerErrorReason(
        answer(409, '{"error":"x","code":409,"reason":"some_future_reason"}'),
      ),
    ).toBe('some_future_reason');
  });

  it('has no reason when Fred sent none', () => {
    expect(
      providerErrorReason(answer(KEY_REQUIRED.status, KEY_REQUIRED.text)),
    ).toBeUndefined();
  });

  it.each([
    ['a code that differs from the status', 410, '{"code":404,"reason":"x"}'],
    ['a string code', 410, '{"code":"410","reason":"x"}'],
    ['a non-JSON body', 410, 'reason: maintenance_expired'],
    ['a truncated body', 410, '{"code":410,"reason":"maintenance_exp'],
    ['a JSON array', 410, '[410,"maintenance_expired"]'],
    ['JSON null', 410, 'null'],
    ['a 2xx status', 200, '{"code":200,"reason":"x"}'],
  ])('ignores %s', (_label, status, body) => {
    expect(providerErrorReason(answer(status, body))).toBeUndefined();
  });

  it.each([
    'Maintenance_Expired',
    'maintenance expired',
    '_leading_underscore',
    '9starts_with_digit',
    `maintenance_expired${String.fromCharCode(0x202e)}`,
    'a'.repeat(65),
  ])('rejects a reason that is not a bounded identifier: %j', (reason) => {
    expect(
      providerErrorReason(
        answer(410, JSON.stringify({ error: 'x', code: 410, reason })),
      ),
    ).toBeUndefined();
  });

  it.each(['timeout', 'body_cap', 'network'] as const)(
    'ignores a %s error, whose message is not the provider body',
    (kind) => {
      expect(
        providerErrorReason(
          answer(MAINTENANCE_EXPIRED.status, MAINTENANCE_EXPIRED.text, kind),
        ),
      ).toBeUndefined();
    },
  );

  it('ignores errors that are not provider answers', () => {
    expect(providerErrorReason(new Error(MAINTENANCE_EXPIRED.text))).toBe(
      undefined,
    );
    expect(providerErrorReason(MAINTENANCE_EXPIRED.text)).toBeUndefined();
    expect(providerErrorReason(undefined)).toBeUndefined();
  });

  it('treats an unreadable diagnostic accessor as no reason', () => {
    const error = answer(MAINTENANCE_EXPIRED.status, MAINTENANCE_EXPIRED.text);
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('hostile accessor');
      },
    });
    expect(providerErrorReason(error)).toBeUndefined();
    expect(isBackendStorageLost(error)).toBe(false);
    expect(isIdempotencyKeyRequired(error)).toBe(false);
  });
});

describe('isBackendStorageLost', () => {
  it('matches only the 410 backend_storage_lost answer', () => {
    expect(
      isBackendStorageLost(
        answer(BACKEND_STORAGE_LOST.status, BACKEND_STORAGE_LOST.text),
      ),
    ).toBe(true);
    expect(
      isBackendStorageLost(
        answer(MAINTENANCE_EXPIRED.status, MAINTENANCE_EXPIRED.text),
      ),
    ).toBe(false);
    expect(
      isBackendStorageLost(
        answer(404, '{"error":"x","code":404,"reason":"backend_storage_lost"}'),
      ),
    ).toBe(false);
  });
});

describe('isIdempotencyKeyRequired', () => {
  it('matches the PR #240 refusal of a keyless command', () => {
    expect(
      isIdempotencyKeyRequired(answer(KEY_REQUIRED.status, KEY_REQUIRED.text)),
    ).toBe(true);
  });

  it.each([
    // A malformed key is a different refusal.
    [400, '{"error":"Idempotency-Key must be a canonical UUIDv4","code":400}'],
    [
      409,
      '{"error":"Idempotency-Key header must occur exactly once","code":409}',
    ],
    [400, 'Idempotency-Key header must occur exactly once'],
  ])('does not match status %i with body %j', (status, body) => {
    expect(isIdempotencyKeyRequired(answer(status, body))).toBe(false);
  });
});
