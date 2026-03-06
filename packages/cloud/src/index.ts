import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  createSignMessage,
  createLeaseDataSignMessage,
  createAuthToken,
  VERSION,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  withErrorHandling,
  jsonResponse,
  bigIntReplacer,
  browseCatalog,
  getBalance,
  listApps,
  appStatus,
  getAppLogs,
  fundCredits,
  deployApp,
  stopApp,
  restartApp,
  updateApp,
} from '@manifest-network/manifest-mcp-core';
import { leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

/** Maximum number of log lines that can be requested via get_logs */
const MAX_LOG_TAIL = 1000;

/** Valid lease state filter values */
const VALID_STATE_FILTERS = ['all', 'pending', 'active', 'closed', 'rejected', 'expired'] as const;

const STATE_FILTER_MAP: Record<typeof VALID_STATE_FILTERS[number], LeaseState> = {
  all: LeaseState.LEASE_STATE_UNSPECIFIED,
  pending: LeaseState.LEASE_STATE_PENDING,
  active: LeaseState.LEASE_STATE_ACTIVE,
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

function leaseStateLabel(state: LeaseState): string {
  switch (state) {
    case LeaseState.LEASE_STATE_PENDING: return 'pending';
    case LeaseState.LEASE_STATE_ACTIVE: return 'active';
    case LeaseState.LEASE_STATE_CLOSED: return 'closed';
    case LeaseState.LEASE_STATE_REJECTED: return 'rejected';
    case LeaseState.LEASE_STATE_EXPIRED: return 'expired';
    default: return leaseStateToJSON(state).toLowerCase();
  }
}

/**
 * MCP server for Manifest cloud deployment operations.
 */
export class CloudMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;

  constructor(options: ManifestMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(config, this.walletProvider);

    this.mcpServer = new McpServer(
      {
        name: '@manifest-network/manifest-mcp-cloud',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerTools();
  }

  private async getProviderAuthToken(address: string, leaseUuid: string): Promise<string> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication.'
      );
    }
    const timestamp = new Date().toISOString();
    const message = createSignMessage(address, leaseUuid, timestamp);
    const { pub_key, signature } = await this.walletProvider.signArbitrary(address, message);
    return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature);
  }

  private async getLeaseDataAuthToken(address: string, leaseUuid: string, metaHashHex: string): Promise<string> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication.'
      );
    }
    const timestamp = new Date().toISOString();
    const message = createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp);
    const { pub_key, signature } = await this.walletProvider.signArbitrary(address, message);
    return createAuthToken(address, leaseUuid, timestamp, pub_key.value, signature, metaHashHex);
  }

  private registerTools(): void {
    // ── browse_catalog ──
    this.mcpServer.registerTool(
      'browse_catalog',
      {
        description: 'Browse available cloud providers and service tiers. Use this before deploy_app to see which providers are online and what SKU sizes (e.g. docker-micro, docker-small) are available with pricing.',
      },
      withErrorHandling('browse_catalog', async () => {
        const queryClient = await this.clientManager.getQueryClient();
        const result = await browseCatalog(queryClient);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── get_balance ──
    this.mcpServer.registerTool(
      'get_balance',
      {
        description: 'Get account balances, credit status, and spending estimates. Use this to check if you have enough credits before deploying, or to monitor remaining credit lifetime.',
      },
      withErrorHandling('get_balance', async () => {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getBalance(queryClient, address);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── fund_credits ──
    this.mcpServer.registerTool(
      'fund_credits',
      {
        description: 'Fund the billing credit account by sending tokens from the wallet. Use this when get_balance shows insufficient credits for deploying apps.',
        inputSchema: {
          amount: z.string().describe('Amount with denomination (e.g. "10000000umfx")'),
        },
      },
      withErrorHandling('fund_credits', async (args) => {
        const result = await fundCredits(this.clientManager, args.amount);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── list_apps ──
    this.mcpServer.registerTool(
      'list_apps',
      {
        description: 'List all leases (deployed apps) for the current account. Use this to find lease UUIDs needed by app_status, get_logs, stop_app, restart_app, and update_app.',
        inputSchema: {
          state: z.enum(VALID_STATE_FILTERS).optional().describe('Filter leases by state (default: "all")'),
        },
      },
      withErrorHandling('list_apps', async (args) => {
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await listApps(queryClient, address, args.state ?? 'all');
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── app_status ──
    this.mcpServer.registerTool(
      'app_status',
      {
        description: 'Get detailed status and connection info for a deployed app. Use this after deploy_app or list_apps to check if an app is running and get its URL.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to check'),
        },
      },
      withErrorHandling('app_status', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await appStatus(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── get_logs ──
    this.mcpServer.registerTool(
      'get_logs',
      {
        description: 'Get recent container logs for a deployed app. Use this to debug apps that are failing or to verify an app started correctly after deploy_app.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to get logs for'),
          tail: z.number().int().min(1).max(MAX_LOG_TAIL).optional().describe('Number of recent log lines to retrieve'),
        },
      },
      withErrorHandling('get_logs', async (args) => {
        const leaseUuid = args.lease_uuid;
        const tail = args.tail;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await getAppLogs(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          tail,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── deploy_app ──
    this.mcpServer.registerTool(
      'deploy_app',
      {
        description: 'Deploy a new containerized application. Requires funded credits (use fund_credits if needed). Creates a lease on-chain, uploads the container manifest to a provider, and polls until ready. Use browse_catalog first to see available SKU sizes.',
        inputSchema: {
          image: z.string().describe('Docker image to deploy (e.g. "nginx:alpine")'),
          port: z.number().int().min(1).max(65535).describe('Container port to expose (e.g. 80)'),
          size: z.string().describe('SKU tier name (e.g. "docker-micro", "docker-small")'),
          env: z.record(z.string(), z.string()).optional().describe('Environment variables as key-value pairs'),
          command: z.array(z.string()).optional().describe('Override container command (entrypoint)'),
          args: z.array(z.string()).optional().describe('Arguments to the container command'),
          user: z.string().optional().describe('User to run the container as (e.g. "1000:1000")'),
          tmpfs: z.array(z.string()).optional().describe('tmpfs mounts (e.g. ["/tmp:size=64M"])'),
          health_check: z.object({
            test: z.array(z.string()),
            interval: z.string().optional(),
            timeout: z.string().optional(),
            retries: z.number().int().optional(),
            start_period: z.string().optional(),
          }).optional().describe('Container health check configuration'),
          stop_grace_period: z.string().optional().describe('Grace period before force-killing (e.g. "30s")'),
          init: z.boolean().optional().describe('Run an init process inside the container'),
          expose: z.array(z.string()).optional().describe('Expose ports without publishing (e.g. ["8080/tcp"])'),
          labels: z.record(z.string(), z.string()).optional().describe('Container labels as key-value pairs'),
          storage: z.string().optional().describe('Storage SKU name for persistent disk (adds a second lease item)'),
          depends_on: z.record(z.string(), z.object({ condition: z.string() })).optional().describe('Service dependencies'),
        },
      },
      withErrorHandling('deploy_app', async (args) => {
        const result = await deployApp(
          this.clientManager,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          (addr, uuid, metaHashHex) => this.getLeaseDataAuthToken(addr, uuid, metaHashHex),
          {
            image: args.image,
            port: args.port,
            size: args.size,
            env: args.env,
            command: args.command,
            args: args.args,
            user: args.user,
            tmpfs: args.tmpfs,
            health_check: args.health_check,
            stop_grace_period: args.stop_grace_period,
            init: args.init,
            expose: args.expose,
            labels: args.labels,
            storage: args.storage,
            depends_on: args.depends_on,
          },
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── stop_app ──
    this.mcpServer.registerTool(
      'stop_app',
      {
        description: 'Stop a deployed app by closing its lease on-chain. This is permanent — the app cannot be restarted after stopping. Use restart_app instead if you just want to restart it.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to stop'),
        },
      },
      withErrorHandling('stop_app', async (args) => {
        const result = await stopApp(this.clientManager, args.lease_uuid);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── restart_app ──
    this.mcpServer.registerTool(
      'restart_app',
      {
        description: 'Restart a running app via the provider without closing its lease. Use this to apply configuration changes or recover from a crash.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to restart'),
        },
      },
      withErrorHandling('restart_app', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await restartApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── update_app ──
    this.mcpServer.registerTool(
      'update_app',
      {
        description: 'Update a deployed app with a new container manifest. Use this to change the Docker image, ports, or environment variables of a running app without closing the lease.',
        inputSchema: {
          lease_uuid: z.string().uuid().describe('The lease UUID of the app to update'),
          manifest: z.string().describe('The full manifest JSON string to deploy'),
        },
      },
      withErrorHandling('update_app', async (args) => {
        const manifest = args.manifest;

        try {
          const parsed = JSON.parse(manifest);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('must be a JSON object');
          }
        } catch (err) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            `Invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        const queryClient = await this.clientManager.getQueryClient();

        const result = await updateApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          manifest,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // ── lease_history ──
    this.mcpServer.registerTool(
      'lease_history',
      {
        description: 'Get paginated on-chain lease history for the current account. Use this to review past deployments, check lease states, and audit billing history.',
        inputSchema: {
          state: z.enum(VALID_STATE_FILTERS).optional().describe('Filter by lease state (default: "all")'),
          limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results (default: 50, max: 100)'),
          offset: z.number().int().min(0).optional().describe('Number of results to skip for pagination (default: 0)'),
        },
      },
      withErrorHandling('lease_history', async (args) => {
        const address = await this.walletProvider.getAddress();
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

        const leases = result.leases.map((l: { uuid: string; state: LeaseState; providerUuid: string; createdAt?: Date; closedAt?: Date; items?: { skuUuid: string; quantity: bigint }[] }) => ({
          uuid: l.uuid,
          state: l.state,
          stateLabel: leaseStateLabel(l.state),
          providerUuid: l.providerUuid,
          createdAt: l.createdAt?.toISOString(),
          closedAt: l.closedAt?.toISOString(),
          items: l.items?.map((item: { skuUuid: string; quantity: bigint }) => ({
            skuUuid: item.skuUuid,
            quantity: item.quantity,
          })),
        }));

        const total = result.pagination?.total ?? BigInt(0);

        return jsonResponse({ leases, total }, bigIntReplacer);
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

export function createMnemonicCloudServer(config: MnemonicServerConfig): Promise<CloudMCPServer> {
  return createMnemonicServer(config, CloudMCPServer);
}
