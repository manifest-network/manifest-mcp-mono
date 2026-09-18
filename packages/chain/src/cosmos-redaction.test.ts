import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({
  setLogger: vi.fn(),
  disconnect: vi.fn(),
  acquireRateLimit: vi.fn(async () => {}),
  getConfig: vi.fn(() => ({
    gasPrice: '0.001umfx',
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
  })),
  getAddress: vi.fn(
    async () => 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta',
  ),
  getSigningClient: vi.fn(),
  getBroadcastClient: vi.fn(),
  withBroadcastLock: vi.fn(<T>(_address: string, operation: () => Promise<T>) =>
    operation(),
  ),
}));

// Only acquisition/I/O is injected; built public core attribution, registry,
// bank handlers, retry, and the actual chain MCP protocol boundary all execute.
vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@manifest-network/manifest-mcp-core')
  >()),
  CosmosClientManager: { getInstance: () => manager },
}));

import { ChainMCPServer } from './index.js';

const MNEMONIC = `${'abandon '.repeat(11)}about`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Cosmos prefixes retain mnemonic redaction over MCP', () => {
  for (const tool of ['cosmos_tx', 'cosmos_estimate_fee'] as const) {
    it.each([
      'code getter',
      'details getter',
      'readable SDK',
      'raw Error',
      'code getter with controls',
    ])(
      `${tool} redacts a mnemonic from %s without leaking a stack`,
      async (kind) => {
        const message =
          kind === 'code getter with controls'
            ? `\u001b[31m\u202e${MNEMONIC}\u202c\u001b[0m`
            : MNEMONIC;
        const original =
          kind === 'raw Error'
            ? new Error(message)
            : new ManifestMCPError(
                ManifestMCPErrorCode.INVALID_CONFIG,
                message,
                { module: 'bank' },
              );
        if (kind.startsWith('code getter') || kind === 'details getter') {
          Object.defineProperty(
            original,
            kind.startsWith('code getter') ? 'code' : 'details',
            {
              get() {
                throw new Error('unavailable');
              },
            },
          );
        }
        const failure = vi.fn().mockRejectedValue(original);
        const simulate =
          tool === 'cosmos_estimate_fee'
            ? failure
            : vi.fn().mockResolvedValue(10_000);
        const signingClient = {
          simulate,
          signAndBroadcast: failure,
          defaultGasMultiplier: 1.5,
        };
        manager.getSigningClient.mockResolvedValue(signingClient);
        manager.getBroadcastClient.mockResolvedValue(signingClient);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const server = new ChainMCPServer({
          config: makeMockConfig(),
          walletProvider: makeMockWallet(),
        });
        const client = new Client({ name: 'redaction-test', version: '1.0.0' });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        try {
          await server.getServer().connect(serverTransport);
          await client.connect(clientTransport);
          const result = await client.callTool({
            name: tool,
            arguments: {
              module: 'bank',
              subcommand: 'send',
              args: [
                'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
                '1umfx',
              ],
            },
          });
          expect(result.isError).toBe(true);
          const wire = JSON.stringify(result);
          expect(wire).toContain('[REDACTED - possible mnemonic]');
          expect(wire).not.toContain(MNEMONIC);
          expect(wire).not.toContain('abandon');
          expect(log.mock.calls.flat().join('\n')).not.toContain('abandon');
          expect(failure).toHaveBeenCalledOnce();
        } finally {
          await client.close();
          await server.getServer().close();
        }
      },
    );
  }
});
