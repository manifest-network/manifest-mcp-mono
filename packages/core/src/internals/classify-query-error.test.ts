import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { classifyLcdError, isNotFoundError } from './classify-query-error.js';

/** An axios-shaped rejection: what @cosmology/lcd actually throws. */
function axiosError(status: number, data: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`);
  Object.assign(err, {
    response: { status, data },
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
  });
  return err;
}

describe('classifyLcdError', () => {
  it('classifies a grpc-gateway code:5 envelope as NOT_FOUND with details', () => {
    const err = classifyLcdError(
      'lease',
      axiosError(404, { code: 5, message: 'lease not found', details: [] }),
    );
    expect(err.code).toBe(ManifestMCPErrorCode.NOT_FOUND);
    expect(err.details).toMatchObject({
      httpStatus: 404,
      grpcCode: 5,
      grpcMessage: 'lease not found',
    });
  });

  // THE regression guard: a real 404 from nodes.chandrastation.com, which does not
  // serve billing. No grpc envelope => NOT a not-found.
  it('does NOT classify a proxy 404 (no grpc envelope) as NOT_FOUND', () => {
    const err = classifyLcdError(
      'lease',
      axiosError(404, { error: 'not_found', message: 'Endpoint not found' }),
    );
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 404 });
    expect(err.details?.grpcCode).toBeUndefined();
    // The proxy body HAS a `message` ("Endpoint not found"). grpcMessage is a
    // @public field documented as KEEPER text — it must not carry proxy text.
    // toMatchObject cannot catch an extra key, so assert absence explicitly.
    expect(err.details?.grpcMessage).toBeUndefined();
  });

  it('preserves httpStatus on a 500 so retry can branch on the number', () => {
    const err = classifyLcdError('lease', axiosError(500, { code: 13 }));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 500, grpcCode: 13 });
  });

  it('handles a non-object body (proxy HTML)', () => {
    const err = classifyLcdError(
      'lease',
      axiosError(502, '<html>bad gateway</html>'),
    );
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.details).toMatchObject({ httpStatus: 502 });
  });

  it('handles an error with no response (network failure)', () => {
    const err = classifyLcdError('lease', new Error('fetch failed'));
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('fetch failed');
  });

  // @cosmology/lcd rejects with a BARE STRING on this path (LCDClient.get).
  it('handles a bare-string rejection', () => {
    const err = classifyLcdError('lease', 'no response data');
    expect(err.code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    expect(err.message).toContain('no response data');
  });
});

describe('isNotFoundError', () => {
  it('accepts our own ManifestMCPError(NOT_FOUND)', () => {
    expect(
      isNotFoundError(
        new ManifestMCPError(ManifestMCPErrorCode.NOT_FOUND, 'lease not found'),
      ),
    ).toBe(true);
  });

  // Dual-package safety (ENG-462): a cross-copy error fails `instanceof` but
  // MUST still classify. A plain object with the right `code` stands in for it.
  it('accepts a cross-copy ManifestMCPError-shaped object (no instanceof)', () => {
    expect(
      isNotFoundError({
        name: 'ManifestMCPError',
        code: 'NOT_FOUND',
        message: 'lease not found',
      }),
    ).toBe(true);
  });

  // Decision 4: a consumer keeps manifestjs as transport and borrows our semantic.
  it('accepts a RAW axios error from a consumer-owned manifestjs client', () => {
    expect(
      isNotFoundError(
        axiosError(404, { code: 5, message: 'credit account not found' }),
      ),
    ).toBe(true);
  });

  it('accepts a plain RPC Error', () => {
    expect(
      isNotFoundError(
        new Error('rpc error: code = NotFound desc = lease not found'),
      ),
    ).toBe(true);
  });

  it('rejects a raw proxy 404', () => {
    expect(
      isNotFoundError(
        axiosError(404, { error: 'not_found', message: 'Endpoint not found' }),
      ),
    ).toBe(false);
  });

  // The AxiosError `.code` landmine: its own code is a STRING, never 'NOT_FOUND'.
  it('does not confuse AxiosError.code with our code', () => {
    expect(isNotFoundError(axiosError(500, { code: 13 }))).toBe(false);
  });

  it('rejects QUERY_FAILED', () => {
    expect(
      isNotFoundError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'lease not found',
        ),
      ),
    ).toBe(false);
  });

  it.each([undefined, null, 'not found', 42])('rejects non-error %p', (v) => {
    expect(isNotFoundError(v)).toBe(false);
  });
});
