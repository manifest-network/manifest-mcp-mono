import {
  INFRASTRUCTURE_ERROR_CODES,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  getLeaseStatus: vi.fn(),
}));

vi.mock('../http/provider.js', () => ({
  getLeaseConnectionInfo: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { getLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo } from '../http/provider.js';
import { appStatus } from './appStatus.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const mockGetLeaseStatus = vi.mocked(getLeaseStatus);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');
const fetchSpy = vi.fn(globalThis.fetch);

function makeActiveQc() {
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

// Build a FredAuthCtx whose providerAuth.providerToken delegates to the
// supplied `getAuthToken` thunk (so the existing token-flow assertions hold).
function makeCtx(
  qc: ReturnType<typeof makeMockQueryClient>,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  return {
    query: qc,
    chain: {} as never,
    fetch: fetchSpy,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        getAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

describe('appStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockGetLeaseStatus.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
      services: { web: { instances: [{ name: 'web-0', status: 'running' }] } },
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      connection: {
        host: 'app.example.com',
        ports: { '80/tcp': 8080 },
      },
    });
  });

  it('returns combined chain state and provider status for active lease', async () => {
    const qc = makeActiveQc();
    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('queries provider status (but NOT connection) for a closed lease (ENG-600)', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(mockGetLeaseStatus).toHaveBeenCalledTimes(1);
    expect(result.fredStatus).toBeDefined();
    // Connection is meaningless for a non-running lease — not fetched.
    expect(mockGetLeaseConnectionInfo).not.toHaveBeenCalled();
    expect(result.connection).toBeUndefined();
  });

  it('surfaces sanitized retention fields for a retained closed lease and omits partition (ENG-600)', async () => {
    mockGetLeaseStatus.mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_CLOSED,
      provision_status: 'retained',
      retained_until: '2026-08-01T00:00:00Z',
      // Control char in sku proves the sanitize spread is WIRED (not just clean-string pass-through).
      items: [{ sku: `s1${String.fromCharCode(0x202e)}`, quantity: 1 }],
      restore_hint: `restore${String.fromCharCode(0x202e)}me`,
      partition: 'p',
    });
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.retained_until).toBe('2026-08-01T00:00:00Z');
    // Sanitized: the bidi char is replaced with a space.
    expect(result.fredStatus?.restore_hint).toBe('restore me');
    expect(result.fredStatus?.items?.[0]?.sku).toBe('s1');
    // Decision 6: partition is omitted from the AI-facing projection.
    expect(result.fredStatus?.partition).toBeUndefined();
  });

  it('DROPS a malformed/injected retained_until instead of leaking it raw past the sanitizer (ENG-555)', async () => {
    const injected = `not-a-timestamp${String.fromCharCode(0x202e)}evil`;
    mockGetLeaseStatus.mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_CLOSED,
      provision_status: 'retained',
      // Non-RFC3339 + bidi-override payload: sanitizeRetentionFields omits it,
      // so the raw value must NOT survive via the `...rest` spread.
      retained_until: injected,
      partition: 'p',
    });
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.retained_until).toBeUndefined();
    // The raw bidi payload must not appear anywhere in the AI-facing projection.
    expect(JSON.stringify(result.fredStatus)).not.toContain(
      String.fromCharCode(0x202e),
    );
  });

  it('surfaces the post-ENG-508 failure pair on fredStatus (ENG-638)', async () => {
    // A `ready` lease carrying a rolled-back UpdateFailed: Fred deliberately
    // retains the attribution on a HEALTHY lease, so this doubles as the case
    // documenting that a non-empty `reason` does not mean the app is down.
    mockGetLeaseStatus.mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: 'ready',
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to the previous version',
    });
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.provision_status).toBe('ready');
    expect(result.fredStatus?.reason).toBe('UpdateFailed');
    expect(result.fredStatus?.message).toBe(
      'update failed; rolled back to the previous version',
    );
  });

  it('SANITIZES provider failure text instead of leaking it raw past the spread (ENG-638)', async () => {
    // fredStatus is a looseObject, so any raw key left in `...rest` reaches
    // model context unsanitized. This is the guard that fails if someone drops
    // reason/message/last_error from the destructure-strip in appStatus.ts.
    mockGetLeaseStatus.mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: 'failed',
      reason: `Container${String.fromCharCode(0x202e)}Exited`,
      message: `crash${String.fromCharCode(0x202e)}loop`,
    });
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.message).toBe('crash loop');
    expect(JSON.stringify(result.fredStatus)).not.toContain(
      String.fromCharCode(0x202e),
    );
  });

  it('surfaces a pre-ENG-508 last_error on the canonical message key (ENG-638)', async () => {
    mockGetLeaseStatus.mockResolvedValueOnce({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: 'failed',
      last_error: 'OOMKilled',
    });
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.last_error).toBe('OOMKilled');
    expect(result.fredStatus?.message).toBe('OOMKilled');
  });

  it('includes lease.items in chainState (so consumers skip a second getLease)', async () => {
    const items = [
      {
        skuUuid: 'sku-1',
        quantity: 1n,
        lockedPrice: { denom: 'upwr', amount: '100' },
        serviceName: 'web',
        customDomain: 'app.example.com',
      },
    ];
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
          items,
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.chainState.items).toEqual(items);
  });

  it('returns chainState.items as [] when the lease has no items (never undefined)', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
          // items intentionally omitted (partial fixture)
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.chainState.items).toEqual([]);
  });

  it('throws when lease not found', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(
      appStatus(makeCtx(qc, mockGetAuthToken), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toThrow('not found on chain');
  });

  it('returns providerError when resolveProviderUrl fails', async () => {
    const qc = makeActiveQc();
    mockResolveProviderUrl.mockRejectedValue(new Error('bad url'));

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toContain('Could not resolve provider');
    expect(result.fredStatus).toBeUndefined();
  });

  it('re-throws infrastructure errors from resolveProviderUrl', async () => {
    const qc = makeActiveQc();
    const infraErr = new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      'rpc down',
    );
    expect(INFRASTRUCTURE_ERROR_CODES.has(infraErr.code)).toBe(true);
    mockResolveProviderUrl.mockRejectedValue(infraErr);

    await expect(
      appStatus(makeCtx(qc, mockGetAuthToken), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toBe(infraErr);
  });

  it('handles partial provider failure with Promise.allSettled', async () => {
    const qc = makeActiveQc();
    mockGetLeaseStatus.mockRejectedValue(new Error('status failed'));
    // connection succeeds

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toBe('status failed');
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('returns providerError when getAuthToken fails', async () => {
    const qc = makeActiveQc();
    mockGetAuthToken.mockRejectedValueOnce(new Error('signing failed'));

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toContain('Auth token error');
    expect(result.fredStatus).toBeUndefined();
  });

  it('calls getAuthToken twice with distinct tokens for status and connection', async () => {
    const qc = makeActiveQc();
    const distinctTokenFn = vi
      .fn()
      .mockResolvedValueOnce('status-token')
      .mockResolvedValueOnce('conn-token');

    await appStatus(makeCtx(qc, distinctTokenFn), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(distinctTokenFn).toHaveBeenCalledTimes(2);
    // The claim is which TOKEN reaches each transport call. Read the slots off the
    // recorded call instead of pinning the whole argument list: toHaveBeenCalledWith is
    // exact-arity, so the incidental trailing signal/allowLoopback slots would make an
    // appended parameter break a test that never claimed anything about them (ENG-706).
    const [statusUrl, statusLease, statusToken, statusFetch] =
      mockGetLeaseStatus.mock.calls[0]!;
    expect({ statusUrl, statusLease, statusToken, statusFetch }).toEqual({
      statusUrl: expect.any(String),
      statusLease: LEASE_UUID,
      statusToken: 'status-token',
      statusFetch: fetchSpy,
    });
    const [connUrl, connLease, connToken, connFetch] =
      mockGetLeaseConnectionInfo.mock.calls[0]!;
    expect({ connUrl, connLease, connToken, connFetch }).toEqual({
      connUrl: expect.any(String),
      connLease: LEASE_UUID,
      connToken: 'conn-token',
      connFetch: fetchSpy,
    });
  });

  it('returns connectionError when only connection info fails', async () => {
    const qc = makeActiveQc();
    mockGetLeaseConnectionInfo.mockRejectedValue(
      new Error('connection failed'),
    );
    // status succeeds

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connectionError).toBe('connection failed');
  });
});
