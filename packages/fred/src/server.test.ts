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
vi.mock('./tools/checkDeploymentReadiness.js', () => ({
  checkDeploymentReadiness: vi.fn().mockResolvedValue({
    tenant: 'manifest1abc',
    image: null,
    size: null,
    wallet_balances: [{ denom: 'umfx', amount: '5000000' }],
    credits: null,
    sku: null,
    available_sku_names: [],
    ready: false,
    missing_steps: ['Credit account does not exist for this tenant.'],
  }),
}));
vi.mock('./tools/waitForAppReady.js', () => ({
  waitForAppReady: vi.fn().mockResolvedValue({
    lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
    provider_uuid: 'prov-1',
    provider_url: 'https://provider.example.com',
    state: 'LEASE_STATE_ACTIVE',
    status: { state: 3 },
  }),
}));

import {
  CosmosClientManager,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  callTool as callToolHelper,
  type ToolResult,
} from '@manifest-network/manifest-mcp-core/__test-utils__/callTool.js';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { getLeaseProvision, getLeaseReleases } from './http/fred.js';
import { FredMCPServer } from './index.js';
import { checkDeploymentReadiness } from './tools/checkDeploymentReadiness.js';
import { deployApp } from './tools/deployApp.js';
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';
import { waitForAppReady } from './tools/waitForAppReady.js';

