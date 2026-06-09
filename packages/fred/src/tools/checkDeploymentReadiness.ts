import {
  createPagination,
  getBalance,
  MAX_PAGE_LIMIT,
  type ManifestQueryClient,
} from '@manifest-network/manifest-mcp-core';

/**
 * `available_skus` is bounded so the response never bloats an LLM context
 * if a provider lists many SKUs. The chain query itself is bounded by
 * `MAX_PAGE_LIMIT` (1000), but agents only need a hint of what's available —
 * the lookup against `size` is exact. 50 mirrors the spirit of the 10-name
 * slice already used in `missing_steps`.
 */
const MAX_SKU_NAMES_RETURNED = 50;

export interface CheckDeploymentReadinessInput {
  /** SKU tier to verify availability for (e.g. "docker-micro"). Optional. */
  readonly size?: string;
  /**
   * Image to consider. Currently informational — the chain does not expose
   * provider `allowed_registries`, so the agent must accept a runtime
   * "registry not allowed" error from the upload step if the registry
   * is not in the operator's allowlist. Recorded in the result so the
   * caller can carry it through to a deployment plan.
   */
  readonly image?: string;
  /**
   * Narrow a duplicate SKU `size` name to one provider (ENG-258).
   * Get candidates from `browse_catalog` or `check_deployment_readiness`.
   */
  readonly providerUuid?: string;
  /**
   * Resolve the SKU by uuid, bypassing the `size` name filter (ENG-258).
   * When set, `size` is ignored for candidate selection (consistent with
   * core `resolveSku`). Narrow to one provider by also supplying `providerUuid`.
   */
  readonly skuUuid?: string;
}

export interface SkuSummary {
  readonly name: string;
  readonly uuid: string;
  readonly provider_uuid: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
}

export interface CheckDeploymentReadinessResult {
  readonly tenant: string;
  readonly image: string | null;
  readonly size: string | null;
  readonly wallet_balances: ReadonlyArray<{
    readonly denom: string;
    readonly amount: string;
  }>;
  readonly credits: Awaited<ReturnType<typeof getBalance>>['credits'];
  readonly current_balance?: ReadonlyArray<{
    readonly denom: string;
    readonly amount: string;
  }>;
  readonly hours_remaining?: string;
  /** Determinate SKU pick (exactly 1 candidate) or null when ambiguous. */
  readonly sku: SkuSummary | null;
  /** Active SKU candidates: uuid-resolved (skuUuid path) or name-filtered (size path), narrowed by providerUuid if given. (ENG-258) */
  readonly sku_candidates: readonly SkuSummary[];
  /**
   * All active SKUs with their uuid and provider_uuid for disambiguation. (ENG-258)
   * Capped at MAX_SKU_NAMES_RETURNED to avoid bloating LLM context.
   */
  readonly available_skus: ReadonlyArray<{
    readonly name: string;
    readonly uuid: string;
    readonly provider_uuid: string;
  }>;
  readonly ready: boolean;
  readonly missing_steps: readonly string[];
}

/**
 * Combined pre-flight check for a deploy: wallet balances, credit account,
 * and SKU availability in a single round trip. The agent uses this before
 * `deploy_app` to decide whether to fund credits, switch SKU, or top up
 * the wallet.
 *
 * The `ready` flag is conservative — `false` whenever a clearly missing
 * prerequisite is detected. `missing_steps` is the actionable bullet list
 * the agent can surface to the user verbatim.
 *
 * Note: provider `allowed_registries` is operator config not exposed via
 * chain or public API, so this helper cannot pre-validate `image`. The
 * deploy upload will reject disallowed registries at runtime; document
 * that to the user when the readiness check is "ready: true" but the
 * registry is suspect.
 *
 * ENG-258: When `size` matches multiple active SKUs (duplicate names across
 * providers), `sku` is null and `sku_candidates` lists all matches.  Supply
 * `providerUuid` or `skuUuid` to narrow to a single candidate.
 */
