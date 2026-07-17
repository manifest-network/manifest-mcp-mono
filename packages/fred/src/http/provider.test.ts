import { describe, expect, it, vi } from 'vitest';
import {
  checkedFetch,
  getProviderHealth,
  isUrlSsrfSafe,
  MAX_RESPONSE_BYTES,
  ProviderApiError,
  parseJsonResponse,
  readBodyCapped,
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

  it('accepts HTTP localhost ONLY with allowLoopback opt-in', () => {
    expect(
      validateProviderUrl('http://localhost:8080', { allowLoopback: true }),
    ).toBe('http://localhost:8080');
    expect(
      validateProviderUrl('http://127.0.0.1:8080', { allowLoopback: true }),
    ).toBe('http://127.0.0.1:8080');
  });

  it('rejects loopback by default (SSRF)', () => {
    expect(() => validateProviderUrl('http://localhost:8080')).toThrow(
      ProviderApiError,
    );
    expect(() => validateProviderUrl('https://127.0.0.1')).toThrow(
      ProviderApiError,
    );
    expect(() => validateProviderUrl('https://[::1]')).toThrow(
      ProviderApiError,
    );
  });

  it('rejects private / metadata IPs regardless of allowLoopback', () => {
    for (const u of [
      'https://10.0.0.1',
      'https://192.168.1.1',
      'https://172.16.0.1',
      'https://169.254.169.254',
    ]) {
      expect(() => validateProviderUrl(u)).toThrow(ProviderApiError);
      expect(() => validateProviderUrl(u, { allowLoopback: true })).toThrow(
        ProviderApiError,
      );
    }
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

describe('isUrlSsrfSafe', () => {
  it('blocks metadata, RFC1918, loopback, v4-mapped by default', () => {
    for (const u of [
      'https://169.254.169.254',
      'https://10.0.0.1',
      'https://192.168.1.1',
      'https://172.16.0.1',
      'https://127.0.0.1',
      'https://[::1]',
      'https://[::ffff:10.0.0.1]',
      'https://0.0.0.0', // unspecified range
      'https://[::ffff:169.254.169.254]', // v4-mapped metadata in URL form
    ]) {
      expect(isUrlSsrfSafe(u)).toBe(false);
    }
  });

  it('allows public IPs and DNS names (DNS fails open — defense in depth)', () => {
    expect(isUrlSsrfSafe('https://8.8.8.8')).toBe(true);
    expect(isUrlSsrfSafe('https://provider.example.com')).toBe(true);
  });

  it('is protocol-agnostic (covers wss:// for the provider WebSocket)', () => {
    expect(isUrlSsrfSafe('wss://169.254.169.254')).toBe(false);
    expect(isUrlSsrfSafe('wss://provider.example.com')).toBe(true);
  });

  it('allowLoopback re-allows ONLY loopback, never RFC1918/metadata', () => {
    expect(isUrlSsrfSafe('http://localhost', { allowLoopback: true })).toBe(
      true,
    );
    expect(isUrlSsrfSafe('https://127.0.0.1', { allowLoopback: true })).toBe(
      true,
    );
    expect(isUrlSsrfSafe('https://[::1]', { allowLoopback: true })).toBe(true);
    expect(isUrlSsrfSafe('https://10.0.0.1', { allowLoopback: true })).toBe(
      false,
    );
    expect(
      isUrlSsrfSafe('https://169.254.169.254', { allowLoopback: true }),
    ).toBe(false);
    expect(isUrlSsrfSafe('https://0.0.0.0', { allowLoopback: true })).toBe(
      false,
    );
  });

  it('normalizes obfuscated IPv4 encodings via new URL() (bypass regression)', () => {
    // decimal / hex / octal / short-form all resolve to 127.0.0.1
    expect(isUrlSsrfSafe('http://2130706433/')).toBe(false);
    expect(isUrlSsrfSafe('http://0x7f000001/')).toBe(false);
    expect(isUrlSsrfSafe('http://0177.0.0.1/')).toBe(false);
    expect(isUrlSsrfSafe('http://127.1/')).toBe(false);
    // uppercase host is lower-cased by WHATWG
    expect(isUrlSsrfSafe('http://LOCALHOST')).toBe(false);
    expect(isUrlSsrfSafe('http://LOCALHOST', { allowLoopback: true })).toBe(
      true,
    );
  });

  it('userinfo does not smuggle a blocked host (real target is after @)', () => {
    // hostname is evil.com (a DNS name) — that is where the request goes
    expect(isUrlSsrfSafe('https://169.254.169.254@evil.com/')).toBe(true);
  });

  it('returns false for unparseable URLs', () => {
    expect(isUrlSsrfSafe('not-a-url')).toBe(false);
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
    // Fake timers remove real-time flakiness on loaded CI: the 5/20/80ms
    // ordering (caller abort < internal timeout < mock fetch rejection) is
    // advanced deterministically.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const mockFetch = vi.fn((_url: string, _opts?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              ),
            80,
          );
        });
      });

      const callerReason = new Error('user cancelled');
      const fetchPromise = checkedFetch(
        'https://example.com',
        { signal: controller.signal },
        20, // internal timeout at 20ms — should be cleared by the caller abort
        mockFetch as unknown as typeof globalThis.fetch,
      );
      // Capture the rejection eagerly so advancing timers doesn't surface an
      // unhandled-rejection warning in vitest.
      let caught: unknown;
      fetchPromise.catch((err: unknown) => {
        caught = err;
      });
      setTimeout(() => controller.abort(callerReason), 5);

      await vi.advanceTimersByTimeAsync(80);

      // Must surface the caller's reason, not a "timed out" ProviderApiError.
      expect(caught).toBe(callerReason);
    } finally {
      vi.useRealTimers();
    }
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

  it('aborts a body that exceeds the cap instead of buffering it whole', async () => {
    const res = new Response('x'.repeat(100), { status: 200 });
    await expect(
      parseJsonResponse(res, 'https://example.com', 10),
    ).rejects.toBeInstanceOf(ProviderApiError);
  });
});

