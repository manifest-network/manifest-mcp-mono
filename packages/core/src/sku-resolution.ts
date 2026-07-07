import {
  asProviderUuid,
  asSkuUuid,
  type ProviderUuid,
  type SkuUuid,
} from './brands.js';
import type { ReadCtx } from './ctx.js';
import { withReadSignal } from './internals/read-signal.js';
import type { CallOptions } from './options.js';
import { createPagination, MAX_PAGE_LIMIT } from './queries/utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * A single concrete SKU. `skuUuid` is the immutable identity; `name` is a
 * free-form, NON-unique label (the chain enforces no name uniqueness).
 */
export interface SkuCandidate {
  readonly skuUuid: SkuUuid;
  readonly providerUuid: ProviderUuid;
  readonly name: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
}

/** The `details` shape of a `SKU_AMBIGUOUS` `ManifestMCPError` (produced by `ambiguous()` below). */
export interface SkuAmbiguousDetails {
  readonly reason: 'AMBIGUOUS_SKU_NAME';
  readonly size: string;
  readonly candidates: readonly SkuCandidate[];
}

/** Narrow an unknown error to the SKU_AMBIGUOUS shape. Discriminates on the `code` VALUE (+ the
 *  `details.reason` tag) — no `instanceof`, so it is dual-package-safe. cosmjs `isDeliverTxFailure`
 *  idiom. */
export function isSkuAmbiguousError(
  value: unknown,
): value is ManifestMCPError & { readonly details: SkuAmbiguousDetails } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === ManifestMCPErrorCode.SKU_AMBIGUOUS &&
    (value as { details?: { reason?: unknown } }).details?.reason ===
      'AMBIGUOUS_SKU_NAME'
  );
}

export interface ResolveSkuInput {
  /** User-facing tier name. Always supplied; used for matching + error messages. */
  readonly size: string;
  /** Narrow name matches to one provider. */
  readonly providerUuid?: string;
  /** Bypass name lookup entirely; wins over size/providerUuid. */
  readonly skuUuid?: string;
}

function toCandidate(s: {
  uuid: string;
  name: string;
  providerUuid: string;
  basePrice?: { amount: string; denom: string };
  active?: boolean;
}): SkuCandidate {
  return {
    skuUuid: asSkuUuid(s.uuid),
    providerUuid: asProviderUuid(s.providerUuid),
    name: s.name,
    ...(s.basePrice
      ? { price: { amount: s.basePrice.amount, denom: s.basePrice.denom } }
      : {}),
    active: s.active ?? true,
  };
}

async function fetchActiveSkus(
  ctx: ReadCtx,
  opts?: CallOptions,
): Promise<SkuCandidate[]> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await withReadSignal(
    ctx,
    () => ctx.query.liftedinit.sku.v1.sKUs({ activeOnly: true, pagination }),
    opts,
  );
  return result.skus.map(toCandidate);
}

/** List every active SKU matching `size` (optionally narrowed by provider). No throw on >1. */
export async function listSkuCandidates(
  ctx: ReadCtx,
  input: { size: string; providerUuid?: string },
  opts?: CallOptions,
): Promise<SkuCandidate[]> {
  const sizeTrimmed = input.size.trim();
  const providerUuidTrimmed = input.providerUuid?.trim() || undefined;
  const all = await fetchActiveSkus(ctx, opts);
  let named = all.filter((s) => s.name === sizeTrimmed);
  if (providerUuidTrimmed !== undefined) {
    named = named.filter((s) => s.providerUuid === providerUuidTrimmed);
  }
  return named;
}

function ambiguous(size: string, candidates: SkuCandidate[]): ManifestMCPError {
  const lines = candidates
    .map(
      (c) =>
        `  - ${c.name} (sku_uuid=${c.skuUuid}, provider_uuid=${c.providerUuid}` +
        `${c.price ? `, price=${c.price.amount} ${c.price.denom}` : ''})`,
    )
    .join('\n');
  return new ManifestMCPError(
    ManifestMCPErrorCode.SKU_AMBIGUOUS,
    `SKU name "${size}" matches ${candidates.length} active SKUs. ` +
      `Specify provider_uuid (or sku_uuid) to disambiguate:\n${lines}`,
    {
      reason: 'AMBIGUOUS_SKU_NAME',
      size,
      candidates,
    } satisfies SkuAmbiguousDetails,
  );
}

/**
 * Resolve a SKU intent to a single concrete SKU. See the design spec §4.1.
 *
 * - `skuUuid` given → find it among active SKUs; validate `providerUuid` if also given.
 * - else by name → 0 → QUERY_FAILED (lists names); 1 → return; >1 → SKU_AMBIGUOUS.
 *   With `providerUuid`, narrow first; same-provider duplicates → SKU_AMBIGUOUS (require sku_uuid).
 */
export async function resolveSku(
  ctx: ReadCtx,
  input: ResolveSkuInput,
  opts?: CallOptions,
): Promise<SkuCandidate> {
  const skuUuid = input.skuUuid?.trim() || undefined;
  const providerUuid = input.providerUuid?.trim() || undefined;
  const size = input.size.trim();
  const all = await fetchActiveSkus(ctx, opts);

  if (skuUuid !== undefined) {
    const hit = all.find((s) => s.skuUuid === skuUuid);
    if (!hit) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `SKU uuid "${skuUuid}" not found among active SKUs.`,
      );
    }
    if (providerUuid !== undefined && providerUuid !== hit.providerUuid) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `sku_uuid ${skuUuid} belongs to provider ${hit.providerUuid}, ` +
          `not the requested provider_uuid ${providerUuid}.`,
      );
    }
    return hit;
  }

  const named = all.filter((s) => s.name === size);
  if (named.length === 0) {
    const names = [...new Set(all.map((s) => s.name))];
    const MAX_SHOWN = 20;
    const shown = names.slice(0, MAX_SHOWN).join(', ');
    const more =
      names.length > MAX_SHOWN
        ? ` (+${names.length - MAX_SHOWN} more; ${names.length} total)`
        : '';
    const available =
      names.length === 0
        ? 'No active SKUs exist on this chain.'
        : `Available: ${shown}${more}`;
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `SKU tier "${size}" not found on any provider. ${available}`,
    );
  }

  if (providerUuid !== undefined) {
    const onProvider = named.filter((s) => s.providerUuid === providerUuid);
    if (onProvider.length === 0) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `SKU tier "${size}" is not offered by provider ${providerUuid}. ` +
          `Offered by: ${[...new Set(named.map((s) => s.providerUuid))].join(', ')}.`,
      );
    }
    if (onProvider.length > 1) throw ambiguous(size, onProvider);
    return onProvider[0];
  }

  if (named.length > 1) throw ambiguous(size, named);
  return named[0];
}
