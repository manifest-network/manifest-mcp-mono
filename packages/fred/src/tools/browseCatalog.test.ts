import { noopLogger } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it, vi } from 'vitest';
import type { FredReadCtx } from '../ctx.js';
import { browseCatalog, mapWithConcurrency } from './browseCatalog.js';

describe('mapWithConcurrency', () => {
  it('preserves input order even when items resolve out of order', async () => {
    const items = [1, 2, 3, 4, 5];
    // Items resolve in reverse order (5 resolves first, 1 resolves last)
    const results = await mapWithConcurrency(items, 5, async (item) => {
      await new Promise((r) => setTimeout(r, (6 - item) * 10));
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('limits concurrency to the specified cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually uses concurrency
  });

  it('works when items count is less than limit', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (x) => x * 2);
    expect(results).toEqual([2, 4]);
  });

  it('handles empty items array', async () => {
    const fn = vi.fn();
    const results = await mapWithConcurrency([], 5, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clamps limit to at least 1 when given 0', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('propagates errors from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('browseCatalog', () => {
  it('ENG-258: returns a flat skus[] with uuid + provider + split provider fields', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providers: [
          {
            uuid: 'p1',
            address: 'm1',
            apiUrl: 'https://provider.example.com',
            active: true,
          },
        ],
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '100', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '120', denom: 'umfx' },
          },
        ],
      },
    });
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{"status":"healthy","checks":{}}'),
    );
    const ctx: FredReadCtx = {
      // `query`/`chain` keep `as never` deliberately — `qc` is a partial
      // makeMockQueryClient (not assignable to ManifestQueryClient) and `chain`
      // is `{}`; neither is cleanly typeable. `fetch` IS, so type the spy so a
      // wrong fetch shape/return-type is caught instead of swallowed by a cast.
      query: qc as never,
      chain: {} as never,
      fetch: fetchSpy,
      logger: noopLogger,
    };
    const res = await browseCatalog(ctx);

    // GOLDEN — the exact object captured from the pre-refactor positional run.
    const GOLDEN = {
      providers: [
        {
          uuid: 'p1',
          address: 'm1',
          apiUrl: 'https://provider.example.com',
          active: true,
          healthy: true,
          health_status: 'healthy',
          providerUuid: undefined,
        },
      ],
      skus: [
        {
          name: 'docker-micro',
          sku_uuid: 'a',
          provider_uuid: 'p1',
          provider_url: 'https://provider.example.com',
          price: '100',
          unit: 'umfx',
          active: true,
        },
        {
          name: 'docker-micro',
          sku_uuid: 'b',
          provider_uuid: 'p2',
          provider_url: null,
          price: '120',
          unit: 'umfx',
          active: true,
        },
      ],
    };
    expect(res).toEqual(GOLDEN);
    expect(res).not.toHaveProperty('tiers');
    // ctx.fetch is threaded down to the provider-health call.
    expect(fetchSpy).toHaveBeenCalled();
  });
});

/**
 * Fred ENG-522/ENG-608 turned `GET /health` into a LIVENESS contract: it answers 200
 * whenever the process can answer, and carries a THREE-tier verdict in the body
 * (`healthy` / `degraded` / `unhealthy`) instead of folding everything into a 503.
 *
 * The `healthy` boolean is unaffected — an impaired provider used to 503 into the catch
 * and land on the `false` initializer, and now reaches `false` through the verdict. What
 * WAS lost is the diagnosis: the 503 threw a ProviderApiError whose message carried the
 * whole health body, and a 200 throws nothing. These tests pin that it is carried again.
 */
