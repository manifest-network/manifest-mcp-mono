import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    cosmosTx: vi.fn(),
    // setItemCustomDomain calls cosmosTx through an internal `'../cosmos.js'`
    // import that the package-level mock above doesn't intercept. Mock the
    // helper directly so its orchestration call from deployApp is observable
    // and doesn't try to reach the (unmocked) internal cosmosTx path.
    setItemCustomDomain: vi.fn(),
  };
});

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    uploadLeaseData: vi.fn(),
    getLeaseConnectionInfo: vi.fn(),
  };
});

vi.mock('../http/fred.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/fred.js')>();
  return {
    ...actual,
    pollLeaseUntilReady: vi.fn(),
  };
});

import {
  asFqdn,
  asLeaseUuid,
  cosmosTx,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockClientManager,
  makeMockQueryClient,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import type { FredAuthCtx } from '../ctx.js';
import { pollLeaseUntilReady, TerminalChainStateError } from '../http/fred.js';
import { getLeaseConnectionInfo, uploadLeaseData } from '../http/provider.js';
import { deployApp } from './deployApp.js';

/**
 * Build a FredAuthCtx for the converted `deployApp(ctx, spec, callOptions?)`
 * signature: `chain` is the mock client manager, `query` its query client, and
 * `providerAuth` adapts the address-param port onto the legacy token thunks.
 */
async function ctx(cm: unknown): Promise<FredAuthCtx> {
  const manager = cm as any;
  return {
    query: await manager.getQueryClient(),
    chain: manager,
    fetch: vi.fn(globalThis.fetch),
    logger: noopLogger,
    providerAuth: {
      providerToken: ({ address, leaseUuid }) =>
        mockGetAuthToken(address, leaseUuid),
      leaseDataToken: ({ address, leaseUuid, metaHashHex }) =>
        mockGetLeaseDataAuthToken(address, leaseUuid, metaHashHex),
    },
  };
}

const mockCosmosTx = vi.mocked(cosmosTx);
const mockSetItemCustomDomain = vi.mocked(setItemCustomDomain);
const mockUploadLeaseData = vi.mocked(uploadLeaseData);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockPollLeaseUntilReady = vi.mocked(pollLeaseUntilReady);

const mockGetAuthToken = vi.fn();
const mockGetLeaseDataAuthToken = vi.fn();

function makeQueryClient() {
  return makeMockQueryClient({
    sku: {
      providers: [
        {
          uuid: 'prov-1',
          address: 'manifest1prov',
          apiUrl: 'https://provider.example.com',
          active: true,
        },
      ],
      skus: [
        {
          uuid: 'sku-micro-uuid',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { amount: '36000', denom: 'umfx' },
        },
      ],
      providerLookup: {
        'prov-1': {
          provider: { apiUrl: 'https://provider.example.com' },
        } as any,
      },
    },
  });
}

describe('deployApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      confirmed: true,
      events: [
        {
          type: 'liftedinit.billing.v1.LeaseCreated',
          attributes: [
            {
              key: 'lease_uuid',
              value: '"550e8400-e29b-41d4-a716-446655440000"',
            },
          ],
        },
      ],
    });

    mockGetAuthToken.mockResolvedValue('auth-token');
    mockGetLeaseDataAuthToken.mockResolvedValue('lease-data-token');
    mockUploadLeaseData.mockResolvedValue(undefined);
    mockSetItemCustomDomain.mockResolvedValue({
      lease_uuid: asLeaseUuid('550e8400-e29b-41d4-a716-446655440000'),
      service_name: '',
      custom_domain: asFqdn('app.example.com'),
      transactionHash: 'TX2',
      code: 0,
      confirmed: true,
    });
    mockPollLeaseUntilReady.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      tenant: 'manifest1tenant',
      provider_uuid: 'prov-1',
      connection: {
        host: 'app.localhost',
        ports: { '80/tcp': 32001 },
      },
    });
  });

  it('single-service deploy uses buildManifest', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const result = await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        env: { FOO: 'bar' },
      },
      {},
    );

    expect(result.lease_uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.url).toBe('app.localhost:32001');
    expect(result.connection).toEqual({
      host: 'app.localhost',
      ports: { '80/tcp': 32001 },
    });

    // Verify manifest is uploaded as Uint8Array with correct content
    const rawPayload = mockUploadLeaseData.mock.calls[0][2];
    expect(rawPayload).toBeInstanceOf(Uint8Array);
    const payload = new TextDecoder().decode(rawPayload);
    const manifest = JSON.parse(payload);
    expect(manifest).toEqual({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
      env: { FOO: 'bar' },
    });
    expect(manifest.command).toBeUndefined();
    expect(manifest.user).toBeUndefined();
  });

  it('passes gasMultiplier override to cosmosTx', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      { gasMultiplier: 5.0 },
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'create-lease',
      expect.any(Array),
      true,
      { gasMultiplier: 5.0 },
    );
  });

  it('stack deploy with 2 services produces stack manifest', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(
      await ctx(cm as any),
      {
        size: 'docker-micro',
        services: {
          web: { image: 'nginx', ports: { '80/tcp': {} } },
          db: {
            image: 'mysql:8',
            ports: { '3306/tcp': {} },
            env: { MYSQL_ROOT_PASSWORD: 'secret' },
          },
        },
      },
      {},
    );

    const payload = new TextDecoder().decode(
      mockUploadLeaseData.mock.calls[0][2],
    );
    const manifest = JSON.parse(payload);
    expect(Object.keys(manifest)).toEqual(['services']);
    expect(Object.keys(manifest.services)).toEqual(['web', 'db']);
    expect(manifest.services.web).toEqual({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });
    expect(manifest.services.db).toEqual({
      image: 'mysql:8',
      ports: { '3306/tcp': {} },
      env: { MYSQL_ROOT_PASSWORD: 'secret' },
    });
  });

  it('stack deploy lease items include service names', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(
      await ctx(cm as any),
      {
        size: 'docker-micro',
        services: {
          web: { image: 'nginx' },
          db: { image: 'mysql:8' },
        },
      },
      {},
    );

    const txArgs = mockCosmosTx.mock.calls[0][3] as string[];
    expect(txArgs).toContain('sku-micro-uuid:1:web');
    expect(txArgs).toContain('sku-micro-uuid:1:db');
    // Should NOT contain bare 'sku-micro-uuid:1'
    expect(txArgs).not.toContain('sku-micro-uuid:1');
  });

  it('throws when both image and services are provided', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx',
          port: 80,
          size: 'docker-micro',
          services: { web: { image: 'nginx' } },
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('mutually exclusive'),
    });
  });

  it('throws when neither image nor services is provided', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          size: 'docker-micro',
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('either image or services is required'),
    });
  });

  it('throws when image is provided without port', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx',
          size: 'docker-micro',
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('port is required'),
    });
  });

  it('throws when chain event returns malformed lease UUID', async () => {
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      confirmed: true,
      events: [
        {
          type: 'liftedinit.billing.v1.LeaseCreated',
          attributes: [{ key: 'lease_uuid', value: '"not-a-valid-uuid"' }],
        },
      ],
    });

    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('must be a valid UUID'),
    });
  });

  it.each([
    ['uppercase', 'Web'],
    ['leading hyphen', '-web'],
    ['too long', 'a'.repeat(64)],
  ])('throws on invalid service name: %s', async (_label, name) => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          size: 'docker-micro',
          services: { [name]: { image: 'nginx' } },
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid service name'),
    });
  });

  it('fires onLeaseCreated once after TX with leaseUuid and providerUrl, before upload/poll', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const order: string[] = [];
    mockUploadLeaseData.mockImplementation(async () => {
      order.push('upload');
    });
    mockPollLeaseUntilReady.mockImplementation(async () => {
      order.push('poll');
      return { state: LeaseState.LEASE_STATE_ACTIVE };
    });

    const onLeaseCreated = vi.fn((_uuid: string, _url: string) => {
      order.push('onLeaseCreated');
    });

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      { onLeaseCreated },
    );

    expect(onLeaseCreated).toHaveBeenCalledTimes(1);
    expect(onLeaseCreated).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'https://provider.example.com',
    );
    expect(order).toEqual(['onLeaseCreated', 'upload', 'poll']);
  });

  it('surfaces onLeaseCreated errors raw (not wrapped as partial success)', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const onLeaseCreated = vi.fn(() => {
      throw new Error('registry write failed');
    });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        { onLeaseCreated },
      ),
    ).rejects.toThrow(/registry write failed/);

    // Upload and poll never run when the callback throws.
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
    expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
  });

  it('awaits async onLeaseCreated before upload', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const order: string[] = [];
    mockUploadLeaseData.mockImplementation(async () => {
      order.push('upload');
    });

    const onLeaseCreated = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('onLeaseCreated-done');
    });

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      { onLeaseCreated },
    );

    expect(order).toEqual(['onLeaseCreated-done', 'upload']);
  });

  it('propagates async onLeaseCreated rejection raw', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const onLeaseCreated = vi.fn(async () => {
      throw new Error('async registry write failed');
    });

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        { onLeaseCreated },
      ),
    ).rejects.toThrow(/async registry write failed/);

    expect(mockUploadLeaseData).not.toHaveBeenCalled();
    expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
  });

  it('forwards pollOptions and abortSignal to pollLeaseUntilReady', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const controller = new AbortController();
    const onProgress = vi.fn();
    const checkChainState = vi.fn().mockResolvedValue(null);

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      {
        abortSignal: controller.signal,
        pollOptions: {
          intervalMs: 123,
          timeoutMs: 45_678,
          onProgress,
          checkChainState,
        },
      },
    );

    expect(mockPollLeaseUntilReady).toHaveBeenCalledTimes(1);
    const forwarded = mockPollLeaseUntilReady.mock.calls[0][3];
    expect(forwarded).toEqual({
      intervalMs: 123,
      timeoutMs: 45_678,
      onProgress,
      checkChainState,
      abortSignal: controller.signal,
    });
  });

  it('passes undefined pollOptions fields when not provided (preserves poll defaults)', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      {},
    );

    expect(mockPollLeaseUntilReady).toHaveBeenCalledTimes(1);
    const forwarded = mockPollLeaseUntilReady.mock.calls[0][3];
    expect(forwarded).toEqual({ abortSignal: undefined });
  });

  it('fires onLeaseCreated even when abortSignal is already aborted (lease exists on-chain)', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));

    const onLeaseCreated = vi.fn();

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        { abortSignal: controller.signal, onLeaseCreated },
      ),
    ).rejects.toThrow();

    // The lease was created on-chain — caller MUST be notified regardless of abort state.
    expect(onLeaseCreated).toHaveBeenCalledTimes(1);
    expect(onLeaseCreated).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'https://provider.example.com',
    );
    // Downstream work (upload, poll) must NOT run after the aborted signal is observed.
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
    expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
  });

  it('threads abortSignal into uploadLeaseData and aborts before upload if already aborted', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow(/user cancelled|partially succeeded/);

    expect(mockUploadLeaseData).not.toHaveBeenCalled();
    expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
  });

  it('lets TerminalChainStateError escape the partial-success wrapper and attaches provider context', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const original = new TerminalChainStateError(
      '550e8400-e29b-41d4-a716-446655440000',
      'rejected',
    );
    const originalStack = original.stack;
    mockPollLeaseUntilReady.mockRejectedValue(original);

    let caught: unknown;
    try {
      await deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        {},
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TerminalChainStateError);
    expect((caught as TerminalChainStateError).chainState).toBe('rejected');
    expect((caught as TerminalChainStateError).leaseUuid).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    // deployApp enriches the thrown error with provider context so Barney doesn't re-query.
    expect((caught as TerminalChainStateError).providerUuid).toBe('prov-1');
    expect((caught as TerminalChainStateError).providerUrl).toBe(
      'https://provider.example.com',
    );
    // Stack trace must point at the origin (poll), not at the deployApp catch.
    expect((caught as Error).stack).toBe(originalStack);
    // Must NOT be wrapped with the "Deploy partially succeeded" advice.
    expect((caught as Error).message).not.toMatch(/Deploy partially succeeded/);
    expect((caught as Error).message).not.toMatch(/close_lease/);
  });

  it('still wraps non-TerminalChainStateError poll failures with partial-success advice', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    mockPollLeaseUntilReady.mockRejectedValue(
      new Error('provider unreachable'),
    );

    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
        },
        {},
      ),
    ).rejects.toThrow(/Deploy partially succeeded/);
  });

  it('passes abortSignal to uploadLeaseData when not aborted', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const controller = new AbortController();

    await deployApp(
      await ctx(cm as any),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      },
      { abortSignal: controller.signal },
    );

    expect(mockUploadLeaseData).toHaveBeenCalledTimes(1);
    // uploadLeaseData(url, uuid, payload, token, fetchFn?, abortSignal?)
    expect(mockUploadLeaseData.mock.calls[0][5]).toBe(controller.signal);
  });

  // ========================================================================
  // customDomain orchestration
  //
  // The set-domain tx slots into the existing partial-success try/catch
  // between createLease and the manifest upload. Failures are wrapped in
  // the same "Deploy partially succeeded… close_lease if needed" error
  // as upload/poll failures, so callers don't have to learn a new error
  // shape per failure mode.
  // ========================================================================
  describe('customDomain', () => {
    it('skips setItemCustomDomain when customDomain is omitted', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });

      const result = await deployApp(
        await ctx(cm as any),
        { image: 'nginx:alpine', port: 80, size: 'docker-micro' },
        {},
      );

      expect(mockSetItemCustomDomain).not.toHaveBeenCalled();
      expect(result.custom_domain).toBeUndefined();
      expect(result.service_name).toBeUndefined();
    });

    it('calls setItemCustomDomain after createLease with the supplied FQDN', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });

      const result = await deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
          customDomain: 'app.example.com',
        },
        {},
      );

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: cm,
          logger: expect.anything(),
        }),
        {
          leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
          customDomain: 'app.example.com',
          serviceName: undefined,
        },
        undefined,
      );
      expect(result.custom_domain).toBe('app.example.com');
      expect(result.service_name).toBeUndefined();
    });

    it('forwards gasMultiplier to the set-domain tx (same overrides as create-lease)', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });

      await deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
          customDomain: 'app.example.com',
        },
        { gasMultiplier: 4.0 },
      );

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: expect.any(String),
          customDomain: 'app.example.com',
          serviceName: undefined,
        },
        { gasMultiplier: 4.0 },
      );
    });

    it('passes serviceName when supplied for a stack lease', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });

      const result = await deployApp(
        await ctx(cm as any),
        {
          size: 'docker-micro',
          services: {
            web: { image: 'nginx', ports: { '80/tcp': {} } },
            db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
          },
          customDomain: 'app.example.com',
          serviceName: 'web',
        },
        {},
      );

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: expect.any(String),
          customDomain: 'app.example.com',
          serviceName: 'web',
        },
        undefined,
      );
      expect(result.custom_domain).toBe('app.example.com');
      expect(result.service_name).toBe('web');
    });

    it('trims surrounding whitespace before forwarding to setItemCustomDomain and echoing on the result', async () => {
      // Pinned by c9cf3e1: a regression that drops the trim would ship
      // " app.example.com " bytes to the chain, which IsValidFQDN
      // rejects → orphaned paid-for lease via the partial-success wrap.
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });
      mockSetItemCustomDomain.mockResolvedValueOnce({
        lease_uuid: asLeaseUuid('550e8400-e29b-41d4-a716-446655440000'),
        service_name: '',
        custom_domain: asFqdn('app.example.com'),
        transactionHash: 'TX2',
        code: 0,
        confirmed: true,
      });

      const result = await deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
          customDomain: '  app.example.com  ',
        },
        {},
      );

      expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: expect.anything(),
          logger: expect.anything(),
        }),
        {
          leaseUuid: expect.any(String),
          customDomain: 'app.example.com',
          serviceName: undefined,
        },
        undefined,
      );
      expect(result.custom_domain).toBe('app.example.com');
    });

    it('rejects empty/whitespace-only customDomain before any chain tx', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            image: 'nginx',
            port: 80,
            size: 'docker-micro',
            customDomain: '   ',
          },
          {},
        ),
      ).rejects.toThrow(/cannot be empty/);
      expect(mockCosmosTx).not.toHaveBeenCalled();
      expect(mockSetItemCustomDomain).not.toHaveBeenCalled();
    });

    it('rejects customDomain on a stack lease without serviceName', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            size: 'docker-micro',
            services: { web: { image: 'nginx' } },
            customDomain: 'app.example.com',
          },
          {},
        ),
      ).rejects.toThrow(/serviceName is required/);
      expect(mockCosmosTx).not.toHaveBeenCalled();
    });

    it('rejects serviceName that does not match any service', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            size: 'docker-micro',
            services: { web: { image: 'nginx' } },
            customDomain: 'app.example.com',
            serviceName: 'nope',
          },
          {},
        ),
      ).rejects.toThrow(/does not match any service/);
      expect(mockCosmosTx).not.toHaveBeenCalled();
    });

    it('rejects serviceName matching a prototype key (regression for the `in` operator bypass)', async () => {
      // Pinned by c9cf3e1: `'constructor' in {}` returns true, so a
      // refactor back to `if (serviceName in services)` would silently
      // accept a prototype key on a stack lease whose `services` map
      // doesn't define a same-named entry — sailing through create-lease
      // and only failing at the set-domain tx (orphaned paid-for lease).
      // The fix uses Object.keys(services).includes(serviceName) which
      // checks own enumerable string keys only.
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      for (const protoKey of [
        'constructor',
        'toString',
        'hasOwnProperty',
        '__proto__',
      ]) {
        await expect(
          deployApp(
            await ctx(cm as any),
            {
              size: 'docker-micro',
              services: { web: { image: 'nginx' } },
              customDomain: 'app.example.com',
              serviceName: protoKey,
            },
            {},
          ),
        ).rejects.toThrow(/does not match any service/);
      }
      expect(mockCosmosTx).not.toHaveBeenCalled();
    });

    it('rejects serviceName when customDomain is omitted (silently-ignored input is a foot-gun)', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            size: 'docker-micro',
            services: { web: { image: 'nginx' } },
            serviceName: 'web',
          },
          {},
        ),
      ).rejects.toThrow(
        /serviceName is only meaningful when customDomain is set/,
      );
      expect(mockCosmosTx).not.toHaveBeenCalled();
      expect(mockSetItemCustomDomain).not.toHaveBeenCalled();
    });

    it('rejects serviceName on an image+port (legacy 1-item) lease', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({ queryClient: qc });

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            image: 'nginx',
            port: 80,
            size: 'docker-micro',
            customDomain: 'app.example.com',
            serviceName: 'web',
          },
          {},
        ),
      ).rejects.toThrow(/serviceName must not be set/);
      expect(mockCosmosTx).not.toHaveBeenCalled();
    });

    it('wraps a set-domain failure in the existing partial-success error (lease X created…)', async () => {
      const qc = makeQueryClient();
      const cm = makeMockClientManager({
        queryClient: qc,
        address: 'manifest1tenant',
      });
      mockSetItemCustomDomain.mockRejectedValueOnce(
        new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'Transaction billing set-item-custom-domain failed: domain already claimed',
        ),
      );

      await expect(
        deployApp(
          await ctx(cm as any),
          {
            image: 'nginx',
            port: 80,
            size: 'docker-micro',
            customDomain: 'taken.example.com',
          },
          {},
        ),
      ).rejects.toThrow(
        /Deploy partially succeeded.*lease 550e8400.*close_lease if needed.*domain already claimed/s,
      );
      // Manifest upload and poll must NOT happen if the set-domain step
      // threw — set-domain runs before them inside the same try block.
      expect(mockUploadLeaseData).not.toHaveBeenCalled();
      expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
    });
  });
});
