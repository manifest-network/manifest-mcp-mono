import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@manifest-network/manifest-mcp-core')>();
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue({
        disconnect: vi.fn(),
        getQueryClient: vi.fn().mockResolvedValue({}),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({}),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
    cosmosQuery: vi.fn(),
    cosmosTx: vi.fn(),
  };
});

import { ChainMCPServer } from './index.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  cosmosQuery,
  cosmosTx,
} from '@manifest-network/manifest-mcp-core';
import { makeMockConfig, makeMockWallet } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';

const mockCosmosQuery = vi.mocked(cosmosQuery);
const mockCosmosTx = vi.mocked(cosmosTx);

let activeTransports: InMemoryTransport[] = [];

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(
  server: ChainMCPServer,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<ToolResult> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  activeTransports.push(clientTransport, serverTransport);

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return await client.callTool({ name: toolName, arguments: toolInput }) as ToolResult;
  } finally {
    await client.close();
  }
}

const CHAIN_TOOL_NAMES = [
  'get_account_info',
  'cosmos_query',
  'cosmos_tx',
  'list_modules',
  'list_module_subcommands',
];

beforeEach(() => {
  vi.clearAllMocks();
  activeTransports = [];
});

afterEach(async () => {
  for (const t of activeTransports) {
    await t.close();
  }
  activeTransports = [];
});

describe('ChainMCPServer', () => {
  describe('listTools via protocol', () => {
    it('should advertise exactly 5 chain tools', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(5);
        expect(result.tools.map(t => t.name).sort()).toEqual([...CHAIN_TOOL_NAMES].sort());
      } finally {
        await client.close();
      }
    });
  });

  describe('handleToolCall dispatch', () => {
    it('routes get_account_info to wallet.getAddress()', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'get_account_info');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.address).toBe('manifest1abc');
    });

    it('routes cosmos_query to cosmosQuery()', async () => {
      mockCosmosQuery.mockResolvedValue({
        module: 'bank',
        subcommand: 'balances',
        result: { balances: [{ denom: 'umfx', amount: '1000' }] },
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
      });

      expect(mockCosmosQuery).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes cosmos_tx to cosmosTx()', async () => {
      mockCosmosTx.mockResolvedValue({
        module: 'bank',
        subcommand: 'send',
        transactionHash: 'HASH123',
        code: 0,
        height: '100',
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      });

      expect(mockCosmosTx).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes list_modules to getAvailableModules()', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_modules');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('queryModules');
      expect(parsed).toHaveProperty('txModules');
    });

    it('routes list_module_subcommands to getModuleSubcommands()', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_module_subcommands', {
        type: 'query',
        module: 'bank',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.type).toBe('query');
      expect(parsed.module).toBe('bank');
      expect(parsed).toHaveProperty('subcommands');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('ManifestMCPError produces {error, code, message, details} with isError=true', async () => {
      mockCosmosQuery.mockRejectedValue(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'something broke', { extra: 'info' }),
      );

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', { module: 'bank', subcommand: 'balances' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toBe('something broke');
      expect(parsed.details).toEqual({ extra: 'info' });
    });

    it('generic Error produces {error, message} with isError=true', async () => {
      mockCosmosQuery.mockRejectedValue(new Error('unexpected'));

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', { module: 'bank', subcommand: 'balances' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe(true);
      expect(parsed.message).toBe('unexpected');
      expect(parsed.code).toBeUndefined();
    });
  });

  describe('BigInt serialization', () => {
    it('tool results with BigInt values are serialized as strings', async () => {
      mockCosmosQuery.mockResolvedValue({
        module: 'bank',
        subcommand: 'balances',
        result: { balances: [{ denom: 'umfx', amount: BigInt('999999999999999999') }] },
      } as any);

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', { module: 'bank', subcommand: 'balances' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.result.balances[0].amount).toBe('999999999999999999');
    });
  });

  describe('sensitive field redaction', () => {
    it('error details with sensitive fields are redacted', async () => {
      mockCosmosTx.mockRejectedValue(
        new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'tx fail', {
          mnemonic: 'word1 word2 word3',
          password: 'secret123',
          module: 'bank',
        }),
      );

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_tx', { module: 'bank', subcommand: 'send', args: [] });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.details.mnemonic).toBe('[REDACTED]');
      expect(parsed.details.password).toBe('[REDACTED]');
      expect(parsed.details.module).toBe('bank');
    });
  });

  describe('unknown tool', () => {
    it('returns an error for unrecognized tool name', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'nonexistent_tool');

      expect(result.isError).toBe(true);
    });
  });
});
