import { toUtf8 } from '@cosmjs/encoding';
import {
  CosmosClientManager,
  executeTx,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { callTool } from '@manifest-network/manifest-mcp-core/__test-utils__/callTool.js';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { CosmwasmMCPServer } from './index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const transports: InMemoryTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  CosmosClientManager.clearInstances();
  vi.restoreAllMocks();
});

it('serializes converter and core transactions under the real account lock', async () => {
  const server = new CosmwasmMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet(),
    converterAddress: 'manifest1converter',
  });
  const manager = server.getClientManager();
  const queried = deferred();
  const queryClient = Object.assign(makeMockQueryClient(), {
    cosmwasm: {
      wasm: {
        v1: {
          smartContractState: async () => {
            queried.resolve();
            return {
              data: toUtf8(
                JSON.stringify({
                  poa_admin: 'manifest1admin',
                  rate: '1',
                  source_denom: 'umfx',
                  target_denom: 'upwr',
                  paused: false,
                }),
              ),
            };
          },
        },
      },
    },
  });
  vi.spyOn(manager, 'getQueryClient').mockResolvedValue(queryClient);
  const broadcasting = deferred();
  const release = deferred();
  const signAndBroadcast = vi.fn().mockImplementation(async () => {
    broadcasting.resolve();
    await release.promise;
    return {
      transactionHash: 'HASH',
      code: 0,
      height: 1,
      gasUsed: 100n,
      gasWanted: 100n,
      events: [],
    };
  });
  vi.spyOn(manager, 'getBroadcastClient').mockResolvedValue({
    simulate: vi.fn().mockResolvedValue(100),
    signAndBroadcast,
  } as unknown as Awaited<ReturnType<typeof manager.getBroadcastClient>>);
  vi.spyOn(manager, 'acquireRateLimit').mockResolvedValue(undefined);
  // Start the core transaction first and hold its actual broadcast open.
  const first = executeTx({ chain: manager, logger: noopLogger }, [
    { typeUrl: '/test.Message', value: {} },
  ]);
  await broadcasting.promise;
  const second = callTool(
    server.getServer(),
    'convert_mfx_to_pwr',
    { amount: '1' },
    transports,
  );
  await queried.promise;
  // The converter has finished its query but cannot acquire the held lock.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(signAndBroadcast).toHaveBeenCalledTimes(1);
  release.resolve();
  await first;
  const result = await second;
  expect(result.isError).toBeUndefined();
  expect(signAndBroadcast).toHaveBeenCalledTimes(2);
});
