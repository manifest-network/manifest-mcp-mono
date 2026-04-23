import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./faucet.js', () => ({
  requestFaucet: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
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
    cosmosEstimateFee: vi.fn(),
  };
});

import {
  cosmosEstimateFee,
  cosmosQuery,
  cosmosTx,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  callTool as callToolHelper,
  type ToolResult,
} from '@manifest-network/manifest-mcp-core/__test-utils__/callTool.js';
import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { requestFaucet } from './faucet.js';
import { ChainMCPServer } from './index.js';

const mockRequestFaucet = vi.mocked(requestFaucet);

const mockCosmosQuery = vi.mocked(cosmosQuery);
const mockCosmosTx = vi.mocked(cosmosTx);
const mockCosmosEstimateFee = vi.mocked(cosmosEstimateFee);

let activeTransports: InMemoryTransport[] = [];

function callTool(
  server: ChainMCPServer,
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Promise<ToolResult> {
  return callToolHelper(
    server.getServer(),
    toolName,
    toolInput,
    activeTransports,
  );
}

const CHAIN_TOOL_NAMES = [
  'get_account_info',
  'cosmos_query',
  'cosmos_tx',
  'cosmos_estimate_fee',
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
    it('should advertise exactly 6 chain tools', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(6);
        expect(result.tools.map((t) => t.name).sort()).toEqual(
          [...CHAIN_TOOL_NAMES].sort(),
        );
      } finally {
        await client.close();
      }
    });

    it('should advertise 7 tools when faucetUrl is provided', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        faucetUrl: 'https://faucet.test.com',
      });

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);

      try {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(7);
        expect(result.tools.map((t) => t.name).sort()).toEqual(
          [...CHAIN_TOOL_NAMES, 'request_faucet'].sort(),
        );
      } finally {
        await client.close();
      }
    });
  });

  // The annotations + _meta.manifest matrix is the contract the
  // manifest-agent plugin relies on to derive its broadcast policy. Pin it
  // explicitly per tool: a change here is a downstream-visible change and
  // should require updating the plugin in lockstep.
  describe('tool annotations + _meta.manifest', () => {
    async function listTools(faucetUrl?: string) {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        faucetUrl,
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.listTools();
        return new Map(result.tools.map((t) => [t.name, t]));
      } finally {
        await client.close();
      }
    }

    it('every tool has annotations.title and _meta.manifest at the current version', async () => {
      // Safety net: when a new tool is registered, this test fails until the
      // contract metadata is added. Per-tool tests below pin the values.
      // Includes the conditional faucet tool by passing faucetUrl.
      const tools = await listTools('https://faucet.test.com');
      expect(tools.size).toBeGreaterThan(0);
      for (const [name, tool] of tools) {
        expect(tool.annotations?.title, `${name} annotations.title`).toEqual(
          expect.any(String),
        );
        expect(tool._meta, `${name} _meta`).toMatchObject({
          manifest: {
            v: 1,
            broadcasts: expect.any(Boolean),
            estimable: expect.any(Boolean),
          },
        });
      }
    });

    it('get_account_info is read-only and local (no openWorld)', async () => {
      const t = (await listTools()).get('get_account_info');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: false, estimable: false },
      });
    });

    it('cosmos_query is read-only and openWorld', async () => {
      const t = (await listTools()).get('cosmos_query');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: false, estimable: false },
      });
    });

    it('cosmos_estimate_fee is read-only', async () => {
      const t = (await listTools()).get('cosmos_estimate_fee');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: false, estimable: false },
      });
    });

    it('list_modules and list_module_subcommands are read-only and local', async () => {
      const tools = await listTools();
      for (const name of ['list_modules', 'list_module_subcommands'] as const) {
        const t = tools.get(name);
        expect(t?.annotations, name).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(t?._meta, name).toEqual({
          manifest: { v: 1, broadcasts: false, estimable: false },
        });
      }
    });

    it('cosmos_tx is the one estimable broadcaster (destructive, fund-spending)', async () => {
      const t = (await listTools()).get('cosmos_tx');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: true, estimable: true },
      });
    });

    it('request_faucet mutates external state but agent does not broadcast or pay', async () => {
      // Faucet operator's wallet signs and broadcasts; from the agent's
      // perspective the call is an HTTP request returning funds. Hence
      // readOnlyHint=false (state changes) but broadcasts=false.
      const t = (await listTools('https://faucet.test.com')).get(
        'request_faucet',
      );
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: false, estimable: false },
      });
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

    it('passes gas_multiplier override to cosmosTx', async () => {
      mockCosmosTx.mockResolvedValue({
        module: 'bank',
        subcommand: 'send',
        transactionHash: 'X',
        code: 0,
        height: '1',
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
        gas_multiplier: 3.0,
      });

      expect(mockCosmosTx).toHaveBeenCalledWith(
        expect.anything(),
        'bank',
        'send',
        ['addr', '100umfx'],
        false,
        { gasMultiplier: 3.0 },
      );
    });

    it('routes cosmos_estimate_fee to cosmosEstimateFee()', async () => {
      mockCosmosEstimateFee.mockResolvedValue({
        module: 'bank',
        subcommand: 'send',
        gasEstimate: '100000',
        fee: { amount: [{ denom: 'umfx', amount: '150000' }], gas: '150000' },
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      });

      expect(mockCosmosEstimateFee).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('passes gas_multiplier override to cosmosEstimateFee', async () => {
      mockCosmosEstimateFee.mockResolvedValue({
        module: 'bank',
        subcommand: 'send',
        gasEstimate: '100000',
        fee: { amount: [{ denom: 'umfx', amount: '300000' }], gas: '300000' },
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
        gas_multiplier: 3.0,
      });

      expect(mockCosmosEstimateFee).toHaveBeenCalledWith(
        expect.anything(),
        'bank',
        'send',
        ['addr', '100umfx'],
        { gasMultiplier: 3.0 },
      );
    });

    it('cosmos_estimate_fee accepts missing args (defaults to [])', async () => {
      mockCosmosEstimateFee.mockResolvedValue({
        module: 'bank',
        subcommand: 'params',
        gasEstimate: '50000',
        fee: { amount: [{ denom: 'umfx', amount: '75000' }], gas: '75000' },
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'params',
        // args omitted intentionally
      });

      expect(result.isError).toBeUndefined();
      expect(mockCosmosEstimateFee).toHaveBeenCalledWith(
        expect.anything(),
        'bank',
        'params',
        [],
        undefined,
      );
    });

    it('passes undefined (not {}) when no gas_multiplier override', async () => {
      mockCosmosEstimateFee.mockResolvedValue({
        module: 'bank',
        subcommand: 'send',
        gasEstimate: '100000',
        fee: { amount: [{ denom: 'umfx', amount: '150000' }], gas: '150000' },
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      });

      expect(mockCosmosEstimateFee).toHaveBeenCalledWith(
        expect.anything(),
        'bank',
        'send',
        ['addr', '100umfx'],
        undefined,
      );
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

    it('routes request_faucet to requestFaucet()', async () => {
      mockRequestFaucet.mockResolvedValue({
        address: 'manifest1abc',
        results: [{ denom: 'umfx', success: true }],
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        faucetUrl: 'https://faucet.test.com',
      });
      const result = await callTool(server, 'request_faucet');

      expect(mockRequestFaucet).toHaveBeenCalledWith(
        'https://faucet.test.com',
        'manifest1abc',
        undefined,
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results[0].denom).toBe('umfx');
    });

    it('request_faucet passes denom when provided', async () => {
      mockRequestFaucet.mockResolvedValue({
        address: 'manifest1abc',
        results: [{ denom: 'umfx', success: true }],
      });

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        faucetUrl: 'https://faucet.test.com',
      });
      const result = await callTool(server, 'request_faucet', {
        denom: 'umfx',
      });

      expect(mockRequestFaucet).toHaveBeenCalledWith(
        'https://faucet.test.com',
        'manifest1abc',
        'umfx',
      );
      expect(result.isError).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('request_faucet error produces isError=true', async () => {
      mockRequestFaucet.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Faucet status returned HTTP 503',
        ),
      );

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        faucetUrl: 'https://faucet.test.com',
      });
      const result = await callTool(server, 'request_faucet');

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('QUERY_FAILED');
    });

    it('ManifestMCPError produces {error, code, message, details} with isError=true', async () => {
      mockCosmosQuery.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'something broke',
          { extra: 'info' },
        ),
      );

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toBe('something broke');
      expect(parsed.details).toEqual({ extra: 'info' });
    });

    it('cosmos_estimate_fee error produces {error, code, message, details} with isError=true', async () => {
      mockCosmosEstimateFee.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.SIMULATION_FAILED,
          'simulation failed',
          { module: 'bank', subcommand: 'send' },
        ),
      );

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('SIMULATION_FAILED');
      expect(parsed.message).toBe('simulation failed');
    });

    it('generic Error produces {error, message} with isError=true', async () => {
      mockCosmosQuery.mockRejectedValue(new Error('unexpected'));

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
      });

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
        result: {
          balances: [{ denom: 'umfx', amount: BigInt('999999999999999999') }],
        },
      } as any);

      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
      });

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
      const result = await callTool(server, 'cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: [],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.details.mnemonic).toBe('[REDACTED]');
      expect(parsed.details.password).toBe('[REDACTED]');
      expect(parsed.details.module).toBe('bank');
    });
  });

  describe('Zod validation', () => {
    it('rejects list_module_subcommands with invalid type', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_module_subcommands', {
        type: 'invalid',
        module: 'bank',
      });

      expect(result.isError).toBe(true);
    });

    it('rejects cosmos_query when module is missing', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_query', {
        subcommand: 'balances',
      });

      expect(result.isError).toBe(true);
      expect(mockCosmosQuery).not.toHaveBeenCalled();
    });

    it('rejects cosmos_tx when args is not an array', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: 'not-an-array',
      });

      expect(result.isError).toBe(true);
      expect(mockCosmosTx).not.toHaveBeenCalled();
    });

    it('rejects cosmos_estimate_fee when module is missing', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        subcommand: 'send',
        args: ['addr', '100umfx'],
      });

      expect(result.isError).toBe(true);
      expect(mockCosmosEstimateFee).not.toHaveBeenCalled();
    });

    it('rejects cosmos_estimate_fee when args is not an array', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: 'not-an-array',
      });

      expect(result.isError).toBe(true);
      expect(mockCosmosEstimateFee).not.toHaveBeenCalled();
    });

    it('rejects cosmos_estimate_fee when gas_multiplier < 1', async () => {
      const server = new ChainMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['addr', '100umfx'],
        gas_multiplier: 0.5,
      });

      expect(result.isError).toBe(true);
      expect(mockCosmosEstimateFee).not.toHaveBeenCalled();
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
