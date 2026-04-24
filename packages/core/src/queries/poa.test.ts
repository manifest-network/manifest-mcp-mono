import { describe, expect, it, vi } from 'vitest';
import { routePoAQuery } from './poa.js';

function makeMockPoAClient() {
  return {
    strangelove_ventures: {
      poa: {
        v1: {
          poaAuthority: vi
            .fn()
            .mockResolvedValue({ authority: 'manifest1authority' }),
          consensusPower: vi
            .fn()
            .mockResolvedValue({ consensusPower: BigInt(1000) }),
          pendingValidators: vi.fn().mockResolvedValue({ pending: [] }),
        },
      },
    },
  } as any;
}

describe('routePoAQuery', () => {
  it('routes authority subcommand', async () => {
    const qc = makeMockPoAClient();
    const result = await routePoAQuery(qc, 'authority', []);
    expect(result).toEqual({ authority: 'manifest1authority' });
    expect(qc.strangelove_ventures.poa.v1.poaAuthority).toHaveBeenCalledWith(
      {},
    );
  });

  it('routes consensus-power subcommand', async () => {
    const qc = makeMockPoAClient();
    const result = await routePoAQuery(qc, 'consensus-power', [
      'manifestvaloper1abc',
    ]);
    expect(result).toEqual({ consensusPower: BigInt(1000) });
    expect(qc.strangelove_ventures.poa.v1.consensusPower).toHaveBeenCalledWith({
      validatorAddress: 'manifestvaloper1abc',
    });
  });

  it('routes pending-validators subcommand', async () => {
    const qc = makeMockPoAClient();
    const result = await routePoAQuery(qc, 'pending-validators', []);
    expect(result).toEqual({ pending: [] });
  });

  it('throws when consensus-power args are missing', async () => {
    const qc = makeMockPoAClient();
    await expect(routePoAQuery(qc, 'consensus-power', [])).rejects.toThrow(
      'validator-address',
    );
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockPoAClient();
    await expect(routePoAQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
