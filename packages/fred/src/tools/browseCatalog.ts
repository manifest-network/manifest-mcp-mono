import {
  createPagination,
  INFRASTRUCTURE_ERROR_CODES,
  MAX_PAGE_LIMIT,
  ManifestMCPError,
  sanitizeForDisplay,
} from '@manifest-network/manifest-mcp-core';
import type { FredReadCtx } from '../ctx.js';
import {
  getProviderHealth,
  ProviderApiError,
  type ProviderHealthResponse,
} from '../http/provider.js';

/** Maximum concurrent outgoing health check requests to provider APIs */
const MAX_CONCURRENT_HEALTH_CHECKS = 5;

/**
 * Run an array of async functions with a concurrency limit.
 * Returns results in the same order as the input.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Cap on the per-check detail folded into one provider's `healthError`. A provider
 *  with a large backend fleet can fail many probes at once, and this string is
 *  repeated for EVERY provider in a catalog response the model then reads. */
const MAX_REPORTED_CHECKS = 5;

/**
 * Per-field caps on provider-controlled health text (ENG-555, ENG-669).
 *
 * Bounding the NUMBER of checks is not enough: the check names and messages are
 * themselves provider-controlled, arrive bounded only by the 10 MiB transport cap,
 * and land in `structuredContent` on a SUCCESS response — which is precisely the
 * sink ENG-669 called out, because no error-path cap ever sees it. Before this
 * summary existed, `healthError` was built from `err.message` and inherited the
 * `ProviderApiError` constructor's cap; composing from `checks` directly would
 * bypass that entirely, and `browse_catalog` repeats it per provider.
 *
 * `sanitizeForDisplay` does both halves of the job — strips Cc/Cf/Zl/Zp (so a
 * provider cannot smuggle a bidi override or NUL into model-facing prose) and
 * truncates by code point. Fred's own messages are curated constants of ~30 chars,
 * so these caps are generous rather than lossy.
 */
const CHECK_NAME_CHARS = 64;
const CHECK_MESSAGE_CHARS = 120;
/** Whole-summary backstop, so one provider's contribution stays bounded no matter
 *  how the per-field caps and check count multiply out (5 × ~190 + prefix). */
const MAX_HEALTH_ERROR_CHARS = 1024;
/** The verdict is provider-controlled too, and is echoed as `health_status`. */
const HEALTH_STATUS_CHARS = 32;

/**
 * Order failing checks so the cap above can never drop a DISTINCT one.
 *
 * The provider's `checks` map is marshalled by Go's `encoding/json`, which SORTS map
 * keys — so the wire order is `backend:docker-1`, `backend:docker-2`, …, `chain`,
 * `payload_store`, `placement_store`, `token_tracker`, and `JSON.parse` preserves it.
 * A head-of-list cap therefore keeps only the `backend:*` prefix and silently drops
 * every singleton check, including `payload_store` — the one this whole summary exists
 * to surface, since it is the pre-flight tell that `update_app` will 5xx here.
 *
 * The singleton checks are bounded at four by construction and each means something
 * different, so they all go first. `backend:*` is the unbounded, repetitive family: N
 * failing backends carry roughly the information of one, and the residual count after
 * the cap says the rest.
 */
