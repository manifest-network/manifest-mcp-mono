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
    // restore_app is deliberately NOT mocked at the tool layer (see the ENG-666
    // block below), so its HTTP leg has to be stubbed here or it would reach the
    // network.
    restoreLease: vi.fn(),
  };
});

vi.mock('./tools/createLease.js', () => ({ createLease: vi.fn() }));

vi.mock('./tools/resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

vi.mock('./tools/fetchActiveLease.js', () => ({
  fetchActiveLease: vi.fn(),
}));

vi.mock('./tools/fetchLease.js', () => ({
  fetchLease: vi.fn(),
}));

vi.mock('./tools/browseCatalog.js', () => ({
  browseCatalog: vi.fn().mockResolvedValue({ providers: [], skus: [] }),
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
    sku_candidates: [],
    available_skus: [],
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
import {
  getLeaseProvision,
  getLeaseReleases,
  restoreLease,
} from './http/fred.js';
import { FredMCPServer } from './server/index.js';
import { appStatus } from './tools/appStatus.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { checkDeploymentReadiness } from './tools/checkDeploymentReadiness.js';
import { createLease } from './tools/createLease.js';
import { deployApp } from './tools/deployApp.js';
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { fetchLease } from './tools/fetchLease.js';
import { getAppLogs } from './tools/getLogs.js';
import { MAX_LEASE_STATUS_CHARS } from './tools/projectLeaseStatus.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';
import { restartApp } from './tools/restartApp.js';
import { updateApp } from './tools/updateApp.js';
import { waitForAppReady } from './tools/waitForAppReady.js';

const mockDeployApp = vi.mocked(deployApp);
const mockGetLeaseProvision = vi.mocked(getLeaseProvision);
const mockGetLeaseReleases = vi.mocked(getLeaseReleases);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);
const mockFetchActiveLease = vi.mocked(fetchActiveLease);
const mockFetchLease = vi.mocked(fetchLease);
const mockWaitForAppReady = vi.mocked(waitForAppReady);
const mockCheckDeploymentReadiness = vi.mocked(checkDeploymentReadiness);
const mockBrowseCatalog = vi.mocked(browseCatalog);
const mockAppStatus = vi.mocked(appStatus);
const mockGetAppLogs = vi.mocked(getAppLogs);
const mockRestartApp = vi.mocked(restartApp);
const mockUpdateApp = vi.mocked(updateApp);
const mockCreateLease = vi.mocked(createLease);
const mockRestoreLease = vi.mocked(restoreLease);

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

    it('restore_app broadcasts an additive (non-destructive), non-idempotent recovery tx (ENG-599)', async () => {
      const t = (await listTools()).get('restore_app');
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
  });

  describe('app_diagnostics', () => {
    it('returns provision diagnostics for a valid lease', async () => {
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
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
      // Pre-ENG-508 provider: the deprecated key is echoed AND surfaced on the
      // canonical `message`, so a caller reading either works (ENG-638).
      expect(parsed.last_error).toBe('image pull timeout');
      expect(parsed.message).toBe('image pull timeout');
      // No reason on the wire => no fabricated one, and no derived guidance.
      expect(parsed.reason).toBeUndefined();
      expect(parsed.next_step).toBeUndefined();

      expect(mockFetchLease).toHaveBeenCalledWith(
        expect.anything(),
        LEASE_UUID,
      );
      expect(mockResolveProviderUrl).toHaveBeenCalledWith(
        expect.anything(),
        'prov-1',
      );
      expect(mockGetLeaseProvision).toHaveBeenCalledOnce();
      // Deliberate positional pin. app_diagnostics has no `ctx.fetch` seam — it calls
      // getLeaseProvision directly (server/register-tools.ts) — so the SSRF wiring
      // (ENG-268, ENG-490) is only observable on the argument list. Slots are counted
      // from the START, never the end: these used to read `.at(-2)` / `.at(-1)`, which
      // silently slide onto different arguments when the tail grows rather than failing
      // (ENG-706). getLeaseProvision is (providerUrl, leaseUuid, authToken, fetchFn,
      // allowLoopback), so fetchFn is slot 3 and allowLoopback slot 4.
      const [, , , fetchFn, allowLoopback] =
        mockGetLeaseProvision.mock.lastCall!;
      expect(typeof fetchFn).toBe('function');
      // The guarded fetch, not the global one — `typeof` alone cannot tell them apart.
      expect(fetchFn).not.toBe(globalThis.fetch);
      expect(allowLoopback).toBe(false);
    });

    it('surfaces sanitized retention fields for a retained CLOSED lease (ENG-600)', async () => {
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_CLOSED,
      } as Awaited<ReturnType<typeof fetchLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'retained',
        fail_count: 0,
        retained_until: '2026-08-01T00:00:00Z',
        // Control char proves the sanitize projection is WIRED, not clean-string pass-through.
        items: [{ sku: `s1${String.fromCharCode(0x202e)}`, quantity: 1 }],
        restore_hint: `restore${String.fromCharCode(0x202e)}me`,
        partition: 'p',
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
      expect(parsed.provision_status).toBe('retained');
      expect(parsed.retained_until).toBe('2026-08-01T00:00:00Z');
      expect(parsed.restore_hint).toBe('restore me'); // sanitized (bidi → space)
      expect(parsed.items?.[0]?.sku).toBe('s1');
      // partition is omitted from the AI-facing projection (Decision 6).
      expect(parsed.partition).toBeUndefined();
    });

    it('returns a benign early result for a non-provisionable (REJECTED) lease without querying the provider (ENG-600)', async () => {
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_REJECTED,
      } as Awaited<ReturnType<typeof fetchLease>>);

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.provision_status).toBe('LEASE_STATE_REJECTED');
      expect(parsed.fail_count).toBe(0);
      // Never provisioned → the provider is not queried.
      expect(mockResolveProviderUrl).not.toHaveBeenCalled();
      expect(mockGetLeaseProvision).not.toHaveBeenCalled();
    });

    it('accepts a provision response with no failure fields at all', async () => {
      // Pins the regression caught by nightly e2e: the Fred provider omits the
      // failure fields when there's no recent failure, so every one must be
      // declared optional. structuredResponse's JSON.stringify round-trip drops
      // the undefined keys entirely; the SDK's output validation must accept
      // the result anyway.
      //
      // ENG-638 NOTE: this test used to assert only that an absent `last_error`
      // was accepted — which post-ENG-508 is true for EVERY response, since Fred
      // no longer sends the field at all. It therefore passed *because of* the
      // break it was meant to guard. It now pins the healthy case explicitly:
      // no reason, no message, no derived guidance, and no legacy key.
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'provisioned',
        fail_count: 0,
        // All of reason/message/last_error are optional; omit them to model a
        // healthy provider response from EITHER wire era.
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
      expect(sc.reason).toBeUndefined();
      expect(sc.message).toBeUndefined();
      expect(sc.next_step).toBeUndefined();
    });

    it('surfaces reason/message/next_step from a post-ENG-508 provider', async () => {
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'failed',
        fail_count: 3,
        reason: 'ImagePullFailed',
        message: 'image pull failed',
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      // isError undefined also proves the outputSchema ACCEPTS the new keys.
      expect(result.isError).toBeUndefined();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.reason).toBe('ImagePullFailed');
      expect(sc.message).toBe('image pull failed');
      // Derived by this server from the reason — the actionable half the enum
      // name alone does not carry.
      expect(sc.next_step).toContain('update_app');
      // Nothing fabricates the removed legacy key.
      expect(sc.last_error).toBeUndefined();
    });

    it('passes an UNRECOGNIZED reason through with NO next_step', async () => {
      // Fred's reason set is open and add-only. A newer provider's value must
      // reach the model verbatim (never rejected by the schema — which is why
      // `reason` is z.string() and not z.enum), and the absence of guidance is
      // what tells the caller to fall back to `message`.
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'failed',
        fail_count: 1,
        reason: 'SomeFutureReason',
        message: 'a cause this client has never heard of',
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
      expect(sc.reason).toBe('SomeFutureReason');
      expect(sc.message).toBe('a cause this client has never heard of');
      expect(sc.next_step).toBeUndefined();
    });

    it('sanitizes a provider-injected control char in message (ENG-555)', async () => {
      // Proves sanitizeFailureFields is actually WIRED here, not merely correct
      // in its own unit test — the ENG-600 bidi-injection pattern.
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      mockGetLeaseProvision.mockResolvedValue({
        status: 'failed',
        fail_count: 1,
        reason: 'ContainerExited',
        // RIGHT-TO-LEFT OVERRIDE (U+202E), written as an escape.
        message: `exit 1${String.fromCharCode(0x202e)}gnitseuqer`,
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_diagnostics', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        String.fromCharCode(0x202e),
      );
    });

    it('returns error when lease not found on chain', async () => {
      mockFetchLease.mockRejectedValue(
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
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
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
    it('surfaces + sanitizes a post-ENG-508 failed release (ENG-638)', async () => {
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
            version: 3,
            image: 'nginx:3.0',
            status: 'failed',
            created_at: '2025-01-03T00:00:00Z',
            reason: 'UpdateFailed',
            // RIGHT-TO-LEFT OVERRIDE (U+202E) — the raw element is forwarded
            // wholesale through a looseObject, so this proves the per-element
            // sanitize is wired and the raw key cannot survive the spread.
            message: `update failed${String.fromCharCode(0x202e)}kcab dellor`,
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
      expect(parsed.releases[0].reason).toBe('UpdateFailed');
      expect(parsed.releases[0].message).toContain('update failed');
      expect(JSON.stringify(parsed.releases)).not.toContain(
        String.fromCharCode(0x202e),
      );
    });

    it('does not let a MALFORMED provider reason break the tool', async () => {
      // This server-layer test deliberately mocks below the HTTP schema, just as a
      // direct library caller can supply an already-constructed DTO. The projector
      // remains defensive: sanitizeFailureFields drops a non-string `reason`, and
      // stripping the raw key first prevents it surviving the sanitized spread and
      // failing the declared `reason: z.string()` output schema.
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
            version: 4,
            image: 'nginx:4.0',
            status: 'failed',
            created_at: '2025-01-04T00:00:00Z',
            // Neither is a non-empty string: both are dropped by the sanitizer.
            reason: 12345,
            message: '',
          },
        ],
      } as never);

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_releases', {
        lease_uuid: LEASE_UUID,
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // The malformed values are gone, not forwarded.
      expect(parsed.releases[0].reason).toBeUndefined();
      expect(parsed.releases[0].message).toBeUndefined();
      // The rest of the element still comes through.
      expect(parsed.releases[0].version).toBe(4);
      expect(parsed.releases[0].status).toBe('failed');
    });

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
      expect(parsed.release_count).toBe(2);
      expect(parsed.truncated).toBe(false);
      // These fixtures carry no `manifest`, so the element shape is unchanged and
      // stays exactly pinned.
      expect(parsed.releases[0]).toEqual({
        version: 1,
        image: 'nginx:1.0',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      });
      // Pre-ENG-508 release: the deprecated `error` is echoed AND surfaced on
      // the canonical `message` key, so a caller reading either keeps working
      // across the provider fleet's upgrade (ENG-638). Deliberately still
      // toEqual, not toMatchObject — the projection stays exactly pinned.
      expect(parsed.releases[1]).toEqual({
        version: 2,
        image: 'nginx:2.0',
        status: 'deploying',
        created_at: '2025-01-02T00:00:00Z',
        error: 'timeout',
        message: 'timeout',
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
      // Deliberate positional pin — same contract and same reasoning as the
      // app_diagnostics case above (ENG-268, ENG-490, ENG-706). getLeaseReleases is
      // (providerUrl, leaseUuid, authToken, fetchFn, allowLoopback).
      const [, , , fetchFn, allowLoopback] =
        mockGetLeaseReleases.mock.lastCall!;
      expect(typeof fetchFn).toBe('function');
      expect(fetchFn).not.toBe(globalThis.fetch);
      expect(allowLoopback).toBe(false);
    });

    it('never forwards a release manifest into model context (ENG-669)', async () => {
      mockFetchActiveLease.mockResolvedValue({
        uuid: LEASE_UUID,
        providerUuid: 'prov-1',
      } as never);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      // Fred sends the full base64 manifest on EVERY release (no omitempty), and
      // structuredResponse duplicates structuredContent into the text content — so
      // this used to land in context twice, ~800 KB for one release.
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
            manifest: 'A'.repeat(400_000),
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

      // Asserting on the serialized text catches BOTH copies at once.
      expect(result.content[0].text.length).toBeLessThan(5_000);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.releases[0]).not.toHaveProperty('manifest');
      // 400_000 base64 chars, no padding → 300_000 bytes.
      expect(parsed.releases[0].manifest_bytes).toBe(300_000);
    });

    it('caps how many releases reach model context and says it did (ENG-669)', async () => {
      mockFetchActiveLease.mockResolvedValue({
        uuid: LEASE_UUID,
        providerUuid: 'prov-1',
      } as never);
      mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
      // Neither side paginates and Fred prunes by age, never by count, so history
      // length is a second unbounded dimension independent of the manifest blob.
      mockGetLeaseReleases.mockResolvedValue({
        lease_uuid: LEASE_UUID,
        tenant: 'manifest1tenant',
        provider_uuid: 'prov-1',
        releases: Array.from({ length: 30 }, (_, i) => ({
          version: i + 1,
          image: `nginx:${i + 1}`,
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
        })),
      });

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_releases', {
        lease_uuid: LEASE_UUID,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.releases).toHaveLength(20);
      // The newest window, and the true total so the model knows more exist.
      expect(parsed.releases[0].version).toBe(11);
      expect(parsed.release_count).toBe(30);
      expect(parsed.truncated).toBe(true);
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
      mockFetchLease.mockResolvedValue({
        providerUuid: 'prov-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
      } as Awaited<ReturnType<typeof fetchLease>>);
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
      // ENG-638: this prompt is a shipped runtime artifact, so the fields it
      // tells the model to read are part of the contract. Before this, the test
      // asserted only the tool names — the prompt could have gone on naming a
      // field Fred no longer sends without anything failing.
      expect(text).toContain('reason');
      expect(text).toContain('message');
      expect(text).toContain('next_step');
      // The two facts a model cannot infer from the enum name.
      expect(text).toContain('may EXTEND');
      expect(text).toContain('UpdateFailed');
      expect(text).not.toContain(
        'record provision_status, fail_count, and last_error',
      );
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
      const [, address, readinessInput] =
        mockCheckDeploymentReadiness.mock.calls[0]!;
      expect({ address, readinessInput }).toEqual({
        address: 'manifest1abc',
        readinessInput: {
          size: 'docker-micro',
          image: 'nginx:alpine',
          providerUuid: undefined,
          skuUuid: undefined,
        },
      });
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
        // ctx — the SSRF-guarded fetch lives on ctx.fetch (ENG-268/311).
        expect.objectContaining({
          query: expect.anything(),
          chain: expect.anything(),
          fetch: expect.any(Function),
          logger: expect.anything(),
          providerAuth: expect.anything(),
        }),
        expect.objectContaining({
          address: 'manifest1abc',
          leaseUuid: LEASE_UUID,
        }),
        expect.objectContaining({
          timeoutMs: 30_000,
          intervalMs: 5_000,
        }),
      );
    });

    it('caps provider status before it reaches model context and reports truncation', async () => {
      mockWaitForAppReady.mockResolvedValueOnce({
        lease_uuid: LEASE_UUID,
        provider_uuid: 'prov-1',
        provider_url: 'https://provider.example.com',
        state: 'LEASE_STATE_ACTIVE',
        status: {
          state: LeaseState.LEASE_STATE_ACTIVE,
          provision_status: 'ready',
          giant_extension: 'x'.repeat(MAX_LEASE_STATUS_CHARS),
        },
      } as Awaited<ReturnType<typeof waitForAppReady>>);

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'wait_for_app_ready', {
        lease_uuid: LEASE_UUID,
      });
      const output = result.structuredContent as {
        status: Record<string, unknown>;
        status_truncated: boolean;
      };

      expect(output.status).toMatchObject({
        state: LeaseState.LEASE_STATE_ACTIVE,
        provision_status: 'ready',
      });
      expect(output.status.giant_extension).toBeUndefined();
      expect(output.status_truncated).toBe(true);
      expect(JSON.stringify(output.status).length).toBeLessThanOrEqual(
        MAX_LEASE_STATUS_CHARS,
      );
    });

    it('sanitizes readiness status and omits the owner-only partition key', async () => {
      mockWaitForAppReady.mockResolvedValueOnce({
        lease_uuid: LEASE_UUID,
        provider_uuid: 'prov-1',
        provider_url: 'https://provider.example.com',
        state: 'LEASE_STATE_ACTIVE',
        status: {
          state: LeaseState.LEASE_STATE_ACTIVE,
          partition: 'owner-only',
          reason: 'ImagePull\u202eFailed\nretry',
          restore_hint: 'restore\u202e\nnow',
        },
      } as Awaited<ReturnType<typeof waitForAppReady>>);

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'wait_for_app_ready', {
        lease_uuid: LEASE_UUID,
      });
      const output = result.structuredContent as {
        status: Record<string, unknown>;
      };

      expect(output.status.partition).toBeUndefined();
      expect(output.status.reason).toBe('ImagePull Failed retry');
      expect(output.status.restore_hint).toBe('restore now');
    });

    it('omits timeout/interval when not provided', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'wait_for_app_ready', { lease_uuid: LEASE_UUID });

      const opts = mockWaitForAppReady.mock.calls.at(-1)?.[2];
      expect(opts).toMatchObject({
        timeoutMs: undefined,
        intervalMs: undefined,
      });
    });
  });

  describe('app_status model-context budget', () => {
    it('caps fredStatus while leaving the chain projection intact', async () => {
      mockAppStatus.mockResolvedValueOnce({
        lease_uuid: LEASE_UUID,
        chainState: {
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
          createdAt: '2026-08-26T00:00:00.000Z',
          closedAt: undefined,
          items: [],
        },
        fredStatus: {
          state: LeaseState.LEASE_STATE_ACTIVE,
          provision_status: 'ready',
          giant_extension: 'x'.repeat(MAX_LEASE_STATUS_CHARS),
        },
      } as Awaited<ReturnType<typeof appStatus>>);

      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'app_status', {
        lease_uuid: LEASE_UUID,
      });
      const output = result.structuredContent as {
        chainState: { providerUuid: string };
        fredStatus: Record<string, unknown>;
        fredStatusTruncated: boolean;
      };

      expect(output.chainState.providerUuid).toBe('prov-1');
      expect(output.fredStatus).toMatchObject({
        state: LeaseState.LEASE_STATE_ACTIVE,
        provision_status: 'ready',
      });
      expect(output.fredStatus.giant_extension).toBeUndefined();
      expect(output.fredStatusTruncated).toBe(true);
    });
  });

  describe('deploy_app', () => {
    it('routes gas_multiplier to deployApp callOptions', async () => {
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
        // The FredAuthCtx — carries the SSRF-guarded fetch injected by
        // FredMCPServer (ENG-268) plus the providerAuth port.
        expect.objectContaining({
          query: expect.anything(),
          chain: expect.anything(),
          fetch: expect.any(Function),
          logger: expect.anything(),
          providerAuth: expect.anything(),
        }),
        expect.objectContaining({
          image: 'nginx:alpine',
          size: 'docker-micro',
        }),
        expect.objectContaining({ gasMultiplier: 3.5 }),
      );
    });

    it('maps custom_domain and service_name (snake_case) to customDomain/serviceName (camelCase) on the helper input', async () => {
      // The MCP-tool layer renames per project convention. A missed rename
      // here would only surface in e2e — this test pins the mapping so a
      // future schema change can't drift the field name silently.
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'deploy_app', {
        size: 'docker-micro',
        services: { web: { image: 'nginx', ports: { '80/tcp': {} } } },
        custom_domain: 'app.example.com',
        service_name: 'web',
      });

      expect(mockDeployApp).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.anything(),
          chain: expect.anything(),
          fetch: expect.any(Function),
          logger: expect.anything(),
          providerAuth: expect.anything(),
        }),
        expect.objectContaining({
          customDomain: 'app.example.com',
          serviceName: 'web',
        }),
        // callOptions content is asserted in the gas_multiplier test above; here we only pin the spec mapping
        expect.any(Object),
      );
    });

    it('rejects a service_name that is not a valid RFC 1123 DNS label at the MCP boundary', async () => {
      // Mirrors the lease package's set_item_custom_domain regex enforcement
      // so a malformed service_name fails fast at the tool boundary instead
      // of slipping through to deployApp's services-membership check (which
      // only catches mismatch, not malformedness).
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      const result = await callTool(server, 'deploy_app', {
        size: 'docker-micro',
        services: { web: { image: 'nginx', ports: { '80/tcp': {} } } },
        custom_domain: 'app.example.com',
        service_name: 'NotALabel',
      });

      expect(result.isError).toBe(true);
      expect(mockDeployApp).not.toHaveBeenCalled();
    });

    it('does not set customDomain/serviceName on the helper input when the schema fields are omitted', async () => {
      const server = new FredMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet({ signArbitrary: true }),
      });
      await callTool(server, 'deploy_app', {
        image: 'nginx',
        port: 80,
        size: 'docker-micro',
      });

      const input = mockDeployApp.mock.calls.at(-1)?.[1];
      expect(input?.customDomain).toBeUndefined();
      expect(input?.serviceName).toBeUndefined();
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

      const callOptions = mockDeployApp.mock.calls.at(-1)?.[2];
      expect(callOptions?.onLeaseCreated).toBeUndefined();
      // Left ENTIRELY undefined, not `{}`: that is the contract that lets
      // fred's own poll defaults apply (ENG-661).
      expect(callOptions?.pollOptions).toBeUndefined();
    });

    /**
     * ENG-661. `deploy_app` exposed no timeout knob at all, so an MCP caller
     * could not raise the readiness deadline — while the sibling
     * `wait_for_app_ready` had one all along.
     */
    describe('timeout_seconds', () => {
      it('converts seconds to milliseconds on the poll options', async () => {
        const server = new FredMCPServer({
          config: makeMockConfig(),
          walletProvider: makeMockWallet({ signArbitrary: true }),
        });
        await callTool(server, 'deploy_app', {
          image: 'nginx',
          port: 80,
          size: 'docker-micro',
          timeout_seconds: 45,
        });

        const callOptions = mockDeployApp.mock.calls.at(-1)?.[2];
        expect(callOptions?.pollOptions?.timeoutMs).toBe(45_000);
        // No progress token in this call, so nothing else rides along.
        expect(callOptions?.pollOptions?.onProgress).toBeUndefined();
      });

      it('rejects an out-of-range value before deployApp is reached', async () => {
        const server = new FredMCPServer({
          config: makeMockConfig(),
          walletProvider: makeMockWallet({ signArbitrary: true }),
        });
        mockDeployApp.mockClear();
        const result = await callTool(server, 'deploy_app', {
          image: 'nginx',
          port: 80,
          size: 'docker-micro',
          timeout_seconds: 0,
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('timeout_seconds');
        expect(mockDeployApp).not.toHaveBeenCalled();
      });
    });

    it('fans deployApp lifecycle callbacks out as MCP progress notifications', async () => {
      // Drive the deployApp mock through onLeaseCreated and two onProgress
      // ticks so we can assert the server-side wiring forwards them as
      // notifications/progress messages over the wire.
      mockDeployApp.mockImplementationOnce(async (_ctx, _spec, callOptions) => {
        await callOptions?.onLeaseCreated?.(
          'lease-uuid-1',
          'https://provider.example.com',
        );
        callOptions?.pollOptions?.onProgress?.({
          state: LeaseState.LEASE_STATE_PENDING,
          provision_status: 'image_pulling',
        } as unknown as Parameters<
          NonNullable<
            NonNullable<
              NonNullable<typeof callOptions>['pollOptions']
            >['onProgress']
          >
        >[0]);
        callOptions?.pollOptions?.onProgress?.({
          state: LeaseState.LEASE_STATE_ACTIVE,
        } as unknown as Parameters<
          NonNullable<
            NonNullable<
              NonNullable<typeof callOptions>['pollOptions']
            >['onProgress']
          >
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

describe('SSRF guard wiring (ENG-268)', () => {
  // FredMCPServer injects an SSRF-guarded fetch as the FINAL positional arg of
  // every outbound-HTTP tool call (default ON). These pin the trailing fetchFn
  // at each tool-layer call site so a future refactor that drops the argument
  // can't silently fall back to unguarded globalThis.fetch. (The two
  // direct-HTTP sites, app_diagnostics/app_releases, are pinned in their own
  // tests above; the guard's blocking behavior is covered by core's
  // guarded-fetch.test.ts, and the gate logic by fetch-gate.test.ts.)
  const ORIG_GUARD_ENV = process.env.MANIFEST_FRED_FETCH_GUARDED;
  afterEach(() => {
    if (ORIG_GUARD_ENV === undefined) {
      delete process.env.MANIFEST_FRED_FETCH_GUARDED;
    } else {
      process.env.MANIFEST_FRED_FETCH_GUARDED = ORIG_GUARD_ENV;
    }
  });

  function makeServer(): FredMCPServer {
    return new FredMCPServer({
      config: makeMockConfig(),
      walletProvider: makeMockWallet({ signArbitrary: true }),
    });
  }

  const cases: Array<{
    tool: string;
    input: Record<string, unknown>;
    lastFetchArg: () => unknown;
  }> = [
    {
      tool: 'browse_catalog',
      input: {},
      lastFetchArg: () => mockBrowseCatalog.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'app_status',
      input: { lease_uuid: LEASE_UUID },
      lastFetchArg: () => mockAppStatus.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'get_logs',
      input: { lease_uuid: LEASE_UUID },
      lastFetchArg: () => mockGetAppLogs.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'restart_app',
      input: { lease_uuid: LEASE_UUID },
      lastFetchArg: () => mockRestartApp.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'wait_for_app_ready',
      input: { lease_uuid: LEASE_UUID },
      lastFetchArg: () => mockWaitForAppReady.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'deploy_app',
      input: { image: 'nginx:alpine', port: 80, size: 'docker-micro' },
      lastFetchArg: () => mockDeployApp.mock.lastCall?.[0]?.fetch,
    },
    {
      tool: 'update_app',
      input: { lease_uuid: LEASE_UUID, manifest: '{"services":{}}' },
      lastFetchArg: () => mockUpdateApp.mock.lastCall?.[0]?.fetch,
    },
  ];

  for (const { tool, input, lastFetchArg } of cases) {
    it(`${tool} threads a guarded fetch (not globalThis.fetch) by default`, async () => {
      const server = makeServer();
      await callTool(server, tool, input);
      const fetchArg = lastFetchArg();
      expect(typeof fetchArg).toBe('function');
      expect(fetchArg).not.toBe(globalThis.fetch);
    });
  }

  it('opt-out (MANIFEST_FRED_FETCH_GUARDED=0) threads no guarded fetch', async () => {
    process.env.MANIFEST_FRED_FETCH_GUARDED = '0';
    const server = makeServer();
    await callTool(server, 'app_status', { lease_uuid: LEASE_UUID });
    expect(mockAppStatus.mock.lastCall?.[0]?.fetch).toBe(globalThis.fetch);
  });

  // Both SSRF layers (connect-guard + provider-URL string check) share one
  // switch: with the guard OFF, the server relaxes the provider-URL SSRF check
  // to allow loopback via ctx.allowLoopback (needed for e2e's loopback
  // providerd). Default/ON stays strict. (ENG-490)
  it('opt-out (MANIFEST_FRED_FETCH_GUARDED=0) sets ctx.allowLoopback=true', async () => {
    process.env.MANIFEST_FRED_FETCH_GUARDED = '0';
    const server = makeServer();
    await callTool(server, 'browse_catalog', {});
    expect(mockBrowseCatalog.mock.lastCall?.[0]?.allowLoopback).toBe(true);
  });

  it('default (guard ON) keeps ctx.allowLoopback=false (strict)', async () => {
    delete process.env.MANIFEST_FRED_FETCH_GUARDED;
    const server = makeServer();
    await callTool(server, 'browse_catalog', {});
    expect(mockBrowseCatalog.mock.lastCall?.[0]?.allowLoopback).toBe(false);
  });

  it('explicit ON (MANIFEST_FRED_FETCH_GUARDED=1) keeps ctx.allowLoopback=false', async () => {
    process.env.MANIFEST_FRED_FETCH_GUARDED = '1';
    const server = makeServer();
    await callTool(server, 'browse_catalog', {});
    expect(mockBrowseCatalog.mock.lastCall?.[0]?.allowLoopback).toBe(false);
  });
});

// Two contracts on one call shape:
//   - fire-and-return (ENG-488): the tools pass `pollOptions: false` so adopting
//     restartApp/updateApp's default-poll does not make them block ~2 min;
//   - cancellable (ENG-666): they pass the request's `extra.signal`, without which
//     every abort guard inside the tool functions is dead code.
// These invoke the handler (the annotation-matrix tests above only read metadata),
// pinning both so either regression is caught.
describe('restart_app / update_app call shape (ENG-488, ENG-666)', () => {
  function makeServer(): FredMCPServer {
    return new FredMCPServer({
      config: makeMockConfig(),
      walletProvider: makeMockWallet({ signArbitrary: true }),
    });
  }

  it('restart_app opts out of the poll and forwards the request signal', async () => {
    const server = makeServer();
    await callTool(server, 'restart_app', { lease_uuid: LEASE_UUID });
    expect(mockRestartApp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseUuid: LEASE_UUID }),
      expect.objectContaining({ pollOptions: false }),
    );
    const opts = mockRestartApp.mock.calls.at(-1)?.[2];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('update_app opts out of the poll and forwards the request signal', async () => {
    const server = makeServer();
    await callTool(server, 'update_app', {
      lease_uuid: LEASE_UUID,
      manifest: '{"services":{}}',
    });
    expect(mockUpdateApp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseUuid: LEASE_UUID }),
      expect.objectContaining({ pollOptions: false }),
    );
    const opts = mockUpdateApp.mock.calls.at(-1)?.[2];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });
});

// The seam ENG-666 exposed: restoreApp's abort guards were 100% unit-tested and 0%
// reachable, because the handler never took `extra`. This drives the REAL restoreApp
// (it is deliberately not mocked in this file) through the MCP transport, so it fails
// if the handler ever stops threading the signal again.
describe('MCP cancellation reaches the lifecycle tools (ENG-666)', () => {
  // Must satisfy zod's strict uuid check (version + variant nibbles), or the handler
  // rejects at schema validation and the test never reaches restoreApp at all.
  const SOURCE_UUID = '550e8400-e29b-41d4-a716-446655440001';

  // The shared callTool helper does not forward RequestOptions, and widening it would
  // touch four packages — so drive the client directly here.
  async function callToolWithSignal(
    server: FredMCPServer,
    toolName: string,
    toolInput: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    activeTransports.push(clientTransport, serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.getServer().connect(serverTransport);
    await client.connect(clientTransport);
    return client.callTool(
      { name: toolName, arguments: toolInput },
      undefined,
      { signal },
    );
  }

  it('cancelling restore_app during its pre-flight reads creates no lease', async () => {
    const server = new FredMCPServer({
      config: makeMockConfig(),
      walletProvider: makeMockWallet({ signArbitrary: true }),
    });
    mockFetchLease.mockResolvedValue({
      uuid: SOURCE_UUID,
      state: 4,
      providerUuid: 'prov-1',
      metaHash: new Uint8Array([1, 2]),
      items: [{ skuUuid: 'sku-1', quantity: 1n }],
    } as never);
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    const ac = new AbortController();
    // Cancel mid-flight, from inside the last pre-flight read. The macrotask lets
    // notifications/cancelled round-trip and abort the server-side handler signal
    // before restoreApp reaches its pre-broadcast guard.
    mockGetLeaseProvision.mockImplementation(async () => {
      ac.abort();
      await new Promise((r) => setTimeout(r, 0));
      return { status: 'retained', fail_count: 0 };
    });

    await expect(
      callToolWithSignal(
        server,
        'restore_app',
        { source_lease_uuid: SOURCE_UUID },
        ac.signal,
      ),
    ).rejects.toThrow();

    // The client rejects the moment it aborts, while the server handler is still
    // running — drain the server side before asserting on it, or the "no broadcast"
    // check would pass simply by observing too early.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    // Prove the run actually reached the cancellation window: without this the test
    // would pass vacuously if restoreApp failed earlier for an unrelated reason.
    expect(mockGetLeaseProvision).toHaveBeenCalled();
    // The credit-reserving broadcast must not have fired. This is the assertion the
    // issue asks for, and it fails without extra.signal threaded through.
    expect(mockCreateLease).not.toHaveBeenCalled();
    expect(mockRestoreLease).not.toHaveBeenCalled();
  });
});
