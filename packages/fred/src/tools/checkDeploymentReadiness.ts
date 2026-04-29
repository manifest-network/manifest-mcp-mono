import {
  createPagination,
  getBalance,
  MAX_PAGE_LIMIT,
  type ManifestQueryClient,
} from '@manifest-network/manifest-mcp-core';

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
}

export interface SkuSummary {
  readonly name: string;
  readonly uuid: string;
  readonly provider_uuid: string;
  readonly price?: { readonly amount: string; readonly denom: string };
  readonly active: boolean;
  readonly stateful: boolean;
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
  readonly sku: SkuSummary | null;
  readonly available_sku_names: readonly string[];
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

  const skuByName = new Map(skusResult.skus.map((s) => [s.name, s]));
  const sku = input.size ? (skuByName.get(input.size) ?? null) : null;

  const missing: string[] = [];
  if (input.size && !sku) {
    const available = Array.from(skuByName.keys()).slice(0, 10).join(', ');
    missing.push(
      `Requested SKU "${input.size}" is not available. Pick one of: ${available || '(none active)'}`,
    );
  }
  if (!balance.credits) {
    missing.push(
      'Credit account does not exist for this tenant. Call fund_credit to create and fund it.',
    );
  } else if (balance.credits.available_balances.length === 0) {
    missing.push(
      'Credit account exists but has no available balance. Call fund_credit to top it up.',
    );
  }
  if (balance.balances.length === 0) {
    missing.push(
      'Wallet has no balance — cannot pay for the create-lease transaction. Use the faucet (testnet) or top up the wallet.',
    );
  }

  const skuSummary: SkuSummary | null = sku
    ? {
        name: sku.name,
        uuid: sku.uuid,
        provider_uuid: sku.providerUuid,
        price: sku.basePrice
          ? { amount: sku.basePrice.amount, denom: sku.basePrice.denom }
          : undefined,
        active: sku.active,
        stateful: sku.diskMb > 0n,
      }
    : null;

  return {
    tenant: address,
    image: input.image ?? null,
    size: input.size ?? null,
    wallet_balances: balance.balances,
    credits: balance.credits,
    ...(balance.current_balance && {
      current_balance: balance.current_balance,
    }),
    ...(balance.hours_remaining && {
      hours_remaining: balance.hours_remaining,
    }),
    sku: skuSummary,
    available_sku_names: Array.from(skuByName.keys()),
    ready: missing.length === 0,
    missing_steps: missing,
  };
}
