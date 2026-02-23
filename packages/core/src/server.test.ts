import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Mock CosmosClientManager before importing ManifestMCPServer
vi.mock('./client.js', () => ({
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
}));

vi.mock('./cosmos.js', () => ({
  cosmosQuery: vi.fn(),
  cosmosTx: vi.fn(),
}));

vi.mock('./tools/browseCatalog.js', () => ({
  browseCatalog: vi.fn(),
}));

vi.mock('./tools/getBalance.js', () => ({
  getBalance: vi.fn(),
}));

vi.mock('./tools/listApps.js', () => ({
  listApps: vi.fn(),
}));

vi.mock('./tools/appStatus.js', () => ({
  appStatus: vi.fn(),
}));

vi.mock('./tools/getLogs.js', () => ({
  getAppLogs: vi.fn(),
}));

import { ManifestMCPServer } from './index.js';
import type { WalletProvider, ManifestMCPConfig } from './types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import type { AppRegistry } from './registry.js';
import { cosmosQuery, cosmosTx } from './cosmos.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { getBalance } from './tools/getBalance.js';
import { listApps } from './tools/listApps.js';
import { appStatus } from './tools/appStatus.js';
import { getAppLogs } from './tools/getLogs.js';

const mockCosmosQuery = vi.mocked(cosmosQuery);
const mockCosmosTx = vi.mocked(cosmosTx);
const mockBrowseCatalog = vi.mocked(browseCatalog);
const mockGetBalance = vi.mocked(getBalance);
const mockListApps = vi.mocked(listApps);
const mockAppStatus = vi.mocked(appStatus);
const mockGetAppLogs = vi.mocked(getAppLogs);

function makeMockConfig(): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    addressPrefix: 'manifest',
  };
}

function makeMockWallet(opts?: { signArbitrary?: boolean }): WalletProvider {
  const wallet: WalletProvider = {
    getAddress: vi.fn().mockResolvedValue('manifest1abc'),
    getSigner: vi.fn().mockResolvedValue({}),
  };
  if (opts?.signArbitrary) {
    wallet.signArbitrary = vi.fn().mockResolvedValue({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'mockPubKey' },
      signature: 'mockSignature',
    });
  }
  return wallet;
}

function makeMockAppRegistry(): AppRegistry {
  return {
    getApps: vi.fn().mockReturnValue([]),
    getApp: vi.fn().mockReturnValue({ name: 'test', leaseUuid: 'uuid', status: 'active' }),
    findApp: vi.fn().mockReturnValue(undefined),
    getAppByLease: vi.fn().mockReturnValue(undefined),
    addApp: vi.fn(),
    updateApp: vi.fn(),
    removeApp: vi.fn(),
  };
}

/**
 * Helper: invoke a tool via the public MCP protocol using InMemoryTransport.
 * This avoids accessing private SDK internals and validates full request/response flow.
 */
