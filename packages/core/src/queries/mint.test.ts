import { describe, expect, it, vi } from 'vitest';
import { routeMintQuery } from './mint.js';

function makeMockMintClient(overrides: Record<string, unknown> = {}) {
  return {
    cosmos: {
      mint: {
        v1beta1: {
          params: vi.fn().mockResolvedValue({ params: { mintDenom: 'umfx' } }),
          inflation: vi
            .fn()
            .mockResolvedValue({ inflation: '0.130000000000000000' }),
          annualProvisions: vi.fn().mockResolvedValue({
            annualProvisions: '1000000.000000000000000000',
          }),
          ...overrides,
        },
      },
    },
  } as any;
}

describe('routeMintQuery', () => {
  it('routes params', async () => {
    const qc = makeMockMintClient();
    const result = await routeMintQuery(qc, 'params', []);
    expect(result).toEqual({ params: { mintDenom: 'umfx' } });
  });

  it('routes inflation as a string', async () => {
    const qc = makeMockMintClient();
    const result = await routeMintQuery(qc, 'inflation', []);
    expect(result).toEqual({ inflation: '0.130000000000000000' });
  });

  it('decodes inflation when returned as Uint8Array bytes', async () => {
    const bytes = new TextEncoder().encode('0.250000000000000000');
    const qc = makeMockMintClient({
      inflation: vi.fn().mockResolvedValue({ inflation: bytes }),
    });
    const result = await routeMintQuery(qc, 'inflation', []);
    expect(result).toEqual({ inflation: '0.250000000000000000' });
  });

  it('routes annual-provisions', async () => {
    const qc = makeMockMintClient();
    const result = await routeMintQuery(qc, 'annual-provisions', []);
    expect(result).toEqual({
      annualProvisions: '1000000.000000000000000000',
    });
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockMintClient();
    await expect(routeMintQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
