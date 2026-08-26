// This file mocks NOTHING (ENG-725).
//
// It used to `vi.mock('../http/fred.js')` for the transport and `vi.mock('./resolveLeaseProvider.js')`
// for the provider lookup. Both are gone: the wire is injected at `ctx.fetch`, so the REAL
// `resolveProviderUrl`, `validateProviderUrl`, `getLeaseLogs`, `fetchJsonChecked` and `checkedFetch`
// run on every case — and the `tail` claim is now made against the URL that actually went out
// rather than against an argument slot.
//
// The probe is default-deny: an unrouted request fails BY NAME instead of being re-wrapped as a
// plausible `ProviderApiError{kind:'network'}` that a test could go green on.
import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { getAppLogs } from './getLogs.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';

const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

let wire: ReturnType<typeof sealedFetchProbe>;

/** A lease in `state`, at a provider reachable at PROVIDER_URL. */
function makeCtx(state = LeaseState.LEASE_STATE_ACTIVE): FredAuthCtx {
  return {
    query: makeMockQueryClient({
      billing: { lease: { uuid: LEASE_UUID, state, providerUuid: 'prov-1' } },
      sku: {
        providerLookup: { 'prov-1': { provider: { apiUrl: PROVIDER_URL } } },
      },
    }) as never,
    chain: {} as never,
    fetch: wire.fetch,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        mockGetAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

/** Script `/logs` with a body; one probe per test (`calls` survives `vi.clearAllMocks`). */
function routeLogs(logs: unknown): void {
  wire = sealedFetchProbe({
    '/logs': {
      json: {
        lease_uuid: LEASE_UUID,
        tenant: 'manifest1abc',
        provider_uuid: 'prov-1',
        logs,
      },
    },
  });
}

describe('getAppLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('auth-token');
    routeLogs({});
  });

  it('returns logs from provider', async () => {
    routeLogs({ web: 'line1\nline2' });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.logs).toEqual({ web: 'line1\nline2' });
    expect(result.truncated).toBe(false);
  });

  it('truncates logs exceeding MAX_LOG_CHARS', async () => {
    routeLogs({ web: 'x'.repeat(5000) });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.truncated).toBe(true);
    // The provider-controlled service name consumes the same 4,000-character budget.
    expect(result.logs.web.length).toBe(4000 - 'web'.length);
  });

  it('fairly truncates a large service without hiding a useful later sibling', async () => {
    routeLogs({ web: 'x'.repeat(4000), worker: 'should be skipped' });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.truncated).toBe(true);
    expect(result.logs.web).toBeDefined();
    expect(result.logs.worker).toBe('should be skipped');
  });

  it('drops non-string entries at the transport seam before they can poison the budget', async () => {
    routeLogs({ broken: 1, web: 'ready' });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.logs.broken).toBeUndefined();
    expect(result.logs.web).toBe('ready');
    expect(result.truncated).toBe(true);
    expect(
      Object.entries(result.logs).reduce(
        (sum, [service, log]) => sum + service.length + log.length,
        0,
      ),
    ).toBeLessThanOrEqual(4000);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ])(
    'normalizes a %s logs map to a clean empty result',
    async (_label, logs) => {
      routeLogs(logs);

      const result = await getAppLogs(makeCtx(), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      });

      expect(result.logs).toEqual({});
      expect(result.truncated).toBe(false);
    },
  );

  it.each([
    ['a string', 'boom'],
    ['an array', ['boom']],
  ])(
    'flags %s logs map as truncated instead of silently empty',
    async (_label, logs) => {
      routeLogs(logs);

      const result = await getAppLogs(makeCtx(), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      });

      expect(result.logs).toEqual({});
      expect(result.truncated).toBe(true);
    },
  );

  it('redistributes unused shares while retaining every service diagnostic', async () => {
    routeLogs({
      web: 'x'.repeat(10_000),
      db: 'connection refused',
      worker: 'OOMKilled',
    });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.logs.db).toBe('connection refused');
    expect(result.logs.worker).toBe('OOMKilled');
    expect(result.logs.web?.length).toBeGreaterThan(3_900);
    expect(result.truncated).toBe(true);
    expect(
      Object.entries(result.logs).reduce(
        (sum, [service, log]) => sum + service.length + log.length,
        0,
      ),
    ).toBeLessThanOrEqual(4000);
  });

  it('counts service-name keys and skips an over-budget key without hiding later logs', async () => {
    const hugeService = 's'.repeat(4001);
    routeLogs({ [hugeService]: '', web: 'ready' });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.logs[hugeService]).toBeUndefined();
    expect(result.logs.web).toBe('ready');
    expect(result.truncated).toBe(true);
  });

  it('keeps the hard cap when a service key consumes its entire allocation', async () => {
    const service = 's'.repeat(4000);
    routeLogs({ [service]: 'x' });

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.logs[service]).toBe('');
    expect(result.truncated).toBe(true);
    expect(service.length + (result.logs[service]?.length ?? 0)).toBe(4000);
  });

  it('treats __proto__ as a service name without invoking the legacy prototype setter', async () => {
    routeLogs(
      Object.fromEntries([
        ['__proto__', 'safe'],
        ['web', 'ready'],
      ]),
    );

    const result = await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(
      Object.getOwnPropertyDescriptor(result.logs, '__proto__')?.value,
    ).toBe('safe');
    expect(result.logs.web).toBe('ready');
    expect(result.truncated).toBe(false);
  });

  it('throws when lease is not active', async () => {
    await expect(
      getAppLogs(makeCtx(LeaseState.LEASE_STATE_CLOSED), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toThrow('logs are not available');

    // And it fails BEFORE reaching the provider — the sealed probe is what makes that
    // assertable at all. Previously a stray call would have been absorbed by the mock.
    expect(wire.calls).toHaveLength(0);
  });

  it('passes tail through to the provider as a query parameter', async () => {
    await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
      tail: 50,
    });

    // The claim used to be "tail reaches slot 3 of the transport". It is now the stronger and
    // more durable one: `tail` reached the WIRE, in the shape the provider actually receives.
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/logs?tail=50`,
    );
    const headers = wire.calls[0]?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe('Bearer auth-token');
  });

  it('caps tail at MAX_TAIL', async () => {
    // Only observable on the wire, so this case did not exist before.
    await getAppLogs(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
      tail: 999_999,
    });

    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/logs?tail=1000`,
    );
  });
});
