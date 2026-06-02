import type { WalletProvider } from '@manifest-network/manifest-mcp-core';
import {
  CosmosClientManager,
  createMnemonicServer,
  createValidatedConfig,
  type ManifestMCPServerOptions,
  type MnemonicServerConfig,
  VERSION,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthTokenService } from './http/auth-token-service.js';
import { resolveGuardedFetch } from './server/fetch-gate.js';
import { registerPrompts } from './server/register-prompts.js';
import { registerResources } from './server/register-resources.js';
import { registerTools } from './server/register-tools.js';

export type { ManifestMCPServerOptions } from '@manifest-network/manifest-mcp-core';
export {
  INFRASTRUCTURE_ERROR_CODES,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
export {
  AuthTimestampTracker,
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
          resources: {},
          prompts: {},
        },
      },
    );

    // SSRF guard (ENG-268). Fred fetches provider/Fred APIs at URLs sourced
    // from on-chain SKU records, so a malicious provider could point them at
    // an internal host. Route all outbound HTTP through an SSRF-guarded fetch
    // by default; operators opt out with MANIFEST_FRED_FETCH_GUARDED=0.
    const fetchFn = resolveGuardedFetch(
      typeof process !== 'undefined'
        ? process.env.MANIFEST_FRED_FETCH_GUARDED
        : undefined,
      typeof process !== 'undefined' && !!process.versions?.node,
    );

    registerTools({
      mcpServer: this.mcpServer,
      clientManager: this.clientManager,
      walletProvider: this.walletProvider,
      authTokens: this.authTokens,
      fetchFn,
    });
    registerResources({
      mcpServer: this.mcpServer,
      clientManager: this.clientManager,
      walletProvider: this.walletProvider,
    });
    registerPrompts(this.mcpServer);
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
