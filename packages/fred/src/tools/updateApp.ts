import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { FredAuthCtx } from '../ctx.js';
import {
  type FredLeaseStatus,
  pollLeaseUntilReady,
  updateLease,
} from '../http/fred.js';
import {
  isStackManifest,
  mergeManifest,
  validateServiceName,
} from '../manifest.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function updateApp(
  ctx: FredAuthCtx,
  input: {
    address: string;
    leaseUuid: string;
    manifest: string;
    existingManifest?: string;
  },
  opts: LifecycleCallOptions = {},
): Promise<{ lease_uuid: string; status: string; ready?: FredLeaseStatus }> {
  const { address, leaseUuid, manifest, existingManifest } = input;
  opts.abortSignal?.throwIfAborted();

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
      for (const name of Object.keys(parsed.services)) {
        if (!validateServiceName(name)) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            `Invalid service name: "${name}". Must be 1-63 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens.`,
          );
        }
      }
      // Per-service merge: merge each service independently
      let oldParsed: unknown;
      try {
        oldParsed = JSON.parse(existingManifest);
      } catch (err) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          `Invalid existing_manifest: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isStackManifest(oldParsed)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Cannot merge: new manifest is a stack but existing_manifest is not. Provide a stack-format existing_manifest or omit existing_manifest for full replacement.',
        );
      }
      const mergedStack: Record<string, unknown> = {};
      for (const [svc, svcManifest] of Object.entries(parsed.services)) {
        const oldSvcJson = oldParsed.services[svc]
          ? JSON.stringify(oldParsed.services[svc])
          : '{}';
        mergedStack[svc] = mergeManifest(
          svcManifest as Record<string, unknown>,
          oldSvcJson,
        );
      }
      finalManifest = JSON.stringify({ services: mergedStack });
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

  // Fast path: a supplied providerUrl skips both on-chain queries (fetchActiveLease + resolveProviderUrl).
  let providerUrl: string;
  if (opts.providerUrl) {
    providerUrl = opts.providerUrl;
  } else {
    const lease = await fetchActiveLease(ctx, leaseUuid, 'cannot be updated');
    providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
  }

  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  const result = await updateLease(
    providerUrl,
    leaseUuid,
    new TextEncoder().encode(finalManifest),
    authToken,
    ctx.fetch,
  );
  const base = { lease_uuid: leaseUuid, status: result.status };

  if (opts.pollOptions === false) return base;
  const ready = await pollLeaseUntilReady(
    providerUrl,
    leaseUuid,
    () => ctx.providerAuth.providerToken({ address, leaseUuid }),
    { ...opts.pollOptions, abortSignal: opts.abortSignal },
    ctx.fetch,
  );
  return { ...base, ready };
}
