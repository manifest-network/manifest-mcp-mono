import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  fundCredits,
  getBalance,
  jsonResponse,
  LeaseState,
  leaseStateToJSON,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  stopApp,
  VERSION,
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

interface LeaseItemRecord {
  skuUuid: string;
  quantity: bigint;
}

interface LeaseRecord {
  uuid: string;
  state: LeaseState;
  providerUuid: string;
  createdAt?: Date;
  closedAt?: Date;
  items?: LeaseItemRecord[];
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
          'Get account balances, credit status, and spending estimates. Use this to check if you have enough credits before deploying, or to monitor remaining credit lifetime.',
      },
      withErrorHandling('credit_balance', async () => {
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getBalance(queryClient, address);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- fund_credit --
    this.mcpServer.registerTool(
      'fund_credit',
      {
        description:
          'Fund the billing credit account by sending tokens from the wallet. Use this when credit_balance shows insufficient credits.',
        inputSchema: {
          amount: z
            .string()
            .describe('Amount with denomination (e.g. "10000000umfx")'),
        },
      },
      withErrorHandling('fund_credit', async (args) => {
        const result = await fundCredits(this.clientManager, args.amount);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- leases_by_tenant --
    this.mcpServer.registerTool(
      'leases_by_tenant',
      {
        description:
          'List leases for the current account with optional state filtering and pagination. Use this to find lease UUIDs, review deployment history, and audit billing.',
        inputSchema: {
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
      },
      withErrorHandling('leases_by_tenant', async (args) => {
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();

        const limit = BigInt(args.limit ?? 50);
        const offset = BigInt(args.offset ?? 0);
        const stateKey = (args.state ?? 'all') as keyof typeof STATE_FILTER_MAP;
        const stateFilter = STATE_FILTER_MAP[stateKey];

        const billing = queryClient.liftedinit.billing.v1;
        const result = await billing.leasesByTenant({
          tenant: address,
          stateFilter,
          pagination: {
            key: new Uint8Array(),
            offset,
            limit,
            countTotal: true,
            reverse: false,
          },
        });

        const leases = result.leases.map((l: LeaseRecord) => ({
          uuid: l.uuid,
          state: l.state,
          stateLabel: leaseStateLabel(l.state),
          providerUuid: l.providerUuid,
          createdAt: l.createdAt?.toISOString(),
          closedAt: l.closedAt?.toISOString(),
          items: l.items?.map((item: LeaseItemRecord) => ({
            skuUuid: item.skuUuid,
            quantity: item.quantity,
          })),
        }));

        const total = result.pagination?.total ?? BigInt(0);

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
        },
      },
      withErrorHandling('close_lease', async (args) => {
        const result = await stopApp(this.clientManager, args.lease_uuid);
        return jsonResponse(result, bigIntReplacer);
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
      },
      withErrorHandling('get_skus', async (args) => {
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();
        const activeOnly = args.active_only ?? true;
        const result = await queryClient.liftedinit.sku.v1.sKUs({ activeOnly });
        return jsonResponse({ skus: result.skus }, bigIntReplacer);
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
      },
      withErrorHandling('get_providers', async (args) => {
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();
        const activeOnly = args.active_only ?? true;
        const result = await queryClient.liftedinit.sku.v1.providers({
          activeOnly,
        });
        return jsonResponse({ providers: result.providers }, bigIntReplacer);
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
