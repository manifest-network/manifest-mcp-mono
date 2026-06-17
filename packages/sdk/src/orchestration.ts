// `/orchestration` subpath — the elicitation-driven orchestration surface.
//
// agent-core's `export * from './types.js'` is type-only, so `export type *` re-exports
// ALL contract types (DeployAppOptions, ManageDomain*, Plan, Readiness, ProgressEvent,
// FailureEnvelope, the *Callbacks interfaces, …) with ZERO runtime leak — in particular
// the node-only `createGuardedFetch` VALUE is dropped. The 5 orchestration fns are the
// explicit VALUE surface. Browser-safe ONLY because Task A1 fenced agent-core's barrel
// (moved `createGuardedFetch` to its own node-gated `/guarded-fetch` subpath).
export type * from '@manifest-network/manifest-agent-core';
export {
  closeLease,
  deployApp,
  loadChainDenomMap,
  manageDomain,
  troubleshootDeployment,
} from '@manifest-network/manifest-agent-core';
