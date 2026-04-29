import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  bigIntReplacer,
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  jsonResponse,
  leaseStateToJSON,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  manifestMeta,
  mutatingAnnotations,
  readOnlyAnnotations,
  structuredResponse,
  VERSION,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AuthTokenService } from './http/auth-token-service.js';
import { getLeaseProvision, getLeaseReleases, MAX_TAIL } from './http/fred.js';
import { appStatus } from './tools/appStatus.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { buildManifestPreview } from './tools/buildManifestPreview.js';
import { checkDeploymentReadiness } from './tools/checkDeploymentReadiness.js';
import { deployApp } from './tools/deployApp.js';
import { fetchActiveLease } from './tools/fetchActiveLease.js';
import { getAppLogs } from './tools/getLogs.js';
import { resolveProviderUrl } from './tools/resolveLeaseProvider.js';
import { restartApp } from './tools/restartApp.js';
import { updateApp } from './tools/updateApp.js';
import { waitForAppReady } from './tools/waitForAppReady.js';

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
  type TerminalChainLeaseState,
  type TerminalChainState,
  type TerminalChainStateContext,
  TerminalChainStateError,
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
  type ManifestFormat,
  type ManifestValidationResult,
  mergeManifest,
  metaHashHex,
  normalizePorts,
  parseStackManifest,
  validateManifest,
  validateServiceName,
} from './manifest.js';
export { appStatus } from './tools/appStatus.js';
export { browseCatalog, mapWithConcurrency } from './tools/browseCatalog.js';
export {
  type BuildManifestPreviewInput,
  type BuildManifestPreviewResult,
  buildManifestPreview,
  type ManifestPreviewServiceInput,
} from './tools/buildManifestPreview.js';
export {
  type CheckDeploymentReadinessInput,
  type CheckDeploymentReadinessResult,
  checkDeploymentReadiness,
  type SkuSummary,
} from './tools/checkDeploymentReadiness.js';
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
export {
  type WaitForAppReadyOptions,
  type WaitForAppReadyResult,
  waitForAppReady,
} from './tools/waitForAppReady.js';

export class FredMCPServer {
  private mcpServer: McpServer;
  private clientManager: CosmosClientManager;
  private walletProvider: WalletProvider;
  private authTokens: AuthTokenService;

