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
import { ProviderApiError } from '../http/provider.js';
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

/**
 * Turn a 5xx from `POST /update` into an honest "we do not know" (ENG-619).
 *
 * Fred's `/update` persists the payload to `payloads.db` AFTER handing it to the
 * backend, and answers 500 when that persist fails — where the pre-ENG-619 build
 * answered a misleading `202`. Three faults reach that 500 and all three emit an
 * identical body, so the wire cannot tell them apart:
 *
 *   - `payload_store_db_path` unset  → refused before the backend; NOT applied.
 *   - the backend rejected           → NOT applied.
 *   - persist failed after apply     → APPLIED, and the next reprovision reverts it.
 *
 * The third is why a flat "update failed" is the wrong thing to say: a model that
 * believes the update failed typically reaches for close-and-redeploy, which
 * destroys a lease whose deployment is in fact live.
 *
 * Scoped to `status >= 500` on purpose. A 4xx is a stable answer that Fred authored
 * about the request itself, and wrapping it would break the raw-body match at
 * `e2e/lifecycle.e2e.test.ts` that polls transient 409s. Transport faults (status 0
 * — network, timeout) are also left alone: genuinely in-doubt too, but a different
 * story to tell, and unchanged by this Fred release.
 *
 * Anything not matching is rethrown untouched.
 */
function rethrowIndeterminate(err: unknown, leaseUuid: string): unknown {
  if (!ProviderApiError.isProviderApiError(err) || err.status < 500) return err;
  return new ManifestMCPError(
    ManifestMCPErrorCode.UPDATE_INDETERMINATE,
    `The provider could not durably record the update to lease ${leaseUuid} (HTTP ${err.status}), ` +
      'so it may or may not have been applied — and an update that WAS applied but not recorded ' +
      "is reverted by the provider's next reprovision. Check app_status and app_releases to see " +
      'which manifest is actually live before doing anything else. Re-invoking update_app is safe ' +
      'and re-applies AND re-records; do NOT close the lease and redeploy — the app may be running. ' +
      `Provider said: ${err.message}`,
    { lease_uuid: leaseUuid, status: err.status },
  );
}

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
  // Resolve ONCE: a second call would mint a second timeout from the same `timeout`.
  const signal = resolveFredSignal(opts);
  signal?.throwIfAborted();

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

  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  // Final check immediately before the non-idempotent mutate POST: an abort during the
  // (slow-path) providerUrl resolution / token mint must not still fire the update.
  signal?.throwIfAborted();
  let result: Awaited<ReturnType<typeof updateLease>>;
  try {
    result = await updateLease(
      providerUrl,
      leaseUuid,
      finalManifestBytes,
      authToken,
      ctx.fetch,
      ctx.allowLoopback,
    );
  } catch (err) {
    throw rethrowIndeterminate(err, leaseUuid);
  }
  const base = { lease_uuid: leaseUuid, status: result.status };

  if (opts.pollOptions === false) return base;
  const ready = await pollLeaseUntilReady(
    providerUrl,
    leaseUuid,
    () => ctx.providerAuth.providerToken({ address, leaseUuid }),
    { ...opts.pollOptions, abortSignal: signal },
    ctx.fetch,
    ctx.allowLoopback,
  );
  return { ...base, ready };
}
