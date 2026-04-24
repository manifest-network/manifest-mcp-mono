import { describe, expect, it, vi } from 'vitest';
import { routeIbcTransferQuery } from './ibc-transfer.js';

function makeMockIbcTransferClient() {
  return {
    ibc: {
      applications: {
        transfer: {
          v1: {
            params: vi.fn().mockResolvedValue({
              params: { sendEnabled: true, receiveEnabled: true },
            }),
            denomTrace: vi.fn().mockResolvedValue({
              denomTrace: { path: 'transfer/channel-0', baseDenom: 'uatom' },
            }),
            denomTraces: vi.fn().mockResolvedValue({
              denomTraces: [],
              pagination: undefined,
            }),
          },
        },
      },
    },
  } as any;
}

describe('routeIbcTransferQuery', () => {
  it('routes params subcommand', async () => {
    const qc = makeMockIbcTransferClient();
    const result = await routeIbcTransferQuery(qc, 'params', []);
    expect(result).toHaveProperty('params');
  });

  it('routes denom-trace subcommand', async () => {
    const qc = makeMockIbcTransferClient();
    const result = await routeIbcTransferQuery(qc, 'denom-trace', [
      'ABC123DEF',
    ]);
    expect(result).toEqual({
      denomTrace: { path: 'transfer/channel-0', baseDenom: 'uatom' },
    });
    expect(qc.ibc.applications.transfer.v1.denomTrace).toHaveBeenCalledWith({
      hash: 'ABC123DEF',
    });
  });

  it('routes denom-traces subcommand with pagination', async () => {
    const qc = makeMockIbcTransferClient();
    const result = await routeIbcTransferQuery(qc, 'denom-traces', []);
    expect(result).toHaveProperty('denomTraces');
  });

  it('throws when denom-trace hash is missing', async () => {
    const qc = makeMockIbcTransferClient();
    await expect(routeIbcTransferQuery(qc, 'denom-trace', [])).rejects.toThrow(
      'hash',
    );
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockIbcTransferClient();
    await expect(
      routeIbcTransferQuery(qc, 'nonexistent', []),
    ).rejects.toThrow();
  });
});