  constructor(options: ManifestMCPServerOptions) {
    const config = createValidatedConfig(options.config);
    this.walletProvider = options.walletProvider;
    this.clientManager = CosmosClientManager.getInstance(
      config,
      this.walletProvider,
    );
    this.authTokens = new AuthTokenService(this.walletProvider);

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

  private registerTools(): void {
    // -- browse_catalog --
    this.mcpServer.registerTool(
      'browse_catalog',
      {
        description:
          'Browse available cloud providers and service tiers with live health checks. Use this before deploy_app to see which providers are online and what SKU sizes (e.g. docker-micro, docker-small) are available with pricing.',
        annotations: readOnlyAnnotations('Browse providers and SKUs'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
        annotations: readOnlyAnnotations('Get deployed app status'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
          (addr, uuid) => this.authTokens.providerToken(addr, uuid),
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- wait_for_app_ready --
    this.mcpServer.registerTool(
      'wait_for_app_ready',
      {
        description:
          'Wait for a deployed app to reach the ACTIVE state on the provider, polling at the configured interval. Use this after deploy_app instead of looping app_status manually. Throws on timeout or terminal lease state.',
        inputSchema: {
          lease_uuid: z
            .string()
            .uuid()
            .describe('The lease UUID of the app to wait on'),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(600)
            .optional()
            .describe(
              'Maximum seconds to wait before throwing. Defaults to 120s.',
            ),
          interval_seconds: z
            .number()
            .int()
            .min(1)
            .max(60)
            .optional()
            .describe('Seconds between status polls. Defaults to 3s.'),
        },
        outputSchema: {
          lease_uuid: z.string().describe('The lease UUID that was waited on'),
          provider_uuid: z.string().describe('Provider hosting the lease'),
          provider_url: z.string().describe('Provider API URL'),
          state: z
            .string()
            .describe(
              'Final lease state, JSON-encoded LeaseState (e.g. LEASE_STATE_ACTIVE)',
            ),
          status: z
            .looseObject({})
            .describe(
              'Raw provider status payload (instances, endpoints, services, etc.)',
            ),
        },
        annotations: readOnlyAnnotations('Wait for deployed app readiness'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling(
        'wait_for_app_ready',
        async (
          args,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
          const emit = this.progressEmitter('wait_for_app_ready', extra);
          const leaseUuid = args.lease_uuid;
          const address = await this.walletProvider.getAddress();
          await this.clientManager.acquireRateLimit();
          const queryClient = await this.clientManager.getQueryClient();
          const result = await waitForAppReady(
            queryClient,
            address,
            leaseUuid,
            (addr, uuid) => this.authTokens.providerToken(addr, uuid),
            {
              timeoutMs:
                args.timeout_seconds !== undefined
                  ? args.timeout_seconds * 1_000
                  : undefined,
              intervalMs:
                args.interval_seconds !== undefined
                  ? args.interval_seconds * 1_000
                  : undefined,
              abortSignal: extra.signal,
              onProgress: emit
                ? (status) => {
                    const state = leaseStateToJSON(status.state);
                    const provision = status.provision_status
                      ? `, provision=${status.provision_status}`
                      : '';
                    emit(`Polling lease: state=${state}${provision}`);
                  }
                : undefined,
            },
          );
          return structuredResponse(
            result as unknown as Record<string, unknown>,
            bigIntReplacer,
          );
        },
      ),
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
        annotations: readOnlyAnnotations('Get container logs'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
          (addr, uuid) => this.authTokens.providerToken(addr, uuid),
          tail,
        );
        return jsonResponse(result, bigIntReplacer);
      }),
    );

    // -- check_deployment_readiness --
    this.mcpServer.registerTool(
      'check_deployment_readiness',
      {
        description:
          "Pre-flight check for deploy_app: surfaces the caller's wallet balances, credit account, requested SKU availability, and a human-readable list of missing steps. Use this before deploy_app to decide whether to fund credits, switch SKU, or top up the wallet. Note: the chain does not expose provider allowed_registries, so a `ready: true` does not guarantee the registry of `image` is allowed — that is checked at upload time.",
        inputSchema: {
          size: z
            .string()
            .optional()
            .describe(
              'SKU tier to verify availability for (e.g. "docker-micro"). Omit to skip the SKU check.',
            ),
          image: z
            .string()
            .optional()
            .describe(
              'Image planned for deployment. Recorded on the result for downstream display; not validated.',
            ),
        },
        outputSchema: {
          tenant: z.string(),
          image: z.string().nullable(),
          size: z.string().nullable(),
          wallet_balances: z.array(
            z.object({ denom: z.string(), amount: z.string() }),
          ),
          credits: z.looseObject({}).nullable(),
          current_balance: z
            .array(z.object({ denom: z.string(), amount: z.string() }))
            .optional(),
          hours_remaining: z.string().optional(),
          sku: z
            .object({
              name: z.string(),
              uuid: z.string(),
              provider_uuid: z.string(),
              price: z
                .object({ amount: z.string(), denom: z.string() })
                .optional(),
              active: z.boolean(),
              stateful: z.boolean(),
            })
            .nullable(),
          available_sku_names: z.array(z.string()),
          ready: z.boolean(),
          missing_steps: z.array(z.string()),
        },
        annotations: readOnlyAnnotations('Check deploy pre-flight readiness'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('check_deployment_readiness', async (args) => {
        const address = await this.walletProvider.getAddress();
        await this.clientManager.acquireRateLimit();
        const queryClient = await this.clientManager.getQueryClient();
        const result = await checkDeploymentReadiness(queryClient, address, {
          size: args.size,
          image: args.image,
        });
        return structuredResponse(
          result as unknown as Record<string, unknown>,
          bigIntReplacer,
        );
      }),
    );

    // -- build_manifest_preview --
    this.mcpServer.registerTool(
      'build_manifest_preview',
      {
        description:
          'Build a deployment manifest, validate it against the documented Fred rules, and compute the SHA-256 meta_hash that would be recorded on-chain. Use this BEFORE deploy_app to catch invalid manifests without paying for a lease. Two modes: raw `manifest` JSON string, or structured fields (image+port, or services for stacks).',
        inputSchema: {
          manifest: z
            .string()
            .optional()
            .describe(
              'Raw manifest JSON string. Mutually exclusive with structured fields below.',
            ),
          image: z
            .string()
            .optional()
            .describe(
              'Single-service image. Required (with port) when not using manifest or services.',
            ),
          port: z
            .number()
            .int()
            .min(1)
            .max(65535)
            .optional()
            .describe('Container port to expose. Required with image.'),
          env: z
            .record(z.string(), z.string())
            .optional()
            .describe('Environment variables as key-value pairs.'),
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
          init: z.boolean().optional(),
          expose: z.array(z.string()).optional(),
          labels: z.record(z.string(), z.string()).optional(),
          depends_on: z
            .record(z.string(), z.object({ condition: z.string() }))
            .optional(),
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
              'Multi-service stack. Mutually exclusive with image/port and manifest.',
            ),
        },
        outputSchema: {
          manifest_json: z
            .string()
            .describe('Canonical manifest JSON that would be uploaded'),
          manifest: z
            .looseObject({})
            .describe('Parsed manifest object (same content as manifest_json)'),
          format: z
            .enum(['single', 'stack'])
            .describe('Detected manifest format'),
          meta_hash_hex: z
            .string()
            .describe('SHA-256 of manifest_json, lowercase hex'),
          validation: z.object({
            valid: z.boolean(),
            errors: z.array(z.string()),
          }),
        },
        annotations: readOnlyAnnotations('Preview and validate a manifest'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
      },
      withErrorHandling('build_manifest_preview', async (args) => {
        const result = await buildManifestPreview({
          manifest: args.manifest,
          image: args.image,
          port: args.port,
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
          depends_on: args.depends_on,
          services: args.services,
        });
        return structuredResponse(
          result as unknown as Record<string, unknown>,
          bigIntReplacer,
        );
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
          gas_multiplier: z
            .number()
            .finite()
            .min(1)
            .optional()
            .describe(
              'Gas simulation multiplier override for this transaction. Defaults to the server-configured value (typically 1.5). Increase if a transaction fails with out-of-gas errors.',
            ),
        },
        // Additive: creates a new lease and uploads a manifest. Does not
        // replace any existing app's state.
        annotations: mutatingAnnotations('Deploy a containerized app', {
          destructive: false,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
      },
      withErrorHandling(
        'deploy_app',
        async (
          args,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
          const emit = this.progressEmitter('deploy_app', extra);
          const result = await deployApp(
            this.clientManager,
            (addr, uuid) => this.authTokens.providerToken(addr, uuid),
            (addr, uuid, metaHashHex) =>
              this.authTokens.leaseDataToken(addr, uuid, metaHashHex),
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
              gasMultiplier: args.gas_multiplier,
              abortSignal: extra.signal,
              onLeaseCreated: emit
                ? (leaseUuid, providerUrl) => {
                    emit(
                      `Lease ${leaseUuid} created on chain at ${providerUrl}; uploading manifest`,
                    );
                  }
                : undefined,
              pollOptions: emit
                ? {
                    onProgress: (status) => {
                      const state = leaseStateToJSON(status.state);
                      const provision = status.provision_status
                        ? `, provision=${status.provision_status}`
                        : '';
                      emit(`Polling lease: state=${state}${provision}`);
                    },
                  }
                : undefined,
            },
          );
          return jsonResponse(result, bigIntReplacer);
        },
      ),
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
        // Additive: triggers a restart cycle without replacing config.
        // Not idempotent — each call triggers a fresh restart even when
        // the app is already running (relies on the helper's default).
        annotations: mutatingAnnotations('Restart a deployed app', {
          destructive: false,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
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
          (addr, uuid) => this.authTokens.providerToken(addr, uuid),
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
        // Destructive: replaces the running app's manifest. Even with the
        // merge mode, prior config can be overwritten.
        annotations: mutatingAnnotations('Update a deployed app manifest', {
          destructive: true,
        }),
        _meta: manifestMeta({
          broadcasts: true,
          estimable: false,
        }),
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
          (addr, uuid) => this.authTokens.providerToken(addr, uuid),
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
        annotations: readOnlyAnnotations('Get app provision diagnostics'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
        const authToken = await this.authTokens.providerToken(
          address,
          leaseUuid,
        );
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
        annotations: readOnlyAnnotations('Get app release history'),
        _meta: manifestMeta({
          broadcasts: false,
          estimable: false,
        }),
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
        const authToken = await this.authTokens.providerToken(
          address,
          leaseUuid,
        );
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

  /**
   * Builds a fire-and-forget progress emitter for a long-running tool.
   * Returns `undefined` if the caller didn't request progress (no
   * `progressToken` in `extra._meta`); callers can branch on that to skip
   * notification work entirely.
   *
   * Notifications are best-effort: failures are logged but don't fail the
   * tool. Each call increments the progress counter.
   */
  private progressEmitter(
    toolName: string,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): ((message: string) => void) | undefined {
    const token = extra._meta?.progressToken;
    if (token === undefined) return undefined;
    let counter = 0;
    return (message: string) => {
      counter += 1;
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: counter,
            message,
          },
        })
        .catch((err: unknown) => {
          logger.warn(
            `[${toolName}] progress notification failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    };
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
