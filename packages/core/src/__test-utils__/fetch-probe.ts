// A wire probe for provider HTTP: an injectable `fetch` that answers from a script or a route
// map, records every dispatch, and DENIES anything it was not told to answer.
//
// Promoted here from `packages/fred/src/http/fred.test.ts`, which had carried it since ENG-705
// and whose JSDoc named this exact destination: "If a second test file ever needs this, promote
// it to `packages/core/src/__test-utils__/fetch-probe.ts` beside `fred-wire.ts`, plus an exports
// entry — not to a new directory under `packages/fred/src`, which tsdown's entry glob would ship
// to `dist`." A second file now needs it (ENG-725). `ProbeCall` / `ProbeStep` / `ProbeScript` /
// `respond` / `fetchProbe` below are that code VERBATIM; only `export` markers were added.
//
// WHY A PROBE AND NOT A MODULE MOCK. It sits at `doFetch` (fred's `http/provider.ts`), BELOW
// every layer of the transport, so nothing the transport does internally can escape it. Vitest
// does not rewrite intra-module references, so a PARTIAL mock of a module whose internals call
// each other leaks silently — the class of bug ENG-705/713/715 each fixed one file at a time.
// Injecting at the transport's own seam removes the reason to mock at all, and the real
// `validateProviderUrl`, `checkedFetch`, `readBodyCapped`, `classifyTransportError`,
// `classifyBodyError` and JSON parse then run on every assertion.
//
// WHY NOT MSW / nock / undici's `MockAgent` — recorded so nobody re-litigates it (ENG-725). All
// three intercept GLOBALS, and this codebase injects fetch as a function ARGUMENT, which none of
// them can see. Worse, `tools/vitest/ban-global-fetch.ts` deliberately installs its stub as
// `configurable` so `vi.stubGlobal` keeps working, so an MSW `setupServer().listen()` would
// SILENTLY overwrite the ENG-705 ban in every package. `MockAgent` additionally cannot reach
// core's guarded path (`internals/guarded-fetch.ts` returns `undici.fetch` directly and passes an
// explicit per-request `dispatcher`), and injecting a mock dispatcher would DELETE the
// `new undici.Agent({ connect })` SSRF hook that fred's composition-root test exists to assert.
// `fetch-mock@12` was the one live alternative and lost on specifics: its response-config model
// cannot express the `streamError`-vs-`transportError` identity distinction below, and the escape
// ledger would have to be hand-rolled either way.
import { afterEach } from 'vitest';

/** One recorded wire dispatch. */
export interface ProbeCall {
  readonly url: string;
  /**
   * What the TRANSPORT passed, not what the caller handed `fetchJsonChecked`:
   * `checkedFetchWithin` dispatches `{ ...init, signal: deadline.signal }`. So `init.signal`
   * is ALWAYS present — even for a function with no signal parameter — and is always the
   * composed deadline signal, never the caller's own instance. Identity comparison against a
   * caller signal will always fail; assert `.aborted` / `.reason` instead.
   */
  readonly init: RequestInit;
}

/** What the probe should do for one call. */
export type ProbeStep =
  /** A 2xx JSON body. `json: null` is legal, and models a provider that literally sends `null`. */
  | {
      readonly json: unknown;
      readonly status?: number;
      readonly headers?: Record<string, string>;
    }
  /**
   * A non-2xx. The REAL non-2xx block builds the `ProviderApiError` from this, so the status,
   * the `kind` tag and the message-from-body composition are all under test.
   *
   * Give `text` a non-empty value unless you mean to exercise the `body || "HTTP <status>"`
   * fallback — an empty body is falsy and silently becomes `HTTP 502`.
   */
  | {
      readonly status: number;
      readonly text?: string;
      readonly headers?: Record<string, string>;
    }
  /**
   * The body stream errors mid-read. `classifyBodyError` passes a non-timeout through
   * UNCHANGED, so the value arrives at the caller verbatim, identity intact.
   *
   * This is the only wire shape that can hand `pollLeaseUntilReady` something that is not a
   * `ProviderApiError` — a probe that merely REJECTS is laundered into a retryable
   * `kind: 'network'` by `classifyTransportError`'s third arm, which would silently invert
   * any test about a value failing fast.
   */
  | { readonly streamError: unknown }
  /**
   * The transport itself rejects: an injected fetch running its own shorter deadline, a
   * connect error, a stream reset. When neither our deadline fired nor the caller aborted,
   * `classifyTransportError`'s third arm tags this `kind: 'network'` — deliberately
   * retryable. Use it to model a genuine transport fault; to model a value that must reach
   * the caller verbatim, use `streamError` instead.
   */
  | { readonly transportError: unknown }
  /** Never settles until the observed (composed) signal aborts; then rejects with its reason. */
  | { readonly hang: true };

