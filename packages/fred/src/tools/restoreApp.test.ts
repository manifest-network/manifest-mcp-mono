import { toHex } from '@cosmjs/encoding';
import {
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return { ...actual, cosmosTx: vi.fn() };
});
vi.mock('../http/fred.js', () => ({
  getLeaseProvision: vi.fn(),
  restoreLease: vi.fn(),
  pollLeaseUntilReady: vi.fn(),
}));
vi.mock('./createLease.js', () => ({ createLease: vi.fn() }));
vi.mock('./fetchLease.js', () => ({ fetchLease: vi.fn() }));
vi.mock('./resolveLeaseProvider.js', () => ({ resolveProviderUrl: vi.fn() }));

import { cosmosTx } from '@manifest-network/manifest-mcp-core';
import {
  getLeaseProvision,
  pollLeaseUntilReady,
  restoreLease,
} from '../http/fred.js';
import { ProviderApiError } from '../http/provider.js';
import { createLease } from './createLease.js';
import { fetchLease } from './fetchLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { restoreApp } from './restoreApp.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockGetProvision = vi.mocked(getLeaseProvision);
const mockRestoreLease = vi.mocked(restoreLease);
const mockPoll = vi.mocked(pollLeaseUntilReady);
const mockCreateLease = vi.mocked(createLease);
const mockFetchLease = vi.mocked(fetchLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const SOURCE = '11111111-2222-3333-4444-555555555555';
const NEW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const META = new Uint8Array([1, 2]);

function makeCtx() {
  return {
    chain: { acquireRateLimit: vi.fn().mockResolvedValue(undefined) } as never,
    query: {} as never,
    fetch: vi.fn() as never,
    allowLoopback: false,
    providerAuth: {
      providerToken: vi.fn().mockResolvedValue('tok'),
      leaseDataToken: vi.fn(),
    },
  } as unknown as Parameters<typeof restoreApp>[0];
}

function mockSource(items: unknown[] = [{ skuUuid: 's1', quantity: 1n }]) {
  mockFetchLease.mockResolvedValue({
    uuid: SOURCE,
    state: LeaseState.LEASE_STATE_CLOSED,
    providerUuid: 'prov-1',
    metaHash: META,
    items,
  } as never);
}

describe('restoreApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockGetProvision.mockResolvedValue({ status: 'retained', fail_count: 0 });
    mockCreateLease.mockResolvedValue(NEW as never);
    mockRestoreLease.mockResolvedValue({ status: 'provisioning' });
    // clearAllMocks() resets calls but NOT implementations, so a mockRejectedValue
    // set by one case would otherwise leak into every later one.
    mockCosmosTx.mockResolvedValue(undefined as never);
  });

  it('happy path: creates a fresh lease from the source and restores onto it', async () => {
    mockSource();
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );

    expect(result).toEqual({
      lease_uuid: NEW,
      source_lease_uuid: SOURCE,
      status: 'provisioning',
    });
    expect(mockCreateLease).toHaveBeenCalledWith(expect.anything(), {
      metaHashHex: toHex(META),
      leaseItems: ['s1:1'],
    });
    expect(mockRestoreLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      NEW,
      SOURCE,
      'tok',
      expect.anything(),
      false,
    );
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('pre-flight: throws RESTORE_NOT_RETAINED without creating a lease when source is not retained', async () => {
    mockSource();
    mockGetProvision.mockResolvedValue({ status: 'active', fail_count: 0 });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_NOT_RETAINED,
    });
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it('terminal 422: cancels the created lease once and throws RESTORE_REJECTED', async () => {
    mockSource();
    mockRestoreLease.mockRejectedValue(new ProviderApiError(422, 'demote'));
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.RESTORE_REJECTED });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
  });

  it('503: cancels and throws RESTORE_RETRYABLE (agent may re-invoke)', async () => {
    mockSource();
    mockRestoreLease.mockRejectedValue(
      new ProviderApiError(503, 'insufficient resources'),
    );
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.RESTORE_RETRYABLE });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  it('in-doubt (status 0 timeout): does NOT cancel; throws RESTORE_ORPHAN with the orphaned uuid', async () => {
    mockSource();
    mockRestoreLease.mockRejectedValue(new ProviderApiError(0, 'timeout'));
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
      details: { orphaned_lease_uuid: NEW },
    });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('compensation fails: 422 + cancel rejects → RESTORE_ORPHAN naming the orphaned uuid', async () => {
    mockSource();
    mockRestoreLease.mockRejectedValue(new ProviderApiError(422, 'demote'));
    mockCosmosTx.mockRejectedValue(new Error('chain unreachable'));
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
      details: { orphaned_lease_uuid: NEW },
    });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  it('post-pivot poll timeout: reports provisioning and does NOT cancel (data-loss guard)', async () => {
    mockSource();
    mockPoll.mockRejectedValue(new ProviderApiError(0, 'poll timeout'));
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: {} },
    );
    expect(result).toMatchObject({ lease_uuid: NEW, status: 'provisioning' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('post-pivot poll SUCCESS: returns the polled ready status', async () => {
    mockSource();
    mockPoll.mockResolvedValue({
      state: 2,
      provision_status: 'running',
    } as never);
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: {} },
    );
    expect(result.lease_uuid).toBe(NEW);
    expect(result.ready).toMatchObject({ provision_status: 'running' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('committed-but-empty-body (2xx ProviderApiError): treated as committed, NOT orphaned', async () => {
    mockSource();
    // parseJsonResponse throws ProviderApiError with the 2xx status on an empty body.
    mockRestoreLease.mockRejectedValue(new ProviderApiError(202, 'empty body'));
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(result).toMatchObject({ lease_uuid: NEW, status: 'provisioning' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('surfaces custom_domain_not_restored when the source items carry a custom domain', async () => {
    mockSource([
      {
        skuUuid: 's1',
        quantity: 1n,
        serviceName: 'web',
        customDomain: 'app.x.com',
      },
    ]);
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(result.custom_domain_not_restored).toEqual(['app.x.com']);
  });

  it('acquires the rate limit once before the pre-tx reads (Copilot #2)', async () => {
    mockSource();
    const ctx = makeCtx();
    await restoreApp(
      ctx,
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(
      (
        ctx as unknown as {
          chain: { acquireRateLimit: ReturnType<typeof vi.fn> };
        }
      ).chain.acquireRateLimit,
    ).toHaveBeenCalledTimes(1);
  });

  it('sanitizes provider-controlled text out of the failure message (Copilot #1)', async () => {
    mockSource();
    const bidi = String.fromCharCode(0x202e);
    mockRestoreLease.mockRejectedValue(
      new ProviderApiError(422, `demote${bidi}evil`),
    );
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && !e.message.includes(bidi),
    );
  });

  it('aborts before createLease when the signal fires during pre-flight reads — no broadcast, no orphan (ENG-488)', async () => {
    mockSource();
    const ac = new AbortController();
    // Abort lands during the pre-flight provision read — before createLease.
    mockGetProvision.mockImplementation(async () => {
      ac.abort();
      return { status: 'retained', fail_count: 0 };
    });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false, signal: ac.signal },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as Error)?.name === 'AbortError');
    // The on-chain create-lease broadcast must NOT fire after an abort.
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it('rolls the fresh lease back when the signal fires between createLease and the restore POST (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    // Abort lands right after the lease is created, before the restore POST.
    mockCreateLease.mockImplementation(async () => {
      ac.abort();
      return NEW as never;
    });
    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    // The restore POST never fired — nothing was adopted (unchanged from ENG-488).
    expect(mockRestoreLease).not.toHaveBeenCalled();
    // ...so the empty PENDING shell is rolled back rather than left reserving credit.
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    // A bare AbortError would name no lease, and over MCP the host never sees the
    // rejection at all — so the outcome has to be a reported, identified rollback.
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
    );
    expect((err as ManifestMCPError).details).toMatchObject({
      lease_uuid: NEW,
      rolled_back: true,
    });
  });

  it('rolls back when the cancel lands during the token mint, the one await before the POST (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    const ctx = makeCtx();
    // Two tokens are minted: the SOURCE one during pre-flight, then the NEW-lease one
    // just before the POST. Only the latter sits in the window under test — aborting
    // on the former would trip the earlier pre-broadcast guard instead.
    (
      ctx.providerAuth.providerToken as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ leaseUuid }: { leaseUuid: string }) => {
      if (leaseUuid === NEW) ac.abort();
      return 'tok';
    });

    const err = await restoreApp(
      ctx,
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(mockRestoreLease).not.toHaveBeenCalled();
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
    );
  });

  it('falls back to the orphan surface when the compensating cancel itself fails (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    mockCreateLease.mockImplementation(async () => {
      ac.abort();
      return NEW as never;
    });
    mockCosmosTx.mockRejectedValue(new Error('chain unreachable'));

    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
    );
    expect((err as ManifestMCPError).details).toMatchObject({
      orphaned_lease_uuid: NEW,
    });
  });

  it('still compensates and reports the provider verdict when a rejection coincides with an abort (ENG-666)', async () => {
    // Guards the removal of the `if (aborted) throw err` bypass: a real 422 that
    // merely coincides with a cancel must still be classified by the PROVIDER's
    // answer — not short-circuited into a bare abort that skips the rollback.
    mockSource();
    const ac = new AbortController();
    mockRestoreLease.mockImplementation(async () => {
      ac.abort();
      throw new ProviderApiError(422, 'unprocessable');
    });

    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.RESTORE_REJECTED,
    );
  });

  it('honours the deprecated abortSignal spelling as well as signal (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    mockGetProvision.mockImplementation(async () => {
      ac.abort();
      return { status: 'retained', fail_count: 0 };
    });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false, abortSignal: ac.signal },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as Error)?.name === 'AbortError');
    expect(mockCreateLease).not.toHaveBeenCalled();
  });
});
