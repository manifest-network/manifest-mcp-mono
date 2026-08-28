// Universal `/orchestration` subpath — the elicitation-driven orchestration surface.
//
// agent-core's `export * from './types.js'` is type-only, so `export type *` re-exports
// ALL contract types (DeployAppOptions, ManageDomain*, Plan, Readiness, ProgressEvent,
// FailureEnvelope, the *Callbacks interfaces, …) with ZERO runtime leak — in particular
// the node-only `createGuardedFetch` VALUE is dropped. Four orchestrator functions plus the
// `loadChainDenomMap` loader are the explicit VALUE surface. Two opt-in operations still require
// Node at CALL time: `deployApp(spec, callbacks, { dataDir })` persists a manifest, and
// `loadChainDenomMap(path)` reads chain data. Both use `process.getBuiltinModule` after a runtime
// guard, so importing and bundling the wider orchestration surface remains browser-safe (ENG-667).
export type * from '@manifest-network/manifest-agent-core';
export {
  closeLease,
  deployApp,
  loadChainDenomMap,
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