/** A step, a script of steps (the last repeats forever), or a per-call function. */
export type ProbeScript =
  | ProbeStep
  | ProbeStep[]
  | ((call: ProbeCall, n: number) => ProbeStep);

export interface FetchProbe {
  /** Pass as the `fetchFn` argument. */
  readonly fetch: typeof globalThis.fetch;
  /** Every dispatch, in order. A plain array, not a `vi.fn` log — see the one-probe-per-test rule. */
  readonly calls: readonly ProbeCall[];
}

export function respond(step: ProbeStep, call: ProbeCall): Promise<Response> {
  if ('hang' in step) {
    const { signal } = call.init;
    return new Promise<Response>((_resolve, reject) => {
      // A probe that aborts the caller BEFORE returning sees an already-aborted signal, and
      // `addEventListener('abort')` never fires on one — without this the transport hangs
      // forever and takes the suite's timeout with it.
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  }
  if ('transportError' in step) {
    return Promise.reject(step.transportError);
  }
  if ('streamError' in step) {
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(step.streamError);
          },
          // `BodyInit` is not in scope under this package's `lib`, so the accepted body type
          // is derived from `Response` itself rather than named.
        }) as unknown as ConstructorParameters<typeof Response>[0],
        { status: 200 },
      ),
    );
  }
  if ('json' in step) {
    return Promise.resolve(
      new Response(JSON.stringify(step.json), {
        status: step.status ?? 200,
        headers: { 'content-type': 'application/json', ...step.headers },
      }),
    );
  }
  return Promise.resolve(
    new Response(step.text ?? `HTTP ${step.status}`, {
      status: step.status,
      headers: step.headers,
    }),
  );
}

/**
 * Build a wire probe.
 *
 * Construct one per `it`, never in a `describe` scope or a `beforeEach`: `calls` is a plain
 * array that `vi.clearAllMocks()` would not reset, and a hoisted probe would leak its script
 * cursor into the next test.
 *
 * If a second test file ever needs this, promote it to
 * `packages/core/src/__test-utils__/fetch-probe.ts` beside `fred-wire.ts`, plus an exports
 * entry — not to a new directory under `packages/fred/src`, which tsdown's entry glob would
 * ship to `dist`.
 */
export function fetchProbe(script: ProbeScript): FetchProbe {
  const calls: ProbeCall[] = [];
  const fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const call: ProbeCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const n = calls.length - 1;
    const step =
      typeof script === 'function'
        ? script(call, n)
        : Array.isArray(script)
          ? script[Math.min(n, script.length - 1)]
          : script;
    return respond(step, call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

// ─── The sealed layer (ENG-725) ────────────────────────────────────────────────────────────
//
// `fetchProbe` answers ONE script, which is right for a test of a single transport function.
// A tool test drives several endpoints, so it needs a route map — and, more importantly, it
// needs the UNROUTED case to be a loud, named failure rather than a plausible one.

/** Route key → what to answer. Keys are last path segments: `/status`, `/logs`, `/health`, … */
export type ProbeRoutes = Readonly<Record<string, ProbeScript>>;

export interface SealedFetchProbe extends FetchProbe {
  /**
   * Requests this probe REFUSED, in order. Normally empty; the `afterEach` below fails the
   * test if it is not. Exposed so a test can assert on a deliberate denial without tripping it
   * — drain it with {@link __drainProbeEscapes} in that case.
   */
  readonly escapes: readonly string[];
}

/**
 * The route key a URL resolves to: its LAST path segment, query string dropped.
 *
 * Fred's ten endpoints are all distinct in that segment — `/status`, `/logs`, `/provision`,
 * `/restart`, `/update`, `/restore`, `/releases` (`http/fred.ts`) and `/health`, `/connection`,
 * `/data` (`http/provider.ts`) — so a last-segment map is unambiguous without pattern matching.
 * Matching on the last segment rather than a substring is deliberate: a substring key would make
 * `/status` also match a future `/lease-status`, and the failure would be a wrong answer rather
 * than a denial.
 *
 * The query string is dropped because `getLeaseLogs` appends one (`?tail=…`). That is not lost
 * information — it is recoverable from `calls`, which is the only place a test can assert the
 * tool built the right query at all.
 */
function routeKeyOf(url: string): string {
  // A relative or malformed URL has no origin to parse against; fall back to the raw string so
  // the escape message still names something a reader can act on.
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0] ?? url;
  }
  const segments = pathname.split('/').filter(Boolean);
  return `/${segments[segments.length - 1] ?? ''}`;
}