const mockDeployApp = vi.mocked(deployApp);
const mockGetLeaseProvision = vi.mocked(getLeaseProvision);
const mockGetLeaseReleases = vi.mocked(getLeaseReleases);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);
const mockFetchActiveLease = vi.mocked(fetchActiveLease);
const mockWaitForAppReady = vi.mocked(waitForAppReady);
const mockCheckDeploymentReadiness = vi.mocked(checkDeploymentReadiness);

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
  // Connects an MCP client to the server over an in-memory transport,
  // pushes both transports into `activeTransports` for afterEach cleanup,
  // runs `fn`, and closes the client. Shared between the resources and
  // prompts blocks; per-test cleanup also runs in the top-level afterEach.
  async function withClient<T>(
    server: FredMCPServer,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    activeTransports.push(clientTransport, serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.getServer().connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

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

    it('read-only tools: browse_catalog, app_status, get_logs, app_diagnostics, app_releases, wait_for_app_ready, build_manifest_preview, check_deployment_readiness', async () => {
      const tools = await listTools();
      const readOnly = [
        'browse_catalog',
        'app_status',
        'get_logs',
        'app_diagnostics',
        'app_releases',
        'wait_for_app_ready',
        'build_manifest_preview',
        'check_deployment_readiness',
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

    it('deploy_app broadcasts an additive (non-destructive), fund-spending tx', async () => {
      const t = (await listTools()).get('deploy_app');
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

    it('restart_app broadcasts an additive, fund-spending tx (not idempotent: each call triggers a fresh restart cycle)', async () => {
      const t = (await listTools()).get('restart_app');
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

    it('update_app broadcasts a destructive (replaces config), fund-spending tx', async () => {
      const t = (await listTools()).get('update_app');
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(t?._meta?.manifest).toEqual({
        v: 1,
        broadcasts: true,
        estimable: false,
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

    it('accepts a provision response without last_error', async () => {
      // Pins the regression caught by nightly e2e: the Fred provider omits
      // last_error when there's no recent failure, so the outputSchema
      // must declare it optional. structuredResponse's JSON.stringify
      // round-trip drops the undefined key entirely; the resulting
      // structuredContent has no `last_error` property and the SDK's
      // output validation must still accept it.
      mockFetchActiveLease.mockResolvedValue({
        providerUuid: 'prov-1',
      } as Awaited<ReturnType<typeof fetchActiveLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'provisioned',
        fail_count: 0,
        last_error: undefined as unknown as string,
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.lease_uuid).toBe(LEASE_UUID);
      expect(sc.provision_status).toBe('provisioned');
      expect(sc.fail_count).toBe(0);
      expect(sc.last_error).toBeUndefined();
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

  describe('resources', () => {
    // Resource contents are a union of text/blob shapes; resources we register
    // always emit text/json so we narrow at the test layer.
    function textOf(content: { text?: string; blob?: string }): string {
      if (typeof content.text !== 'string') {
        throw new Error('resource contents missing text');
      }
      return content.text;
    }

    function withRealQueryClient(): void {
      const qc = makeMockQueryClient({
        billing: {
          activeLeases: [
            {
              uuid: 'a-1',
              providerUuid: 'p1',
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
          pendingLeases: [],
          closedLeases: [
            {
              uuid: 'c-1',
              providerUuid: 'p1',
              createdAt: new Date('2025-12-25T00:00:00Z'),
            },
          ],
        },
        sku: {
          providers: [
            {
              uuid: 'p1',
              address: 'manifest1prov',
              apiUrl: 'https://prov.example',
              active: true,
            },
          ],
          skus: [
            {
              uuid: 'sku-1',
              name: 'docker-micro',
              providerUuid: 'p1',
              basePrice: { amount: '100', denom: 'upwr' },
            },
          ],
        },
      });
      vi.mocked(CosmosClientManager.getInstance).mockReturnValue({
        disconnect: vi.fn(),
        getQueryClient: vi.fn().mockResolvedValue(qc),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({}),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      } as unknown as CosmosClientManager);
    }

    it('lists three resources with manifest:// URIs', async () => {
      withRealQueryClient();
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) => c.listResources());
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toEqual(
        expect.arrayContaining([
          'manifest://leases/active',
          'manifest://leases/recent',
          'manifest://providers',
        ]),
      );
    });

    it('reads manifest://providers as JSON', async () => {
      withRealQueryClient();
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.readResource({ uri: 'manifest://providers' }),
      );
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('application/json');
      const parsed = JSON.parse(textOf(result.contents[0]));
      expect(parsed.providers).toHaveLength(1);
      expect(parsed.providers[0].uuid).toBe('p1');
      expect(parsed.skus[0].name).toBe('docker-micro');
    });

    it('reads manifest://leases/active with tenant and counts', async () => {
      withRealQueryClient();
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.readResource({ uri: 'manifest://leases/active' }),
      );
      const parsed = JSON.parse(textOf(result.contents[0]));
      expect(parsed.tenant).toBe('manifest1abc');
      expect(parsed.counts.active).toBe(1);
      expect(parsed.counts.pending).toBe(0);
      expect(parsed.active[0].uuid).toBe('a-1');
    });

    it('reads manifest://leases/recent (any state, reverse order)', async () => {
      withRealQueryClient();
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.readResource({ uri: 'manifest://leases/recent' }),
      );
      const parsed = JSON.parse(textOf(result.contents[0]));
      expect(parsed.tenant).toBe('manifest1abc');
      expect(parsed.leases.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('prompts', () => {
    it('lists three workflow prompts', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) => c.listPrompts());
      const names = result.prompts.map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'deploy-containerized-app',
          'diagnose-failing-app',
          'shutdown-all-leases',
        ]),
      );
    });

    it('renders deploy-containerized-app with the supplied image/port/size', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.getPrompt({
          name: 'deploy-containerized-app',
          arguments: { image: 'nginx:1.25', port: '80', size: 'docker-micro' },
        }),
      );
      expect(result.messages).toHaveLength(1);
      const m = result.messages[0];
      expect(m.role).toBe('user');
      const text = (m.content as { type: string; text: string }).text;
      expect(text).toContain('nginx:1.25');
      expect(text).toContain('docker-micro');
      // Pins the workflow contract so a downstream change requires test update.
      expect(text).toContain('check_deployment_readiness');
      expect(text).toContain('build_manifest_preview');
      expect(text).toContain('deploy_app');
      expect(text).toContain('wait_for_app_ready');
    });

    it('renders diagnose-failing-app with the supplied lease_uuid', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.getPrompt({
          name: 'diagnose-failing-app',
          arguments: { lease_uuid: LEASE_UUID },
        }),
      );
      const text = (
        result.messages[0].content as { type: string; text: string }
      ).text;
      expect(text).toContain(LEASE_UUID);
      expect(text).toContain('app_status');
      expect(text).toContain('app_diagnostics');
      expect(text).toContain('get_logs');
    });

    it('renders shutdown-all-leases without arguments', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await withClient(server, (c) =>
        c.getPrompt({ name: 'shutdown-all-leases' }),
      );
      const text = (
        result.messages[0].content as { type: string; text: string }
      ).text;
      expect(text).toContain('manifest://leases/active');
      expect(text).toContain('close_lease');
    });
  });

  describe('check_deployment_readiness', () => {
    it('forwards size and image to the tool function', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'check_deployment_readiness', {
        size: 'docker-micro',
        image: 'nginx:alpine',
      });

      expect(result.isError).toBeUndefined();
      expect(mockCheckDeploymentReadiness).toHaveBeenCalledWith(
        expect.anything(),
        'manifest1abc',
        { size: 'docker-micro', image: 'nginx:alpine' },
      );
      expect(result.structuredContent).toMatchObject({
        ready: false,
        missing_steps: expect.any(Array),
      });
    });
  });

  describe('build_manifest_preview', () => {
    it('returns canonical manifest, meta_hash, and validation', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'build_manifest_preview', {
        image: 'nginx:1.25',
        port: 80,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        format: 'single',
        validation: { valid: true, errors: [] },
      });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.meta_hash_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof sc.manifest_json).toBe('string');
    });

    it('reports validation errors without erroring the call', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const result = await callTool(server, 'build_manifest_preview', {
        image: 'nginx:1.25',
        port: 80,
        env: { PATH: '/bin' },
      });

      expect(result.isError).toBeUndefined();
      const sc = result.structuredContent as {
        validation: { valid: boolean; errors: string[] };
      };
      expect(sc.validation.valid).toBe(false);
      expect(sc.validation.errors.some((e) => e.includes('PATH'))).toBe(true);
    });
  });

  describe('wait_for_app_ready', () => {
    it('forwards lease_uuid and converts seconds to milliseconds', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'wait_for_app_ready', {
        lease_uuid: LEASE_UUID,
        timeout_seconds: 30,
        interval_seconds: 5,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        lease_uuid: LEASE_UUID,
        state: 'LEASE_STATE_ACTIVE',
      });

      expect(mockWaitForAppReady).toHaveBeenCalledWith(
        expect.anything(),
        'manifest1abc',
        LEASE_UUID,
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 30_000,
          intervalMs: 5_000,
        }),
      );
    });

    it('omits timeout/interval when not provided', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'wait_for_app_ready', { lease_uuid: LEASE_UUID });

      const opts = mockWaitForAppReady.mock.calls.at(-1)?.[4];
      expect(opts).toMatchObject({
        timeoutMs: undefined,
        intervalMs: undefined,
      });
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

    it('omits progress callbacks when client does not request progress', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'deploy_app', {
        image: 'nginx',
        port: 80,
        size: 'docker-micro',
      });

      const input = mockDeployApp.mock.calls.at(-1)?.[3];
      expect(input?.onLeaseCreated).toBeUndefined();
      expect(input?.pollOptions).toBeUndefined();
    });

    it('fans deployApp lifecycle callbacks out as MCP progress notifications', async () => {
      // Drive the deployApp mock through onLeaseCreated and two onProgress
      // ticks so we can assert the server-side wiring forwards them as
      // notifications/progress messages over the wire.
      mockDeployApp.mockImplementationOnce(async (_cm, _a, _b, input) => {
        await input.onLeaseCreated?.(
          'lease-uuid-1',
          'https://provider.example.com',
        );
        input.pollOptions?.onProgress?.({
          state: LeaseState.LEASE_STATE_PENDING,
          provision_status: 'image_pulling',
        } as unknown as Parameters<
          NonNullable<typeof input.pollOptions.onProgress>
        >[0]);
        input.pollOptions?.onProgress?.({
          state: LeaseState.LEASE_STATE_ACTIVE,
        } as unknown as Parameters<
          NonNullable<typeof input.pollOptions.onProgress>
        >[0]);
        return {
          lease_uuid: 'lease-uuid-1',
          provider_uuid: 'p1',
          provider_url: 'https://provider.example.com',
          state: LeaseState.LEASE_STATE_ACTIVE,
        } as unknown as Awaited<ReturnType<typeof deployApp>>;
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      activeTransports.push(clientTransport, serverTransport);
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await server.getServer().connect(serverTransport);
      await client.connect(clientTransport);

      const messages: string[] = [];
      try {
        await client.callTool(
          {
            name: 'deploy_app',
            arguments: {
              image: 'nginx',
              port: 80,
              size: 'docker-micro',
            },
          },
          undefined,
          {
            onprogress: (p) => {
              if (p.message) messages.push(p.message);
            },
          },
        );
      } finally {
        await client.close();
      }

      expect(messages).toHaveLength(3);
      expect(messages[0]).toContain('lease-uuid-1');
      expect(messages[1]).toMatch(/PENDING/);
      expect(messages[1]).toMatch(/image_pulling/);
      expect(messages[2]).toMatch(/ACTIVE/);
    });
  });
});
