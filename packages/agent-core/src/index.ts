export { closeLease } from './close-lease.js';
export { deployApp } from './deploy-app.js';
// M1 fix: re-export `loadChainDenomMap` for public consumption. The
// `DeployAppOptions.chainDataFile` JSDoc (types.ts) instructs callers
// to pre-load via `await loadChainDenomMap(chainDataFile)` and pass
// the result via `opts.denomMap`; that pattern requires the function
// to be importable from `@manifest-network/manifest-agent-core`.
// Matches the `DenomMap` + `DenomLookup` type promotions in commit B.
export { loadChainDenomMap } from './internals/humanize-denom.js';
export { manageDomain } from './manage-domain.js';
export { troubleshootDeployment } from './troubleshoot.js';
export * from './types.js';
