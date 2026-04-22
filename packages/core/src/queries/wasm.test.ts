import { describe, expect, it, vi } from 'vitest';
import { routeWasmQuery } from './wasm.js';

function makeMockWasmClient(overrides?: {
  contractInfo?: { address?: string; contractInfo?: unknown };
}) {
  const contractInfo = overrides?.contractInfo ?? {
    address: 'manifest1contract',
    contractInfo: {
      codeId: 1n,
      creator: 'manifest1creator',
      admin: '',
      label: 'test',
    },
  };

  return {
    cosmwasm: {
      wasm: {
        v1: {
          contractInfo: vi.fn().mockResolvedValue(contractInfo),
        },
      },
    },
  } as never;
}

describe('routeWasmQuery', () => {
  describe('contract-info', () => {
    it('surfaces both address and contractInfo from the response', async () => {
      const qc = makeMockWasmClient();
      const result = await routeWasmQuery(qc, 'contract-info', [
        'manifest1contract',
      ]);
      expect(result).toEqual({
        address: 'manifest1contract',
        contractInfo: expect.objectContaining({
          codeId: 1n,
          creator: 'manifest1creator',
        }),
      });
    });

    it('throws when address arg is missing', async () => {
      const qc = makeMockWasmClient();
      await expect(routeWasmQuery(qc, 'contract-info', [])).rejects.toThrow();
    });
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockWasmClient();
    await expect(routeWasmQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
