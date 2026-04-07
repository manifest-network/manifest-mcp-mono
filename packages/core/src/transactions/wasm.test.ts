import { describe, expect, it, vi } from 'vitest';
import type { TxOptions } from '../types.js';
import { routeWasmTransaction } from './wasm.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';

function makeMockSigningClient() {
  return {
    simulate: vi.fn().mockResolvedValue(150000),
    signAndBroadcast: vi.fn().mockResolvedValue({
      code: 0,
      transactionHash: 'ABCD1234',
      height: 100,
      gasUsed: 50000n,
      gasWanted: 100000n,
    }),
  } as any;
}

describe('routeWasmTransaction', () => {
  it('passes "auto" as fee when no options provided (preserves legacy behavior)', async () => {
    const client = makeMockSigningClient();
    await routeWasmTransaction(
      client,
      SENDER,
      'execute',
      ['manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg', '{"foo":"bar"}'],
      true,
    );

    // simulate is NOT called when fee='auto' from buildGasFee
    expect(client.simulate).not.toHaveBeenCalled();
    const [, , fee] = client.signAndBroadcast.mock.calls[0];
    expect(fee).toBe('auto');
  });

  it('uses computed StdFee when options provided (positive bugfix)', async () => {
    const client = makeMockSigningClient();
    const options: TxOptions = {
      gasMultiplier: 2.0,
      gasPrice: '1.0umfx',
    };

    await routeWasmTransaction(
      client,
      SENDER,
      'execute',
      ['manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg', '{"foo":"bar"}'],
      true,
      options,
    );

    // simulate is called when buildGasFee runs with options
    expect(client.simulate).toHaveBeenCalledOnce();
    const [, , fee] = client.signAndBroadcast.mock.calls[0];
    // Should be a computed StdFee object, not 'auto'
    expect(fee).not.toBe('auto');
    expect(fee).toMatchObject({
      gas: '300000', // 150000 * 2.0
      amount: [{ denom: 'umfx', amount: '300000' }],
    });
  });
});
