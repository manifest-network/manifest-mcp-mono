import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';

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
});
