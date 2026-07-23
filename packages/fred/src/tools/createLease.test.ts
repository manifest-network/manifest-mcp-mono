import { describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@manifest-network/manifest-mcp-core')>();
  return { ...actual, cosmosTx: vi.fn() };
});

import { cosmosTx } from '@manifest-network/manifest-mcp-core';
import { createLease, extractLeaseUuid } from './createLease.js';

const mockCosmosTx = vi.mocked(cosmosTx);

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const txResult = {
  events: [
    { type: 'lease_created', attributes: [{ key: 'lease_uuid', value: UUID }] },
  ],
};

describe('extractLeaseUuid', () => {
  it('pulls the branded uuid from lease events', () => {
    expect(extractLeaseUuid(txResult as never)).toBe(UUID);
  });

  it('throws TX_FAILED when no lease uuid is present', () => {
    expect(() =>
      extractLeaseUuid({ events: [{ type: 'other', attributes: [] }] } as never),
    ).toThrow(/lease UUID/i);
  });
});

describe('createLease', () => {
  it('broadcasts billing create-lease with --meta-hash + items and returns the uuid', async () => {
    mockCosmosTx.mockResolvedValue(txResult as never);
    const ctx = { chain: {} as never };

    const res = await createLease(ctx, {
      metaHashHex: 'ab',
      leaseItems: ['s1:1', 's2:2:web'],
    });

    expect(res).toBe(UUID);
    expect(mockCosmosTx).toHaveBeenCalledWith(
      ctx.chain,
      'billing',
      'create-lease',
      ['--meta-hash', 'ab', 's1:1', 's2:2:web'],
      true,
      undefined,
    );
  });
});
