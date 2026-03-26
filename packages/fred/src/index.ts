import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  jsonResponse,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  VERSION,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AuthTimestampTracker,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './http/auth.js';
import { getLeaseProvision, getLeaseReleases, MAX_TAIL } from './http/fred.js';
import { appStatus } from './tools/appStatus.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { deployApp } from './tools/deployApp.js';
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { getAppLogs } from './tools/getLogs.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';
import { restartApp } from './tools/restartApp.js';
import { updateApp } from './tools/updateApp.js';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';
export {
  INFRASTRUCTURE_ERROR_CODES,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
export {
  type AuthTokenPayload,
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './http/auth.js';
export {
  type FredActionResponse,
  type FredInstanceInfo,
  type FredLeaseInfo,
  type FredLeaseLogs,
  type FredLeaseProvision,
  type FredLeaseRelease,
  type FredLeaseReleases,
  type FredLeaseStatus,
  type FredServiceStatus,
  getLeaseInfo,
  getLeaseLogs,
  getLeaseProvision,
  getLeaseReleases,
  getLeaseStatus,
  MAX_TAIL,
  type PollOptions,
  pollLeaseUntilReady,
  restartLease,
  updateLease,
} from './http/fred.js';
export {
  type ConnectionDetails,
  checkedFetch,
  getLeaseConnectionInfo,
  getProviderHealth,
  type InstanceInfo,
  type LeaseConnectionResponse,
  ProviderApiError,
  type ProviderHealthResponse,
  type ServiceConnectionDetails,
  uploadLeaseData,
  validateProviderUrl,
} from './http/provider.js';
export {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  deriveAppNameFromImage,
  getServiceNames,
  isStackManifest,
  mergeManifest,
  normalizePorts,
  parseStackManifest,
  validateServiceName,
} from './manifest.js';
export { appStatus } from './tools/appStatus.js';
export { browseCatalog, mapWithConcurrency } from './tools/browseCatalog.js';
export {
  type DeployAppInput,
  type DeployAppResult,
  deployApp,
  type ServiceConfig,
} from './tools/deployApp.js';
export { fetchActiveLease } from './tools/fetchActiveLease.js';
export { getAppLogs } from './tools/getLogs.js';
export { resolveProviderUrl } from './tools/resolveLeaseProvider.js';
export { restartApp } from './tools/restartApp.js';
export { updateApp } from './tools/updateApp.js';

export class FredMCPServer {
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
        name: '@manifest-network/manifest-mcp-fred',
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

  private requireSignArbitrary(): NonNullable<WalletProvider['signArbitrary']> {
    if (!this.walletProvider.signArbitrary) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Wallet does not support signArbitrary (ADR-036). Required for provider authentication. Use a wallet provider that implements signArbitrary.',
      );
    }
    return this.walletProvider.signArbitrary.bind(this.walletProvider);
  }

  private authTimestamps = new AuthTimestampTracker();

  private async getProviderAuthToken(
    address: string,
    leaseUuid: string,
  ): Promise<string> {
    const signArbitrary = this.requireSignArbitrary();
    const timestamp = this.authTimestamps.next();
    const message = createSignMessage(address, leaseUuid, timestamp);
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(
      address,
      leaseUuid,
      timestamp,
      pub_key.value,
      signature,
    );
  }

  private async getLeaseDataAuthToken(
    address: string,
    leaseUuid: string,
    metaHashHex: string,
  ): Promise<string> {
    const signArbitrary = this.requireSignArbitrary();
    const timestamp = this.authTimestamps.next();
    const message = createLeaseDataSignMessage(
      leaseUuid,
      metaHashHex,
      timestamp,
    );
    const { pub_key, signature } = await signArbitrary(address, message);
    return createAuthToken(
      address,
      leaseUuid,
      timestamp,
      pub_key.value,
      signature,
      metaHashHex,
    );
  }

  private registerTools(): void {
    // -- browse_catalog --
    this.mcpServer.registerTool(
      'browse_catalog',
      {
        description:
          'Browse available cloud providers and service tiers with live health checks. Use this before deploy_app to see which providers are online and what SKU sizes (e.g. docker-micro, docker-small) are available with pricing.',
      },
      withErrorHandling('browse_catalog', async () => {
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await browseCatalog(queryClient);
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- app_status --
    this.mcpServer.registerTool(
      'app_status',
      {
        description:
          'Get detailed status and connection info for a deployed app. Use this after deploy_app to check if an app is running and get its URL.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to check'),
        },
      },
      withErrorHandling('app_status', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
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

    // -- get_logs --
    this.mcpServer.registerTool(
      'get_logs',
      {
        description:
          'Get recent container logs for a deployed app. Use this to debug apps that are failing or to verify an app started correctly after deploy_app.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to get logs for'),
          tail: z
            .number()
            .int()
            .min(1)
            .max(MAX_TAIL)
            .optional()
            .describe('Number of recent log lines to retrieve'),
        },
      },
      withErrorHandling('get_logs', async (args) => {
        const leaseUuid = args.lease_uuid;
        const tail = args.tail;
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
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

    // -- deploy_app --
    this.mcpServer.registerTool(
      'deploy_app',
      {
        description:
          'Deploy a new containerized application. Requires funded credits (use fund_credit if needed). Creates a lease on-chain, uploads the container manifest to a provider, and polls until ready. Use browse_catalog first to see available SKU sizes.',
        inputSchema: {
          image: z
            .string()
            .optional()
            .describe(
              'Docker image to deploy. Required unless services is provided.',
            ),
          port: z
            .number()
            .int()
            .min(1)
            .max(65535)
            .optional()
            .describe(
              'Container port to expose. Required unless services is provided.',
            ),
          size: z
            .string()
            .describe('SKU tier name (e.g. "docker-micro", "docker-small")'),
          env: z
            .record(z.string(), z.string())
            .optional()
            .describe('Environment variables as key-value pairs'),
          command: z
            .array(z.string())
            .optional()
            .describe('Override container command (entrypoint)'),
          args: z
            .array(z.string())
            .optional()
            .describe('Arguments to the container command'),
          user: z
            .string()
            .optional()
            .describe('User to run the container as (e.g. "1000:1000")'),
          tmpfs: z
            .array(z.string())
            .optional()
            .describe('tmpfs mounts (e.g. ["/tmp:size=64M"])'),
          health_check: z
            .object({
              test: z.array(z.string()),
              interval: z.string().optional(),
              timeout: z.string().optional(),
              retries: z.number().int().optional(),
              start_period: z.string().optional(),
            })
            .optional()
            .describe('Container health check configuration'),
          stop_grace_period: z
            .string()
            .optional()
            .describe('Grace period before force-killing (e.g. "30s")'),
          init: z
            .boolean()
            .optional()
            .describe('Run an init process inside the container'),
          expose: z
            .array(z.string())
            .optional()
            .describe('Expose ports without publishing (e.g. ["8080/tcp"])'),
          labels: z
            .record(z.string(), z.string())
            .optional()
            .describe('Container labels as key-value pairs'),
          storage: z
            .string()
            .optional()
            .describe(
              'Storage SKU name for persistent disk (adds a second lease item)',
            ),
          depends_on: z
            .record(z.string(), z.object({ condition: z.string() }))
            .optional()
            .describe('Service dependencies'),
          services: z
            .record(
              z.string(),
              z.object({
                image: z.string(),
                ports: z.record(z.string(), z.object({})).optional(),
                env: z.record(z.string(), z.string()).optional(),
                command: z.array(z.string()).optional(),
                args: z.array(z.string()).optional(),
                user: z.string().optional(),
                tmpfs: z.array(z.string()).optional(),
                health_check: z
                  .object({
                    test: z.array(z.string()),
                    interval: z.string().optional(),
                    timeout: z.string().optional(),
                    retries: z.number().int().optional(),
                    start_period: z.string().optional(),
                  })
                  .optional(),
                stop_grace_period: z.string().optional(),
                depends_on: z
                  .record(z.string(), z.object({ condition: z.string() }))
                  .optional(),
                expose: z.array(z.string()).optional(),
                labels: z.record(z.string(), z.string()).optional(),
              }),
            )
            .optional()
            .describe(
              'Multi-service stack. Mutually exclusive with image/port. Keys are service names (RFC 1123 DNS labels).',
            ),
        },
      },
      withErrorHandling('deploy_app', async (args) => {
        const result = await deployApp(
          this.clientManager,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          (addr, uuid, metaHashHex) =>
            this.getLeaseDataAuthToken(addr, uuid, metaHashHex),
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
            services: args.services,
          },
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- restart_app --
    this.mcpServer.registerTool(
      'restart_app',
      {
        description:
          'Restart a running app via the provider without closing its lease. Use this to apply configuration changes or recover from a crash.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to restart'),
        },
      },
      withErrorHandling('restart_app', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
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

    // -- update_app --
    this.mcpServer.registerTool(
      'update_app',
      {
        description:
          'Update a deployed app with a new container manifest. Use this to change the Docker image, ports, or environment variables of a running app without closing the lease.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to update'),
          manifest: z
            .string()
            .describe('The full manifest JSON string to deploy'),
          existing_manifest: z
            .string()
            .optional()
            .describe(
              'The current manifest JSON. When provided, the new manifest is merged over the existing one (env, ports, labels merged; other fields carried forward if not in new).',
            ),
        },
      },
      withErrorHandling('update_app', async (args) => {
        const manifest = args.manifest;

        try {
          const parsed = JSON.parse(manifest);
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
          ) {
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
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();

        const result = await updateApp(
          queryClient,
          address,
          leaseUuid,
          (addr, uuid) => this.getProviderAuthToken(addr, uuid),
          manifest,
          args.existing_manifest,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- app_diagnostics --
    this.mcpServer.registerTool(
      'app_diagnostics',
      {
        description:
          'Get provision diagnostics for a deployed app. Use this to debug apps stuck in provisioning or that failed to start. Returns provision status, failure count, and last error message.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to diagnose'),
        },
      },
      withErrorHandling('app_diagnostics', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();

        const lease = await fetchActiveLease(
          queryClient,
          leaseUuid,
          'cannot be diagnosed',
        );
        const providerUrl = await resolveProviderUrl(
          queryClient,
          lease.providerUuid,
        );
        const authToken = await this.getProviderAuthToken(address, leaseUuid);
        const provision = await getLeaseProvision(
          providerUrl,
          leaseUuid,
          authToken,
        );

        return jsonResponse(
          {
            lease_uuid: leaseUuid,
            provision_status: provision.status,
            fail_count: provision.fail_count,
            last_error: provision.last_error,
          },
          bigIntReplacer,
        );
      }),
    );

    // -- app_releases --
    this.mcpServer.registerTool(
      'app_releases',
      {
        description:
          'Get release/version history for a deployed app. Use this to see what versions have been deployed, when they were created, and their status.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to get release history for'),
        },
      },
      withErrorHandling('app_releases', async (args) => {
        const leaseUuid = args.lease_uuid;
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();

        const lease = await fetchActiveLease(
          queryClient,
          leaseUuid,
          'releases are not available',
        );
        const providerUrl = await resolveProviderUrl(
          queryClient,
          lease.providerUuid,
        );
        const authToken = await this.getProviderAuthToken(address, leaseUuid);
        const result = await getLeaseReleases(
          providerUrl,
          leaseUuid,
          authToken,
        );

        return jsonResponse(
          {
            lease_uuid: leaseUuid,
            releases: result.releases,
          },
          bigIntReplacer,
        );
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

export function createMnemonicFredServer(
  config: MnemonicServerConfig,
): Promise<FredMCPServer> {
  return createMnemonicServer(config, FredMCPServer);
}