/** Escapes recorded across all sealed probes in the current test. Drained by the `afterEach`. */
let escapes: string[] = [];

/**
 * Drain and reset the recorded escapes.
 *
 * For a test that trips a probe DELIBERATELY (the guard's own self-test, or a case asserting
 * that a tool must not call an endpoint) and must not leave a violation for the `afterEach`.
 */
export function __drainProbeEscapes(): string[] {
  const hits = escapes;
  escapes = [];
  return hits;
}

/**
 * Fail the current test if a sealed probe refused a request. Registered as the `afterEach` below.
 *
 * THE THROW ALONE IS NOT ENOUGH, which is the whole reason this exists. fred's transport catches
 * every rejection from `doFetch` and `classifyTransportError` re-wraps it as
 * `ProviderApiError{ status: 0, kind: 'network' }` — so a test asserting a network fault goes
 * GREEN on a request the probe refused, and the assertion above it proved nothing. That is the
 * same false-green `tools/vitest/ban-global-fetch.ts` was written to kill, and it recorded the
 * measurement that matters: with its reporting body neutered, all six of its guard checks still
 * passed. Every refusal therefore has to survive to the end of the test.
 *
 * Exported, rather than inlined into the hook, so the guard test can invoke the reporting path
 * DIRECTLY — otherwise a test could only observe that escapes are RECORDED, and the throw (the
 * half that converts an escape into a failure) would go unproven.
 */
export function __reportProbeEscapes(): void {
  const hits = __drainProbeEscapes();
  if (hits.length === 0) return;
  throw new Error(
    `A sealed fetch probe refused ${hits.length} request(s) during this test. Each was thrown ` +
      "at the caller, but fred's transport re-wraps any `doFetch` rejection as " +
      '`ProviderApiError{ kind: "network" }`, so a test asserting a transport fault would have ' +
      'gone green on it. Either the code under test reached an endpoint this test did not ' +
      'script, or a route key is wrong.\n\n' +
      `${hits.join('\n')}`,
  );
}

afterEach(__reportProbeEscapes);

/**
 * Build a DEFAULT-DENY wire probe from a route map.
 *
 * Every route answers a {@link ProbeScript}, so a poll loop is driven by scripting its endpoint
 * with an array whose last step repeats (`[PENDING, PENDING, READY]`) exactly as `fetchProbe`
 * does. Bodies should come from `./fred-wire.js`, whose fixtures are `Record<string, unknown>`
 * on purpose — typing them as the client's own interfaces would stop a fixture expressing the
 * provider drift they exist to model.
 *
 * An unrouted request is thrown at the caller AND recorded (see {@link __reportProbeEscapes});
 * it never resolves, and it never silently becomes a `Response`.
 *
 * Construct one per `it`, never in a `describe` scope or a `beforeEach` — `calls` is a plain
 * array that `vi.clearAllMocks()` would not reset, and a hoisted probe leaks its script cursor
 * into the next test. (Same rule as {@link fetchProbe}, same reason.)
 */
export function sealedFetchProbe(routes: ProbeRoutes = {}): SealedFetchProbe {
  const calls: ProbeCall[] = [];
  // Per-route cursors: each route advances its own script independently, so scripting `/status`
  // as a 3-step sequence is unaffected by however many times `/provision` was read.
  const cursors = new Map<string, number>();

  const fetch = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const call: ProbeCall = { url: String(input), init: init ?? {} };
    calls.push(call);

    const key = routeKeyOf(call.url);
    const script = routes[key];
    if (script === undefined) {
      const known = Object.keys(routes).sort().join(', ') || '(none)';
      const message =
        `sealed fetch probe refused ${init?.method ?? 'GET'} ${call.url} — no route for ` +
        `'${key}'. Routed: ${known}.`;
      escapes.push(message);
      return Promise.reject(new Error(message));
    }

    const n = cursors.get(key) ?? 0;
    cursors.set(key, n + 1);
    const step =
      typeof script === 'function'
        ? script(call, n)
        : Array.isArray(script)
          ? script[Math.min(n, script.length - 1)]
          : script;
    return respond(step as ProbeStep, call);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    get escapes() {
      return escapes;
    },
  };
}
