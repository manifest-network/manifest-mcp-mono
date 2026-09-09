import { cosmos } from '@manifest-network/manifestjs/dist/codegen/cosmos/bundle.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestQueryClient } from '../client.js';
import { ManifestMCPErrorCode } from '../types.js';
import { routeGovQuery } from './gov.js';
import { routeStakingQuery } from './staking.js';
import { parseInteger } from './utils.js';

const proposal = vi.fn().mockResolvedValue({ proposal: undefined });
const proposals = vi.fn().mockResolvedValue({ proposals: [] });
const historicalInfo = vi.fn().mockResolvedValue({ hist: undefined });
const query = {
  cosmos: {
    gov: { v1: { proposal, proposals } },
    staking: { v1beta1: { historicalInfo } },
  },
} as unknown as ManifestQueryClient;
beforeEach(() => vi.clearAllMocks());

describe('query integer wire boundaries', () => {
  it.each(['-1', '18446744073709551616', '0x10', '1.5', '1e3', ' 1'])(
    'rejects proposal ID %s without making a query',
    async (value) => {
      await expect(
        routeGovQuery(query, 'proposal', [value]),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
      expect(proposal).not.toHaveBeenCalled();
    },
  );

  it('preserves a maximum uint64 proposal ID through the actual request codec', async () => {
    await routeGovQuery(query, 'proposal', ['18446744073709551615']);
    const codec = cosmos.gov.v1.QueryProposalRequest;
    const encoded = codec.encode(proposal.mock.calls[0][0]).finish();
    expect(codec.decode(encoded).proposalId).toBe(18_446_744_073_709_551_615n);
  });

  it.each(['-9223372036854775809', '9223372036854775808', '0x10'])(
    'rejects int64 height overflow or nondecimal spelling %s',
    async (value) => {
      await expect(
        routeStakingQuery(query, 'historical-info', [value]),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
      expect(historicalInfo).not.toHaveBeenCalled();
    },
  );

  it.each(['1.5', '1e3', '1abc', '9007199254740993'])(
    'does not truncate or round number-shaped input %s',
    (value) => {
      expect(() => parseInteger(value, 'status')).toThrow();
    },
  );
});

it.each(['4294967297', '4294967298', '-4294967295', '6', '-1'])(
  'rejects invalid or wrapping proposal filter %s before querying',
  async (status) => {
    await expect(
      routeGovQuery(query, 'proposals', [status]),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
    expect(proposals).not.toHaveBeenCalled();
  },
);

it.each([0, 1, 2, 3, 4, 5])(
  'preserves supported proposal status %s through the actual codec',
  async (status) => {
    await routeGovQuery(query, 'proposals', [String(status)]);
    const codec = cosmos.gov.v1.QueryProposalsRequest;
    const encoded = codec.encode(proposals.mock.calls[0][0]).finish();
    expect(codec.decode(encoded).proposalStatus).toBe(status);
  },
);
