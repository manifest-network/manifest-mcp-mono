import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { updateLease } from '../http/fred.js';
import {
  isStackManifest,
  mergeManifest,
  validateServiceName,
} from '../manifest.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function updateApp(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  manifest: string,
  existingManifest?: string,
  fetchFn?: typeof globalThis.fetch,
) {
  const lease = await fetchActiveLease(
    queryClient,
    leaseUuid,
    'cannot be updated',
  );

  let finalManifest = manifest;
  if (existingManifest) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(manifest) as Record<string, unknown>;
    } catch (err) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (isStackManifest(parsed)) {
      for (const name of Object.keys(parsed)) {
        if (!validateServiceName(name)) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            `Invalid service name: "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`,
          );
        }
      }
      // Per-service merge: merge each service independently
      let oldStack: Record<string, unknown>;
      try {
        oldStack = JSON.parse(existingManifest) as Record<string, unknown>;
      } catch (err) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid existing_manifest: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const mergedStack: Record<string, unknown> = {};
      for (const [svc, svcManifest] of Object.entries(parsed)) {
        const oldSvcJson = oldStack[svc] ? JSON.stringify(oldStack[svc]) : '{}';
        mergedStack[svc] = mergeManifest(
          svcManifest as Record<string, unknown>,
          oldSvcJson,
        );
      }
      finalManifest = JSON.stringify(mergedStack);
    } else {
      try {
        const merged = mergeManifest(parsed, existingManifest);
        finalManifest = JSON.stringify(merged);
      } catch (err) {
        if (err instanceof ManifestMCPError) throw err;
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid existing_manifest: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  const authToken = await getAuthToken(address, leaseUuid);
  const result = await updateLease(
    providerUrl,
    leaseUuid,
    finalManifest,
    authToken,
    fetchFn,
  );

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
