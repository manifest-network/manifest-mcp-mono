// Main barrel: the BROWSER-SAFE capability layer (deploy/restart/update/status/
// logs/catalog functions, manifest helpers, HTTP wrappers, types). The MCP
// server (`FredMCPServer`, `createMnemonicFredServer`) lives at the Node-only
// `@manifest-network/manifest-mcp-fred/server` subpath, so importing a
// capability function here never drags in the server machinery / SSRF
// `fetch-gate` / core's Node-only `/guarded-fetch` into a browser bundle.
// (ENG-287 — the same barrel-hygiene split ENG-281 applied to core.)
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
export {
  type DeployManifestInput,
  type DeployManifestOptions,
  deployManifest,
  type SkuSelector,
} from './tools/deployManifest.js';
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
