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
import { validateProviderUrl } from '../http/provider.js';
import { resolveMaintenanceIdempotencyKey } from '../maintenance.js';
import {
  maintenanceError,
  maintenanceWaitError,
} from '../maintenance-error.js';
import {
  isStackManifest,
  mergeManifest,
  validateServiceName,
} from '../manifest.js';
import { resolveFredSignal } from './call-signal.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import {
  assertManifestFitsUpdateRequest,
  parseAndValidateManifestPayload,
} from './validateManifestPayload.js';

export async function updateApp(
  ctx: FredAuthCtx,
  input: {
    address: string;
    leaseUuid: string;
    manifest: string;
    existingManifest?: string;
  },
  opts: LifecycleCallOptions = {},
): Promise<{
  lease_uuid: string;
  idempotency_key: string;
  status: string;
  ready?: FredLeaseStatus;
}> {
  const { address, leaseUuid, manifest, existingManifest } = input;
  // Resolve ONCE: a second call would mint a second timeout from the same `timeout`.
  const signal = resolveFredSignal(opts);
  signal?.throwIfAborted();
  const idempotencyKey = resolveMaintenanceIdempotencyKey(opts.idempotencyKey);

  let finalManifest = manifest;
  if (existingManifest) {
    let parsed: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(manifest);
      if (
        candidate === null ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        throw new Error('must be a JSON object');
      }
      parsed = candidate as Record<string, unknown>;
    } catch (err) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (isStackManifest(parsed)) {
      if (Object.keys(parsed).some((key) => key !== 'services')) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'Stack manifest updates must contain only the top-level "services" field; move single-service fields inside each service.',
        );
      }
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

  // Validate the final payload after merge. This catches bad fields carried
  // forward from existing_manifest as well as new input, before provider URL
  // lookup, token minting, or the destructive update POST (ENG-637/ENG-755).
  const { bytes: finalManifestBytes } =
    parseAndValidateManifestPayload(finalManifest);
  assertManifestFitsUpdateRequest(finalManifestBytes);

  // Fast path: a supplied providerUrl skips both on-chain queries (fetchActiveLease + resolveProviderUrl).
  let providerUrl: string;
  if (opts.providerUrl) {
    providerUrl = opts.providerUrl;
  } else {
    const lease = await fetchActiveLease(ctx, leaseUuid, 'cannot be updated');
    providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
  }

  // URL rejection is local and proves no maintenance request was sent.
  validateProviderUrl(providerUrl, { allowLoopback: ctx.allowLoopback });

  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  // Final check immediately before the mutate POST: an abort during the
  // (slow-path) providerUrl resolution / token mint must not still fire the update.
  signal?.throwIfAborted();
  const command = { operation: 'update' as const, leaseUuid, idempotencyKey };
  let result: Awaited<ReturnType<typeof updateLease>>;
  try {
    result = await updateLease(
      providerUrl,
      leaseUuid,
      finalManifestBytes,
      authToken,
      ctx.fetch,
      ctx.allowLoopback,
      idempotencyKey,
    );
  } catch (err) {
    throw maintenanceError(err, { ...command, outcome: 'unknown' });
  }
  const base = {
    lease_uuid: leaseUuid,
    idempotency_key: idempotencyKey,
    status: result.status,
  };

  if (opts.pollOptions === false) return base;
  try {
    const ready = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => ctx.providerAuth.providerToken({ address, leaseUuid }),
      { ...opts.pollOptions, abortSignal: signal },
      ctx.fetch,
      ctx.allowLoopback,
    );
    return { ...base, ready };
  } catch (err) {
    throw maintenanceWaitError(err, {
      ...command,
      signal,
      callerSignals: [opts.signal, opts.abortSignal],
    });
  }
}
