import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkedFetch,
  getProviderHealth,
  isTransientProviderError,
  isUrlSsrfSafe,
  MAX_RESPONSE_BYTES,
  ProviderApiError,
  parseJsonResponse,
  parseRetryAfterMs,
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
    // VALID JSON, but larger than the cap. This matters: a pre-cap implementation
    // (`await res.text()` + `JSON.parse`) would parse it successfully and return —
    // so the only way this rejects is the cap abort, not an incidental parse error.
    const body = JSON.stringify({ data: 'x'.repeat(100) }); // valid, > 10 bytes
    const res = new Response(body, { status: 200 });
    await expect(
      parseJsonResponse(res, 'https://example.com', 10),
    ).rejects.toThrow(/10-byte cap/); // the cap-abort message, not "Invalid JSON"
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

  it('still surfaces ProviderApiError when cancelling the overflowed stream itself rejects', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode('x'.repeat(1024)));
      },
      cancel() {
        // Underlying source throws during cancellation — reader.cancel() rejects.
        throw new Error('cancel boom');
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(
      readBodyCapped(res, 'https://p.example', 2048),
    ).rejects.toBeInstanceOf(ProviderApiError); // not the raw 'cancel boom'
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

  it('cancels the response body on the Content-Length fast-reject so the socket is released', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fakeRes = {
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }),
      body,
    } as unknown as Response;
    await expect(
      readBodyCapped(fakeRes, 'https://p.example', 10),
    ).rejects.toBeInstanceOf(ProviderApiError);
    expect(cancelled).toBe(true); // stream torn down, not left dangling
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

// The raw HTTP functions (exported on the fred barrel and SDK `/deploy`) fall back to unguarded
// `globalThis.fetch` when `fetchFn` is omitted. That fallback used to be SILENT — these pin the
// warning, and pin that a deliberately-injected fetch stays quiet.
describe('checkedFetch unguarded-fetch warning (raw HTTP path)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('warns once (naming createFredClientNode) when fetchFn is omitted on Node', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { checkedFetch: cf } = await import('./provider.js');
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
    );

    await cf('https://example.com', undefined, 5000);
    await cf('https://example.com', undefined, 5000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('createFredClientNode');
  });

  it('does not warn when a fetchFn is injected (even a plain globalThis.fetch)', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { checkedFetch: cf } = await import('./provider.js');
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});
    const injected = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await cf('https://example.com', undefined, 5000, injected);

    expect(injected).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  // A plain-JS caller can pass `null` (TypeScript's `strict` blocks it, but this package ships to
  // JS consumers). `null` must count as NOT injected: the `?? globalThis.fetch` fallback runs
  // unguarded either way, so treating it as "injected" would recreate the silent path this warning
  // exists to close.
  it('warns when fetchFn is explicitly null (nullish, not just undefined)', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { checkedFetch: cf } = await import('./provider.js');
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
    );

    await cf(
      'https://example.com',
      undefined,
      5000,
      null as unknown as typeof globalThis.fetch,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('createFredClientNode');
  });

  it('still dispatches through the injected fetch after the signature change', async () => {
    const { checkedFetch: cf } = await import('./provider.js');
    const injected = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await cf('https://example.com', undefined, 5000, injected);

    expect(res.ok).toBe(true);
    // The omitted-fetchFn fallback must not shadow an explicitly-passed impl.
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected.mock.calls[0]?.[0]).toBe('https://example.com');
  });
});

describe('hasInjectedFetch', () => {
  it('is nullish-aware so it agrees with the `?? globalThis.fetch` fallback', async () => {
    const { hasInjectedFetch } = await import('./unguarded-warning.js');
    const fn = (() => {}) as unknown as typeof globalThis.fetch;

    expect(hasInjectedFetch(fn)).toBe(true);
    expect(hasInjectedFetch(globalThis.fetch)).toBe(true);
    expect(hasInjectedFetch(undefined)).toBe(false);
    expect(hasInjectedFetch(null)).toBe(false);
  });
});

describe('warnUnguardedOnce', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('stays silent in a browser runtime (no connect guard to be missing)', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { warnUnguardedOnce } = await import('./unguarded-warning.js');
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});

    warnUnguardedOnce(false, false);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on Node with no injected fetch, and only once', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { warnUnguardedOnce } = await import('./unguarded-warning.js');
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});

    warnUnguardedOnce(false, true);
    warnUnguardedOnce(false, true);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * ENG-661. `checkedFetch` used to throw a bare `ProviderApiError(status, body)`
 * and drop the `Retry-After` header entirely — even though Fred emits one with
 * every 429 (internal/api/ratelimit.go). And with `status === 0` standing in
 * for seven unrelated non-HTTP causes, nothing downstream could tell a blip
 * from a permanent rejection without sniffing message text.
 */
describe('parseRetryAfterMs', () => {
  it('parses delta-seconds, the form Fred sends', () => {
    expect(parseRetryAfterMs('1')).toBe(1_000);
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(' 2 ')).toBe(2_000);
  });

  it('parses an HTTP-date, which an intermediary proxy may substitute', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const at = new Date(now + 5_000).toUTCString();
    // toUTCString() drops sub-second precision, so allow the rounding.
    expect(parseRetryAfterMs(at, now)).toBeGreaterThanOrEqual(4_000);
    expect(parseRetryAfterMs(at, now)).toBeLessThanOrEqual(5_000);
  });

  it('floors a past HTTP-date at 0 rather than returning a negative sleep', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(
      0,
    );
  });

  it("clamps an absurd delta to Fred's own 86400s ceiling", () => {
    expect(parseRetryAfterMs('999999999')).toBe(86_400_000);
  });

  it('returns undefined for absent or unparseable values — no guidance beats bad guidance', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });
});

