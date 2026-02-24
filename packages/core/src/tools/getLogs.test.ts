import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAppLogs } from './getLogs.js';
import { InMemoryAppRegistry } from '../registry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

vi.mock('../http/fred.js', () => ({
  getLeaseLogs: vi.fn(),
}));

import { getLeaseLogs } from '../http/fred.js';

const mockGetLeaseLogs = vi.mocked(getLeaseLogs);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('getAppLogs', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new InMemoryAppRegistry();
  });

  it('returns logs for a known app', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: 'line1\nline2', worker: 'log data' },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.app_name).toBe('my-app');
    expect(result.logs).toEqual({ web: 'line1\nline2', worker: 'log data' });
    expect(result.truncated).toBe(false);
  });

  it('throws QUERY_FAILED when app has no providerUrl', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
      // no providerUrl
    });

    await expect(
      getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no provider URL'),
    });
  });

  it('truncates logs to 4000 characters total across services', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    // First service: 3000 chars, second service: 2000 chars -> needs truncation
    mockGetLeaseLogs.mockResolvedValue({
      logs: {
        svc1: 'a'.repeat(3000),
        svc2: 'b'.repeat(2000),
      },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);

    const totalChars = Object.values(result.logs).reduce((sum, l) => sum + l.length, 0);
    expect(totalChars).toBeLessThanOrEqual(4000);
    expect(result.truncated).toBe(true);
  });

  it('truncates within a single service (takes tail of string)', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    // Single service with 5000 chars
    const logData = 'START' + 'x'.repeat(4990) + 'END!!';
    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: logData },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.logs.web).toHaveLength(4000);
    // slice(-4000) takes the tail, so it should end with the original ending
    expect(result.logs.web.endsWith('END!!')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('sets truncated flag when truncation occurs', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: 'a'.repeat(5000) },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when logs fit within limit', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: 'short log' },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);
    expect(result.truncated).toBe(false);
    expect(result.logs.web).toBe('short log');
  });

  it('passes tail parameter to getLeaseLogs', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockGetLeaseLogs.mockResolvedValue({ logs: {} });

    await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken, 100);

    expect(mockGetLeaseLogs).toHaveBeenCalledWith(
      'https://provider.example.com',
      'lease-1',
      'auth-token-123',
      100,
    );
  });

  it('skips services when total character limit reached', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockGetLeaseLogs.mockResolvedValue({
      logs: {
        svc1: 'a'.repeat(4000), // fills the entire budget
        svc2: 'b'.repeat(1000), // should be skipped
      },
    });

    const result = await getAppLogs(ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.logs.svc1).toHaveLength(4000);
    expect(result.logs.svc2).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it('throws when app not found in registry', async () => {
    await expect(
      getAppLogs(ADDRESS, 'nonexistent', registry, mockGetAuthToken),
    ).rejects.toThrow(ManifestMCPError);
  });
});
