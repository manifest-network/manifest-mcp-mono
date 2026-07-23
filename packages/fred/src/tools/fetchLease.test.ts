import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import { fetchLease } from './fetchLease.js';

function ctxWith(lease: unknown) {
  return {
    query: {
      liftedinit: { billing: { v1: { lease: vi.fn().mockResolvedValue({ lease }) } } },
    },
  } as unknown as Parameters<typeof fetchLease>[0];
}

describe('fetchLease', () => {
  it('returns the lease regardless of state (e.g. CLOSED)', async () => {
    const lease = { uuid: 'u1', state: 4 /* CLOSED */, providerUuid: 'p1', items: [] };
    expect(await fetchLease(ctxWith(lease), 'u1')).toBe(lease);
  });

  it('throws QUERY_FAILED when the lease is absent', async () => {
    await expect(fetchLease(ctxWith(null), 'u1')).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });
});