let activeTransports: InMemoryTransport[] = [];

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(
  server: ManifestMCPServer,
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

const BASE_TOOL_NAMES = [
  'get_account_info',
  'cosmos_query',
  'cosmos_tx',
  'list_modules',
  'list_module_subcommands',
  'browse_catalog',
  'get_balance',
];

const APP_TOOL_NAMES = [
  'list_apps',
  'app_status',
  'get_logs',
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

describe('ManifestMCPServer', () => {
  describe('getTools', () => {
    it('should return 7 base tools without appRegistry', () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const tools = server.getTools();
      expect(tools).toHaveLength(7);
      expect(tools.map(t => t.name)).toEqual(BASE_TOOL_NAMES);
    });

    it('should return 10 tools with appRegistry', () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        appRegistry: makeMockAppRegistry(),
      });
      const tools = server.getTools();
      expect(tools).toHaveLength(10);
      expect(tools.map(t => t.name)).toEqual([...BASE_TOOL_NAMES, ...APP_TOOL_NAMES]);
    });

    it('should have correct tool names in each set', () => {
      const serverNoApps = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const serverWithApps = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        appRegistry: makeMockAppRegistry(),
      });

      const baseNames = new Set(serverNoApps.getTools().map(t => t.name));
      const allNames = new Set(serverWithApps.getTools().map(t => t.name));

      // All base tools present in both
      for (const name of BASE_TOOL_NAMES) {
        expect(baseNames.has(name)).toBe(true);
        expect(allNames.has(name)).toBe(true);
      }

      // App tools only in the app-registry server
      for (const name of APP_TOOL_NAMES) {
        expect(baseNames.has(name)).toBe(false);
        expect(allNames.has(name)).toBe(true);
      }
    });
  });

  describe('handleToolCall dispatch', () => {
    it('routes get_account_info to wallet.getAddress()', async () => {
      const server = new ManifestMCPServer({
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

      const server = new ManifestMCPServer({
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

      const server = new ManifestMCPServer({
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

    it('routes browse_catalog to browseCatalog()', async () => {
      mockBrowseCatalog.mockResolvedValue({ providers: [], tiers: {} } as any);

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'browse_catalog');

      expect(mockBrowseCatalog).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes get_balance to getBalance()', async () => {
      mockGetBalance.mockResolvedValue({ balances: [], credits: null } as any);

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'get_balance');

      expect(mockGetBalance).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes list_apps to listApps()', async () => {
      mockListApps.mockResolvedValue({ apps: [], count: 0 });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        appRegistry: makeMockAppRegistry(),
      });
      const result = await callTool(server, 'list_apps');

      expect(mockListApps).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes app_status to appStatus()', async () => {
      mockAppStatus.mockResolvedValue({ name: 'test', status: 'active', chainState: null } as any);

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
        appRegistry: makeMockAppRegistry(),
      });
      const result = await callTool(server, 'app_status', { name: 'test' });

      expect(mockAppStatus).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes get_logs to getAppLogs()', async () => {
      mockGetAppLogs.mockResolvedValue({ app_name: 'test', logs: {}, truncated: false });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
        appRegistry: makeMockAppRegistry(),
      });
      const result = await callTool(server, 'get_logs', { name: 'test' });

      expect(mockGetAppLogs).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes list_modules to getAvailableModules()', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_modules');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('queryModules');
      expect(parsed).toHaveProperty('txModules');
    });
  });

  describe('error handling', () => {
    it('ManifestMCPError produces {error, code, message, details} with isError=true', async () => {
      mockCosmosQuery.mockRejectedValue(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'something broke', { extra: 'info' }),
      );

      const server = new ManifestMCPServer({
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

      const server = new ManifestMCPServer({
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

      const server = new ManifestMCPServer({
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

      const server = new ManifestMCPServer({
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

  describe('mnemonic detection', () => {
    it('12-word strings in error details are redacted', async () => {
      const words12 = 'one two three four five six seven eight nine ten eleven twelve';
      mockCosmosTx.mockRejectedValue(
        new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'fail', {
          someField: words12,
        }),
      );

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_tx', { module: 'bank', subcommand: 'send', args: [] });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.details.someField).toBe('[REDACTED - possible mnemonic]');
    });

    it('24-word strings in error details are redacted', async () => {
      const words24 = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
      mockCosmosTx.mockRejectedValue(
        new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'fail', {
          data: words24,
        }),
      );

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'cosmos_tx', { module: 'bank', subcommand: 'send', args: [] });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.details.data).toBe('[REDACTED - possible mnemonic]');
    });
  });

  describe('app tools without registry', () => {
    it('list_apps throws MISSING_CONFIG when appRegistry not provided', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_apps');

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('MISSING_CONFIG');
    });

    it('app_status throws MISSING_CONFIG when appRegistry not provided', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'app_status', { name: 'test' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('MISSING_CONFIG');
    });

    it('get_logs throws MISSING_CONFIG when appRegistry not provided', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'get_logs', { name: 'test' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('MISSING_CONFIG');
    });
  });

  describe('unknown tool', () => {
    it('returns UNKNOWN_ERROR for unrecognized tool name', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'nonexistent_tool');

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('UNKNOWN_ERROR');
      expect(parsed.message).toContain('nonexistent_tool');
    });
  });

  describe('getProviderAuthToken', () => {
    it('throws when wallet lacks signArbitrary', async () => {
      mockAppStatus.mockImplementation(async (_qc, _addr, _name, _reg, getAuthToken) => {
        // Call the auth token getter to trigger the error
        await getAuthToken('manifest1abc', 'lease-1');
        return {} as any;
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(), // no signArbitrary
        appRegistry: makeMockAppRegistry(),
      });
      const result = await callTool(server, 'app_status', { name: 'test' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('WALLET_NOT_CONNECTED');
      expect(parsed.message).toContain('signArbitrary');
    });
  });
});
