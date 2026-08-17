import { noopLogger } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/provider.js', () => ({
  getLeaseConnectionInfo: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { getLeaseConnectionInfo as getLeaseConnectionInfoTransport } from '../http/provider.js';
import { getLeaseConnectionInfo } from './getLeaseConnectionInfo.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const mockTransport = vi.mocked(getLeaseConnectionInfoTransport);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
// Threaded and asserted, never invoked — see appStatus.test.ts for why this is spelled
// with an explicit throw rather than `vi.fn(globalThis.fetch)` (ENG-715).
const fetchSpy = vi.fn<typeof globalThis.fetch>(() => {
  throw new Error(
    'this fetch spy is threaded and asserted, never invoked — a call here means a mock ' +
      'did not intercept provider HTTP (ENG-705/ENG-715)',
  );
});
const mockGetAuthToken = vi.fn().mockResolvedValue('conn-token');

function makeCtx(qc: ReturnType<typeof makeMockQueryClient>) {
  return {
    query: qc,
    chain: {} as never,
    fetch: fetchSpy,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        mockGetAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

const GOLDEN = {
  lease_uuid: LEASE_UUID,
  tenant: 'manifest1abc',
  provider_uuid: 'prov-1',
  connection: {
    host: 'app.example.com',
    ports: { '80/tcp': 8080 },
  },
};

describe('getLeaseConnectionInfo (capability)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockTransport.mockResolvedValue(GOLDEN);
  });

  it('resolves the provider URL, mints a token, and returns the connection info', async () => {
    const qc = makeMockQueryClient({});
    const result = await getLeaseConnectionInfo(makeCtx(qc), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
      providerUuid: 'prov-1',
    });

    expect(result).toEqual(GOLDEN);
    expect(mockResolveProviderUrl).toHaveBeenCalledWith(
      expect.objectContaining({ query: qc }),
      'prov-1',
    );
    expect(mockGetAuthToken).toHaveBeenCalledWith('manifest1abc', LEASE_UUID);
    // Threads the resolved URL, minted token, and ctx.fetch into the transport. Read off
    // the recorded call rather than pinning the whole argument list: toHaveBeenCalledWith
    // is exact-arity, so the incidental trailing allowLoopback slot would make an appended
    // parameter break a claim that was only ever about the first four (ENG-706).
    const [url, leaseUuid, token, fetchFn] = mockTransport.mock.calls[0]!;
    expect({ url, leaseUuid, token, fetchFn }).toEqual({
      url: 'https://provider.example.com',
      leaseUuid: LEASE_UUID,
      token: 'conn-token',
      fetchFn: fetchSpy,
    });
  });
});
