import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchFaucetStatus,
  requestFaucet,
  requestFaucetCredit,
} from './faucet.js';

function mockFetch(
  responses: Array<{ status: number; body: string | Record<string, unknown> }>,
): typeof globalThis.fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const r = responses[callIndex++];
    if (!r) throw new Error('Unexpected fetch call');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `HTTP ${r.status}`,
      json: async () =>
        typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
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

/** Builds a valid faucet /status response body with optional overrides. */
function statusBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'ok',
    nodeUrl: 'http://localhost:26657',
    chainId: 'manifest-ledger-beta',
    chainTokens: ['umfx', 'upwr'],
    availableTokens: ['umfx', 'upwr'],
    holder: { address: 'manifest1faucet', balance: [] },
    distributors: [],
    ...overrides,
  };
}

describe('fetchFaucetStatus', () => {
  it('returns status with available denoms', async () => {
    const body = statusBody({
      holder: {
        address: 'manifest1faucet',
        balance: [
          { denom: 'umfx', amount: '10000000' },
          { denom: 'upwr', amount: '10000000' },
        ],
      },
    });
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

  it('throws ManifestMCPError when availableTokens field is missing', async () => {
    const fetch = mockFetch([{ status: 200, body: { status: 'ok' } }]);

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('throws ManifestMCPError when availableTokens is not an array', async () => {
    const fetch = mockFetch([
      { status: 200, body: { status: 'ok', availableTokens: 'umfx' } },
    ]);

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('throws ManifestMCPError when required fields are missing', async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: { status: 'ok', availableTokens: ['umfx'], chainTokens: [] },
      },
    ]);

    await expect(fetchFaucetStatus(FAUCET_URL, fetch)).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('strips trailing slashes from faucet URL', async () => {
    const body = statusBody({
      chainTokens: ['umfx'],
      availableTokens: ['umfx'],
    });
    const fetch = mockFetch([{ status: 200, body }]);

    await fetchFaucetStatus('https://faucet.test.com///', fetch);

    expect(fetch).toHaveBeenCalledWith(
      'https://faucet.test.com/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('requestFaucetCredit', () => {
  it('returns success on 200 with plain text body', async () => {
    const fetch = mockFetch([{ status: 200, body: 'ok' }]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result).toEqual({ denom: 'umfx', success: true });
    expect(fetch).toHaveBeenCalledWith(
      `${FAUCET_URL}/credit`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: ADDRESS, denom: 'umfx' }),
      }),
    );
  });

  it('returns failure with error on cooldown (405)', async () => {
    const fetch = mockFetch([
      {
        status: 405,
        body: 'Too many requests for the same address. Blocked to prevent draining. Please wait 86400 seconds and try it again!',
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
    expect(result.error).toContain('Too many requests');
  });

  it('returns failure on bad address (400)', async () => {
    const fetch = mockFetch([
      {
        status: 400,
        body: 'Address is not in the expected format for this chain.',
      },
    ]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Address is not in the expected format');
  });

  it('returns failure on unavailable token (422)', async () => {
    const fetch = mockFetch([
      {
        status: 422,
        body: 'Token is not available. Available tokens are: umfx,upwr',
      },
    ]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'ubad',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Token is not available');
  });

  it('returns failure on send error (500)', async () => {
    const fetch = mockFetch([{ status: 500, body: 'Sending tokens failed' }]);

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Sending tokens failed');
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

  it('handles non-Error thrown values', async () => {
    const fetch = vi.fn(async () => {
      throw 'string error';
    }) as unknown as typeof globalThis.fetch;

    const result = await requestFaucetCredit(
      FAUCET_URL,
      ADDRESS,
      'umfx',
      fetch,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });
});

describe('requestFaucet', () => {
  it('requests specific denom without calling /status', async () => {
    const fetch = mockFetch([{ status: 200, body: 'ok' }]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, 'umfx', fetch);

    expect(result.address).toBe(ADDRESS);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].denom).toBe('umfx');
    expect(result.results[0].success).toBe(true);
    // Only one fetch call (no /status)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discovers denoms from /status and requests all', async () => {
    // /status + 2x /credit
    const fetch = mockFetch([
      { status: 200, body: statusBody() },
      { status: 200, body: 'ok' },
      { status: 200, body: 'ok' },
    ]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.success)).toBe(true);
  });

  it('handles partial success (one denom on cooldown)', async () => {
    const fetch = mockFetch([
      { status: 200, body: statusBody() },
      { status: 200, body: 'ok' },
      {
        status: 405,
        body: 'Too many requests for the same address. Blocked to prevent draining. Please wait 86400 seconds and try it again!',
      },
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

  it('filters empty strings from availableTokens', async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: statusBody({
          chainTokens: ['umfx', ''],
          availableTokens: ['', 'umfx', ''],
        }),
      },
      { status: 200, body: 'ok' },
    ]);

    const result = await requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].denom).toBe('umfx');
  });

  it('throws when all availableTokens are empty strings', async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: statusBody({
          chainTokens: [],
          availableTokens: ['', ''],
        }),
      },
    ]);

    await expect(
      requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('throws when faucet has no tokens configured', async () => {
    const fetch = mockFetch([
      {
        status: 200,
        body: statusBody({ chainTokens: [], availableTokens: [] }),
      },
    ]);

    await expect(
      requestFaucet(FAUCET_URL, ADDRESS, undefined, fetch),
    ).rejects.toThrow(ManifestMCPError);
  });
});
