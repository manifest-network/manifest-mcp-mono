import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('./http/fred.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http/fred.js')>();
  return {
    ...actual,
    getLeaseProvision: vi.fn(),
    getLeaseReleases: vi.fn(),
  };
});

vi.mock('./tools/resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

vi.mock('./tools/fetchActiveLease.js', () => ({
  fetchActiveLease: vi.fn(),
}));

vi.mock('./tools/browseCatalog.js', () => ({
  browseCatalog: vi.fn().mockResolvedValue({ providers: [], tiers: {} }),
}));
vi.mock('./tools/appStatus.js', () => ({
  appStatus: vi.fn().mockResolvedValue({}),
}));
vi.mock('./tools/getLogs.js', () => ({
  getAppLogs: vi.fn().mockResolvedValue({}),
}));
vi.mock('./tools/deployApp.js', () => ({
  deployApp: vi.fn().mockResolvedValue({}),
}));
vi.mock('./tools/restartApp.js', () => ({
  restartApp: vi.fn().mockResolvedValue({}),
}));
vi.mock('./tools/updateApp.js', () => ({
  updateApp: vi.fn().mockResolvedValue({}),
}));

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
import { getLeaseProvision, getLeaseReleases } from './http/fred.js';
import { FredMCPServer } from './index.js';
import { deployApp } from './tools/deployApp.js';
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';

const mockDeployApp = vi.mocked(deployApp);
const mockGetLeaseProvision = vi.mocked(getLeaseProvision);
const mockGetLeaseReleases = vi.mocked(getLeaseReleases);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);
const mockFetchActiveLease = vi.mocked(fetchActiveLease);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';

let activeTransports: InMemoryTransport[] = [];

function callTool(
  server: FredMCPServer,
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

describe('FredMCPServer', () => {
  // The annotations + _meta.manifest matrix is the contract the
  // manifest-agent plugin relies on to derive its broadcast policy. Pin it
  // explicitly per tool: a change here is a downstream-visible change and
  // should require updating the plugin in lockstep.
  describe('tool annotations + _meta.manifest', () => {
    async function listTools() {
      const server = new FredMCPServer({
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

    it('read-only tools: browse_catalog, app_status, get_logs, app_diagnostics, app_releases', async () => {
      const tools = await listTools();
      const readOnly = [
        'browse_catalog',
        'app_status',
        'get_logs',
        'app_diagnostics',
        'app_releases',
      ] as const;
      for (const name of readOnly) {
        const t = tools.get(name);
        expect(t?.annotations, name).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        });
        expect(t?._meta, name).toEqual({
          manifest: { v: 1, broadcasts: false, estimable: false },
        });
      }
    });

    it('deploy_app broadcasts an additive (non-destructive), fund-spending tx', async () => {
      const t = (await listTools()).get('deploy_app');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: true, estimable: false },
      });
    });

    it('restart_app broadcasts an additive, fund-spending tx (not idempotent: each call triggers a fresh restart cycle)', async () => {
      const t = (await listTools()).get('restart_app');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: true, estimable: false },
      });
    });

    it('update_app broadcasts a destructive (replaces config), fund-spending tx', async () => {
      const t = (await listTools()).get('update_app');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      expect(t?._meta).toEqual({
        manifest: { v: 1, broadcasts: true, estimable: false },
      });
    });
  });

  describe('app_diagnostics', () => {
    it('returns provision diagnostics for a valid lease', async () => {
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'provisioned',
        fail_count: 2,
        last_error: 'image pull timeout',
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.lease_uuid).toBe(LEASE_UUID);
      expect(parsed.provision_status).toBe('provisioned');
      expect(parsed.fail_count).toBe(2);
      expect(parsed.last_error).toBe('image pull timeout');

      expect(mockFetchActiveLease).toHaveBeenCalledWith(
        expect.anything(),
        LEASE_UUID,
        'cannot be diagnosed',
      );
      expect(mockResolveProviderUrl).toHaveBeenCalledWith(
        expect.anything(),
        'prov-1',
      );
      expect(mockGetLeaseProvision).toHaveBeenCalledOnce();
    });

    it('returns error when lease not found on chain', async () => {
      mockFetchActiveLease.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Lease "${LEASE_UUID}" not found on chain`,
        ),
      );

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toContain('not found on chain');
      expect(mockGetLeaseProvision).not.toHaveBeenCalled();
    });

    it('returns error when provider URL resolution fails', async () => {
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Provider "prov-1" has no API URL',
        ),
      );

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toContain('has no API URL');
      expect(mockGetLeaseProvision).not.toHaveBeenCalled();
    });
  });

  describe('app_releases', () => {
    it('returns release history for a valid lease', async () => {
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseReleases.mockResolvedValue({
        lease_uuid: LEASE_UUID,
        tenant: 'manifest1tenant',
        provider_uuid: 'prov-1',
        releases: [
          {
            version: 1,
            image: 'nginx:1.0',
            status: 'active',
            created_at: '2025-01-01T00:00:00Z',
          },
          {
            version: 2,
            image: 'nginx:2.0',
            status: 'deploying',
            created_at: '2025-01-02T00:00:00Z',
            error: 'timeout',
          },
        ],
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_releases', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.lease_uuid).toBe(LEASE_UUID);
      expect(parsed.releases).toHaveLength(2);
      expect(parsed.releases[0]).toEqual({
        version: 1,
        image: 'nginx:1.0',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      });
      expect(parsed.releases[1]).toEqual({
        version: 2,
        image: 'nginx:2.0',
        status: 'deploying',
        created_at: '2025-01-02T00:00:00Z',
        error: 'timeout',
      });

      expect(mockFetchActiveLease).toHaveBeenCalledWith(
        expect.anything(),
        LEASE_UUID,
        'releases are not available',
      );
      expect(mockResolveProviderUrl).toHaveBeenCalledWith(
        expect.anything(),
        'prov-1',
      );
      expect(mockGetLeaseReleases).toHaveBeenCalledOnce();
    });

    it('returns error when lease not found on chain', async () => {
      mockFetchActiveLease.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Lease "${LEASE_UUID}" not found on chain`,
        ),
      );

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_releases', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toContain('not found on chain');
      expect(mockGetLeaseReleases).not.toHaveBeenCalled();
    });

    it('returns error when provider URL resolution fails', async () => {
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockRejectedValue(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Provider "prov-1" has no API URL',
        ),
      );

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_releases', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('QUERY_FAILED');
      expect(parsed.message).toContain('has no API URL');
      expect(mockGetLeaseReleases).not.toHaveBeenCalled();
    });
  });

  describe('missing signArbitrary', () => {
    it('returns INVALID_CONFIG when wallet lacks signArbitrary', async () => {
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(), // no signArbitrary
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.code).toBe('INVALID_CONFIG');
      expect(parsed.message).toContain('signArbitrary');
    });
  });

  describe('deploy_app', () => {
    it('passes gas_multiplier to deployApp input', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'deploy_app', {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        gas_multiplier: 3.5,
      });

      expect(mockDeployApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ gasMultiplier: 3.5 }),
      );
    });
  });
});
