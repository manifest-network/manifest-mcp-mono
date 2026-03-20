import { describe, expect, it, vi } from 'vitest';
import {
  checkedFetch,
  ProviderApiError,
  parseJsonResponse,
  validateProviderUrl,
} from './provider.js';

describe('validateProviderUrl', () => {
  it('accepts HTTPS URLs', () => {
    expect(validateProviderUrl('https://provider.example.com/')).toBe(
      'https://provider.example.com',
    );
  });

  it('strips trailing slashes', () => {
    expect(validateProviderUrl('https://example.com///')).toBe(
      'https://example.com',
    );
  });

  it('accepts HTTP localhost', () => {
    expect(validateProviderUrl('http://localhost:8080')).toBe(
      'http://localhost:8080',
    );
    expect(validateProviderUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it('rejects HTTP non-localhost', () => {
    expect(() => validateProviderUrl('http://example.com')).toThrow(
      ProviderApiError,
    );
  });

  it('rejects invalid URLs', () => {
    expect(() => validateProviderUrl('not-a-url')).toThrow(ProviderApiError);
  });
});

describe('checkedFetch', () => {
  it('returns response for successful requests', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await checkedFetch(
      'https://example.com',
      undefined,
      5000,
      mockFetch,
    );
    expect(res.ok).toBe(true);
  });

  it('throws ProviderApiError for non-ok responses', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('bad', { status: 500 }));
    await expect(
      checkedFetch('https://example.com', undefined, 5000, mockFetch),
    ).rejects.toThrow(ProviderApiError);
  });

  it('throws ProviderApiError on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      checkedFetch('https://example.com', undefined, 5000, mockFetch),
    ).rejects.toThrow(ProviderApiError);
  });
});

describe('parseJsonResponse', () => {
  it('parses valid JSON', async () => {
    const res = new Response('{"status":"ok"}', { status: 200 });
    const result = await parseJsonResponse<{ status: string }>(
      res,
      'https://example.com',
    );
    expect(result.status).toBe('ok');
  });

  it('throws ProviderApiError for invalid JSON', async () => {
    const res = new Response('not json', { status: 200 });
    await expect(parseJsonResponse(res, 'https://example.com')).rejects.toThrow(
      ProviderApiError,
    );
  });
});
