// ROOT barrel — the thin aggregating surface for `@manifest-network/manifest-sdk`.
//
// Carries the WHOLESALE type surface (query-result types, ports, contracts) via
// `export type *` plus a curated set of VALUE re-exports: the client factories,
// brand parsers/casts, the signer/wallet ports, the error vocabulary, and config.
// NO free fns EXCEPT error-vocabulary helpers over ManifestMCPError (sanitizeForLogging,
// isSkuAmbiguousError) — domain-operation fns live on the scoped subpaths (`/reads`, `/catalog`, `/deploy`,
// `/orchestration`), which also structurally resolves the fred-vs-agent-core
// `deployApp` name clash. `export type * from core` + the named VALUE re-exports of
// the same symbols compile clean (no TS2300/TS2308) and emit only the curated
// values at runtime.
export type * from '@manifest-network/manifest-mcp-core';
export {
  asAddress,
  asFqdn,
  asLeaseUuid,
  asProviderUuid,
  asSkuUuid,
  CosmosClientManager,
  createConfig,
  createManifestClient,
  createManifestReadClient,
  createSignerAdapter,
  createValidatedConfig,
  INFRASTRUCTURE_ERROR_CODES,
  isSkuAmbiguousError,
  ManifestMCPError,
  ManifestMCPErrorCode,
  MnemonicWalletProvider,
  // @public — compose-only consumers build a FredAuthCtx for the ctx-shaped
  // lifecycle fns (restartApp/updateApp/getAppLogs); they need the silent
  // default logger as the `logger` slot.
  noopLogger,
  parseAddress,
  parseFqdn,
  parseLeaseUuid,
  parseProviderUuid,
  parseSkuUuid,
  requireAuthSigner,
  resolveCallSignal,
  // @public — spec §7 M5: consumer-reachable redaction for ManifestMCPError.details before logging.
  sanitizeForLogging,
  signArbitraryWithAmino,
  VERSION,
  validateConfig,
} from '@manifest-network/manifest-mcp-core';
export type {
  CreateFredClientOptions,
  FredActions,
  FredClient,
} from '@manifest-network/manifest-mcp-fred';
// Only the factory on ROOT — `fredActions` is the low-level client-mixin builder (off the §9 narrative);
// a consumer composing the SDK uses `createFredClient`. (It remains available from the fred package.)
export {
  createFredClient,
  ProviderApiError,
} from '@manifest-network/manifest-mcp-fred';
