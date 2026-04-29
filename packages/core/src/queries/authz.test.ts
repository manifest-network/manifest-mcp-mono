import { describe, expect, it, vi } from 'vitest';
import { routeAuthzQuery } from './authz.js';

function makeMockAuthzClient() {
  return {
    cosmos: {
      authz: {
        v1beta1: {
          grants: vi
            .fn()
            .mockResolvedValue({ grants: [], pagination: undefined }),
          granterGrants: vi
            .fn()
            .mockResolvedValue({ grants: [], pagination: undefined }),
          granteeGrants: vi
            .fn()
            .mockResolvedValue({ grants: [], pagination: undefined }),
        },
      },
    },
  } as any;
}

describe('routeAuthzQuery', () => {
  it('routes grants with default empty msg-type-url', async () => {
    const qc = makeMockAuthzClient();
    const result = await routeAuthzQuery(qc, 'grants', [
      'manifest1granter',
      'manifest1grantee',
    ]);
    expect(result).toEqual({ grants: [], pagination: undefined });
    expect(qc.cosmos.authz.v1beta1.grants).toHaveBeenCalledWith(
      expect.objectContaining({
        granter: 'manifest1granter',
        grantee: 'manifest1grantee',
        msgTypeUrl: '',
      }),
    );
  });

  it('routes grants with --msg-type-url flag', async () => {
    const qc = makeMockAuthzClient();
    await routeAuthzQuery(qc, 'grants', [
      '--msg-type-url',
      '/cosmos.bank.v1beta1.MsgSend',
      'manifest1granter',
      'manifest1grantee',
    ]);
    expect(qc.cosmos.authz.v1beta1.grants).toHaveBeenCalledWith(
      expect.objectContaining({
        msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
      }),
    );
  });

  it('routes granter-grants', async () => {
    const qc = makeMockAuthzClient();
    await routeAuthzQuery(qc, 'granter-grants', ['manifest1granter']);
    expect(qc.cosmos.authz.v1beta1.granterGrants).toHaveBeenCalledWith(
      expect.objectContaining({ granter: 'manifest1granter' }),
    );
  });

  it('routes grantee-grants', async () => {
    const qc = makeMockAuthzClient();
    await routeAuthzQuery(qc, 'grantee-grants', ['manifest1grantee']);
    expect(qc.cosmos.authz.v1beta1.granteeGrants).toHaveBeenCalledWith(
      expect.objectContaining({ grantee: 'manifest1grantee' }),
    );
  });

  it('throws when grants is missing both addresses', async () => {
    const qc = makeMockAuthzClient();
    await expect(routeAuthzQuery(qc, 'grants', [])).rejects.toThrow();
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockAuthzClient();
    await expect(routeAuthzQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
