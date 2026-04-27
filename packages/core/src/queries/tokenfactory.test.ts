import { describe, expect, it, vi } from 'vitest';
import { routeTokenfactoryQuery } from './tokenfactory.js';

function makeMockTokenfactoryClient() {
  return {
    osmosis: {
      tokenfactory: {
        v1beta1: {
          params: vi.fn().mockResolvedValue({
            params: { denomCreationFee: [] },
          }),
          denomAuthorityMetadata: vi.fn().mockResolvedValue({
            authorityMetadata: { admin: 'manifest1admin' },
          }),
          denomsFromCreator: vi.fn().mockResolvedValue({
            denoms: ['factory/manifest1abc/foo'],
          }),
          denomsFromAdmin: vi.fn().mockResolvedValue({
            denoms: ['factory/manifest1abc/foo'],
          }),
        },
      },
    },
  } as any;
}

describe('routeTokenfactoryQuery', () => {
  it('routes params subcommand', async () => {
    const qc = makeMockTokenfactoryClient();
    const result = await routeTokenfactoryQuery(qc, 'params', []);
    expect(result).toHaveProperty('params');
  });

  it('routes denom-authority-metadata subcommand', async () => {
    const qc = makeMockTokenfactoryClient();
    const result = await routeTokenfactoryQuery(
      qc,
      'denom-authority-metadata',
      ['factory/manifest1abc/foo'],
    );
    expect(result).toEqual({
      authorityMetadata: { admin: 'manifest1admin' },
    });
    expect(
      qc.osmosis.tokenfactory.v1beta1.denomAuthorityMetadata,
    ).toHaveBeenCalledWith({ denom: 'factory/manifest1abc/foo' });
  });

  it('routes denoms-from-creator subcommand', async () => {
    const qc = makeMockTokenfactoryClient();
    const result = await routeTokenfactoryQuery(qc, 'denoms-from-creator', [
      'manifest1abc',
    ]);
    expect(result).toHaveProperty('denoms');
  });

  it('routes denoms-from-admin subcommand', async () => {
    const qc = makeMockTokenfactoryClient();
    const result = await routeTokenfactoryQuery(qc, 'denoms-from-admin', [
      'manifest1abc',
    ]);
    expect(result).toHaveProperty('denoms');
  });

  it('throws when denom-authority-metadata arg is missing', async () => {
    const qc = makeMockTokenfactoryClient();
    await expect(
      routeTokenfactoryQuery(qc, 'denom-authority-metadata', []),
    ).rejects.toThrow('denom');
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockTokenfactoryClient();
    await expect(
      routeTokenfactoryQuery(qc, 'nonexistent', []),
    ).rejects.toThrow();
  });
});
