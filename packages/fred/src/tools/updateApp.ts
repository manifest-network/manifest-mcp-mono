import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { LeaseState, leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { updateLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { mergeManifest, isStackManifest } from '../manifest.js';

export async function updateApp(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  manifest: string,
  existingManifest?: string,
  fetchFn?: typeof globalThis.fetch,
) {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({ leaseUuid });

  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }

  const lease = leaseResult.lease;

  if (lease.state !== LeaseState.LEASE_STATE_ACTIVE && lease.state !== LeaseState.LEASE_STATE_PENDING) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is not active (state: ${leaseStateToJSON(lease.state)}) and cannot be updated`,
    );
  }

  let finalManifest = manifest;
  if (existingManifest) {
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    if (isStackManifest(parsed)) {
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
        mergedStack[svc] = mergeManifest(svcManifest as Record<string, unknown>, oldSvcJson);
      }
      finalManifest = JSON.stringify(mergedStack);
    } else {
      const merged = mergeManifest(parsed, existingManifest);
      finalManifest = JSON.stringify(merged);
    }
  }

  const providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  const authToken = await getAuthToken(address, leaseUuid);
  const result = await updateLease(providerUrl, leaseUuid, finalManifest, authToken, fetchFn);

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
