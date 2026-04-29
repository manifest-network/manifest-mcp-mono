import { describe, expect, it, vi } from 'vitest';
import { routeFeegrantQuery } from './feegrant.js';

function makeMockFeegrantClient() {
  return {
    cosmos: {
      feegrant: {
        v1beta1: {
          allowance: vi.fn().mockResolvedValue({ allowance: undefined }),
          allowances: vi
            .fn()
            .mockResolvedValue({ allowances: [], pagination: undefined }),
          allowancesByGranter: vi
            .fn()
            .mockResolvedValue({ allowances: [], pagination: undefined }),
        },
      },
    },
  } as any;
}

describe('routeFeegrantQuery', () => {
  it('routes allowance', async () => {
    const qc = makeMockFeegrantClient();
    await routeFeegrantQuery(qc, 'allowance', [
      'manifest1granter',
      'manifest1grantee',
    ]);
    expect(qc.cosmos.feegrant.v1beta1.allowance).toHaveBeenCalledWith({
      granter: 'manifest1granter',
      grantee: 'manifest1grantee',
    });
  });

  it('routes allowances', async () => {
    const qc = makeMockFeegrantClient();
    await routeFeegrantQuery(qc, 'allowances', ['manifest1grantee']);
    expect(qc.cosmos.feegrant.v1beta1.allowances).toHaveBeenCalledWith(
      expect.objectContaining({ grantee: 'manifest1grantee' }),
    );
  });

  it('routes allowances-by-granter', async () => {
    const qc = makeMockFeegrantClient();
    await routeFeegrantQuery(qc, 'allowances-by-granter', ['manifest1granter']);
    expect(qc.cosmos.feegrant.v1beta1.allowancesByGranter).toHaveBeenCalledWith(
      expect.objectContaining({ granter: 'manifest1granter' }),
    );
  });

  it('throws when allowance is missing addresses', async () => {
    const qc = makeMockFeegrantClient();
    await expect(routeFeegrantQuery(qc, 'allowance', [])).rejects.toThrow();
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockFeegrantClient();
    await expect(routeFeegrantQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
