import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetBalance = vi.fn();
const mockFundCredits = vi.fn();
const mockStopApp = vi.fn();
const mockSetItemCustomDomain = vi.fn();
const mockLeasesByTenant = vi.fn();
const mockLeaseByCustomDomain = vi.fn();
const mockSKUs = vi.fn();
const mockProviders = vi.fn();

// Shared rate-limit spy on the single mocked CosmosClientManager instance.
// Hoisted so the `vi.mock` factory below can wire it into `getInstance`'s
// return value AND the test body can assert against it. This is the SAME
// token bucket the real core read fns reach through `ctx.chain` (the read
// handlers are thin callers — the core fns are NOT mocked here), so it pins
// "acquire exactly once per logical read" at the handler layer: re-adding a
// handler-level pre-acquire on top of the core fn's own acquire would make
// these assertions fail. (ENG-309)
const { mockAcquireRateLimit } = vi.hoisted(() => ({
  mockAcquireRateLimit: vi.fn().mockResolvedValue(undefined),
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
        getQueryClient: vi.fn().mockResolvedValue({
          liftedinit: {
            billing: {
              v1: {
                leasesByTenant: (...args: unknown[]) =>
                  mockLeasesByTenant(...args),
                leaseByCustomDomain: (...args: unknown[]) =>
                  mockLeaseByCustomDomain(...args),
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
        acquireRateLimit: mockAcquireRateLimit,
      }),
    },
    getBalance: (...args: unknown[]) => mockGetBalance(...args),
    fundCredits: (...args: unknown[]) => mockFundCredits(...args),
    stopApp: (...args: unknown[]) => mockStopApp(...args),
    setItemCustomDomain: (...args: unknown[]) =>
      mockSetItemCustomDomain(...args),
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
  'set_item_custom_domain',
  'lease_by_custom_domain',
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
    it('should advertise exactly 8 lease tools', async () => {
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
        expect(result.tools).toHaveLength(8);
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

    it('read-only tools: credit_balance, leases_by_tenant, lease_by_custom_domain, get_skus, get_providers', async () => {
      const tools = await listTools();
      const readOnly = [
        'credit_balance',
        'leases_by_tenant',
        'lease_by_custom_domain',
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

    it('set_item_custom_domain broadcasts a non-destructive idempotent tx (re-setting same value is a no-op)', async () => {
      const t = (await listTools()).get('set_item_custom_domain');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
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
      expect(mockGetBalance.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          query: expect.anything(),
          chain: expect.anything(),
          logger: expect.anything(),
        }),
      );
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
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        { amount: '10000000umfx', tenant: undefined },
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
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        { amount: '10000000umfx', tenant: undefined },
        { gasMultiplier: 2.5 },
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
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          amount: '10000000umfx',
          // parseAddress brands the raw tenant; at runtime it's the same string.
          tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
        },
        undefined,
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
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        { leaseUuid: '550e8400-e29b-41d4-a716-446655440000' },
        { gasMultiplier: 4.0 },
      );
    });
  });

  describe('set_item_custom_domain', () => {
    const LEASE_UUID_FIXTURE = '550e8400-e29b-41d4-a716-446655440000';

    it('routes a set call to setItemCustomDomain with the FQDN', async () => {
      mockSetItemCustomDomain.mockResolvedValue({
        lease_uuid: LEASE_UUID_FIXTURE,
        service_name: '',
        custom_domain: 'app.example.com',
        transactionHash: 'TX_HASH',
        code: 0,
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: LEASE_UUID_FIXTURE,
        custom_domain: 'app.example.com',
      });

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: LEASE_UUID_FIXTURE,
          customDomain: 'app.example.com',
          serviceName: undefined,
        },
        undefined,
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toMatchObject({
        lease_uuid: LEASE_UUID_FIXTURE,
        custom_domain: 'app.example.com',
        transactionHash: 'TX_HASH',
        code: 0,
      });
    });

    it('routes a clear call with clear:true and an empty domain', async () => {
      mockSetItemCustomDomain.mockResolvedValue({
        lease_uuid: LEASE_UUID_FIXTURE,
        service_name: '',
        custom_domain: '',
        transactionHash: 'TX_HASH2',
        code: 0,
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: LEASE_UUID_FIXTURE,
        clear: true,
      });

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        { leaseUuid: LEASE_UUID_FIXTURE, clear: true, serviceName: undefined },
        undefined,
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.custom_domain).toBe('');
    });

    it('forwards service_name and gas_multiplier overrides', async () => {
      mockSetItemCustomDomain.mockResolvedValue({
        lease_uuid: LEASE_UUID_FIXTURE,
        service_name: 'web',
        custom_domain: 'app.example.com',
        transactionHash: 'TX_HASH',
        code: 0,
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      await callTool(server, 'set_item_custom_domain', {
        lease_uuid: LEASE_UUID_FIXTURE,
        custom_domain: 'app.example.com',
        service_name: 'web',
        gas_multiplier: 4.0,
      });

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: LEASE_UUID_FIXTURE,
          customDomain: 'app.example.com',
          serviceName: 'web',
        },
        { gasMultiplier: 4.0 },
      );
    });
  });

  describe('lease_by_custom_domain', () => {
    it('returns the lease and service_name when the FQDN is claimed', async () => {
      mockLeaseByCustomDomain.mockResolvedValue({
        // A real lease always carries `items` (and `providerUuid`); the
        // full-passthrough BrandedLease materializes `items: []` for an
        // items-less fixture, so keep the mock realistic. Production output
        // is byte-identical — brands erase in JSON.
        lease: {
          uuid: 'lease-1',
          tenant: 'manifest1tenant',
          providerUuid: 'provider-1',
          items: [],
        },
        serviceName: 'web',
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'lease_by_custom_domain', {
        custom_domain: 'app.example.com',
      });

      expect(mockLeaseByCustomDomain).toHaveBeenCalledWith({
        customDomain: 'app.example.com',
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        lease: {
          uuid: 'lease-1',
          tenant: 'manifest1tenant',
          providerUuid: 'provider-1',
          items: [],
        },
        service_name: 'web',
      });
    });

    it('returns service_name "" for legacy 1-item leases', async () => {
      mockLeaseByCustomDomain.mockResolvedValue({
        lease: { uuid: 'lease-2', tenant: 'manifest1tenant' },
        serviceName: '',
      });

      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'lease_by_custom_domain', {
        custom_domain: 'legacy.example.com',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.service_name).toBe('');
      expect(parsed.lease).toMatchObject({ uuid: 'lease-2' });
    });

    // Not-found is exercised by the NOT_FOUND test below: the chain
    // keeper raises gRPC NotFound for unclaimed FQDNs (proto declares
    // QueryLeaseByCustomDomainResponse.lease as nullable=false), so the
    // success path never returns {lease: undefined}.
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

  // Regression guard for ENG-309: the read handlers were converted to thin
  // ReadCtx callers and the handler-level `await this.clientManager
  // .acquireRateLimit()` pre-acquire was removed, because the core read fn
  // already acquires one token via `withReadSignal`. Re-adding the
  // pre-acquire would DOUBLE-consume a token on the same logical read. The
  // core fns are NOT mocked here, so a real read drives one acquire through
  // the shared `mockAcquireRateLimit` spy on the single mocked client
  // manager. Asserting "exactly once per invocation" at the protocol layer
  // makes the handler's abstinence test-provable, not merely review-provable
  // — re-adding any pre-acquire line turns these red.
  describe('read handlers acquire exactly one rate-limit token per call', () => {
    const cases: ReadonlyArray<{
      tool: string;
      input: Record<string, unknown>;
      arm: () => void;
    }> = [
      {
        tool: 'leases_by_tenant',
        input: { state: 'all' },
        arm: () =>
          mockLeasesByTenant.mockResolvedValue({
            leases: [],
            pagination: { total: BigInt(0) },
          }),
      },
      {
        tool: 'lease_by_custom_domain',
        input: { custom_domain: 'app.example.com' },
        arm: () =>
          mockLeaseByCustomDomain.mockResolvedValue({
            lease: { uuid: 'lease-1', tenant: 'manifest1tenant', items: [] },
            serviceName: 'web',
          }),
      },
      {
        tool: 'get_skus',
        input: {},
        arm: () => mockSKUs.mockResolvedValue({ skus: [] }),
      },
      {
        tool: 'get_providers',
        input: {},
        arm: () => mockProviders.mockResolvedValue({ providers: [] }),
      },
    ];

    for (const { tool, input, arm } of cases) {
      it(`${tool} acquires the rate-limit token exactly once`, async () => {
        arm();
        const server = new LeaseMCPServer({
          config: makeMockConfig(),
          walletProvider: makeMockWallet(),
        });
        const result = await callTool(server, tool, input);

        expect(result.isError).toBeUndefined();
        // Exactly one acquire: the core read fn's own (via withReadSignal),
        // with NO handler-level pre-acquire stacked on top.
        expect(mockAcquireRateLimit).toHaveBeenCalledTimes(1);
      });
    }
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

  describe('set_item_custom_domain mutual-exclusion validation', () => {
    it('rejects custom_domain + clear:true with structured INVALID_CONFIG code', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        custom_domain: 'app.example.com',
        clear: true,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/either.*clear/i);
    });

    it('rejects neither-set-nor-clear with structured INVALID_CONFIG code', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/Provide.*custom_domain/i);
    });

    it('rejects whitespace-only custom_domain at the tool boundary (before reaching the helper)', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        custom_domain: '   ',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/Provide.*custom_domain/i);
      expect(mockSetItemCustomDomain).not.toHaveBeenCalled();
    });

    it('treats whitespace-only as empty when clearing (clear:true + spaces is allowed, equivalent to clear:true alone)', async () => {
      mockSetItemCustomDomain.mockResolvedValue({
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        service_name: '',
        custom_domain: '',
        transactionHash: 'X',
        code: 0,
      });
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'set_item_custom_domain', {
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
        custom_domain: '   ',
        clear: true,
      });

      expect(result.isError).toBeUndefined();
      // Trimmed value reaches the helper; empty + clear:true is the
      // canonical "clear" form.
      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
          clear: true,
          serviceName: undefined,
        },
        undefined,
      );
    });
  });

  describe('lease_by_custom_domain whitespace handling', () => {
    it('rejects whitespace-only custom_domain at the tool boundary with INVALID_CONFIG', async () => {
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'lease_by_custom_domain', {
        custom_domain: '   ',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toMatch(/cannot be empty/);
      expect(mockLeaseByCustomDomain).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace before sending the FQDN to the chain', async () => {
      mockLeaseByCustomDomain.mockResolvedValue({
        lease: { uuid: 'lease-1', tenant: 'manifest1tenant' },
        serviceName: '',
      });
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'lease_by_custom_domain', {
        custom_domain: '  app.example.com  ',
      });

      expect(result.isError).toBeUndefined();
      expect(mockLeaseByCustomDomain).toHaveBeenCalledWith({
        customDomain: 'app.example.com',
      });
    });

    it('raises an unclaimed FQDN as structured NOT_FOUND', async () => {
      // The keeper returns `status.Errorf(codes.NotFound, "no lease with
      // custom_domain X")` for unclaimed FQDNs. cosmjs surfaces this as a
      // plain Error; core's classifier now recognizes it and getLeaseByCustomDomain
      // (NOT mocked here — the real core fn runs over the mocked query client)
      // returns null, which this tool re-raises as NOT_FOUND rather than
      // wrapping as an opaque QUERY_FAILED (ENG-536).
      mockLeaseByCustomDomain.mockRejectedValue(
        new Error(
          'Query failed with (22): rpc error: code = NotFound desc = no lease with custom_domain unclaimed.example.com: key not found',
        ),
      );
      const server = new LeaseMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'lease_by_custom_domain', {
        custom_domain: 'unclaimed.example.com',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('NOT_FOUND');
      expect(parsed.message).toMatch(/no lease with custom_domain/);
      expect(parsed.details).toMatchObject({
        customDomain: 'unclaimed.example.com',
      });
    });
  });
});
