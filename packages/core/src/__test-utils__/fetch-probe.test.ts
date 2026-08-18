// Guard for the sealed layer of `fetch-probe.ts` (ENG-725).
//
// `fetchProbe` itself is exercised by 69 cases in `packages/fred/src/http/fred.test.ts`, which
// drive it through the real transport; this file covers only what the promotion ADDED — route
// resolution and the escape ledger — plus the non-vacuity controls those need to be guards
// rather than claims.
//
// The control that matters is `(reporting actually throws)`. `tools/vitest/ban-global-fetch.ts`
// recorded the lesson verbatim: with its reporting body neutered, all six of its guard checks
// still passed, because recording a violation and FAILING on one are different properties and
// only the second one bites. Every test below that trips the probe deliberately therefore
// drains the ledger itself, so the module's own `afterEach` cannot mask the difference.
import { describe, expect, it } from 'vitest';
import {
  __drainProbeEscapes,
  __reportProbeEscapes,
  fetchProbe,
  sealedFetchProbe,
} from './fetch-probe.js';

const BASE = 'https://provider.example.com';
const LEASE = `${BASE}/v1/leases/550e8400-e29b-41d4-a716-446655440000`;

describe('sealedFetchProbe — routing', () => {
  it('routes on the last path segment, ignoring the lease uuid', async () => {
    const probe = sealedFetchProbe({
      '/status': { json: { state: 'LEASE_STATE_ACTIVE' } },
    });

    const res = await probe.fetch(`${LEASE}/status`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: 'LEASE_STATE_ACTIVE' });
    expect(probe.calls).toHaveLength(1);
  });

  it('drops the query string before routing, and keeps it in the call log', async () => {
    // `getLeaseLogs` appends `?tail=…`. The query must not defeat the route, and it must stay
    // recoverable — the request log is the ONLY place a test can assert the tool built it.
    const probe = sealedFetchProbe({ '/logs': { json: { logs: {} } } });

    await probe.fetch(`${LEASE}/logs?tail=50`);

    expect(probe.calls[0]?.url).toContain('?tail=50');
  });

  it('advances each route cursor independently', async () => {
    // A poll loop reads `/status` repeatedly while another endpoint is read once; scripting one
    // must not consume the other's script.
    const probe = sealedFetchProbe({
      '/status': [
        { json: { state: 'LEASE_STATE_PENDING' } },
        { json: { state: 'LEASE_STATE_ACTIVE' } },
      ],
      '/provision': { json: { provision_status: 'ready' } },
    });

    const first = await (await probe.fetch(`${LEASE}/status`)).json();
    await probe.fetch(`${LEASE}/provision`);
    const second = await (await probe.fetch(`${LEASE}/status`)).json();

    expect(first).toEqual({ state: 'LEASE_STATE_PENDING' });
    expect(second).toEqual({ state: 'LEASE_STATE_ACTIVE' });
  });

  it('repeats the last step of a script forever', async () => {
    const probe = sealedFetchProbe({
      '/status': [{ json: { n: 1 } }, { json: { n: 2 } }],
    });

    await probe.fetch(`${LEASE}/status`);
    await probe.fetch(`${LEASE}/status`);
    const third = await (await probe.fetch(`${LEASE}/status`)).json();

    expect(third).toEqual({ n: 2 });
  });

  it('builds a FRESH Response per call', async () => {
    // Load-bearing, and the reason a route stores a step DESCRIPTOR rather than a `Response`.
    // A stored `Response` is single-read: the poll hits the same URL N times and the transport
    // streams `res.body.getReader()` on each, so iteration 2 would die with
    // `TypeError: Body is unusable`. Reading twice here is the regression test for that.
    const probe = sealedFetchProbe({ '/status': { json: { state: 'x' } } });

    const a = await probe.fetch(`${LEASE}/status`);
    await a.text();
    const b = await probe.fetch(`${LEASE}/status`);

    await expect(b.text()).resolves.toBe('{"state":"x"}');
  });
});

describe('sealedFetchProbe — the escape ledger', () => {
  it('refuses an unrouted request, naming the method, the URL and the routes it has', async () => {
    const probe = sealedFetchProbe({ '/status': { json: {} } });

    await expect(
      probe.fetch(`${LEASE}/connection`, { method: 'POST' }),
    ).rejects.toThrow(
      /refused POST .*\/connection — no route for '\/connection'/,
    );

    const hits = __drainProbeEscapes();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('Routed: /status');
  });

  it('records the refusal even when the caller SWALLOWS the rejection', async () => {
    // The whole reason the ledger exists. fred's transport catches every `doFetch` rejection and
    // re-wraps it as `ProviderApiError{ kind: 'network' }`, so a test asserting a transport fault
    // goes green on a refused request. Simulate exactly that swallow.
    const probe = sealedFetchProbe({});

    let swallowed = false;
    try {
      await probe.fetch(`${LEASE}/status`);
    } catch {
      swallowed = true;
    }

    expect(swallowed).toBe(true);
    expect(__drainProbeEscapes()).toHaveLength(1);
  });

  it('(non-vacuity) reporting actually THROWS, not merely records', () => {
    // Invoke the reporting path DIRECTLY. Inlined into the hook, a test could only observe that
    // escapes are recorded, and the throw — the half that converts an escape into a failure —
    // would go unproven. Neuter `__reportProbeEscapes`'s body and this is the test that fails.
    const probe = sealedFetchProbe({});
    void probe.fetch(`${LEASE}/status`).catch(() => undefined);

    expect(() => __reportProbeEscapes()).toThrow(
      /refused 1 request\(s\) during this test/,
    );
  });

  it('(non-vacuity) reporting is silent when nothing escaped', () => {
    expect(__drainProbeEscapes()).toEqual([]);
    expect(() => __reportProbeEscapes()).not.toThrow();
  });

  it('draining resets the ledger', async () => {
    const probe = sealedFetchProbe({});
    await probe.fetch(`${LEASE}/status`).catch(() => undefined);

    expect(__drainProbeEscapes()).toHaveLength(1);
    expect(__drainProbeEscapes()).toEqual([]);
  });
});

describe('fetchProbe — unchanged by the promotion', () => {
  it('still answers a bare script and records the dispatch', async () => {
    const probe = fetchProbe({ json: { ok: true } });

    const res = await probe.fetch(`${LEASE}/status`);

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(probe.calls).toHaveLength(1);
  });

  it('is NOT sealed — an unscripted URL is answered, not refused', async () => {
    // The distinction between the two exports, pinned. `fetchProbe` answers one script for every
    // URL by design (its callers test ONE transport function); `sealedFetchProbe` denies. If this
    // ever starts refusing, 69 cases in fred's `http/fred.test.ts` change meaning.
    const probe = fetchProbe({ json: { ok: true } });

    await expect(probe.fetch(`${BASE}/anything/at/all`)).resolves.toBeDefined();
    expect(__drainProbeEscapes()).toEqual([]);
  });
});
