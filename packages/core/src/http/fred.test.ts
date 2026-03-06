import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getLeaseStatus,
  getLeaseLogs,
  getLeaseProvision,
  restartLease,
  updateLease,
  pollLeaseUntilReady,
} from './fred.js';
import { ProviderApiError } from './provider.js';

const mockFetch = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_URL = 'https://provider.example.com';
const LEASE_UUID = 'lease-1234';
const AUTH_TOKEN = 'token-abc';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('getLeaseStatus', () => {
  it('constructs correct URL and passes auth header', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'running', services: {} }));

    const result = await getLeaseStatus(BASE_URL, LEASE_UUID, AUTH_TOKEN);

    expect(result).toEqual({ status: 'running', services: {} });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/status`);
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it('throws ProviderApiError on HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(getLeaseStatus(BASE_URL, LEASE_UUID, AUTH_TOKEN)).rejects.toThrow(ProviderApiError);
  });

  it('uses custom fetchFn when provided', async () => {
    const customFetch = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }));

    const result = await getLeaseStatus(BASE_URL, LEASE_UUID, AUTH_TOKEN, customFetch);

    expect(result).toEqual({ status: 'ready' });
    expect(customFetch).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('getLeaseLogs', () => {
  it('appends tail query parameter', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: { web: 'log data' } }));

    await getLeaseLogs(BASE_URL, LEASE_UUID, AUTH_TOKEN, 50);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/logs?tail=50`);
  });

  it('caps tail at 1000', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: {} }));

    await getLeaseLogs(BASE_URL, LEASE_UUID, AUTH_TOKEN, 5000);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('?tail=1000');
  });

  it('omits tail param when undefined', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: {} }));

    await getLeaseLogs(BASE_URL, LEASE_UUID, AUTH_TOKEN);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/logs`);
  });

  it('returns parsed log response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ logs: { svc1: 'line1\nline2' } }));

    const result = await getLeaseLogs(BASE_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.logs).toEqual({ svc1: 'line1\nline2' });
  });
});

describe('getLeaseProvision', () => {
  it('constructs correct URL and returns provision status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'provisioned' }));

    const result = await getLeaseProvision(BASE_URL, LEASE_UUID, AUTH_TOKEN);

    expect(result).toEqual({ status: 'provisioned' });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/provision`);
  });
});

describe('restartLease', () => {
  it('sends POST with auth header', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'restarting' }));

    const result = await restartLease(BASE_URL, LEASE_UUID, AUTH_TOKEN);

    expect(result).toEqual({ status: 'restarting' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/restart`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
  });
});

describe('updateLease', () => {
  it('sends POST with octet-stream body and auth header', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'updating' }));

    const payload = 'binary-data-here';
    const result = await updateLease(BASE_URL, LEASE_UUID, payload, AUTH_TOKEN);

    expect(result).toEqual({ status: 'updating' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/fred/lease/${LEASE_UUID}/update`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(init.body).toBe(payload);
  });
});

describe('pollLeaseUntilReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on ready status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'ready' }));

    const promise = pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN);
    const result = await promise;

    expect(result.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns on running status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'running' }));

    const result = await pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN);

    expect(result.status).toBe('running');
  });

  it('throws on failed status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'failed' }));

    await expect(
      pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN),
    ).rejects.toThrow(ProviderApiError);
  });

  it('throws on error status', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: 'error' }));

    await expect(
      pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN),
    ).rejects.toThrow(/entered error state/);
  });

  it('throws on timeout', { timeout: 5000 }, async () => {
    // Use real timers for this test to avoid unhandled-rejection timing issues
    vi.useRealTimers();
    mockFetch.mockImplementation(async () => jsonResponse({ status: 'provisioning' }));

    await expect(
      pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 30,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('calls token factory on each poll iteration', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) {
        return jsonResponse({ status: 'ready' });
      }
      return jsonResponse({ status: 'provisioning' });
    });

    const tokenFactory = vi.fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    const promise = pollLeaseUntilReady(BASE_URL, LEASE_UUID, tokenFactory, {
      intervalMs: 200,
      timeoutMs: 10_000,
    });

    // First call with token-1
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenFactory).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer token-1');

    // Second call with token-2
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.status).toBe('ready');
    expect(tokenFactory).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
  });

  it('polls at the specified interval and returns when ready', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount >= 3) {
        return jsonResponse({ status: 'ready' });
      }
      return jsonResponse({ status: 'provisioning' });
    });

    const promise = pollLeaseUntilReady(BASE_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 200,
      timeoutMs: 10_000,
    });

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call after interval
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Third call after another interval
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
