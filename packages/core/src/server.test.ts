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

vi.mock('./tools/fundCredits.js', () => ({
  fundCredits: vi.fn(),
}));

vi.mock('./tools/deployApp.js', () => ({
  deployApp: vi.fn(),
}));

vi.mock('./tools/stopApp.js', () => ({
  stopApp: vi.fn(),
}));

vi.mock('./tools/restartApp.js', () => ({
  restartApp: vi.fn(),
}));

vi.mock('./tools/updateApp.js', () => ({
  updateApp: vi.fn(),
}));

import { ManifestMCPServer } from './index.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { cosmosQuery, cosmosTx } from './cosmos.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { getBalance } from './tools/getBalance.js';
import { listApps } from './tools/listApps.js';
import { appStatus } from './tools/appStatus.js';
import { getAppLogs } from './tools/getLogs.js';
import { fundCredits } from './tools/fundCredits.js';
import { deployApp } from './tools/deployApp.js';
import { stopApp } from './tools/stopApp.js';
import { restartApp } from './tools/restartApp.js';
import { updateApp } from './tools/updateApp.js';
import { makeMockConfig, makeMockWallet } from './__test-utils__/mocks.js';

const mockCosmosQuery = vi.mocked(cosmosQuery);
const mockCosmosTx = vi.mocked(cosmosTx);
const mockBrowseCatalog = vi.mocked(browseCatalog);
const mockGetBalance = vi.mocked(getBalance);
const mockListApps = vi.mocked(listApps);
const mockAppStatus = vi.mocked(appStatus);
const mockGetAppLogs = vi.mocked(getAppLogs);
const mockFundCredits = vi.mocked(fundCredits);
const mockDeployApp = vi.mocked(deployApp);
const mockStopApp = vi.mocked(stopApp);
const mockRestartApp = vi.mocked(restartApp);
const mockUpdateApp = vi.mocked(updateApp);

/**
 * Helper: invoke a tool via the public MCP protocol using InMemoryTransport.
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

const ALL_TOOL_NAMES = [
  'get_account_info',
  'cosmos_query',
  'cosmos_tx',
  'list_modules',
  'list_module_subcommands',
  'browse_catalog',
  'get_balance',
  'fund_credits',
  'list_apps',
  'app_status',
  'get_logs',
  'deploy_app',
  'stop_app',
  'restart_app',
  'update_app',
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
    it('should return all 15 tools', () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const tools = server.getTools();
      expect(tools).toHaveLength(15);
      expect(tools.map(t => t.name)).toEqual(ALL_TOOL_NAMES);
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
      mockListApps.mockResolvedValue({ leases: [], count: 0 });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'list_apps');

      expect(mockListApps).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes app_status to appStatus()', async () => {
      mockAppStatus.mockResolvedValue({ lease_uuid: '550e8400-e29b-41d4-a716-446655440000', chainState: null } as any);

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_status', { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' });

      expect(mockAppStatus).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes get_logs to getAppLogs()', async () => {
      mockGetAppLogs.mockResolvedValue({ lease_uuid: '550e8400-e29b-41d4-a716-446655440000', logs: {}, truncated: false });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'get_logs', { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' });

      expect(mockGetAppLogs).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes fund_credits to fundCredits()', async () => {
      mockFundCredits.mockResolvedValue({
        module: 'billing',
        subcommand: 'fund-credit',
        transactionHash: 'HASH',
        code: 0,
        height: '100',
        confirmed: true,
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'fund_credits', { amount: '10000000umfx' });

      expect(mockFundCredits).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes deploy_app to deployApp()', async () => {
      mockDeployApp.mockResolvedValue({
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        provider_uuid: 'prov-1',
        provider_url: 'http://localhost:8080',
        status: 'running',
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'deploy_app', {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      });

      expect(mockDeployApp).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes stop_app to stopApp()', async () => {
      mockStopApp.mockResolvedValue({
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        status: 'stopped',
        transactionHash: 'TX',
        code: 0,
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'stop_app', { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' });

      expect(mockStopApp).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes restart_app to restartApp()', async () => {
      mockRestartApp.mockResolvedValue({
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        status: 'restarting',
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'restart_app', { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' });

      expect(mockRestartApp).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('routes update_app to updateApp()', async () => {
      mockUpdateApp.mockResolvedValue({
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        status: 'updated',
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'update_app', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        manifest: '{"image":"nginx:latest","ports":{"80/tcp":{}}}',
      });

      expect(mockUpdateApp).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('rejects update_app with invalid manifest JSON', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'update_app', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        manifest: 'not valid json',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.message).toContain('Invalid manifest');
      expect(mockUpdateApp).not.toHaveBeenCalled();
    });

    it('rejects update_app when manifest is a JSON array', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'update_app', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        manifest: '[1, 2, 3]',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.message).toContain('Invalid manifest');
      expect(mockUpdateApp).not.toHaveBeenCalled();
    });

    it('rejects deploy_app when env is an array', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'deploy_app', {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        env: ['not', 'an', 'object'],
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.message).toContain('env must be an object');
      expect(mockDeployApp).not.toHaveBeenCalled();
    });

    it('rejects deploy_app when env contains non-string values', async () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'deploy_app', {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        env: { FOO: 123 },
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('TX_FAILED');
      expect(parsed.message).toContain('FOO');
      expect(mockDeployApp).not.toHaveBeenCalled();
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
      mockAppStatus.mockImplementation(async (_qc, _addr, _leaseUuid, getAuthToken) => {
        await getAuthToken('manifest1abc', '550e8400-e29b-41d4-a716-446655440000');
        return {} as any;
      });

      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(), // no signArbitrary
      });
      const result = await callTool(server, 'app_status', { lease_uuid: '550e8400-e29b-41d4-a716-446655440000' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('WALLET_NOT_CONNECTED');
      expect(parsed.message).toContain('signArbitrary');
    });
  });
});
