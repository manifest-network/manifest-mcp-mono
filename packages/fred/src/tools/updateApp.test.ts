import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
  pollLeaseUntilReady: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { pollLeaseUntilReady, updateLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { updateApp } from './updateApp.js';

const mockUpdateLease = vi.mocked(updateLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);
const mockPoll = vi.mocked(pollLeaseUntilReady);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDR = 'manifest1abc';
const READY = {
  state: LeaseState.LEASE_STATE_ACTIVE,
  provision_status: 'ready',
} as never;
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');
const fetchSpy = vi.fn(globalThis.fetch);

function activeQc() {
  return makeMockQueryClient({
    billing: {
      lease: {
        uuid: LEASE_UUID,
        state: LeaseState.LEASE_STATE_ACTIVE,
        providerUuid: 'prov-1',
      },
    },
  });
}

function makeCtx(qc: ReturnType<typeof makeMockQueryClient>) {
  return {
    query: qc,
    chain: {} as never,
    fetch: fetchSpy,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        mockGetAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

describe('updateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockUpdateLease.mockResolvedValue({ status: 'updated' });
    mockPoll.mockResolvedValue(READY);
    mockGetAuthToken.mockResolvedValue('auth-token');
  });

  it('without existingManifest: full replacement', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const manifest = JSON.stringify({
      image: 'nginx:2',
      ports: { '80/tcp': {} },
    });
    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest,
      },
      { pollOptions: false },
    );

    // Should pass manifest through unchanged (encoded as Uint8Array)
    const rawPayload = mockUpdateLease.mock.calls[0][2] as Uint8Array;
    expect(rawPayload).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(rawPayload)).toBe(manifest);
  });

  it('with existingManifest: env merged, ports merged, fields carried forward', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      image: 'nginx:2',
      env: { NEW: 'val' },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx:1',
      ports: { '80/tcp': {} },
      env: { OLD: 'kept', NEW: 'overridden' },
      user: '1000:1000',
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sentManifest = JSON.parse(
      new TextDecoder().decode(mockUpdateLease.mock.calls[0][2] as Uint8Array),
    );
    expect(sentManifest.image).toBe('nginx:2');
    expect(sentManifest.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sentManifest.ports).toEqual({ '80/tcp': {} });
    expect(sentManifest.user).toBe('1000:1000');
  });

  it('stack merge: per-service env merged with services wrapper in output', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx:2', env: { NEW: 'val' } },
        db: { image: 'mysql:9' },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: {
          image: 'nginx:1',
          env: { OLD: 'kept', NEW: 'overridden' },
          ports: { '80/tcp': {} },
        },
        db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
      },
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sent = JSON.parse(
      new TextDecoder().decode(mockUpdateLease.mock.calls[0][2] as Uint8Array),
    );
    expect(sent.services).toBeDefined();
    expect(sent.services.web.image).toBe('nginx:2');
    expect(sent.services.web.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sent.services.web.ports).toEqual({ '80/tcp': {} });
    expect(sent.services.db.image).toBe('mysql:9');
    expect(sent.services.db.ports).toEqual({ '3306/tcp': {} });
  });

  it('stack merge: new service gets empty merge base', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx' },
        cache: { image: 'redis', env: { MAXMEM: '64mb' } },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: { image: 'nginx', env: { OLD: 'val' } },
      },
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sent = JSON.parse(
      new TextDecoder().decode(mockUpdateLease.mock.calls[0][2] as Uint8Array),
    );
    expect(sent.services.cache.image).toBe('redis');
    expect(sent.services.cache.env).toEqual({ MAXMEM: '64mb' });
  });

  it('throws on invalid manifest JSON when existingManifest is provided', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: 'not-valid-json',
        existingManifest: '{"image":"nginx"}',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid manifest JSON'),
    });
  });

  it('stack merge: throws on unparseable existingManifest JSON', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest: 'not-valid-json',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid existing_manifest'),
    });
  });

  it('stack merge: throws on invalid service name', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { 'INVALID_NAME!': { image: 'nginx' } },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest: '{"services":{"web":{"image":"old"}}}',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid service name'),
    });
  });

  it('stack merge: throws when existing_manifest is not a stack', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Cannot merge'),
    });
  });

  // ── ENG-488 lifecycle options (fast-path + default-poll) ──

  it('default: resolves lease + provider, updates, then polls to ready', async () => {
    mockUpdateLease.mockResolvedValue({ status: 'updating' });
    const result = await updateApp(makeCtx(activeQc()), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
      manifest: '{"image":"nginx","ports":{}}',
    });

    expect(mockResolveProviderUrl).toHaveBeenCalledTimes(1);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'updating',
      ready: READY,
    });
  });

  it('pollOptions:false → fire-and-return, no poll, no ready field', async () => {
    mockUpdateLease.mockResolvedValue({ status: 'updating' });
    const result = await updateApp(
      makeCtx(activeQc()),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      },
      { pollOptions: false },
    );
    expect(mockPoll).not.toHaveBeenCalled();
    expect(result).toEqual({ lease_uuid: LEASE_UUID, status: 'updating' });
  });

  it('fast path: supplied providerUrl skips fetchActiveLease + resolveProviderUrl', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const leaseFn = qc.liftedinit.billing.v1.lease;
    await updateApp(
      makeCtx(qc),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      },
      { providerUrl: 'https://cached.example.com' },
    );

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(leaseFn).not.toHaveBeenCalled(); // fetchActiveLease not run
    expect(mockUpdateLease).toHaveBeenCalledWith(
      'https://cached.example.com',
      LEASE_UUID,
      expect.any(Uint8Array),
      'auth-token',
      fetchSpy,
    );
    expect(mockPoll).toHaveBeenCalledWith(
      'https://cached.example.com',
      LEASE_UUID,
      expect.any(Function),
      expect.anything(),
      fetchSpy,
    );
  });

  it('fast path WITH existingManifest: merge still runs and zero chain queries', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const leaseFn = qc.liftedinit.billing.v1.lease;
    await updateApp(
      makeCtx(qc),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","env":{"A":"1"}}',
        existingManifest: '{"image":"old","env":{"B":"2"}}',
      },
      { providerUrl: 'https://cached.example.com' },
    );

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(leaseFn).not.toHaveBeenCalled();
    const sent = JSON.parse(
      new TextDecoder().decode(mockUpdateLease.mock.calls[0][2] as Uint8Array),
    );
    expect(sent.env).toEqual({ A: '1', B: '2' });
  });

  it('poll receives a token FUNCTION (re-minted per iteration), not a pre-awaited string', async () => {
    await updateApp(makeCtx(activeQc()), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
      manifest: '{"image":"nginx","ports":{}}',
    });
    const tokenArg = mockPoll.mock.calls[0][2];
    expect(typeof tokenArg).toBe('function');
    mockGetAuthToken.mockClear();
    await (tokenArg as () => Promise<string>)();
    expect(mockGetAuthToken).toHaveBeenCalledWith(ADDR, LEASE_UUID);
  });

  it('pre-aborted signal → throws before the mutate POST', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      updateApp(
        makeCtx(activeQc()),
        {
          address: ADDR,
          leaseUuid: LEASE_UUID,
          manifest: '{"image":"nginx","ports":{}}',
        },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(mockUpdateLease).not.toHaveBeenCalled();
  });

  it('abort DURING providerUrl resolution → throws before the mutate POST (not fired)', async () => {
    const ac = new AbortController();
    mockResolveProviderUrl.mockImplementation(async () => {
      ac.abort();
      return 'https://provider.example.com';
    });
    await expect(
      updateApp(
        makeCtx(activeQc()),
        {
          address: ADDR,
          leaseUuid: LEASE_UUID,
          manifest: '{"image":"nginx","ports":{}}',
        },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(mockUpdateLease).not.toHaveBeenCalled();
  });

  it('default path throws when lease is not active', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });
    await expect(
      updateApp(makeCtx(qc), {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      }),
    ).rejects.toThrow('cannot be updated');
  });
});
