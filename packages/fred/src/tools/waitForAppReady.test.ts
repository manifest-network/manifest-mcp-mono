// This file mocks NOTHING (ENG-725). The wire is injected at `ctx.fetch` as a sealed probe, so the
// real `resolveProviderUrl`, `validateProviderUrl`, readiness poll and transport all run.
//
// The two option-forwarding claims used to read `pollOpts` off a recorded call. They now assert
// what those options DO — how many `/status` reads happen, and whether `onProgress` fires — which
// is both stronger and immune to the poll's signature changing.
import {
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { waitForAppReady } from './waitForAppReady.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';

const READY = {
  state: 'LEASE_STATE_ACTIVE',
  provision_status: 'ready',
};
const PENDING = { state: 'LEASE_STATE_PENDING' };

const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

let wire: ReturnType<typeof sealedFetchProbe>;

function routeStatus(script: unknown = READY): void {
  wire = sealedFetchProbe({
    '/status': (Array.isArray(script)
      ? script.map((s) => ({ json: s }))
      : { json: script }) as never,
  });
}

function makeCtx(qc: ReturnType<typeof makeMockQueryClient>): FredAuthCtx {
  return {
    query: qc as never,
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

function makeActiveQc(state = LeaseState.LEASE_STATE_ACTIVE) {
  return makeMockQueryClient({
    billing: { lease: { uuid: LEASE_UUID, state, providerUuid: 'prov-1' } },
    sku: {
      providerLookup: { 'prov-1': { provider: { apiUrl: PROVIDER_URL } } },
    },
  });
}

describe('waitForAppReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('auth-token');
    routeStatus();
  });

  it('returns identifiers + ACTIVE state when the poll resolves', async () => {
    const result = await waitForAppReady(makeCtx(makeActiveQc()), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.provider_uuid).toBe('prov-1');
    expect(result.provider_url).toBe(PROVIDER_URL);
    expect(result.state).toBe('LEASE_STATE_ACTIVE');
    expect(result.status.provision_status).toBe('ready');

    // Resolved the provider from chain, then read status once from THAT provider.
    expect(wire.calls).toHaveLength(1);
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/status`,
    );
  });

  it('forwards intervalMs/onProgress to the poller — observed, not inspected', async () => {
    // Was: read `pollOpts` off the recorded call and `toMatchObject` it. Now the options are
    // proven to take effect — three reads happen and `onProgress` fires for each.
    const onProgress = vi.fn();
    routeStatus([PENDING, PENDING, READY]);

    await waitForAppReady(
      makeCtx(makeActiveQc()),
      { address: 'manifest1abc', leaseUuid: LEASE_UUID },
      { intervalMs: 0, timeoutMs: 60_000, onProgress },
    );

    expect(wire.calls).toHaveLength(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ provision_status: 'ready' }),
    );
  });

  it('forwards abortSignal to the poller', async () => {
    const ac = new AbortController();
    routeStatus([PENDING, READY]);

    const pending = waitForAppReady(
      makeCtx(makeActiveQc()),
      { address: 'manifest1abc', leaseUuid: LEASE_UUID },
      {
        intervalMs: 10_000,
        onProgress: () => ac.abort(),
        abortSignal: ac.signal,
      },
    );

    // Without the signal reaching the poll, this would sit on a 10s sleep instead of rejecting.
    await expect(pending).rejects.toThrow();
    expect(wire.calls).toHaveLength(1);
  });

  it('rejects when the lease is not active/pending on chain', async () => {
    await expect(
      waitForAppReady(makeCtx(makeActiveQc(LeaseState.LEASE_STATE_CLOSED)), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
    expect(wire.calls).toHaveLength(0);
  });

  it('propagates lease-not-found errors from chain', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const providerFn = qc.liftedinit.sku.v1.provider;

    await expect(
      waitForAppReady(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toBeInstanceOf(ManifestMCPError);

    expect(providerFn).not.toHaveBeenCalled();
    expect(wire.calls).toHaveLength(0);
  });
});
