import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { ProviderApiError, validateProviderUrl } from '../http/provider.js';

export async function resolveProviderUrl(
  queryClient: ManifestQueryClient,
  providerUuid: string,
): Promise<string> {
  if (!providerUuid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      'Provider UUID is empty; the lease may not have an assigned provider',
    );
  }

  try {
    const providerResult = await queryClient.liftedinit.sku.v1.provider({
      uuid: providerUuid,
    });

    if (!providerResult.provider?.apiUrl) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Provider "${providerUuid}" has no API URL`,
      );
    }

    return validateProviderUrl(providerResult.provider.apiUrl);
  } catch (error) {
    if (error instanceof ManifestMCPError) throw error;
    if (error instanceof ProviderApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Failed to resolve provider "${providerUuid}" via SKU module: ${message}`,
    );
  }
}
