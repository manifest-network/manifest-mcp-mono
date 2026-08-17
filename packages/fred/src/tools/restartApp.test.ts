import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  restartLease: vi.fn(),
  pollLeaseUntilReady: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { pollLeaseUntilReady, restartLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { restartApp } from './restartApp.js';

const mockRestartLease = vi.mocked(restartLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);
const mockPoll = vi.mocked(pollLeaseUntilReady);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const READY = {
  state: LeaseState.LEASE_STATE_ACTIVE,
  provision_status: 'ready',
} as never;
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');
// Threaded and asserted, never invoked — see appStatus.test.ts for why this is spelled
// with an explicit throw rather than `vi.fn(globalThis.fetch)` (ENG-715).
const fetchSpy = vi.fn<typeof globalThis.fetch>(() => {
  throw new Error(
    'this fetch spy is threaded and asserted, never invoked — a call here means a mock ' +
      'did not intercept provider HTTP (ENG-705/ENG-715)',
  );
});

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

const ADDR = 'manifest1abc';

describe('restartApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockRestartLease.mockResolvedValue({ status: 'restarting' });
    mockPoll.mockResolvedValue(READY);
    mockGetAuthToken.mockResolvedValue('auth-token');
  });

  it('default: resolves lease + provider, restarts, then polls to ready', async () => {
    const qc = activeQc();
    const result = await restartApp(makeCtx(qc), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
    });

    expect(mockResolveProviderUrl).toHaveBeenCalledTimes(1);
    // Read the slots off the recorded call rather than pinning the whole argument list:
    // toHaveBeenCalledWith is exact-arity, so the incidental trailing allowLoopback slot
    // would make an appended parameter break claims that were never about it (ENG-706).
    const [url, leaseUuid, token, fetchFn] = mockRestartLease.mock.calls[0]!;
    expect({ url, leaseUuid, token, fetchFn }).toEqual({
      url: 'https://provider.example.com',
      leaseUuid: LEASE_UUID,
      token: 'auth-token',
      fetchFn: fetchSpy,
    });
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'restarting',
      ready: READY,
    });
  });

  it('pollOptions:false → fire-and-return, no poll, no ready field', async () => {
    const result = await restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { pollOptions: false },
    );
    expect(mockPoll).not.toHaveBeenCalled();
    expect(result).toEqual({ lease_uuid: LEASE_UUID, status: 'restarting' });
  });

  it('fast path: supplied providerUrl skips fetchActiveLease + resolveProviderUrl', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } }); // lease query would return null
    const leaseFn = qc.liftedinit.billing.v1.lease;
    const result = await restartApp(
      makeCtx(qc),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { providerUrl: 'https://cached.example.com' },
    );

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(leaseFn).not.toHaveBeenCalled(); // fetchActiveLease not run
    const [restartUrl, restartLeaseUuid, restartToken, restartFetch] =
      mockRestartLease.mock.calls[0]!;
    expect({
      restartUrl,
      restartLeaseUuid,
      restartToken,
      restartFetch,
    }).toEqual({
      restartUrl: 'https://cached.example.com',
      restartLeaseUuid: LEASE_UUID,
      restartToken: 'auth-token',
      restartFetch: fetchSpy,
    });
    const [pollUrl, pollLeaseUuid, pollToken, pollOpts, pollFetch] =
      mockPoll.mock.calls[0]!;
    expect({ pollUrl, pollLeaseUuid, pollToken, pollOpts, pollFetch }).toEqual({
      pollUrl: 'https://cached.example.com',
      pollLeaseUuid: LEASE_UUID,
      pollToken: expect.any(Function),
      pollOpts: expect.anything(),
      pollFetch: fetchSpy,
    });
    expect(result.ready).toEqual(READY);
  });

  it('poll receives a token FUNCTION (re-minted per iteration), not a pre-awaited string', async () => {
    await restartApp(makeCtx(activeQc()), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
    });
    const tokenArg = mockPoll.mock.calls[0][2];
    expect(typeof tokenArg).toBe('function');
    mockGetAuthToken.mockClear();
    await (tokenArg as () => Promise<string>)();
    expect(mockGetAuthToken).toHaveBeenCalledWith(ADDR, LEASE_UUID);
  });

  it('pollOptions object is threaded (with abortSignal merged)', async () => {
    const onProgress = vi.fn();
    const ac = new AbortController();
    await restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { pollOptions: { onProgress }, abortSignal: ac.signal },
    );
    const [pollUrl, pollLeaseUuid, pollToken, pollOpts, pollFetch] =
      mockPoll.mock.calls[0]!;
    expect({ pollUrl, pollLeaseUuid, pollToken, pollOpts, pollFetch }).toEqual({
      pollUrl: expect.any(String),
      pollLeaseUuid: LEASE_UUID,
      pollToken: expect.any(Function),
      pollOpts: { onProgress, abortSignal: ac.signal },
      pollFetch: fetchSpy,
    });
  });

  it('pre-aborted signal → throws before the mutate POST', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      restartApp(
        makeCtx(activeQc()),
        { address: ADDR, leaseUuid: LEASE_UUID },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('abort DURING providerUrl resolution → throws before the mutate POST (not fired)', async () => {
    const ac = new AbortController();
    // Top guard passes (not yet aborted); the signal aborts mid-resolution, after the top check.
    mockResolveProviderUrl.mockImplementation(async () => {
      ac.abort();
      return 'https://provider.example.com';
    });
    await expect(
      restartApp(
        makeCtx(activeQc()),
        { address: ADDR, leaseUuid: LEASE_UUID },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('default path still throws when lease is not active', async () => {
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
      restartApp(makeCtx(qc), { address: ADDR, leaseUuid: LEASE_UUID }),
    ).rejects.toThrow('cannot be restarted');
  });
});
