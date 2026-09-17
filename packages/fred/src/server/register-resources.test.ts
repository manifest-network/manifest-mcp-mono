import {
  CosmosClientManager,
  withRetry,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockConfig,
  makeMockWallet,
  makeSealedClientManager,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { unreadableErrors } from '../__test-utils__/unreadable-errors.js';
import { registerResources } from './register-resources.js';

describe.each(['leases/active', 'leases/recent', 'providers'])(
  'resource %s error boundary',
  (path) => {
    it('answers a hostile identity-fetch error through the real manager', async () => {
      const wallet = makeMockWallet();
      const failure = unreadableErrors[0]!.create();
      let fetches = 0;
      const manager = CosmosClientManager.getInstance(
        makeMockConfig({
          restUrl: 'https://lcd.example.com',
          retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
        }),
        wallet,
        async () => {
          fetches++;
          throw failure;
        },
      );
      try {
        await expectResourceFailure(path, manager, wallet);
        expect(fetches).toBe(1);
      } finally {
        manager.disconnect();
      }
    });
    it.each(unreadableErrors)(
      'answers a retried $name without an MCP timeout',
      async ({ create }) => {
        const error = create();
        let attempts = 0;
        const manager = makeSealedClientManager({
          acquireRateLimit: vi.fn().mockResolvedValue(undefined),
          getQueryClient: vi.fn(() =>
            withRetry(
              async () => {
                attempts++;
                throw error;
              },
              {
                config: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
              },
            ),
          ),
        });
        await expectResourceFailure(path, manager, makeMockWallet());
        expect(attempts).toBe(1);
      },
    );
  },
);

describe.each(['leases/active', 'leases/recent'])(
  'resource %s wallet boundary',
  (path) => {
    it('answers an unreadable wallet failure', async () => {
      const wallet = makeMockWallet();
      const error = unreadableErrors[0]!.create();
      wallet.getAddress = async () => {
        throw error;
      };
      await expectResourceFailure(
        path,
        makeSealedClientManager({
          acquireRateLimit: vi.fn().mockResolvedValue(undefined),
          getQueryClient: vi.fn().mockResolvedValue({}),
        }),
        wallet,
      );
    });
    it('preserves readable numeric protocol codes', async () => {
      const wallet = makeMockWallet();
      wallet.getAddress = async () => {
        throw Object.assign(new Error('Invalid wallet request'), {
          code: -32602,
        });
      };
      await expectResourceFailure(
        path,
        makeSealedClientManager({
          acquireRateLimit: vi.fn().mockResolvedValue(undefined),
          getQueryClient: vi.fn().mockResolvedValue({}),
        }),
        wallet,
        -32602,
      );
    });
    it('bounds and sanitizes a readable resource error', async () => {
      const wallet = makeMockWallet();
      wallet.getAddress = async () => {
        throw new Error(`\u001b[31mGETTER\u0007${'x'.repeat(20_000)}`);
      };
      await expectResourceFailure(
        path,
        makeSealedClientManager({
          acquireRateLimit: vi.fn().mockResolvedValue(undefined),
          getQueryClient: vi.fn().mockResolvedValue({}),
        }),
        wallet,
      );
    });
  },
);

async function expectResourceFailure(
  path: string,
  clientManager: CosmosClientManager,
  walletProvider: ReturnType<typeof makeMockWallet>,
  expectedCode = -32603,
) {
  const server = new McpServer({ name: 'resource-error-test', version: '1' });
  registerResources({ mcpServer: server, clientManager, walletProvider });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const onerror = vi.fn();
  server.server.onerror = onerror;
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client
      .readResource({ uri: `manifest://${path}` }, { timeout: 500 })
      .then(
        () => {
          throw new Error('Expected a resource error');
        },
        (error: unknown) => {
          expect(error).toMatchObject({ code: expectedCode });
          expect(error).toBeInstanceOf(Error);
          const message = (error as Error).message;
          expect(message.length).toBeLessThan(2100);
          expect(message).not.toContain('\u001b');
          expect(message).not.toContain('\u0007');
        },
      );
    expect(onerror).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
}
