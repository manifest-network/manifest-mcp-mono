import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it } from 'vitest';
import { ProviderApiError } from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

describe('resolveProviderUrl', () => {
  it('returns validated URL when provider has apiUrl', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const url = await resolveProviderUrl(qc, 'prov-1');
    expect(url).toBe('https://provider.example.com');
  });

  it('throws when providerUuid is empty', async () => {
    const qc = makeMockQueryClient();

    await expect(resolveProviderUrl(qc, '')).rejects.toThrow(
      'Provider UUID is empty',
    );
  });

  it('throws when provider has no apiUrl', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: '' } },
        },
      },
    });

    await expect(resolveProviderUrl(qc, 'prov-1')).rejects.toThrow(
      'has no API URL',
    );
  });

  it('throws when provider query fails', async () => {
    const qc = makeMockQueryClient();

    await expect(resolveProviderUrl(qc, 'nonexistent')).rejects.toThrow(
      'Failed to resolve provider',
    );
  });

  it('re-throws ManifestMCPError from query client', async () => {
    const qc = makeMockQueryClient();
    const err = new ManifestMCPError('QUERY_FAILED' as any, 'custom error');
    (qc.liftedinit.sku.v1.provider as any).mockRejectedValue(err);

    await expect(resolveProviderUrl(qc, 'prov-1')).rejects.toBe(err);
  });

  it('re-throws ProviderApiError from validateProviderUrl without wrapping', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'http://example.com' } },
        },
      },
    });

    await expect(resolveProviderUrl(qc, 'prov-1')).rejects.toThrow(
      ProviderApiError,
    );
    await expect(resolveProviderUrl(qc, 'prov-1')).rejects.toThrow(
      'HTTPS',
    );
  });
});