function byDiagnosticValue(
  [a]: [string, unknown],
  [b]: [string, unknown],
): number {
  const backendA = a.startsWith('backend:') ? 1 : 0;
  const backendB = b.startsWith('backend:') ? 1 : 0;
  if (backendA !== backendB) return backendA - backendB;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render a non-`healthy` verdict into an actionable one-liner (ENG-522/ENG-608).
 *
 * Before `/health` became a liveness contract, an impaired provider answered 503, the
 * transport threw, and the thrown `ProviderApiError` carried the entire health body in
 * its message — so the per-check diagnosis reached the caller as a side effect. On a
 * 200 nothing throws and `checks` is projected away, which would leave a bare
 * `healthy: false` with no attribution at all. This puts the attribution back.
 *
 * Only FAILING checks are named: a passing probe is noise, and listing them all would
 * bury the one that matters. The messages are the provider's own curated constants
 * ("chain connectivity failed", "payload store unavailable", …) — deliberately free of
 * host paths and command output — so they are safe to relay verbatim.
 */
function summarizeFailedChecks(health: ProviderHealthResponse): string {
  const failed = Object.entries(health.checks ?? {})
    .filter(([, c]) => c?.status !== 'healthy')
    .sort(byDiagnosticValue);
  const verdict = sanitizeForDisplay(health.status, HEALTH_STATUS_CHARS);
  if (failed.length === 0) {
    // A verdict with no failing check named: the provider is telling us something is
    // wrong without saying what. Report the verdict rather than inventing a cause.
    return `Provider reports status "${verdict}"`;
  }
  const shown = failed
    .slice(0, MAX_REPORTED_CHECKS)
    .map(([name, c]) => {
      const label = sanitizeForDisplay(name, CHECK_NAME_CHARS);
      return c?.message
        ? `${label} (${sanitizeForDisplay(c.message, CHECK_MESSAGE_CHARS)})`
        : label;
    })
    .join(', ');
  const omitted = failed.length - Math.min(failed.length, MAX_REPORTED_CHECKS);
  // Capped again as a whole: the per-field caps bound each piece, this bounds the sum.
  return sanitizeForDisplay(
    `Provider reports status "${verdict}"; failing checks: ${shown}${
      omitted > 0 ? `, and ${omitted} more` : ''
    }`,
    MAX_HEALTH_ERROR_CHARS,
  );
}

export async function browseCatalog(ctx: FredReadCtx) {
  const sku = ctx.query.liftedinit.sku.v1;

  const pagination = createPagination(MAX_PAGE_LIMIT);

  const [providersResult, skusResult] = await Promise.all([
    sku.providers({ activeOnly: true, pagination }),
    sku.sKUs({ activeOnly: true, pagination }),
  ]);

  const providers = await mapWithConcurrency(
    providersResult.providers,
    MAX_CONCURRENT_HEALTH_CHECKS,
    async (p) => {
      let healthy = false;
      let healthStatus: string | undefined;
      let providerUuid: string | undefined;
      let healthError: string | undefined;
      try {
        const health = await getProviderHealth(
          p.apiUrl,
          undefined,
          ctx.fetch,
          ctx.allowLoopback,
        );
        // Sanitized + capped: this is echoed into structuredContent verbatim, and
        // `status` is as provider-controlled as any check message (ENG-555/ENG-669).
        healthStatus = sanitizeForDisplay(health.status, HEALTH_STATUS_CHARS);
        // Exact match on the one verdict that means "fully serving". Everything else
        // — `degraded`, `unhealthy`, or a tier a future provider adds — is not usable
        // for a deploy. Note `degraded` DOES still serve some traffic, which is why
        // the raw verdict is reported alongside; but its chain-impaired flavour fails
        // every lease-resolving endpoint, so `false` is the honest default here.
        healthy = health.status === 'healthy';
        providerUuid = health.provider_uuid;
        if (!healthy) healthError = summarizeFailedChecks(health);
      } catch (err) {
        if (
          err instanceof ManifestMCPError &&
          INFRASTRUCTURE_ERROR_CODES.has(err.code)
        )
          throw err;
        if (err instanceof ProviderApiError) {
          healthError = `HTTP ${err.status}: ${err.message}`;
        } else {
          healthError = `Health check failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return {
        uuid: p.uuid,
        address: p.address,
        apiUrl: p.apiUrl,
        active: p.active,
        healthy,
        ...(healthStatus !== undefined && { health_status: healthStatus }),
        providerUuid,
        ...(healthError && { healthError }),
      };
    },
  );

  const providerByUuid = new Map(
    providersResult.providers.map((p) => [p.uuid, p]),
  );

  const skus = skusResult.skus.map((s) => ({
    name: s.name,
    sku_uuid: s.uuid,
    provider_uuid: s.providerUuid,
    provider_url: providerByUuid.get(s.providerUuid)?.apiUrl ?? null,
    price: s.basePrice?.amount ?? null,
    unit: s.basePrice?.denom ?? null,
    active: s.active,
  }));

  return { providers, skus };
}
