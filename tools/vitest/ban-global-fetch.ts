// No unit test may reach the network (ENG-705).
//
// Loaded as `setupFiles` by every `packages/*/vitest.config.ts`, so it is evaluated once per
// TEST FILE, inside the worker running that file — not once per worker. Under the repo's
// current defaults (`pool: 'forks'`, `isolate: true`) each file also gets its own process, so
// the two readings happen to coincide; they stop coinciding the moment isolation is turned off
// or a pool reuses workers. Measured both ways: 34 fred files give 34 evaluations across 34
// pids by default, and 34 evaluations in ONE pid under `--no-isolate --pool=threads`. Per-file
// is the rule to rely on, and it is the one that matters here — every file gets a fresh stub.
//
// `globalSetup` would be wrong: it runs in the parent process, not the one the tests execute
// in, so it could not replace the global the code under test actually sees.
//
// WHY THIS EXISTS. `packages/fred`'s HTTP layer takes an injectable `fetchFn` at every entry
// point and falls back to `globalThis.fetch` when it is omitted (`http/provider.ts`, the
// `fetchFn ?? globalThis.fetch` lines). So a mock that misses — the partial-module mock of
// `./provider.js` that ENG-705 removed, or any future one — does not fail loudly. It falls
// through and makes a real outbound request from a unit test: slow, flaky, dependent on the
// machine's DNS, and in the SSRF-guard tests actively misleading. This turns that silent
// fall-through into an immediate, named failure.
//
// It also disarms a live class of landmine: ~10 fred tool tests build their fetch spy as
// `vi.fn(globalThis.fetch)`, which installs the REAL fetch as the spy's default
// implementation. Those spies are only threaded and asserted on today, never invoked — but
// `mockReset()` RESTORES that default rather than clearing it, so the landmine is one edit
// away from firing. With this in place it fires as a test failure instead of a socket.
//
// Measured cost when introduced: zero. A pass-through probe recorded no real-fetch calls
// anywhere in the repo, and this throwing stub changed no test's outcome in any of the nine
// packages.
//
// DELIBERATE NON-COVERAGE — `undici`. Core's SSRF-guarded fetch does not route through the
// global at all: `core/src/internals/guarded-fetch.ts` returns `undici.fetch` directly, to
// dodge a Dispatcher-protocol mismatch between Node's bundled undici 6 and the npm undici 8
// this repo pins. So this guard does NOT constrain `createGuardedFetch`, which is the fred
// MCP server's default path. Nothing needs an exemption today: core's `guarded-fetch.test.ts`
// exercises the real connector against `127.0.0.1` and `169.254.169.254` and passes, because
// the SSRF connector rejects before a socket is ever opened. Closing that hole means stubbing
// `undici.fetch` too, with an allowlist for that file; deliberately out of scope here.
//
// ESCAPE HATCH. A test that genuinely needs to exercise the `?? globalThis.fetch` fallback
// stubs the global itself — `vi.stubGlobal('fetch', …)`, as two cases in
// `packages/fred/src/http/provider.test.ts` do. That overwrites this stub for the duration
// and `vi.unstubAllGlobals()` restores THIS stub, never the real fetch. Any other test should
// inject its own fetch (`fetchFn`, `ctx.fetch`, `opts.fetch`) rather than reaching for the
// global.

import { afterEach } from 'vitest';

/** Thrown by the banned global. Exported so the guard's own self-test can match it exactly. */
export const BANNED_FETCH_MESSAGE =
  'Unit tests must not reach the network: something called globalThis.fetch. ' +
  'This almost always means a mock did not intercept the call and it fell through to the ' +
  'real transport. Inject a fetch instead — `fetchFn` on the http/* functions, `ctx.fetch` ' +
  'on a tool, or `opts.fetch` on a client factory — and return a real `Response` from it. ' +
  'If you are deliberately testing the `?? globalThis.fetch` fallback, stub it for that test ' +
  "with `vi.stubGlobal('fetch', …)`. See tools/vitest/ban-global-fetch.ts (ENG-705).";

/** Violations whose error the code under test SWALLOWED. Drained by the `afterEach` below. */
let swallowed: string[] = [];

/**
 * Drain and reset the recorded violations. Only for this ban's own guard test, which trips
 * the ban deliberately and must not leave a violation behind for the `afterEach` to report.
 */
export function __drainBannedFetchCalls(): string[] {
  const hits = swallowed;
  swallowed = [];
  return hits;
}

// `defineProperty` rather than assignment: `vi.stubGlobal` redefines this property, which
// requires it to stay `configurable`.
Object.defineProperty(globalThis, 'fetch', {
  value: (input?: unknown): never => {
    const target =
      typeof input === 'string'
        ? input
        : String((input as { url?: unknown } | null)?.url ?? input);
    swallowed.push(`${BANNED_FETCH_MESSAGE} (target: ${target})`);
    throw new Error(BANNED_FETCH_MESSAGE);
  },
  writable: true,
  configurable: true,
  enumerable: true,
});

/**
 * Fail the current test if any violation was swallowed. Registered as the `afterEach` below.
 *
 * A SWALLOWED violation is still a violation. Without this, an escape can still read as a
 * PASS: the fred transport catches any throw from `doFetch` and re-wraps it as
 * `ProviderApiError{status: 0, kind: 'network'}`, so a test asserting exactly that goes green
 * on a banned call. That is the same false-green ENG-705 exists to kill, so the throw alone is
 * not enough — every violation has to survive to the end of the test.
 *
 * Exported, rather than inlined into the hook, so the guard test can invoke the reporting path
 * DIRECTLY. Inlined, a test could only observe that violations are recorded, and the throw —
 * the half that actually converts an escape into a failure — would go unproven. It was: with
 * this body neutered, all six guard checks still passed.
 */
export function __reportSwallowedBannedFetch(): void {
  const hits = __drainBannedFetchCalls();
  if (hits.length === 0) return;
  throw new Error(
    `globalThis.fetch was called ${hits.length}x during this test and the error was ` +
      'swallowed by the code under test, so the assertions above proved nothing about the ' +
      `transport.\n\n${hits.join('\n')}`,
  );
}

afterEach(__reportSwallowedBannedFetch);
