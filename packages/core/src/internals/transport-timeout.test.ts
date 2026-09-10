import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { isTransportTimeout } from './transport-timeout.js';

function expiredDeadline(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new DOMException('Owned deadline elapsed', 'TimeoutError'));
  return controller.signal;
}

describe('transport deadline evidence', () => {
  it.each([false, true])(
    'recognizes a non-identical TimeoutError after the owned deadline expires (nested: %s)',
    (nested) => {
      const deadline = expiredDeadline();
      const timeout = new DOMException(
        'Transport deadline expired',
        'TimeoutError',
      );
      const error = nested
        ? Object.assign(new TypeError('Opaque transport wrapper'), {
            cause: Object.assign(new Error('Intermediate wrapper'), {
              cause: timeout,
            }),
          })
        : timeout;

      expect(timeout).not.toBe(deadline.reason);
      expect(isTransportTimeout(error, deadline)).toBe(true);
    },
  );

  it.each(['AbortError', 'TimeoutError'])(
    'does not claim an independent nested %s before its own deadline expires',
    (name) => {
      const controller = new AbortController();
      const error = Object.assign(new Error('Opaque transport wrapper'), {
        cause: new DOMException('Independent cancellation', name),
      });

      expect(isTransportTimeout(error, controller.signal)).toBe(false);
    },
  );

  it.each([
    ManifestMCPErrorCode.INVALID_CONFIG,
    ManifestMCPErrorCode.QUERY_FAILED,
  ])(
    'preserves a nested %s verdict even beneath a recognized TimeoutError',
    (code) => {
      const deadline = expiredDeadline();
      const verdict = new ManifestMCPError(code, 'Established response', {
        httpStatus: 502,
      });
      const error = Object.assign(
        new DOMException('Transport deadline expired', 'TimeoutError'),
        { cause: verdict },
      );

      expect(isTransportTimeout(error, deadline)).toBe(false);
      expect(verdict.details).toEqual({ httpStatus: 502 });
    },
  );

  it('does not infer a deadline from unrelated errors in a cyclic cause chain', () => {
    const outer: Error & { cause?: unknown } = new Error('Outer invariant');
    const inner: Error & { cause?: unknown } = new Error('Inner invariant');
    outer.cause = inner;
    inner.cause = outer;

    expect(isTransportTimeout(outer, expiredDeadline())).toBe(false);
  });

  it('recognizes timeout evidence in a cyclic cause chain without changing it', () => {
    const outer: Error & { cause?: unknown } = new Error('Opaque wrapper');
    const timeout = Object.assign(
      new DOMException('Transport deadline expired', 'TimeoutError'),
      { cause: outer },
    );
    outer.cause = timeout;

    expect(isTransportTimeout(outer, expiredDeadline())).toBe(true);
    expect(outer.cause).toBe(timeout);
    expect(timeout.cause).toBe(outer);
  });
});
