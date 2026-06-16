import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  DNS_LABEL_RE,
  fundCredits,
  getBalance,
  getLeaseByCustomDomain,
  getLeasesByTenant,
  getProviders,
  getSKUs,
  jsonResponse,
  LeaseState,
  leaseStateToJSON,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  manifestMeta,
  mutatingAnnotations,
  noopLogger,
  parseAddress,
  parseFqdn,
  parseLeaseUuid,
  readOnlyAnnotations,
  setItemCustomDomain,
  stopApp,
  structuredResponse,
  VERSION,
  validateAddress,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

const VALID_STATE_FILTERS = [
  'all',
  'pending',
  'active',
  'closed',
  'rejected',
  'expired',
] as const;

const STATE_FILTER_MAP: Record<
  (typeof VALID_STATE_FILTERS)[number],
  LeaseState
> = {
  all: LeaseState.LEASE_STATE_UNSPECIFIED,
  pending: LeaseState.LEASE_STATE_PENDING,
  active: LeaseState.LEASE_STATE_ACTIVE,
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

function leaseStateLabel(state: LeaseState): string {
  switch (state) {
    case LeaseState.LEASE_STATE_PENDING:
      return 'pending';
    case LeaseState.LEASE_STATE_ACTIVE:
      return 'active';
    case LeaseState.LEASE_STATE_CLOSED:
      return 'closed';
    case LeaseState.LEASE_STATE_REJECTED:
      return 'rejected';
    case LeaseState.LEASE_STATE_EXPIRED:
      return 'expired';
    default:
      return leaseStateToJSON(state).toLowerCase();
  }
}

export class LeaseMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;

  constructor(options: ManifestMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-lease',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  private registerTools(): void {
    // -- credit_balance --
    this.mcpServer.registerTool(
      'credit_balance',
      {
        description:
          "Get account balances, credit status, and spending estimates. Defaults to the caller's own account; pass `tenant` to query a different account. Use this to check if you have enough credits before deploying, or to monitor remaining credit lifetime.",
        inputSchema: {
          tenant: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Tenant address to query (bech32). Defaults to the caller when omitted.',
            ),
        },
        outputSchema: {
          credits: z.looseObject({}).nullable(),
          current_balance: z
            .array(z.object({ denom: z.string(), amount: z.string() }))
            .optional(),
          spending_per_hour: z
            .array(z.object({ denom: z.string(), amount: z.string() }))
            .optional(),
          hours_remaining: z.string().optional(),
          running_apps: z.string().optional(),
          balances: z.array(
            z.object({ denom: z.string(), amount: z.string() }),
          ),
        },
        annotations: readOnlyAnnotations('Get billing credit balance'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('credit_balance', async (args) => {
        if (args.tenant !== undefined) {
          validateAddress(args.tenant, 'tenant');
        }
        const address = args.tenant ?? (await this.walletProvider.getAddress());
        // getBalance acquires its own rate-limit token via withReadSignal, so we do
        // NOT pre-acquire here — that would double-consume on the same logical read.
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getBalance(
          {
            query: queryClient,
            chain: this.clientManager,
            logger: noopLogger,
          },
          address,
        );
        return structuredResponse(result, bigIntReplacer);
      }),
    );

    // -- fund_credit --
    this.mcpServer.registerTool(
      'fund_credit',
      {
        description:
          "Fund the billing credit account by sending tokens from the wallet. Defaults to funding the sender's own account; pass `tenant` to fund a different account's credit on its behalf. Use this when credit_balance shows insufficient credits.",
        inputSchema: {
          amount: z
            .string()
            .describe('Amount with denomination (e.g. "10000000umfx")'),
          tenant: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Tenant address whose credit account is being funded (bech32). Defaults to the sender when omitted.',
            ),
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this transaction. Defaults to the server-configured value (typically 1.5). Increase if a transaction fails with out-of-gas errors.',
            ),
        },
        // Additive: increases credit balance, doesn't replace or remove state.
        annotations: mutatingAnnotations('Fund billing credit account', {
          destructive: false,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling('fund_credit', async (args) => {
        const txCtx = { chain: this.clientManager, logger: noopLogger };
        const result = await fundCredits(
          txCtx,
          {
            amount: args.amount,
            tenant: args.tenant ? parseAddress(args.tenant) : undefined,
          },
          args.gas_multiplier !== undefined
            ? { gasMultiplier: args.gas_multiplier }
            : undefined,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- leases_by_tenant --
    this.mcpServer.registerTool(
      'leases_by_tenant',
      {
        description:
          "List leases with optional state filtering and pagination. Defaults to the caller; pass `tenant` to list another account's leases. Use this to find lease UUIDs, review deployment history, and audit billing.",
        inputSchema: {
          tenant: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Tenant address whose leases to list (bech32). Defaults to the caller when omitted.',
            ),
          state: z
            .enum(VALID_STATE_FILTERS)
            .optional()
            .describe('Filter by lease state (default: "all")'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum number of results (default: 50, max: 100)'),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Number of results to skip for pagination (default: 0)'),
        },
        annotations: readOnlyAnnotations('List leases for a tenant'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('leases_by_tenant', async (args) => {
        if (args.tenant !== undefined) {
          validateAddress(args.tenant, 'tenant');
        }
        const address = args.tenant ?? (await this.walletProvider.getAddress());
        // getLeasesByTenant acquires its own rate-limit token via withReadSignal,
        // so we do NOT pre-acquire here — that would double-consume on the same
        // logical read.
        const ctx = {
          query: await this.clientManager.getQueryClient(),
          chain: this.clientManager,
          logger: noopLogger,
        };

        const stateKey = (args.state ?? 'all') as keyof typeof STATE_FILTER_MAP;
        const { leases: raw, total } = await getLeasesByTenant(ctx, {
          tenant: address,
          stateFilter: STATE_FILTER_MAP[stateKey],
          limit: BigInt(args.limit ?? 50),
          offset: BigInt(args.offset ?? 0),
        });

        const leases = raw.map((l) => ({
          uuid: l.uuid,
          state: l.state,
          stateLabel: leaseStateLabel(l.state),
          providerUuid: l.providerUuid,
          createdAt: l.createdAt?.toISOString(),
          closedAt: l.closedAt?.toISOString(),
          items: l.items?.map((item) => ({
            skuUuid: item.skuUuid,
            quantity: item.quantity,
            serviceName: item.serviceName,
            customDomain: item.customDomain,
          })),
        }));

        return jsonResponse({ leases, total }, bigIntReplacer);
      }),
    );

    // -- close_lease --
    this.mcpServer.registerTool(
      'close_lease',
      {
        description:
          'Close a lease on-chain. This is permanent — the lease cannot be reopened after closing.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID to close'),
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this transaction. Defaults to the server-configured value (typically 1.5). Increase if a transaction fails with out-of-gas errors.',
            ),
        },
        // Closing is permanent — the lease cannot be reopened.
        // Idempotent in the sense that closing a closed lease is a no-op,
        // but the state transition itself happens once.
        annotations: mutatingAnnotations('Close a lease (permanent)', {
          destructive: true,
          idempotent: true,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling('close_lease', async (args) => {
        const txCtx = { chain: this.clientManager, logger: noopLogger };
        const result = await stopApp(
          txCtx,
          { leaseUuid: parseLeaseUuid(args.lease_uuid) },
          args.gas_multiplier !== undefined
            ? { gasMultiplier: args.gas_multiplier }
            : undefined,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- set_item_custom_domain --
    this.mcpServer.registerTool(
      'set_item_custom_domain',
      {
        description:
          'Set or clear the custom domain (FQDN) on a lease item. Pass `custom_domain` to set, or `clear: true` to remove it. For stack (multi-service) leases, pass `service_name` to address the target item; for legacy single-item leases, omit it. Signer must be the lease tenant, the module authority, or an address in `params.allowed_list`.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID that owns the target item'),
          custom_domain: z
            .string()
            .max(253)
            .optional()
            .describe(
              'FQDN to assign (e.g. "app.example.com"). Mutually exclusive with `clear: true`; an empty/missing value without `clear: true` is rejected. The chain validates format, lowercase, and reserved-suffix rules.',
            ),
          service_name: z
            .string()
            .regex(DNS_LABEL_RE)
            .optional()
            .describe(
              'DNS label addressing the LeaseItem inside a stack lease (e.g. "web"). Omit for a 1-item legacy lease.',
            ),
          clear: z
            .boolean()
            .optional()
            .describe(
              'Set true to clear the existing domain and free its reverse-index entry.',
            ),
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this transaction. Defaults to the server-configured value (typically 1.5). Increase if a transaction fails with out-of-gas errors.',
            ),
        },
        // Re-assigning a domain replaces the prior value; clearing removes it.
        // Setting the same value twice is a no-op on the index.
        annotations: mutatingAnnotations(
          'Set or clear a lease item custom domain',
          { destructive: false, idempotent: true },
        ),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling('set_item_custom_domain', async (args) => {
        const clearing = args.clear === true;
        // Trim at the tool boundary so whitespace-only input is treated the
        // same as empty (the helper trims too, but checking here keeps the
        // tool's own validation consistent and avoids an unnecessary helper
        // call for the obvious empty/whitespace cases).
        const domain = (args.custom_domain ?? '').trim();
        if (clearing && domain !== '') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'Pass either `custom_domain` to set, or `clear: true` to clear, not both.',
          );
        }
        if (!clearing && domain === '') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'Provide `custom_domain` to set, or `clear: true` to remove the existing domain.',
          );
        }
        const txCtx = { chain: this.clientManager, logger: noopLogger };
        const leaseUuid = parseLeaseUuid(args.lease_uuid);
        const result = await setItemCustomDomain(
          txCtx,
          clearing
            ? { leaseUuid, clear: true, serviceName: args.service_name }
            : {
                leaseUuid,
                customDomain: parseFqdn(domain),
                serviceName: args.service_name,
              },
          args.gas_multiplier !== undefined
            ? { gasMultiplier: args.gas_multiplier }
            : undefined,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- lease_by_custom_domain --
    this.mcpServer.registerTool(
      'lease_by_custom_domain',
      {
        description:
          'Reverse-lookup the active or pending lease that has claimed a given FQDN. Returns the lease and the `service_name` of the item holding the domain (empty string for a 1-item legacy lease).',
        inputSchema: {
          custom_domain: z
            .string()
            .min(1)
            .max(253)
            .describe('The FQDN to look up (e.g. "app.example.com")'),
        },
        annotations: readOnlyAnnotations('Look up lease by custom domain'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('lease_by_custom_domain', async (args) => {
        // The zod schema's `.min(1)` rejects empty strings but accepts
        // whitespace-only — mirror the generic-chain query handler's
        // trim+empty rejection at this layer too so a whitespace-only
        // FQDN is rejected client-side with a structured INVALID_CONFIG
        // instead of being forwarded to the chain. Chain-side failures
        // (notably the keeper's NotFound on an unclaimed FQDN) are
        // wrapped below as QUERY_FAILED — kept distinct so callers can
        // tell "you sent garbage" from "the chain answered no-such-thing".
        const customDomain = args.custom_domain.trim();
        if (customDomain === '') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'lease_by_custom_domain: custom_domain cannot be empty or whitespace-only.',
          );
        }
        // getLeaseByCustomDomain acquires its own rate-limit token via
        // withReadSignal, so we do NOT pre-acquire here — that would
        // double-consume on the same logical read. The QUERY_FAILED wrap
        // for non-`ManifestMCPError` chain failures (notably the keeper's
        // `NotFound` for an unclaimed FQDN) now lives inside the core fn.
        const ctx = {
          query: await this.clientManager.getQueryClient(),
          chain: this.clientManager,
          logger: noopLogger,
        };
        const { lease, serviceName } = await getLeaseByCustomDomain(
          ctx,
          customDomain,
        );
        return jsonResponse(
          { lease, service_name: serviceName },
          bigIntReplacer,
        );
      }),
    );

    // -- get_skus --
    this.mcpServer.registerTool(
      'get_skus',
      {
        description:
          'List available SKUs (service tiers) with pricing. Use this to see what sizes are available before creating a lease.',
        inputSchema: {
          active_only: z
            .boolean()
            .optional()
            .describe('Only return active SKUs (default: true)'),
        },
        annotations: readOnlyAnnotations('List service tiers and pricing'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('get_skus', async (args) => {
        // getSKUs acquires its own rate-limit token via withReadSignal, so we
        // do NOT pre-acquire here — that would double-consume on the same
        // logical read.
        const ctx = {
          query: await this.clientManager.getQueryClient(),
          chain: this.clientManager,
          logger: noopLogger,
        };
        const skus = await getSKUs(ctx, {
          activeOnly: args.active_only ?? true,
        });
        return jsonResponse({ skus }, bigIntReplacer);
      }),
    );

    // -- get_providers --
    this.mcpServer.registerTool(
      'get_providers',
      {
        description:
          'List registered providers. Use this to see which providers are available on-chain.',
        inputSchema: {
          active_only: z
            .boolean()
            .optional()
            .describe('Only return active providers (default: true)'),
        },
        annotations: readOnlyAnnotations('List registered providers'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('get_providers', async (args) => {
        // getProviders acquires its own rate-limit token via withReadSignal, so
        // we do NOT pre-acquire here — that would double-consume on the same
        // logical read.
        const ctx = {
          query: await this.clientManager.getQueryClient(),
          chain: this.clientManager,
          logger: noopLogger,
        };
        const providers = await getProviders(ctx, {
          activeOnly: args.active_only ?? true,
        });
        return jsonResponse({ providers }, bigIntReplacer);
      }),
    );
  }

  getServer(): Server {
    return this.mcpServer.server;
  }

  getClientManager(): CosmosClientManager {
    return this.clientManager;
  }

  disconnect(): void {
    this.clientManager.disconnect();
  }
}

export function createMnemonicLeaseServer(
  config: MnemonicServerConfig,
): Promise<LeaseMCPServer> {
  return createMnemonicServer(config, LeaseMCPServer);
}