describe('checkedFetch error classification', () => {
  it('tags a non-2xx as kind "http" and carries its Retry-After', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '1' },
      }),
    );

    const err = await checkedFetch(
      'https://example.com',
      undefined,
      5_000,
      mockFetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(429);
    expect((err as ProviderApiError).kind).toBe('http');
    expect((err as ProviderApiError).retryAfterMs).toBe(1_000);
  });

  it('reads Retry-After on a 503 too, not only on 429', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('unavailable', {
        status: 503,
        headers: { 'Retry-After': '5' },
      }),
    );

    const err = (await checkedFetch(
      'https://example.com',
      undefined,
      5_000,
      mockFetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.retryAfterMs).toBe(5_000);
  });

  it('leaves retryAfterMs undefined when the provider sent no header', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('bad', { status: 500 }));

    const err = (await checkedFetch(
      'https://example.com',
      undefined,
      5_000,
      mockFetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.kind).toBe('http');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('tags a connect failure as kind "network" and keeps the cause', async () => {
    const underlying = new Error('fetch failed');
    const mockFetch = vi.fn().mockRejectedValue(underlying);

    const err = (await checkedFetch(
      'https://example.com',
      undefined,
      5_000,
      mockFetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.kind).toBe('network');
    expect(err.cause).toBe(underlying);
  });

  it('tags an internal timeout as kind "timeout"', async () => {
    const mockFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const err = (await checkedFetch(
      'https://example.com',
      undefined,
      5,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.kind).toBe('timeout');
  });

  it('tags an SSRF/format rejection as kind "invalid_url"', () => {
    const err = (() => {
      try {
        validateProviderUrl('https://169.254.169.254/latest/meta-data');
      } catch (e) {
        return e;
      }
    })() as ProviderApiError;

    expect(err.kind).toBe('invalid_url');
  });

  it('keeps kind "body_cap" when an oversized body rides on a non-2xx', async () => {
    // Otherwise the cap error is read into text and re-tagged `http`, which
    // makes a 5xx look transient — so the readiness poll would retry and
    // re-stream up to the cap on every attempt, defeating the cap.
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('truncated', {
        status: 503,
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      }),
    );

    const err = (await checkedFetch(
      'https://example.com',
      undefined,
      5_000,
      mockFetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.kind).toBe('body_cap');
    expect(err.status).toBe(503); // the real HTTP status is still preserved
    expect(isTransientProviderError(err)).toBe(false);
  });

  it('tags a malformed body as kind "invalid_json"', async () => {
    const err = (await parseJsonResponse(
      new Response('<html>502 Bad Gateway</html>', { status: 200 }),
      'https://example.com',
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.kind).toBe('invalid_json');
  });
});

describe('isTransientProviderError', () => {
  it.each([
    ['a 500', new ProviderApiError(500, 'boom', { kind: 'http' }), true],
    ['a 503', new ProviderApiError(503, 'boom', { kind: 'http' }), true],
    ['a 429', new ProviderApiError(429, 'slow down', { kind: 'http' }), true],
    ['a 404', new ProviderApiError(404, 'nope', { kind: 'http' }), false],
    ['a 401', new ProviderApiError(401, 'nope', { kind: 'http' }), false],
    ['a 409', new ProviderApiError(409, 'conflict', { kind: 'http' }), false],
    [
      'a connect failure',
      new ProviderApiError(0, 'x', { kind: 'network' }),
      true,
    ],
    ['a timeout', new ProviderApiError(0, 'x', { kind: 'timeout' }), true],
    // A truncated body or an intermediary's HTML error page is a classic blip.
    [
      'a malformed body',
      new ProviderApiError(0, 'x', { kind: 'invalid_json' }),
      true,
    ],
    // These will not change on retry.
    [
      'an SSRF rejection',
      new ProviderApiError(0, 'x', { kind: 'invalid_url' }),
      false,
    ],
    [
      'a body-cap breach',
      new ProviderApiError(0, 'x', { kind: 'body_cap' }),
      false,
    ],
    ['a poll outcome', new ProviderApiError(0, 'x', { kind: 'poll' }), false],
  ])('%s → %s', (_label, err, expected) => {
    expect(isTransientProviderError(err)).toBe(expected);
  });

  it('falls back to the status for an untagged error, so old call sites are unchanged', () => {
    expect(isTransientProviderError(new ProviderApiError(500, 'boom'))).toBe(
      true,
    );
    expect(isTransientProviderError(new ProviderApiError(404, 'nope'))).toBe(
      false,
    );
    // status 0 with no kind: not an HTTP answer and not classified — do not
    // guess that it is retryable.
    expect(isTransientProviderError(new ProviderApiError(0, 'mystery'))).toBe(
      false,
    );
  });

  it('never tolerates something that is not a ProviderApiError', () => {
    expect(isTransientProviderError(new TypeError('bug'))).toBe(false);
    expect(isTransientProviderError({ status: 503 })).toBe(false);
    expect(isTransientProviderError(undefined)).toBe(false);
  });
});
