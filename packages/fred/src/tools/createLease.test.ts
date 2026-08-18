import { describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  const sealed = (name: string) =>
    vi.fn(() => {
      throw new Error(
        `core.${name}() is sealed in this test file (ENG-713). Nothing here called it when the ` +
          'seal was written; if the code under test needs it now, replace the seal with an ' +
          'explicit spy and assert on it. Do NOT simply drop it.',
      );
    });
  return {
    ...actual,
    cosmosTx: vi.fn(),
    // Same shape as `restoreApp.test.ts` (ENG-713): core's tx helpers call `cosmosTx` through
    // their own module-local `'../cosmos.js'` import and `executeTx` broadcasts straight off
    // `ctx.chain`, so the `cosmosTx` spy above cannot see either. The sealed `ctx.chain` below
    // is the containment; these stubs only name the helper in the first line of the failure.
    setItemCustomDomain: sealed('setItemCustomDomain'),
    stopApp: sealed('stopApp'),
    fundCredits: sealed('fundCredits'),
    executeTx: sealed('executeTx'),
    cosmosEstimateFee: sealed('cosmosEstimateFee'),
  };
});

import { cosmosTx } from '@manifest-network/manifest-mcp-core';
import { makeSealedClientManager } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
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
      extractLeaseUuid({
        events: [{ type: 'other', attributes: [] }],
      } as never),
    ).toThrow(/lease UUID/i);
  });
});

describe('createLease', () => {
  it('broadcasts billing create-lease with --meta-hash + items and returns the uuid', async () => {
    mockCosmosTx.mockResolvedValue(txResult as never);
    // Sealed rather than `{}`: every core broadcast passes through this seam, so an escape
    // fails by name instead of as an unclassified TypeError (ENG-713).
    const ctx = { chain: makeSealedClientManager() as never };

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
