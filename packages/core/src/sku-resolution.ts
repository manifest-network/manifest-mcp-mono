import type { ManifestQueryClient } from './client.js';
import { createPagination, MAX_PAGE_LIMIT } from './queries/utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * A single concrete SKU. `skuUuid` is the immutable identity; `name` is a
 * free-form, NON-unique label (the chain enforces no name uniqueness).
 */
export interface SkuCandidate {
  readonly skuUuid: string;
  readonly providerUuid: string;
  readonly name: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
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
    skuUuid: s.uuid,
    providerUuid: s.providerUuid,
    name: s.name,
    ...(s.basePrice
      ? { price: { amount: s.basePrice.amount, denom: s.basePrice.denom } }
      : {}),
    active: s.active ?? true,
  };
}

async function fetchActiveSkus(
  queryClient: ManifestQueryClient,
): Promise<SkuCandidate[]> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const result = await queryClient.liftedinit.sku.v1.sKUs({
    activeOnly: true,
    pagination,
  });
  return result.skus.map(toCandidate);
}

/** List every active SKU matching `size` (optionally narrowed by provider). No throw on >1. */
export async function listSkuCandidates(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string,
): Promise<SkuCandidate[]> {
  const sizeTrimmed = size.trim();
  const providerUuidTrimmed = providerUuid?.trim() || undefined;
  const all = await fetchActiveSkus(queryClient);
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
    { reason: 'AMBIGUOUS_SKU_NAME', size, candidates },
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
  queryClient: ManifestQueryClient,
  input: ResolveSkuInput,
): Promise<SkuCandidate> {
  const skuUuid = input.skuUuid?.trim() || undefined;
  const providerUuid = input.providerUuid?.trim() || undefined;
  const size = input.size.trim();
  const all = await fetchActiveSkus(queryClient);

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
    const available =
      names.length === 0
        ? 'No active SKUs exist on this chain.'
        : `Available: ${names.join(', ')}`;
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
          `Offered by: ${named.map((s) => s.providerUuid).join(', ')}.`,
      );
    }
    if (onProvider.length > 1) throw ambiguous(size, onProvider);
    return onProvider[0];
  }

  if (named.length > 1) throw ambiguous(size, named);
  return named[0];
}
