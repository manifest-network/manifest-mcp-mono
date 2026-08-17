import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkedFetch,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchJsonChecked,
  getProviderHealth,
  isTransientProviderError,
  isUrlSsrfSafe,
  MAX_PROVIDER_ERROR_CHARS,
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

/**
 * `classifyTransportError` used to open on `err instanceof DOMException && err.name ===
 * 'AbortError'` and then return `deadline.signal.reason` WITHOUT checking
 * `deadline.signal.aborted` — and `reason` is `undefined` on a signal that never aborted.
 * An AbortError raised by anything other than this deadline therefore threw `undefined`,
 * which `withErrorHandling` renders at the tool boundary as the literal "undefined"
 * (ENG-703). Every case below keys on the DEADLINE instead of on the error's shape.
 */
describe('classifyTransportError (ENG-703)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Capture settlement eagerly so advancing timers never trips an unhandled rejection. */
  function capture<T>(p: Promise<T>): { readonly current: unknown } {
    const box: { current: unknown } = { current: undefined };
    p.then(
      (v) => {
        box.current = v;
      },
      (e: unknown) => {
        box.current = e;
      },
    );
    return box;
  }

  /**
   * The publicly reachable form: `fetchFn` is a parameter on the fred barrel and the SDK
   * `/deploy` subpath, so a consumer whose own fetch wrapper enforces its own deadline
   * rejects with an AbortError while OUR deadline never fired.
   */
  function abortingFetch(underlying: unknown) {
    return vi
      .fn()
      .mockRejectedValue(underlying) as unknown as typeof globalThis.fetch;
  }

  it('classifies an AbortError raised below us as a ProviderApiError, never as undefined', async () => {
    const underlying = new DOMException(
      'The operation was aborted',
      'AbortError',
    );

    const caught: unknown = await checkedFetch(
      'https://p.example',
      undefined,
      5_000,
      abortingFetch(underlying),
    ).catch((e: unknown) => e);

    expect(ProviderApiError.isProviderApiError(caught)).toBe(true);
    const err = caught as ProviderApiError;
    expect(err.kind).toBe('network');
    expect(err.cause).toBe(underlying);
    // The symptom this ticket is named for: `String(undefined)` at the tool boundary.
    expect(String(caught)).not.toBe('undefined');
  });

  it('classifies it the same way when timeoutMs <= 0 arms no timer of ours at all', async () => {
    // `armDeadline` skips the timer entirely at `timeoutMs <= 0`, so `aborted` is
    // structurally false here — the hole with no injected-fetch trickery involved.
    const caught: unknown = await checkedFetch(
      'https://p.example',
      undefined,
      0,
      abortingFetch(
        new DOMException('The operation was aborted', 'AbortError'),
      ),
    ).catch((e: unknown) => e);

    expect(ProviderApiError.isProviderApiError(caught)).toBe(true);
    expect((caught as ProviderApiError).kind).toBe('network');
  });

  it('leaves an abort raised below us RETRYABLE for the readiness poll', async () => {
    // Deliberate: its realistic provenance is a shorter deadline elsewhere or a stream
    // reset — the same transient family as a connect error, and bounded by the poll's
    // consecutive-failure budget. Before ENG-703 this failed fast, because `undefined`
    // is not a ProviderApiError.
    const caught: unknown = await checkedFetch(
      'https://p.example',
      undefined,
      5_000,
      abortingFetch(
        new DOMException('The operation was aborted', 'AbortError'),
      ),
    ).catch((e: unknown) => e);

    expect(isTransientProviderError(caught)).toBe(true);
  });

  it('blames our own deadline, not the network, for a rejection that lands after it fired', async () => {
    // The fetch ignores `init.signal` and rejects with a NON-abort error at 80ms, well
    // after our 20ms timer. We killed the request; the fetch stack's choice of error
    // object is not evidence about the cause. `cause` keeps the original either way.
    vi.useFakeTimers();
    const underlying = new TypeError('socket hang up');
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(underlying), 80);
        }),
    );

    const caught = capture(
      checkedFetch(
        'https://p.example',
        undefined,
        20,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    );
    await vi.advanceTimersByTimeAsync(80);

    expect(ProviderApiError.isProviderApiError(caught.current)).toBe(true);
    const err = caught.current as ProviderApiError;
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/timed out after 20ms/);
    expect(err.cause).toBe(underlying);
  });

  it('never surfaces a bare null when the caller aborts with an explicit null reason', async () => {
    // The spec substitutes a default AbortError for `abort(undefined)` but NOT for
    // `abort(null)`, so `reason` really is `null` here and reaches the classifier via
    // the pre-dispatch `throwIfAborted()`.
    const controller = new AbortController();
    controller.abort(null);
    const mockFetch = vi.fn(async () => new Response('ok'));

    const caught: unknown = await checkedFetch(
      'https://p.example',
      { signal: controller.signal },
      5_000,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(isTransientProviderError(caught)).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  /**
   * The four shapes an abort reason actually takes at this layer. The MCP SDK aborts with
   * `notification.params.reason`, typed `z.string().optional()`, so a plain string and an
   * empty string are both on the wire, and `_onclose` calls `abort()` with no args. All
   * four are the CALLER's value and are carried verbatim: consumers recognise a cancel by
   * `signal.aborted`, never by the error's shape, and leaving it unwrapped is what makes
   * `isTransientProviderError` reject it for free — a user's cancel is never a blip.
   */
  it.each([
    ['an Error', new Error('user cancelled')],
    [
      'a DOMException',
      new DOMException('The operation was aborted', 'AbortError'),
    ],
    ['a plain string', 'user pressed stop'],
    ['an empty string', ''],
  ])(
    'carries a caller cancel through verbatim (%s) and never tags it transient',
    async (_label, reason) => {
      const controller = new AbortController();
      const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      });

      const settled = checkedFetch(
        'https://p.example',
        { signal: controller.signal },
        5_000,
        mockFetch as unknown as typeof globalThis.fetch,
      ).catch((e: unknown) => e);
      setTimeout(() => controller.abort(reason), 10);
      const caught = await settled;

      expect(caught).toBe(reason);
      expect(ProviderApiError.isProviderApiError(caught)).toBe(false);
      expect(isTransientProviderError(caught)).toBe(false);
    },
  );
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

/**
 * `MAX_RESPONSE_BYTES` is a TRANSPORT cap: it stops 10 MiB reaching the heap, but a
 * 10 MiB error message still reached model context verbatim, because
 * `sanitizeForLogging` redacts without truncating. Capped in the CONSTRUCTOR so the
 * invariant is total — every construction site, both subclasses, and the sinks that
 * embed a message in composed prose or in a SUCCESS response (ENG-669).
 */
describe('ProviderApiError message cap (ENG-669)', () => {
  it('caps a multi-MB non-2xx body before it becomes the error message', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('A'.repeat(2_000_000), { status: 500 }));
    const err = (await checkedFetch(
      'https://p.example',
      undefined,
      undefined,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.message.length).toBe(MAX_PROVIDER_ERROR_CHARS + 1);
    expect(err.message.startsWith('AAA')).toBe(true);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('leaves a normal Fred error body byte-identical', async () => {
    // Guards lifecycle.e2e's /"code"\s*:\s*409/ and /invalid state/i matchers: the
    // cap must be invisible at realistic sizes.
    const body = '{"error":"invalid state for restart","code":409}';
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 409 }));
    const err = (await checkedFetch(
      'https://p.example',
      undefined,
      undefined,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.message).toBe(body);
    expect(err.message).not.toContain('…');
  });

  it('caps every construction site, not just the response-body path', () => {
    expect(new ProviderApiError(0, 'x'.repeat(50_000)).message.length).toBe(
      MAX_PROVIDER_ERROR_CHARS + 1,
    );
  });

  it('caps a subclass message too, via the inherited super() call', () => {
    class Sub extends ProviderApiError {}
    expect(new Sub(500, 'x'.repeat(50_000)).message.length).toBe(
      MAX_PROVIDER_ERROR_CHARS + 1,
    );
  });

  it('never bisects a surrogate pair at the cap boundary', () => {
    const msg = new ProviderApiError(0, '😀'.repeat(8_000)).message;
    // Both halves matter: length alone would pass on a UTF-16 slice that splits a
    // pair, and the pair check alone would pass vacuously on an uncapped string.
    expect(Array.from(msg).length).toBe(MAX_PROVIDER_ERROR_CHARS + 1);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(msg)).toBe(false);
  });

  it('preserves status / kind / retryAfterMs while capping', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('B'.repeat(2_000_000), {
        status: 429,
        headers: { 'retry-after': '1' },
      }),
    );
    const err = (await checkedFetch(
      'https://p.example',
      undefined,
      undefined,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e)) as ProviderApiError;

    expect(err.status).toBe(429);
    expect(err.kind).toBe('http');
    expect(err.retryAfterMs).toBe(1_000);
    expect(err.message.length).toBe(MAX_PROVIDER_ERROR_CHARS + 1);
  });
});

