import { describe, expect, it, vi } from 'vitest';
import {
  checkedFetch,
  ProviderApiError,
  parseJsonResponse,
  validateProviderUrl,
} from './provider.js';

describe('validateProviderUrl', () => {
  it('accepts HTTPS URLs', () => {
    expect(validateProviderUrl('https://provider.example.com/')).toBe(
      'https://provider.example.com',
    );
  });

  it('strips trailing slashes', () => {
    expect(validateProviderUrl('https://example.com///')).toBe(
      'https://example.com',
    );
  });

  it('accepts HTTP localhost', () => {
    expect(validateProviderUrl('http://localhost:8080')).toBe(
      'http://localhost:8080',
    );
    expect(validateProviderUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it('rejects HTTP non-localhost', () => {
    expect(() => validateProviderUrl('http://example.com')).toThrow(
      ProviderApiError,
    );
  });

  it('rejects invalid URLs', () => {
    expect(() => validateProviderUrl('not-a-url')).toThrow(ProviderApiError);
  });
});

describe('checkedFetch', () => {
  it('returns response for successful requests', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await checkedFetch(
      'https://example.com',
      undefined,
      5000,
      mockFetch,
    );
    expect(res.ok).toBe(true);
  });

  it('throws ProviderApiError for non-ok responses', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('bad', { status: 500 }));
    await expect(
      checkedFetch('https://example.com', undefined, 5000, mockFetch),
    ).rejects.toThrow(ProviderApiError);
  });

  it('throws ProviderApiError on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      checkedFetch('https://example.com', undefined, 5000, mockFetch),
    ).rejects.toThrow(ProviderApiError);
  });

  it('enforces internal timeout even when caller provides abortSignal', async () => {
    const controller = new AbortController();
    // Simulate a hung request: fetch resolves only when its signal aborts.
    const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    await expect(
      checkedFetch(
        'https://example.com',
        { signal: controller.signal },
        20, // 20 ms internal timeout
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("rethrows the caller's abort reason (not a generic AbortError) on mid-flight abort", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const fetchPromise = checkedFetch(
      'https://example.com',
      { signal: controller.signal },
      5000,
      mockFetch as unknown as typeof globalThis.fetch,
    );
    const callerReason = new Error('user cancelled');
    setTimeout(() => controller.abort(callerReason), 10);

    await expect(fetchPromise).rejects.toBe(callerReason);
  });

  it('rethrows the default AbortError when caller aborts without a reason', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const fetchPromise = checkedFetch(
      'https://example.com',
      { signal: controller.signal },
      5000,
      mockFetch as unknown as typeof globalThis.fetch,
    );
    setTimeout(() => controller.abort(), 10);

    await expect(fetchPromise).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DOMException &&
        err.name === 'AbortError' &&
        !String(err).includes('timed out'),
    );
  });

  it('aborts immediately when caller signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const mockFetch = vi.fn(async () => new Response('ok'));

    await expect(
      checkedFetch(
        'https://example.com',
        { signal: controller.signal },
        5000,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(/already cancelled/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not misclassify caller cancel as timeout when fetch is slow to reject', async () => {
    const controller = new AbortController();
    // Simulate a fetch that ignores the abort signal and takes longer than the
    // timeout to reject. Without the race guard, the timer would fire during
    // the gap between caller abort and fetch rejection, flipping timedOut=true.
    const mockFetch = vi.fn((_url: string, _opts?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          80,
        );
      });
    });

    const callerReason = new Error('user cancelled');
    const fetchPromise = checkedFetch(
      'https://example.com',
      { signal: controller.signal },
      20, // timeout would fire at ~20ms
      mockFetch as unknown as typeof globalThis.fetch,
    );
    // Abort at 5ms, well before the internal timeout.
    setTimeout(() => controller.abort(callerReason), 5);

    // Must surface the caller's reason, not the "timed out" ProviderApiError.
    await expect(fetchPromise).rejects.toBe(callerReason);
  });

  it('removes caller-signal listener on successful fetch (no leak)', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

    await checkedFetch(
      'https://example.com',
      { signal: controller.signal },
      5000,
      mockFetch as unknown as typeof globalThis.fetch,
    );

    // One abort listener attached and cleaned up.
    const abortAttachCount = addSpy.mock.calls.filter(
      ([ev]) => ev === 'abort',
    ).length;
    const abortRemoveCount = removeSpy.mock.calls.filter(
      ([ev]) => ev === 'abort',
    ).length;
    expect(abortAttachCount).toBe(abortRemoveCount);
    expect(abortAttachCount).toBeGreaterThan(0);
  });
});

describe('parseJsonResponse', () => {
  it('parses valid JSON', async () => {
    const res = new Response('{"status":"ok"}', { status: 200 });
    const result = await parseJsonResponse<{ status: string }>(
      res,
      'https://example.com',
    );
    expect(result.status).toBe('ok');
  });

  it('throws ProviderApiError for invalid JSON', async () => {
    const res = new Response('not json', { status: 200 });
    await expect(parseJsonResponse(res, 'https://example.com')).rejects.toThrow(
      ProviderApiError,
    );
  });
});
