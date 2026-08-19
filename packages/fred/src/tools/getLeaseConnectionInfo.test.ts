// This file mocks NOTHING (ENG-725).
//
// It used to `vi.mock('../http/provider.js')` to replace the transport, and
// `vi.mock('./resolveLeaseProvider.js')` to skip the provider lookup. Both are gone: the wire is
// injected at `ctx.fetch` instead, so the REAL `resolveProviderUrl`, `validateProviderUrl`,
// `getLeaseConnectionInfo`, `fetchJsonChecked` and `checkedFetch` all run on every assertion —
// including the ENG-490 SSRF string check, which the old `resolveLeaseProvider` mock stubbed away.
//
// The probe is default-deny: a request to an endpoint this file did not route fails BY NAME rather
// than being re-wrapped as a plausible `ProviderApiError{kind:'network'}` that an assertion could
// go green on.
import { noopLogger } from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { getLeaseConnectionInfo } from './getLeaseConnectionInfo.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';

const GOLDEN = {
  lease_uuid: LEASE_UUID,
  tenant: 'manifest1abc',
  provider_uuid: 'prov-1',
  connection: {
    host: 'app.example.com',
    ports: { '80/tcp': 8080 },
  },
};

const mockGetAuthToken = vi.fn().mockResolvedValue('conn-token');

let wire: ReturnType<typeof sealedFetchProbe>;

function makeCtx(): FredAuthCtx {
  return {
    query: makeMockQueryClient({
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

describe('getLeaseConnectionInfo (capability)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('conn-token');
    // One probe per test: `calls` is a plain array `vi.clearAllMocks()` would not reset.
    wire = sealedFetchProbe({ '/connection': { json: GOLDEN } });
  });

  it('resolves the provider URL, mints a token, and returns the connection info', async () => {
    const result = await getLeaseConnectionInfo(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
      providerUuid: 'prov-1',
    });

    expect(result).toEqual(GOLDEN);
    expect(mockGetAuthToken).toHaveBeenCalledWith('manifest1abc', LEASE_UUID);
  });

  it('dispatches to the resolved provider URL carrying the minted token', async () => {
    // The claim the old positional destructure was making, now read off the WIRE instead of an
    // argument list — so it survives any signature change and states the property directly.
    await getLeaseConnectionInfo(makeCtx(), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
      providerUuid: 'prov-1',
    });

    expect(wire.calls).toHaveLength(1);
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/connection`,
    );
    const headers = wire.calls[0]?.init.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe('Bearer conn-token');
  });

  it('propagates a provider error rather than degrading', async () => {
    wire = sealedFetchProbe({
      '/connection': { status: 502, text: 'upstream exploded' },
    });

    await expect(
      getLeaseConnectionInfo(makeCtx(), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        providerUuid: 'prov-1',
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