export async function checkDeploymentReadiness(
  queryClient: ManifestQueryClient,
  address: string,
  input: CheckDeploymentReadinessInput = {},
): Promise<CheckDeploymentReadinessResult> {
  const pagination = createPagination(MAX_PAGE_LIMIT);
  const [balance, skusResult] = await Promise.all([
    getBalance(queryClient, address),
    queryClient.liftedinit.sku.v1.sKUs({ activeOnly: true, pagination }),
  ]);

  const allActive = skusResult.skus;

  // Build a SkuSummary from a raw SKU record.
  const toSummary = (s: (typeof allActive)[number]): SkuSummary => ({
    name: s.name,
    uuid: s.uuid,
    provider_uuid: s.providerUuid,
    ...(s.basePrice
      ? { price: { amount: s.basePrice.amount, denom: s.basePrice.denom } }
      : {}),
    active: s.active,
  });

  // Build candidate list (ENG-258 review: skuUuid bypasses the name filter,
  // consistent with core resolveSku — a caller pinning skuUuid whose SKU name
  // differs from `size` must still get that SKU as the single candidate).
  let candidates: SkuSummary[] = [];
  if (input.skuUuid) {
    // UUID path: resolve by identity; size is ignored.
    candidates = allActive
      .filter((s) => s.uuid === input.skuUuid)
      .filter((s) =>
        input.providerUuid ? s.providerUuid === input.providerUuid : true,
      )
      .map(toSummary);
  } else if (input.size) {
    // Name path: filter by name, optionally narrow by provider.
    candidates = allActive
      .filter((s) => s.name === input.size)
      .filter((s) =>
        input.providerUuid ? s.providerUuid === input.providerUuid : true,
      )
      .map(toSummary);
  }
  // Determinate pick only when exactly one candidate (unambiguous).
  const sku = candidates.length === 1 ? candidates[0] : null;

  const missing: string[] = [];
  if (input.skuUuid && candidates.length === 0) {
    missing.push(
      `SKU uuid "${input.skuUuid}" not found among active SKUs${input.providerUuid ? ` on provider ${input.providerUuid}` : ''}.`,
    );
  } else if (!input.skuUuid && input.size && candidates.length === 0) {
    const available = [...new Set(allActive.map((s) => s.name))]
      .slice(0, 10)
      .join(', ');
    missing.push(
      `Requested SKU "${input.size}" is not available. Pick one of: ${available || '(none active)'}`,
    );
  } else if (!input.skuUuid && input.size && candidates.length > 1) {
    // Ambiguous: the name matches >1 active SKU, across one or more providers
    // (a single provider can publish duplicate names too) (ENG-258).
    const providers = [...new Set(candidates.map((c) => c.provider_uuid))];
    missing.push(
      `SKU "${input.size}" matches ${candidates.length} active SKUs (provider(s): ${providers.join(', ')}). ` +
        `Specify provider_uuid or sku_uuid to disambiguate.`,
    );
  }

  if (!balance.credits) {
    missing.push(
      'Credit account does not exist for this tenant. Call `fund_credit` (manifest-mcp-lease server) to create and fund it.',
    );
  } else if (balance.credits.available_balances.length === 0) {
    missing.push(
      'Credit account exists but has no available balance. Call `fund_credit` (manifest-mcp-lease server) to top it up.',
    );
  }
  if (balance.balances.length === 0) {
    missing.push(
      'Wallet has no balance — cannot pay for the create-lease transaction. Use the faucet (testnet) or top up the wallet.',
    );
  }

  // available_skus: full flat list with identity fields for disambiguation.
  // Capped to avoid bloating LLM context.
  const available_skus = allActive
    .map((s) => ({ name: s.name, uuid: s.uuid, provider_uuid: s.providerUuid }))
    .slice(0, MAX_SKU_NAMES_RETURNED);

  return {
    tenant: address,
    image: input.image ?? null,
    // When exactly one SKU candidate resolved, echo its real name so the result
    // is internally consistent (size === sku.name). On the name path with one
    // candidate, sku.name === input.size anyway. Ambiguous/none → falls back to
    // the caller-supplied input.size (ENG-258 r2).
    size: sku?.name ?? input.size ?? null,
    wallet_balances: balance.balances,
    credits: balance.credits,
    ...(balance.current_balance && {
      current_balance: balance.current_balance,
    }),
    ...(balance.hours_remaining && {
      hours_remaining: balance.hours_remaining,
    }),
    sku,
    sku_candidates: candidates,
    available_skus,
    ready: missing.length === 0,
    missing_steps: missing,
  };
}
