import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  return {
    ...actual,
    validateProviderUrl: vi.fn((url: string) => url),
    checkedFetch: vi.fn(),
    parseJsonResponse: vi.fn(),
  };
});

import {
  getLeaseLogs,
  getLeaseStatus,
  MAX_TAIL,
  pollLeaseUntilReady,
  updateLease,
} from './fred.js';
import { checkedFetch, parseJsonResponse } from './provider.js';

const mockCheckedFetch = vi.mocked(checkedFetch);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';

describe('getLeaseStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches status with auth header and converts state to LeaseState', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockCheckedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/status`),
      expect.objectContaining({
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }),
      undefined,
      undefined,
    );
  });

  it('returns UNRECOGNIZED for unknown state strings', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'something_unknown' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.UNRECOGNIZED);
  });

  it('preserves all wire fields through conversion', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'provisioned',
      last_error: 'timeout',
      fail_count: 3,
      endpoints: { http: 'https://app.example.com' },
    });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('provisioned');
    expect(result.last_error).toBe('timeout');
    expect(result.fail_count).toBe(3);
    expect(result.endpoints).toEqual({ http: 'https://app.example.com' });
  });
});

describe('getLeaseLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps tail at MAX_TAIL', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 5000);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).toContain(`?tail=${MAX_TAIL}`);
  });

  it('passes tail directly when within limit', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).toContain('?tail=50');
  });

  it('omits tail query param when not provided', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).not.toContain('?tail');
  });
});

describe('pollLeaseUntilReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediately when state is ACTIVE', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 1000,
      },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('throws on CLOSED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_CLOSED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on REJECTED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_REJECTED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on EXPIRED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_EXPIRED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws immediately on UNRECOGNIZED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'SOME_FUTURE_STATE' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('throws immediately on UNSPECIFIED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
      state: 'LEASE_STATE_UNSPECIFIED',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('polls until ACTIVE after PENDING', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 3 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
      },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(callCount).toBe(3);
  });

  it('times out if never active', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/poll timed out/);
  });

  it('uses callback function for auth token refresh', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const tokenFn = vi
      .fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, tokenFn, {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(tokenFn).toHaveBeenCalledTimes(2);
    // Verify different tokens were used in successive calls
    const firstAuth = mockCheckedFetch.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    const secondAuth = mockCheckedFetch.mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    expect(firstAuth.Authorization).toBe('Bearer token-1');
    expect(secondAuth.Authorization).toBe('Bearer token-2');
  });

  it('includes last state in timeout error message', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/LEASE_STATE_PENDING/);
  });

  it('aborts immediately with a pre-aborted signal', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(mockCheckedFetch).not.toHaveBeenCalled();
  });

  it('aborts during sleep between polls', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    // Abort after a short delay (during the sleep interval)
    setTimeout(() => controller.abort(new Error('user cancelled')), 30);

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 5000,
        timeoutMs: 30000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/user cancelled/);
    // Should have polled once, then been aborted during sleep
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('calls onProgress on each poll iteration', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 3 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const onProgress = vi.fn();
    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 5000,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      state: LeaseState.LEASE_STATE_PENDING,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      state: LeaseState.LEASE_STATE_PENDING,
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
  });
});

describe('updateLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends JSON body with base64-encoded payload', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ status: 'updated' });

    const payload = new TextEncoder().encode('{"image":"nginx:alpine"}');
    await updateLease(PROVIDER_URL, LEASE_UUID, payload, AUTH_TOKEN);

    expect(mockCheckedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/update`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        }),
      }),
      undefined,
      undefined,
    );

    const body = JSON.parse(
      mockCheckedFetch.mock.calls[0][1]?.body as string,
    ) as { payload: string };
    const decoded = atob(body.payload);
    expect(decoded).toBe('{"image":"nginx:alpine"}');
  });

  it('handles large payloads without stack overflow', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ status: 'updated' });

    // 128KB payload — ensures large payloads are handled correctly
    const large = new Uint8Array(128 * 1024).fill(65); // all 'A'
    await updateLease(PROVIDER_URL, LEASE_UUID, large, AUTH_TOKEN);

    const body = JSON.parse(
      mockCheckedFetch.mock.calls[0][1]?.body as string,
    ) as { payload: string };
    const decoded = atob(body.payload);
    expect(decoded.length).toBe(128 * 1024);
    expect(decoded[0]).toBe('A');
  });
});
