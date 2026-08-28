// Node-only `/orchestration` subpath — the elicitation-driven orchestration surface.
//
// agent-core's `export * from './types.js'` is type-only, so `export type *` re-exports
// ALL contract types (DeployAppOptions, ManageDomain*, Plan, Readiness, ProgressEvent,
// FailureEnvelope, the *Callbacks interfaces, …) with ZERO runtime leak — in particular
// the node-only `createGuardedFetch` VALUE is dropped. Four orchestrator functions plus the
// `loadChainDenomMap` loader are the explicit VALUE surface. `deployApp` can persist a manifest
// through agent-core's `saveManifest`, which imports Node filesystem/crypto/path modules; the SDK
// package map therefore fences this whole subpath behind its `node` condition (ENG-667).
export type * from '@manifest-network/manifest-agent-core';
export {
  closeLease,
  deployApp,
  loadChainDenomMap,
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
