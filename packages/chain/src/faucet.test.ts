import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchFaucetStatus,
  requestFaucet,
  requestFaucetCredit,
} from './faucet.js';

function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
): typeof globalThis.fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const r = responses[callIndex++];
    if (!r) throw new Error('Unexpected fetch call');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `HTTP ${r.status}`,
      json: async () => r.body,
      text: async () =>
        typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
    } as Response;
  }) as typeof globalThis.fetch;
}

function mockFetchError(error: Error): typeof globalThis.fetch {
  return vi.fn(async () => {
    throw error;
  }) as typeof globalThis.fetch;
}

const FAUCET_URL = 'https://faucet.test.com';
const ADDRESS = 'manifest1abc';

describe('fetchFaucetStatus', () => {
  it('returns status with available denoms', async () => {
    const body = {
      address: 'manifest1faucet',
      tokens: [
        { denom: 'umfx', amount: '10000000' },
        { denom: 'upwr', amount: '10000000' },
      ],
      cooldown: 86400,
    };
    const fetch = mockFetch([{ status: 200, body }]);

    const result = await fetchFaucetStatus(FAUCET_URL, fetch);

    expect(result).toEqual(body);
    expect(fetch).toHaveBeenCalledWith(
      `${FAUCET_URL}/status`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('throws ManifestMCPError on non-200', async () => {
    const fetch = mockFetch([{ status: 503, body: 'Service Unavailable' }]);

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('throws ManifestMCPError on network error', async () => {
    const fetch = mockFetchError(new Error('Connection refused'));

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('throws ManifestMCPError on invalid JSON response', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => '<html>error</html>',
    })) as unknown as typeof globalThis.fetch;

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('throws ManifestMCPError when tokens field is missing', async () => {
    const fetch = mockFetch([{ status: 200, body: { address: 'x' } }]);

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });
});

describe('requestFaucetCredit', () => {
  it('returns success with transactionHash on 200', async () => {
    const fetch = mockFetch([
      { status: 200, body: { transactionHash: 'HASH123' } },
    ]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result).toEqual({
      denom: 'umfx',
      success: true,
      transactionHash: 'HASH123',
    });
    expect(fetch).toHaveBeenCalledWith(
      `${FAUCET_URL}/credit`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: ADDRESS, denom: 'umfx' }),
      }),
    );
  });

  it('returns failure with error on non-200', async () => {
    const fetch = mockFetch([
      {
        status: 429,
        body: 'Cooldown active for umfx. Try again in 85000s.',
      },
    ]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.denom).toBe('umfx');
    expect(result.error).toContain('Cooldown');
  });

  it('returns failure on network error', async () => {
    const fetch = mockFetchError(new Error('Connection refused'));

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
  });
});

describe('requestFaucet', () => {
  it('requests specific denom without calling /status', async () => {
    const fetch = mockFetch([
      { status: 200, body: { transactionHash: 'TX1' } },
    ]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, 'umfx', fetch);

    expect(result.address).toBe(ADDRESS);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].denom).toBe('umfx');
    expect(result.results[0].success).toBe(true);
    // Only one fetch call (no /status)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discovers denoms from /status and requests all', async () => {
    const statusBody = {
      address: 'manifest1faucet',
      tokens: [
        { denom: 'umfx', amount: '10000000' },
        { denom: 'upwr', amount: '10000000' },
      ],
      cooldown: 86400,
    };
    // /status + 2x /credit
    const fetch = mockFetch([
      { status: 200, body: statusBody },
      { status: 200, body: { transactionHash: 'TX_MFX' } },
      { status: 200, body: { transactionHash: 'TX_PWR' } },
    ]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.success)).toBe(true);
  });

  it('handles partial success', async () => {
    const statusBody = {
      address: 'manifest1faucet',
      tokens: [
        { denom: 'umfx', amount: '10000000' },
        { denom: 'upwr', amount: '10000000' },
      ],
      cooldown: 86400,
    };
    const fetch = mockFetch([
      { status: 200, body: statusBody },
      { status: 200, body: { transactionHash: 'TX_MFX' } },
      { status: 429, body: 'Cooldown active for upwr.' },
    ]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch);

    expect(result.results).toHaveLength(2);
    const mfx = result.results.find((r) => r.denom === 'umfx');
    const pwr = result.results.find((r) => r.denom === 'upwr');
    expect(mfx?.success).toBe(true);
    expect(pwr?.success).toBe(false);
  });

  it('propagates error when /status endpoint fails', async () => {
    const fetch = mockFetch([{ status: 503, body: 'Service Unavailable' }]);

    await expect(
      requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('throws when faucet has no tokens configured', async () => {
    const statusBody = {
      address: 'manifest1faucet',
      tokens: [],
      cooldown: 86400,
    };
    const fetch = mockFetch([{ status: 200, body: statusBody }]);

    await expect(
      requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch),
    ).rejects.toThrow(ManifestMCPError);
  });
});
