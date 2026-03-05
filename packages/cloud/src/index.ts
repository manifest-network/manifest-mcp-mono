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
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  type LeaseStateFilter,
  withErrorHandling,
  jsonResponse,
  bigIntReplacer,
  MAX_LOG_TAIL,
  VALID_STATE_FILTERS,
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
import type { WalletProvider } from '@manifest-network/manifest-mcp-core';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';

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
        const result = await fundCredits(this.clientManager, args.amount as string);
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
        const stateFilter: LeaseStateFilter = (args.state as LeaseStateFilter | undefined) ?? 'all';
        const result = await listApps(queryClient, address, stateFilter);
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
        const leaseUuid = args.lease_uuid as string;
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
        const leaseUuid = args.lease_uuid as string;
        const tail = args.tail as number | undefined;
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
          env: z.record(z.string(), z.string()).optional().describe('Optional environment variables as key-value pairs'),
        },
      },
      withErrorHandling('deploy_app', async (args) => {
        const result = await deployApp(
          this.clientManager,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          (addr, uuid, metaHashHex) => this.getLeaseDataAuthToken(addr, uuid, metaHashHex),
          {
            image: args.image as string,
            port: args.port as number,
            size: args.size as string,
            env: args.env as Record<string, string> | undefined,
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
        const result = await stopApp(this.clientManager, args.lease_uuid as string);
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
        const leaseUuid = args.lease_uuid as string;
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
        const manifest = args.manifest as string;

        try {
          const parsed = JSON.parse(manifest);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('must be a JSON object');
          }
        } catch (err) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Invalid manifest: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const leaseUuid = args.lease_uuid as string;
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