/**
 * The byte cap bounds MEMORY, not TIME. Before ENG-662 `checkedFetch` cleared its
 * timer and detached the caller's abort listener in a `finally` that ran BEFORE any
 * body was read, so a provider that returned headers promptly and then trickled the
 * body produced a call neither the timeout nor a host cancel could terminate.
 *
 * Every case here hangs forever against the pre-fix source.
 */
describe('body-read deadline (ENG-662)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Headers arrive at once, then one byte every `gapMs`, forever. `pull` returns a
   * promise so the stream genuinely stalls between chunks rather than spinning —
   * under fake timers `setTimeout` is patched, so `advanceTimersByTimeAsync` drives it.
   */
  function tricklingStream(gapMs: number, onCancel?: () => void) {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      pull: (controller) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(enc.encode('x'));
            resolve();
          }, gapMs);
        }),
      cancel: () => onCancel?.(),
    });
  }

  /** Capture settlement eagerly so advancing timers never trips an unhandled rejection. */
  function capture<T>(p: Promise<T>): { readonly current: unknown } {
    const box: { current: unknown } = { current: undefined };
    p.then(
      (v) => {
        box.current = v;
      },
      (e: unknown) => {
        box.current = e;
      },
    );
    return box;
  }

  it('T1: times out a trickling body when it owns the deadline', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const res = new Response(
      tricklingStream(60_000, () => {
        cancelled = true;
      }),
    );
    const caught = capture(readBodyCapped(res, 'https://p.example'));

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS - 1_000);
    // Proves the deadline fired, rather than some incidental rejection.
    expect(caught.current).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(caught.current).toBeInstanceOf(ProviderApiError);
    expect((caught.current as ProviderApiError).kind).toBe('timeout');
    expect((caught.current as ProviderApiError).message).toMatch(/timed out/);
    expect(cancelled).toBe(true);
  });

  it('T2: surfaces the caller reason verbatim when a supplied signal aborts mid-body', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const res = new Response(
      tricklingStream(60_000, () => {
        cancelled = true;
      }),
    );
    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const caught = capture(
      readBodyCapped(res, 'https://p.example', MAX_RESPONSE_BYTES, {
        signal: ac.signal,
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(caught.current).toBeUndefined();

    ac.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    // The caller's own reason, NOT a ProviderApiError: pollLeaseUntilReady keys
    // cancellation off identity here.
    expect(caught.current).toBe(reason);
    expect(cancelled).toBe(true);
  });

  it('T3: bounds the no-stream res.text() fallback, which has no reader to cancel', async () => {
    vi.useFakeTimers();
    const fakeRes = {
      ok: true,
      status: 200,
      text: () => new Promise<string>(() => {}), // never settles
    } as unknown as Response;
    const caught = capture(readBodyCapped(fakeRes, 'https://p.example'));

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS + 1_000);
    expect(caught.current).toBeInstanceOf(ProviderApiError);
    expect((caught.current as ProviderApiError).kind).toBe('timeout');
  });

  it('T4: a normal body completes and disposes its own deadline', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('{"a":'));
          c.enqueue(enc.encode('1}'));
          c.close();
        },
      }),
    );
    expect(await readBodyCapped(res, 'https://p.example')).toBe('{"a":1}');
    // The body assertion alone would still pass with `local?.dispose()` removed,
    // while every successful read leaked a live 30s timer. This is the half that
    // actually pins the cleanup.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T5: times out the !res.ok error-body read — the opposite side of the old finally', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () =>
        new Response(tricklingStream(60_000), {
          status: 503,
          headers: { 'retry-after': '5' },
        }),
    );
    const caught = capture(
      checkedFetch(
        'https://p.example',
        undefined,
        20_000,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    );

    await vi.advanceTimersByTimeAsync(19_000);
    expect(caught.current).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    const err = caught.current as ProviderApiError;
    expect(err).toBeInstanceOf(ProviderApiError);
    // Status and Retry-After survive the body timeout; only the kind changes.
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(5_000);
    expect(err.kind).toBe('timeout');
  });

  it('T6: a host cancel mid-error-body surfaces the caller reason, not a 503', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const mockFetch = vi.fn(
      async () => new Response(tricklingStream(60_000), { status: 503 }),
    );
    const caught = capture(
      checkedFetch(
        'https://p.example',
        { signal: ac.signal },
        20_000,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(caught.current).toBeUndefined();

    ac.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    // Must NOT be laundered into placeholder body text on a ProviderApiError.
    expect(caught.current).toBe(reason);
  });

  it('T7: bounds the SUCCESS-path body a bare checkedFetch hands back', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () => new Response(tricklingStream(60_000), { status: 200 }),
    );
    const res = await checkedFetch(
      'https://p.example',
      undefined,
      20_000,
      mockFetch as unknown as typeof globalThis.fetch,
    );
    // checkedFetch returned, so its own deadline is disposed — readBodyCapped's
    // default deadline is what stops this.
    const caught = capture(parseJsonResponse(res, 'https://p.example'));

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS + 1_000);
    expect(caught.current).toBeInstanceOf(ProviderApiError);
    expect((caught.current as ProviderApiError).kind).toBe('timeout');
  });

  it('T8: parseJsonResponse forwards the options bag', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const res = new Response(tricklingStream(60_000));
    const caught = capture(
      parseJsonResponse(res, 'https://p.example', MAX_RESPONSE_BYTES, {
        signal: ac.signal,
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    ac.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    expect(caught.current).toBe(reason);
  });

  it('T9: fetchJsonChecked spends ONE budget across headers and body, not one each', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          // Headers land 6s in, leaving 4s of the 10s budget for the body.
          setTimeout(
            () =>
              resolve(new Response(tricklingStream(60_000), { status: 200 })),
            6_000,
          );
        }),
    );
    const caught = capture(
      fetchJsonChecked(
        'https://p.example',
        undefined,
        10_000,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    );

    await vi.advanceTimersByTimeAsync(9_000);
    expect(caught.current).toBeUndefined();

    // A fresh body-phase deadline would not fire until 6s + 30s. A total budget
    // fires at 10s.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(caught.current).toBeInstanceOf(ProviderApiError);
    expect((caught.current as ProviderApiError).kind).toBe('timeout');
  });

  it('T10: fetchJsonChecked keeps res.status on an invalid-JSON body', async () => {
    // Load-bearing for restoreApp, which tells "restore COMMITTED but the 202 body
    // was empty" from a real failure by branching on a 2xx status here. A 0 would
    // route a lease with adopted volumes into cleanup advice — data loss.
    const mockFetch = vi.fn(async () => new Response('', { status: 202 }));
    const err: unknown = await fetchJsonChecked(
      'https://p.example',
      undefined,
      undefined,
      mockFetch as unknown as typeof globalThis.fetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(202);
    expect((err as ProviderApiError).kind).toBe('invalid_json');
  });

  it('T11: getProviderHealth times out at its own 5s, not 5s + 30s', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () => new Response(tricklingStream(60_000), { status: 200 }),
    );
    const caught = capture(
      getProviderHealth(
        'https://p.example',
        5_000,
        mockFetch as unknown as typeof globalThis.fetch,
      ),
    );

    await vi.advanceTimersByTimeAsync(6_000);
    expect(caught.current).toBeInstanceOf(ProviderApiError);
    expect((caught.current as ProviderApiError).kind).toBe('timeout');
  });

  it('T12: checkedFetch leaves no timer armed for a caller that never reads the body', async () => {
    vi.useFakeTimers();
    // A plain body, deliberately NOT a tricklingStream: that mock schedules its own
    // pull timer, which would be counted below and mask what this asserts.
    const mockFetch = vi.fn(
      async () => new Response('never read', { status: 200 }),
    );
    await checkedFetch(
      'https://p.example',
      undefined,
      20_000,
      mockFetch as unknown as typeof globalThis.fetch,
    );
    // uploadLeaseData is exactly this caller. A design that kept the deadline armed
    // for the returned Response would leave a live timer here with nobody to fire at.
    expect(vi.getTimerCount()).toBe(0);
  });
});