describe('readBodyCapped (response-size ceiling)', () => {
  it('exposes a sane default cap', () => {
    expect(MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('returns the full body when under the cap, across multiple chunks', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"a":'));
        controller.enqueue(enc.encode('1}'));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    expect(await readBodyCapped(res, 'https://p.example', 1000)).toBe(
      '{"a":1}',
    );
  });

  it('throws ProviderApiError once the streamed byte count exceeds the cap', async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Emit 1 KiB chunks forever until the reader cancels.
        controller.enqueue(enc.encode('x'.repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(
      readBodyCapped(res, 'https://p.example', 4096),
    ).rejects.toBeInstanceOf(ProviderApiError);
    expect(cancelled).toBe(true); // stream was cancelled, not drained
  });

  it('tolerates a minimal Response mock without headers or a body stream', async () => {
    const fakeRes = {
      ok: true,
      status: 200,
      text: async () => '{"state":"ok"}',
    } as unknown as Response;
    expect(await readBodyCapped(fakeRes, 'https://p.example')).toBe(
      '{"state":"ok"}',
    );
  });

  it('fast-rejects when a declared Content-Length already exceeds the cap', async () => {
    const fakeRes = {
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }),
      body: null,
      text: async () => '',
    } as unknown as Response;
    await expect(
      readBodyCapped(fakeRes, 'https://p.example', MAX_RESPONSE_BYTES),
    ).rejects.toBeInstanceOf(ProviderApiError);
  });
});

describe('ProviderApiError.isProviderApiError (dual-package-safe brand guard)', () => {
  const BRAND = Symbol.for(
    '@manifest-network/manifest-mcp-fred.ProviderApiError',
  );

  it('returns true for a real instance', () => {
    expect(
      ProviderApiError.isProviderApiError(new ProviderApiError(500, 'x')),
    ).toBe(true);
  });

  it('returns true for a subclass instance (inherited brand)', () => {
    class Sub extends ProviderApiError {}
    expect(ProviderApiError.isProviderApiError(new Sub(500, 'x'))).toBe(true);
  });

  it('returns true for a foreign copy carrying the same registry brand', () => {
    const foreign = Object.defineProperty(new Error('x'), BRAND, {
      value: true,
    });
    expect(ProviderApiError.isProviderApiError(foreign)).toBe(true);
  });

  it('returns false for a plain Error, a { status } fake, and nullish', () => {
    expect(ProviderApiError.isProviderApiError(new Error('x'))).toBe(false);
    expect(ProviderApiError.isProviderApiError({ status: 500 })).toBe(false);
    expect(ProviderApiError.isProviderApiError(null)).toBe(false);
    expect(ProviderApiError.isProviderApiError(undefined)).toBe(false);
  });

  it('brands non-enumerably (not an own enumerable symbol, not copied by spread)', () => {
    const e = new ProviderApiError(500, 'boom');
    expect(Object.getOwnPropertyDescriptor(e, BRAND)?.enumerable).toBe(false);
    expect(Object.getOwnPropertySymbols({ ...e })).not.toContain(BRAND);
  });
});

// The low-level provider HTTP fns forward an `allowLoopback` flag to
// validateProviderUrl so the fred server can share ONE switch with its
// connect-guard (MANIFEST_FRED_FETCH_GUARDED). getProviderHealth is a
// representative site (ENG-490).
describe('low-level fn honors allowLoopback (validate gate)', () => {
  it('getProviderHealth allows a loopback provider URL when allowLoopback=true', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', provider_uuid: 'prov-1' })),
      );

    const result = await getProviderHealth(
      'http://localhost:8080',
      undefined,
      mockFetch as unknown as typeof globalThis.fetch,
      true,
    );

    expect(result.status).toBe('ok');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('getProviderHealth rejects a loopback provider URL by default (allowLoopback omitted)', async () => {
    const mockFetch = vi.fn();

    await expect(
      getProviderHealth(
        'http://localhost:8080',
        undefined,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    ).rejects.toThrow(ProviderApiError);
    // Validation throws before any network call.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('getProviderHealth rejects a loopback provider URL when allowLoopback=false', async () => {
    const mockFetch = vi.fn();

    await expect(
      getProviderHealth(
        'http://localhost:8080',
        undefined,
        mockFetch as unknown as typeof globalThis.fetch,
        false,
      ),
    ).rejects.toThrow(ProviderApiError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
