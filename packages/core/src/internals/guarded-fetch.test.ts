import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardedFetch } from './guarded-fetch.js';

describe('createGuardedFetch — Node-runtime check', () => {
  it('returns a fetch-shaped function on Node', () => {
    const fn = createGuardedFetch();
    expect(typeof fn).toBe('function');
    // Function length: 2 (input, init?) — but JS arity counting may differ.
    // Don't pin .length; just verify it's callable.
  });

  it('throws a clear, actionable error on non-Node runtimes', () => {
    // Simulate non-Node by stashing process.versions.
    const original = process.versions;
    Object.defineProperty(process, 'versions', {
      value: {},
      configurable: true,
    });
    try {
      expect(() => createGuardedFetch()).toThrow(/Node\.js runtime/);
    } finally {
      Object.defineProperty(process, 'versions', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('createGuardedFetch — integration SSRF rejection (slow)', () => {
  // Integration tests against actual SSRF rejection of loopback / metadata
  // targets. These exercise the full pipeline (createGuardedFetch → undici
  // Dispatcher → DNS lookup → ipaddr.js check → connect-time reject).
  //
  // Skip-friendly: if the environment doesn't expose `undici` (e.g. an
  // older Node), the test naturally falls through to `null` result of the
  // outer try.

  it('rejects fetch to 127.0.0.1 with SSRF block message', async () => {
    const guarded = createGuardedFetch();
    let caught: Error | undefined;
    try {
      // Port 9999: unlikely to be in use, but the agent should reject at
      // CONNECT time before any TCP attempt.
      await guarded('http://127.0.0.1:9999/probe');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // The undici fetch wraps connection errors in a TypeError with a
    // `cause` chain. The original SSRF-block message should be visible
    // somewhere in the chain.
    const chain = collectErrorMessages(caught);
    expect(chain).toMatch(/SSRF blocked/);
    expect(chain).toMatch(/loopback/);
  }, 10_000);

  it('rejects fetch to 169.254.169.254 (AWS metadata) with linkLocal block', async () => {
    const guarded = createGuardedFetch();
    let caught: Error | undefined;
    try {
      await guarded('http://169.254.169.254:80/latest/meta-data/');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const chain = collectErrorMessages(caught);
    expect(chain).toMatch(/SSRF blocked/);
    expect(chain).toMatch(/linkLocal/);
  }, 10_000);
});

describe('createGuardedFetch — cachedP recovery after rejection', () => {
  afterEach(() => {
    vi.doUnmock('undici');
    vi.resetModules();
  });

  it('clears cachedP after a rejected buildSsrfDispatcher so the next call retries', async () => {
    // Mock `undici` so the first `new Agent({...})` invocation inside
    // `buildSsrfDispatcher` throws, then subsequent invocations succeed.
    // Without the catch-and-reset, the cached rejected Promise would
    // make EVERY subsequent createGuardedFetch() call fail permanently.
    let constructAttempts = 0;
    vi.doMock('undici', async () => {
      const actual = await vi.importActual<typeof import('undici')>('undici');
      class FlakyAgent extends actual.Agent {
        constructor(opts: ConstructorParameters<typeof actual.Agent>[0]) {
          constructAttempts += 1;
          if (constructAttempts === 1) {
            throw new Error('simulated dispatcher construction failure');
          }
          super(opts);
        }
      }
      return { ...actual, Agent: FlakyAgent };
    });

    // Re-import the SUT so it picks up the mocked undici. Each `vi.resetModules`
    // + dynamic import yields a fresh module instance with cachedP undefined.
    vi.resetModules();
    const { createGuardedFetch: freshCreate } = await import(
      './guarded-fetch.js'
    );
    const guarded = freshCreate();

    // First call: Agent constructor throws → buildSsrfDispatcher rejects →
    // the catch arm clears cachedP and re-throws.
    await expect(guarded('https://example.com/')).rejects.toThrow(
      /simulated dispatcher construction failure/,
    );
    expect(constructAttempts).toBe(1);

    // Second call: cachedP was reset, so buildSsrfDispatcher is invoked
    // again. The Agent constructor succeeds this time. The fetch itself
    // may fail for unrelated reasons (the SSRF guard blocks the test URL),
    // but the failure mode must NOT be "simulated dispatcher construction
    // failure" anymore — proving the cached rejected Promise was cleared.
    let secondError: Error | undefined;
    try {
      // 127.0.0.1: SSRF-blocked target so we don't hit the real network.
      await guarded('http://127.0.0.1:9999/probe');
    } catch (err) {
      secondError = err as Error;
    }
    expect(constructAttempts).toBe(2);
    const secondMessage = secondError ? collectErrorMessages(secondError) : '';
    expect(secondMessage).not.toMatch(
      /simulated dispatcher construction failure/,
    );
  }, 10_000);
});

/**
 * Walk an Error's cause chain (Node 16.9+ supports Error.cause) and join
 * all message strings. undici wraps connect errors in a fetch TypeError
 * with the real cause nested via `.cause`.
 */
function collectErrorMessages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (
    current !== null &&
    current !== undefined &&
    depth < 10 // defensive bound
  ) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  return parts.join(' | ');
}
