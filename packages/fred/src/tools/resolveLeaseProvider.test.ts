import {
  ManifestMCPError,
  type ManifestQueryClient,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it } from 'vitest';
import type { FredReadCtx } from '../ctx.js';
import { ProviderApiError } from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

function makeCtx(
  query: ManifestQueryClient,
  allowLoopback?: boolean,
): FredReadCtx {
  return {
    query,
    chain: {} as never,
    fetch: globalThis.fetch,
    logger: noopLogger,
    ...(allowLoopback !== undefined && { allowLoopback }),
  };
}

describe('resolveProviderUrl', () => {
  it('returns validated URL when provider has apiUrl', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const url = await resolveProviderUrl(makeCtx(qc), 'prov-1');
    expect(url).toBe('https://provider.example.com');
  });

  it('throws when providerUuid is empty', async () => {
    const qc = makeMockQueryClient();

    await expect(resolveProviderUrl(makeCtx(qc), '')).rejects.toThrow(
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

    await expect(resolveProviderUrl(makeCtx(qc), 'prov-1')).rejects.toThrow(
      'has no API URL',
    );
  });

  it('throws when provider query fails', async () => {
    const qc = makeMockQueryClient();

    await expect(
      resolveProviderUrl(makeCtx(qc), 'nonexistent'),
    ).rejects.toThrow('Failed to resolve provider');
  });

  it('re-throws ManifestMCPError from query client', async () => {
    const qc = makeMockQueryClient();
    const err = new ManifestMCPError('QUERY_FAILED' as any, 'custom error');
    (qc.liftedinit.sku.v1.provider as any).mockRejectedValue(err);

    await expect(resolveProviderUrl(makeCtx(qc), 'prov-1')).rejects.toBe(err);
  });

  it('re-throws ProviderApiError from validateProviderUrl without wrapping', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'http://example.com' } },
        },
      },
    });

    await expect(resolveProviderUrl(makeCtx(qc), 'prov-1')).rejects.toThrow(
      ProviderApiError,
    );
    await expect(resolveProviderUrl(makeCtx(qc), 'prov-1')).rejects.toThrow(
      'HTTPS',
    );
  });

  it('resolves a loopback provider apiUrl when ctx.allowLoopback is true (guard off)', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'http://localhost:8080' } },
        },
      },
    });

    const url = await resolveProviderUrl(makeCtx(qc, true), 'prov-1');
    expect(url).toBe('http://localhost:8080');
  });

  it('rejects a loopback provider apiUrl by default (allowLoopback unset → strict)', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'http://localhost:8080' } },
        },
      },
    });

    await expect(resolveProviderUrl(makeCtx(qc), 'prov-1')).rejects.toThrow(
      ProviderApiError,
    );
    await expect(
      resolveProviderUrl(makeCtx(qc, false), 'prov-1'),
    ).rejects.toThrow(ProviderApiError);
  });
});
