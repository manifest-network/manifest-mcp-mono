// Does the SSRF-guarded fetch actually REACH the wire? (ENG-725)
//
// `server.test.ts`'s "SSRF guard wiring" matrix answers a weaker question. It mocks every tool
// module, so it can only assert that the ctx handed to a tool CARRIES a guarded fetch — not that
// anything threads it down to a socket. The only place the stronger property was ever pinned is
// `app_diagnostics` / `app_releases`, and only by accident: those two call the transport directly
// from `register-tools.ts`, so the fetch is visible on an argument list.
//
// This file pins it for a REAL tool path with NOTHING mocked between the composition root and
// `doFetch`: real `getAppLogs`, real `fetchActiveLease`, real `resolveProviderUrl`, real
// `validateProviderUrl`, real `getLeaseLogs`, real `fetchJsonChecked`, real `checkedFetch`.
//
// WHY IT NEEDS A TEST AT ALL, rather than a type. `resolveGuardedFetch` returns `undefined` in two
// of its four branches BY DESIGN (guard off; non-Node runtime), and `fetchJsonChecked` falls back
// to `globalThis.fetch` when `fetchFn` is undefined — a fallback that is deliberately preserved.
// `hasCustomFetch` recognizes both a nullish fallback and core's provenance-tagged client default as
// unguarded, while an explicitly injected function is a deliberate opt-out. So
// no signature, required field or wrapper type can express "the guarded fetch got there". Only a
// runtime assertion can, and this is it.

import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { callTool } from '@manifest-network/manifest-mcp-core/__test-utils__/callTool.js';
import {
  fetchProbe,
  sealedFetchProbe,
} from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FredMCPServer } from './index.js';

// `vi.mock` factories are hoisted above every top-level binding in this file, and the core-barrel
// factory below runs while the barrel is first imported — before a plain `const` here would be
// initialized. `vi.hoisted` is the sanctioned way to share a value with a factory.
const { LEASE_UUID, PROVIDER_URL } = vi.hoisted(() => ({
  LEASE_UUID: '550e8400-e29b-41d4-a716-446655440000',
  PROVIDER_URL: 'https://provider.example.com',
}));

/**
 * The probe standing in for the real guarded fetch. Rebuilt per test — `calls` is a plain array
 * that `vi.clearAllMocks()` would not reset, and a shared probe would leak its log into the next
 * case.
 */
let guarded = sealedFetchProbe();

/**
 * What `createGuardedFetch()` returns for this file: a STABLE function that forwards to whichever
 * probe the current test built. Stable so the mock factory can close over it, forwarding so each
 * test still gets a fresh log.
 *
 * Standing in for the real guarded fetch is what lets these assert IDENTITY end-to-end: whatever
 * reaches `doFetch` must be the value the composition root got from `createGuardedFetch`, not
 * `globalThis.fetch` and not some other function that merely happens to be callable.
 */
const guardedFetch = ((input: unknown, init?: RequestInit) =>
  guarded.fetch(
    input as Parameters<typeof globalThis.fetch>[0],
    init,
  )) as typeof globalThis.fetch;

vi.mock('@manifest-network/manifest-mcp-core/guarded-fetch', () => ({
  createGuardedFetch: vi.fn(() => guardedFetch),
}));

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue({
        disconnect: vi.fn(),
        // Built LAZILY: the factory body runs during the barrel's first import, when this file's
        // imports (`makeMockQueryClient`, `LeaseState`) are not yet initialized.
        getQueryClient: vi.fn(async () =>
          makeMockQueryClient({
            billing: {
              lease: {
                uuid: LEASE_UUID,
                providerUuid: 'prov-1',
                state: LeaseState.LEASE_STATE_ACTIVE,
                items: [],
                createdAt: new Date(0),
              },
            },
            sku: {
              providerLookup: {
                'prov-1': { provider: { apiUrl: PROVIDER_URL } },
              },
            },
          }),
        ),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({ chainId: 'test-chain' }),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

const ORIG_GUARD_ENV = process.env.MANIFEST_FRED_FETCH_GUARDED;

function makeServer(): FredMCPServer {
  return new FredMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet({ signArbitrary: true }),
  });
}

beforeEach(() => {
  guarded = sealedFetchProbe({ '/logs': { json: { logs: { web: 'hello' } } } });
});

afterEach(() => {
  if (ORIG_GUARD_ENV === undefined) {
    delete process.env.MANIFEST_FRED_FETCH_GUARDED;
  } else {
    process.env.MANIFEST_FRED_FETCH_GUARDED = ORIG_GUARD_ENV;
  }
  vi.unstubAllGlobals();
});

describe('the guarded fetch reaches the wire (ENG-725)', () => {
  it('by default, a real tool path dispatches through createGuardedFetch()s value', async () => {
    delete process.env.MANIFEST_FRED_FETCH_GUARDED;
    const server = makeServer();

    await callTool(server.getServer(), 'get_logs', { lease_uuid: LEASE_UUID });

    // The probe IS the guarded fetch. It recording the request is the proof that the value the
    // composition root built travelled ctx -> tool -> transport -> doFetch intact. If any layer
    // dropped it, `fetchJsonChecked` would fall back to `globalThis.fetch`, which
    // `tools/vitest/ban-global-fetch.ts` replaces with a throwing stub — so the failure is loud
    // either way, but this assertion names WHICH property broke.
    expect(guarded.calls).toHaveLength(1);
    expect(guarded.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/logs`,
    );
  });

  it('carries the ADR-036 bearer token on that same dispatch', async () => {
    // Cheap to assert here and nowhere else: this is the only test in the repo where the token
    // mint, the ctx thread and the wire dispatch are all real at once.
    delete process.env.MANIFEST_FRED_FETCH_GUARDED;
    const server = makeServer();

    await callTool(server.getServer(), 'get_logs', { lease_uuid: LEASE_UUID });

    const headers = guarded.calls[0]?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toMatch(/^Bearer .+/);
  });

  it('with the guard OFF, the SAME path falls back to globalThis.fetch', async () => {
    // The inverse control. Without it, a test that asserted "some function reached doFetch" would
    // pass just as happily on the unguarded path, and the assertion above would prove nothing
    // about the guard being ON.
    process.env.MANIFEST_FRED_FETCH_GUARDED = '0';
    const fallback = fetchProbe({ json: { logs: {} } });
    vi.stubGlobal('fetch', fallback.fetch);
    const server = makeServer();

    await callTool(server.getServer(), 'get_logs', { lease_uuid: LEASE_UUID });

    expect(fallback.calls).toHaveLength(1);
    expect(guarded.calls).toHaveLength(0);
  });
});
