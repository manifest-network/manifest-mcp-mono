import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  return {
    ...actual,
    validateProviderUrl: vi.fn((url: string) => url),
    checkedFetch: vi.fn(),
    parseJsonResponse: vi.fn(),
  };
});

import { pollLeaseUntilReady, getLeaseLogs, getLeaseStatus, MAX_TAIL } from './fred.js';
import { checkedFetch, parseJsonResponse } from './provider.js';

const mockCheckedFetch = vi.mocked(checkedFetch);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';

describe('getLeaseStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches status with auth header', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ status: 'ready' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result).toEqual({ status: 'ready' });
    expect(mockCheckedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/status`),
      expect.objectContaining({ headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }),
      undefined,
      undefined,
    );
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

  it('returns immediately when status is ready', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'ready' });

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result.status).toBe('ready');
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('returns when status is running', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'running' });

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result.status).toBe('running');
  });

  it('throws on failed status', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'failed' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/entered failed state/);
  });

  it('throws on error status', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'error' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/entered error state/);
  });

  it('polls until ready after pending', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
      callCount++;
      return { status: callCount < 3 ? 'pending' : 'ready' };
    });

    const result = await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 5000,
    });
    expect(result.status).toBe('ready');
    expect(callCount).toBe(3);
  });

  it('times out if never ready', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'pending' });

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
      return { status: callCount < 2 ? 'pending' : 'ready' };
    });

    const tokenFn = vi.fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, tokenFn, {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(tokenFn).toHaveBeenCalledTimes(2);
    // Verify different tokens were used in successive calls
    const firstAuth = mockCheckedFetch.mock.calls[0][1]?.headers as Record<string, string>;
    const secondAuth = mockCheckedFetch.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstAuth.Authorization).toBe('Bearer token-1');
    expect(secondAuth.Authorization).toBe('Bearer token-2');
  });

  it('includes last status in timeout error message', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'provisioning' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/last status: provisioning/);
  });
});
