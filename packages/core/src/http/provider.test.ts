import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProviderApiError, validateProviderUrl, checkedFetch, parseJsonResponse } from './provider.js';

describe('validateProviderUrl', () => {
  it('should accept https URLs', () => {
    expect(validateProviderUrl('https://provider.example.com')).toBe('https://provider.example.com');
  });

  it('should strip trailing slashes', () => {
    expect(validateProviderUrl('https://provider.example.com/')).toBe('https://provider.example.com');
    expect(validateProviderUrl('https://provider.example.com///')).toBe('https://provider.example.com');
  });

  it('should accept http://localhost', () => {
    expect(validateProviderUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('should accept http://127.0.0.1', () => {
    expect(validateProviderUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('should accept http://[::1]', () => {
    expect(validateProviderUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('should reject http for non-localhost hosts', () => {
    expect(() => validateProviderUrl('http://evil.com')).toThrow(ProviderApiError);
    expect(() => validateProviderUrl('http://evil.com')).toThrow(/HTTPS/);
  });

  it('should reject invalid URLs', () => {
    expect(() => validateProviderUrl('not-a-url')).toThrow(ProviderApiError);
    expect(() => validateProviderUrl('not-a-url')).toThrow(/Invalid provider URL/);
  });

  it('should reject ftp protocol', () => {
    expect(() => validateProviderUrl('ftp://example.com')).toThrow(ProviderApiError);
  });
});

describe('ProviderApiError', () => {
  it('should store status and message', () => {
    const err = new ProviderApiError(404, 'Not found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('ProviderApiError');
  });

  it('should be an instance of Error', () => {
    const err = new ProviderApiError(500, 'fail');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderApiError);
  });
});

describe('checkedFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return response on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }));
    const res = await checkedFetch('https://example.com/health');
    expect(res.ok).toBe(true);
  });

  it('should throw ProviderApiError on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('Service Unavailable'),
    }));
    await expect(checkedFetch('https://example.com/health')).rejects.toThrow(ProviderApiError);
    await expect(checkedFetch('https://example.com/health')).rejects.toThrow('Service Unavailable');
  });

  it('should handle text() failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error('read failed')),
    }));
    await expect(checkedFetch('https://example.com')).rejects.toThrow('HTTP 500');
  });

  it('should wrap network errors as ProviderApiError with URL context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(checkedFetch('https://down.example.com/health')).rejects.toThrow(ProviderApiError);
    await expect(checkedFetch('https://down.example.com/health')).rejects.toThrow(
      /Network request to https:\/\/down\.example\.com\/health failed: fetch failed/,
    );
  });

  it('should let AbortError pass through unwrapped when caller provides signal', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const controller = new AbortController();
    await expect(checkedFetch('https://example.com', { signal: controller.signal })).rejects.toThrow(DOMException);
    await expect(checkedFetch('https://example.com', { signal: controller.signal })).rejects.not.toThrow(ProviderApiError);
  });

  it('should convert internal timeout to ProviderApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }));
    await expect(checkedFetch('https://slow.example.com', undefined, 50)).rejects.toThrow(ProviderApiError);
    await expect(checkedFetch('https://slow.example.com', undefined, 50)).rejects.toThrow(/timed out/);
  });

  it('should not apply internal timeout when caller provides signal', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }));
    // Even with a short timeoutMs, the caller's signal takes precedence
    const promise = checkedFetch('https://slow.example.com', { signal: controller.signal }, 50);
    // Manually abort via the caller's controller
    controller.abort();
    try {
      await promise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect(err).not.toBeInstanceOf(ProviderApiError);
    }
  });
});

describe('parseJsonResponse', () => {
  it('should parse valid JSON', async () => {
    const mockRes = {
      text: vi.fn().mockResolvedValue('{"foo":"bar"}'),
      status: 200,
    } as unknown as Response;
    const result = await parseJsonResponse<{ foo: string }>(mockRes, 'https://example.com');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should throw ProviderApiError on invalid JSON', async () => {
    const mockRes = {
      text: vi.fn().mockResolvedValue('not json'),
      status: 200,
    } as unknown as Response;
    await expect(parseJsonResponse(mockRes, 'https://example.com')).rejects.toThrow(ProviderApiError);
  });
});
