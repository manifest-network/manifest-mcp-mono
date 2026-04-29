import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetBalance = vi.fn();
const mockFundCredits = vi.fn();
const mockStopApp = vi.fn();
const mockLeasesByTenant = vi.fn();
const mockSKUs = vi.fn();
const mockProviders = vi.fn();

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
        getQueryClient: vi.fn().mockResolvedValue({
          liftedinit: {
            billing: {
              v1: {
                leasesByTenant: (...args: unknown[]) =>
                  mockLeasesByTenant(...args),
              },
            },
            sku: {
              v1: {
                sKUs: (...args: unknown[]) => mockSKUs(...args),
                providers: (...args: unknown[]) => mockProviders(...args),
              },
            },
          },
        }),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({}),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
    fundCredits: (...args: unknown[]) => mockFundCredits(...args),
    stopApp: (...args: unknown[]) => mockStopApp(...args),
  };
});

import {
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
import { LeaseMCPServer } from './index.js';

let activeTransports: InMemoryTransport[] = [];

function callTool(
  server: LeaseMCPServer,
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

const LEASE_TOOL_NAMES = [
  'credit_balance',
  'fund_credit',
  'leases_by_tenant',
  'close_lease',
  'get_skus',
  'get_providers',
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

describe('LeaseMCPServer', () => {
  describe('listTools via protocol', () => {
    it('should advertise exactly 6 lease tools', async () => {
      const server = new LeaseMCPServer({
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
          [...LEASE_TOOL_NAMES].sort(),
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
    async function listTools() {
      const server = new LeaseMCPServer({
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
        return new Map(result.tools.map((t) => [t.name, t]));
      } finally {
        await client.close();
      }
    }

    it('every tool has annotations.title and _meta.manifest at the current version', async () => {
      // Safety net: when a new tool is registered, this test fails until the
      // contract metadata is added. Per-tool tests below pin the values.
      const tools = await listTools();
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

    it('read-only tools: credit_balance, leases_by_tenant, get_skus, get_providers', async () => {
      const tools = await listTools();
      const readOnly = [
        'credit_balance',
        'leases_by_tenant',
        'get_skus',
        'get_providers',
      ] as const;
      for (const name of readOnly) {
        const t = tools.get(name);
        expect(t?.annotations, name).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        });
        expect(t?._meta?.manifest, name).toEqual({
          v: 1,
          broadcasts: false,
          estimable: false,
        });
      }
    });

    it('fund_credit broadcasts an additive (non-destructive), fund-spending tx', async () => {
      const t = (await listTools()).get('fund_credit');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });

    it('close_lease broadcasts a destructive, idempotent (closing a closed lease is a no-op), fund-spending tx', async () => {
      const t = (await listTools()).get('close_lease');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
      });
    });
  });

  describe('credit_balance', () => {
    // Shape mirrors what core/src/tools/getBalance.ts actually returns; the
    // tool now declares an outputSchema so the fixture must satisfy it.
    const balanceFixture = {
      credits: null,
      balances: [{ denom: 'umfx', amount: '1000' }],
    };

    it('routes to getBalance with caller address by default', async () => {
      mockGetBalance.mockResolvedValue(balanceFixture);

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'credit_balance');

      expect(mockGetBalance).toHaveBeenCalledOnce();
      expect(mockGetBalance.mock.calls[0][1]).toBe('manifest1abc');
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.balances[0].denom).toBe('umfx');
    });

    it('passes tenant override to getBalance', async () => {
      mockGetBalance.mockResolvedValue(balanceFixture);

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'credit_balance', {
        tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      });

      expect(mockGetBalance).toHaveBeenCalledOnce();
      expect(mockGetBalance.mock.calls[0][1]).toBe(
        'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      );
    });

    it('rejects invalid bech32 tenant before querying', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'credit_balance', {
        tenant: 'not-a-bech32',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe(ManifestMCPErrorCode.INVALID_ADDRESS);
      expect(mockGetBalance).not.toHaveBeenCalled();
    });
  });

  describe('fund_credit', () => {
    const fundResult = {
      sender: 'manifest1abc',
      tenant: 'manifest1abc',
      amount: '10000000umfx',
      transactionHash: 'HASH1',
      code: 0,
    };

    it('routes to fundCredits with amount and no tenant override', async () => {
      mockFundCredits.mockResolvedValue(fundResult);

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'fund_credit', {
        amount: '10000000umfx',
      });

      expect(mockFundCredits).toHaveBeenCalledWith(
        expect.anything(),
        '10000000umfx',
        undefined,
        undefined,
      );
      expect(result.isError).toBeUndefined();
    });

    it('passes gas_multiplier override to fundCredits', async () => {
      mockFundCredits.mockResolvedValue(fundResult);

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'fund_credit', {
        amount: '10000000umfx',
        gas_multiplier: 2.5,
      });

      expect(mockFundCredits).toHaveBeenCalledWith(
        expect.anything(),
        '10000000umfx',
        { gasMultiplier: 2.5 },
        undefined,
      );
    });

    it('passes tenant override to fundCredits', async () => {
      mockFundCredits.mockResolvedValue({
        ...fundResult,
        tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'fund_credit', {
        amount: '10000000umfx',
        tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      });

      expect(mockFundCredits).toHaveBeenCalledWith(
        expect.anything(),
        '10000000umfx',
        undefined,
        'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      );
    });
  });

  describe('leases_by_tenant', () => {
    it('returns leases with state labels and pagination', async () => {
      mockLeasesByTenant.mockResolvedValue({
        leases: [
          {
            uuid: 'lease-1',
            state: 1, // LEASE_STATE_PENDING
            providerUuid: 'prov-1',
            createdAt: new Date('2025-01-01T00:00:00Z'),
            closedAt: undefined,
            items: [{ skuUuid: 'sku-1', quantity: BigInt(1) }],
          },
        ],
        pagination: { total: BigInt(1) },
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'leases_by_tenant', {
        state: 'all',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.leases).toHaveLength(1);
      expect(parsed.leases[0].uuid).toBe('lease-1');
      expect(parsed.leases[0].stateLabel).toBe('pending');
      expect(parsed.leases[0].items[0].quantity).toBe('1');
      expect(parsed.total).toBe('1');
    });

    it('passes pagination params correctly', async () => {
      mockLeasesByTenant.mockResolvedValue({
        leases: [],
        pagination: { total: BigInt(0) },
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'leases_by_tenant', { limit: 10, offset: 5 });

      expect(mockLeasesByTenant).toHaveBeenCalledOnce();
      const call = mockLeasesByTenant.mock.calls[0][0];
      expect(call.pagination.limit).toBe(BigInt(10));
      expect(call.pagination.offset).toBe(BigInt(5));
    });

    it('uses caller address as tenant by default', async () => {
      mockLeasesByTenant.mockResolvedValue({
        leases: [],
        pagination: { total: BigInt(0) },
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'leases_by_tenant', {});

      expect(mockLeasesByTenant).toHaveBeenCalledOnce();
      expect(mockLeasesByTenant.mock.calls[0][0].tenant).toBe('manifest1abc');
    });

    it('passes tenant override to the query', async () => {
      mockLeasesByTenant.mockResolvedValue({
        leases: [],
        pagination: { total: BigInt(0) },
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'leases_by_tenant', {
        tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      });

      expect(mockLeasesByTenant).toHaveBeenCalledOnce();
      expect(mockLeasesByTenant.mock.calls[0][0].tenant).toBe(
        'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      );
    });

    it('rejects invalid bech32 tenant before querying', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'leases_by_tenant', {
        tenant: 'not-a-bech32',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe(ManifestMCPErrorCode.INVALID_ADDRESS);
      expect(mockLeasesByTenant).not.toHaveBeenCalled();
    });
  });

  describe('close_lease', () => {
    it('routes to stopApp with lease UUID', async () => {
      mockStopApp.mockResolvedValue({ transactionHash: 'HASH2', code: 0 });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'close_lease', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(mockStopApp).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();
    });

    it('passes gas_multiplier override to stopApp', async () => {
      mockStopApp.mockResolvedValue({ transactionHash: 'HASH2', code: 0 });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'close_lease', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        gas_multiplier: 4.0,
      });

      expect(mockStopApp).toHaveBeenCalledWith(
        expect.anything(),
        '550e8400-e29b-41d4-a716-446655440000',
        { gasMultiplier: 4.0 },
      );
    });
  });

  describe('get_skus', () => {
    it('returns SKUs with active_only default true', async () => {
      mockSKUs.mockResolvedValue({
        skus: [{ name: 'docker-micro', uuid: 'sku-1' }],
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'get_skus', {});

      expect(mockSKUs).toHaveBeenCalledWith({ activeOnly: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.skus).toHaveLength(1);
    });
  });

  describe('get_providers', () => {
    it('returns providers with active_only default true', async () => {
      mockProviders.mockResolvedValue({
        providers: [{ uuid: 'prov-1', address: 'manifest1x' }],
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'get_providers', {});

      expect(mockProviders).toHaveBeenCalledWith({ activeOnly: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.providers).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('ManifestMCPError produces structured error response', async () => {
      mockGetBalance.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'credit query failed',
        ),
      );

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'credit_balance');

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toBe('credit query failed');
    });
  });
});