describe('browseCatalog provider health verdicts (Fred ENG-522/608)', () => {
  function ctxServing(body: unknown): FredReadCtx {
    return {
      query: makeMockQueryClient({
        sku: {
          providers: [
            {
              uuid: 'p1',
              address: 'm1',
              apiUrl: 'https://provider.example.com',
              active: true,
            },
          ],
          skus: [],
        },
      }) as never,
      chain: {} as never,
      fetch: vi.fn<typeof globalThis.fetch>(
        async () => new Response(JSON.stringify(body)),
      ),
      logger: noopLogger,
    };
  }

  it('healthy: usable, verdict carried, no error string', async () => {
    const res = await browseCatalog(
      ctxServing({
        status: 'healthy',
        provider_uuid: 'prov-1',
        checks: { chain: { status: 'healthy' } },
      }),
    );
    expect(res.providers[0]).toMatchObject({
      healthy: true,
      health_status: 'healthy',
      providerUuid: 'prov-1',
    });
    expect(res.providers[0]).not.toHaveProperty('healthError');
  });

  it('degraded: not usable, and the FAILING checks are named', async () => {
    const res = await browseCatalog(
      ctxServing({
        status: 'degraded',
        provider_uuid: 'prov-1',
        checks: {
          chain: { status: 'unhealthy', message: 'chain connectivity failed' },
          'backend:docker-2': {
            status: 'unhealthy',
            message: 'backend health check failed',
          },
          token_tracker: { status: 'healthy' },
        },
      }),
    );
    const p = res.providers[0]!;
    expect(p).toMatchObject({ healthy: false, health_status: 'degraded' });
    // The whole point of the fix: attribution, not a bare `healthy: false`.
    expect(p.healthError).toContain('chain');
    expect(p.healthError).toContain('chain connectivity failed');
    expect(p.healthError).toContain('backend:docker-2');
    // Passing checks are noise here and must not be listed.
    expect(p.healthError).not.toContain('token_tracker');
  });

  it('unhealthy on a 200: still surfaces the failing check', async () => {
    const res = await browseCatalog(
      ctxServing({
        status: 'unhealthy',
        provider_uuid: 'prov-1',
        checks: {
          payload_store: {
            status: 'unhealthy',
            message: 'payload store unavailable',
          },
        },
      }),
    );
    const p = res.providers[0]!;
    expect(p).toMatchObject({ healthy: false, health_status: 'unhealthy' });
    // payload_store failing is the pre-flight tell that update_app will 500 here.
    expect(p.healthError).toContain('payload_store');
  });

  it('a verdict with no per-check detail still reports the verdict itself', async () => {
    const res = await browseCatalog(
      ctxServing({ status: 'degraded', provider_uuid: 'prov-1', checks: {} }),
    );
    const p = res.providers[0]!;
    expect(p.healthy).toBe(false);
    expect(p.healthError).toContain('degraded');
  });

  // REGRESSION GUARD. `status === 'ok'` was accepted for years and Fred has never
  // emitted it — `git log -S'"ok"'` finds nothing on the health handler. It made every
  // fixture written against it fictional. An unknown verdict must read as NOT healthy.
  it('an unrecognized verdict (including the never-emitted "ok") is not healthy', async () => {
    const res = await browseCatalog(
      ctxServing({ status: 'ok', provider_uuid: 'prov-1', checks: {} }),
    );
    expect(res.providers[0]).toMatchObject({
      healthy: false,
      health_status: 'ok',
    });
  });

  // Fred marshals `checks` from a Go map, and encoding/json SORTS map keys — verified
  // by running the real struct through json.Marshal, which emits
  //   backend:docker-1..5, chain, payload_store, placement_store
  // JSON.parse preserves that order, so a naive head-of-list cap keeps only the
  // repetitive `backend:*` entries and drops every distinct one — including
  // payload_store, the single check this whole feature exists to surface.
  it('a wide failing backend fleet does not crowd out the distinct checks', async () => {
    const checks: Record<string, { status: string; message: string }> = {};
    for (let i = 1; i <= 6; i++) {
      checks[`backend:docker-${i}`] = {
        status: 'unhealthy',
        message: 'backend health check failed',
      };
    }
    checks.chain = {
      status: 'unhealthy',
      message: 'chain connectivity failed',
    };
    checks.payload_store = {
      status: 'unhealthy',
      message: 'payload store unavailable',
    };
    checks.placement_store = {
      status: 'unhealthy',
      message: 'placement store unavailable',
    };
    // Serialize + reparse so the test sees the SAME key order a provider sends,
    // rather than the order this object literal happens to have.
    const wire = JSON.parse(
      JSON.stringify({
        status: 'unhealthy',
        provider_uuid: 'prov-1',
        checks: Object.fromEntries(
          Object.entries(checks).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      }),
    );

    const p = (await browseCatalog(ctxServing(wire))).providers[0]!;
    expect(p.healthy).toBe(false);
    // The three distinct checks must all survive the cap...
    expect(p.healthError).toContain('payload_store');
    expect(p.healthError).toContain('chain');
    expect(p.healthError).toContain('placement_store');
    // ...and the count of what was elided must still be reported.
    expect(p.healthError).toMatch(/\d+ more/);
  });

  // ENG-555 / ENG-669. `checks` names and messages are provider-controlled and arrive
  // bounded only by the 10 MiB transport cap. Before this summary existed, browse_catalog's
  // `healthError` came from `err.message`, which the ProviderApiError CONSTRUCTOR caps and
  // which ENG-669 called out by name — a success response, so no error sink would catch it.
  // Building the string from `checks` directly bypasses that cap entirely, and this runs for
  // EVERY provider in the catalog.
  it('caps and sanitizes provider-controlled check text before it reaches model context', async () => {
    // Escapes, never literal glyphs: a raw bidi/control char does not survive the
    // edit pipeline into a fixture.
    const bidi = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
    const nul = String.fromCharCode(0x00); // NUL
    const p = (
      await browseCatalog(
        ctxServing({
          status: `degraded${bidi}`,
          provider_uuid: 'prov-1',
          checks: {
            chain: {
              status: 'unhealthy',
              message: `${bidi}spoofed${nul} ${'A'.repeat(100_000)}`,
            },
            [`backend:${'B'.repeat(50_000)}`]: {
              status: 'unhealthy',
              message: 'short',
            },
          },
        }),
      )
    ).providers[0]!;

    const err = p.healthError ?? '';
    // Bounded: one provider's contribution cannot be megabytes, and browse_catalog
    // repeats this for every provider in the catalog.
    expect(err.length).toBeLessThan(2_000);
    // Sanitized: no bidi override, no NUL.
    expect(err).not.toContain(bidi);
    expect(err).not.toContain(nul);
    // The verdict is provider-controlled too and is interpolated into the same string.
    expect(p.health_status).toBeDefined();
    // Still useful after capping — the failing check is still named.
    expect(err).toContain('chain');
  });

  it('a non-2xx still lands in the catch and keeps its HTTP error string', async () => {
    const ctx: FredReadCtx = {
      ...ctxServing({}),
      fetch: vi.fn<typeof globalThis.fetch>(
        async () => new Response('nope', { status: 500 }),
      ),
    };
    const p = (await browseCatalog(ctx)).providers[0]!;
    expect(p.healthy).toBe(false);
    expect(p.healthError).toContain('HTTP 500');
  });
});
