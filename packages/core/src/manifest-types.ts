// The SINGLE chokepoint for canonical Manifest/Fred value & wire DTO types (spec §5.1, §8).
// Only this file imports manifestjs generated TYPE paths. Pure DATA only — runtime/behavior
// types (PollOptions, TerminalChainStateError, the deploy *Input specs) stay in fred until
// the data-vs-behavior split (Plan 3b). Snake_case wire shapes are preserved verbatim: several
// of these are MCP `outputSchema` DTOs validated against `structuredContent` at runtime.
// NOTE (3a): DeployResult ids are plain `string` (verbatim). Branding them is Plan 3b — it needs
// trust-cast brand producers in brands.ts (a re-validating parse* throws on non-UUID provider ids).
import type { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

// ===== Manifest build / validation (relocated from fred/src/manifest.ts) =====
export interface BuildManifestOptions {
  image: string;
  ports: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
}

export type ManifestFormat = 'single' | 'stack';

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly format: ManifestFormat | null;
}

// ===== Service config (relocated from fred/src/tools/deployApp.ts) =====
export interface ServiceConfig {
  image: string;
  ports?: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  depends_on?: Record<string, { condition: string }>;
  expose?: string[];
  labels?: Record<string, string>;
}

// ===== Net-new canonical port config (ENG-282). FORWARD-DECLARED: the chokepoint owns the
// canonical shape, but wiring it into `ServiceConfig.ports` (today `Record<string, never>`)
// is ENG-282 and has no P0a consumer — do not wire it here. =====
export interface PortConfig {
  readonly host_port?: number;
  readonly ingress?: boolean;
}

// ===== Provider connection wire types (relocated from fred/src/http/provider.ts) =====
export interface InstanceInfo {
  readonly instance_index: number;
  readonly container_id: string;
  readonly image: string;
  readonly status: string;
  readonly ports?: Record<string, unknown>;
  readonly fqdn?: string;
}

export interface ServiceConnectionDetails {
  readonly host?: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
}

export interface ConnectionDetails {
  readonly host: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
  readonly protocol?: string;
  readonly metadata?: Record<string, string>;
  readonly services?: Record<string, ServiceConnectionDetails>;
}

export interface LeaseConnectionResponse {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly connection: ConnectionDetails;
}

// ===== Fred lease-status / action / release wire types (relocated from fred/src/http/fred.ts) =====
export interface FredInstanceInfo {
  readonly name: string;
  readonly status: string;
  readonly ports?: Record<string, number>;
  readonly fqdn?: string;
}

export interface FredServiceStatus {
  readonly instances: readonly FredInstanceInfo[];
}

export interface FredLeaseStatus {
  readonly state: LeaseState;
  readonly provision_status?: string;
  readonly phase?: string;
  readonly steps?: Record<string, string>;
  readonly instances?: readonly FredInstanceInfo[];
  readonly endpoints?: Record<string, string>;
  readonly last_error?: string;
  readonly fail_count?: number;
  readonly created_at?: string;
  readonly services?: Record<string, FredServiceStatus>;
}

export interface FredLeaseLogs {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly logs: Record<string, string>;
}

export interface FredLeaseProvision {
  readonly status: string;
  readonly fail_count: number;
  /**
   * Set only when the most recent provisioning attempt failed. The Fred
   * provider omits the field on success, so the optional marker matches
   * the wire shape (and matches the same field on FredLeaseStatus above).
   */
  readonly last_error?: string;
}

export interface FredActionResponse {
  readonly status: string;
}

export interface FredLeaseRelease {
  readonly version: number;
  readonly image: string;
  readonly status: string;
  readonly created_at: string;
  readonly error?: string;
  readonly manifest?: string;
}

export interface FredLeaseReleases {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly releases: readonly FredLeaseRelease[];
}

export interface FredLeaseInfo {
  readonly host: string;
  readonly ports?: Record<string, unknown>;
}

// ===== Deploy result wire DTO (relocated VERBATIM from fred/src/tools/deployManifest.ts). KEEPS
// snake_case (it is the `deploy_app` MCP outputSchema validated against structuredContent).
// ids stay plain `string` in 3a; Plan 3b brands them via trust-cast (see header NOTE).
// NOTE: agent-core has an UNRELATED public 'DeployResult' (camelCase orchestration projection,
// agent-core/src/types.ts) — a deliberate DTO-vs-domain boundary per spec §5.1, NOT a
// re-declaration. Do not conflate; the snake→camel mapping is pinned by a mapping test. =====
export interface DeployResult {
  readonly lease_uuid: string;
  readonly provider_uuid: string;
  readonly provider_url: string;
  readonly state: LeaseState;
  readonly url?: string;
  readonly connection?: ConnectionDetails;
  readonly connectionError?: string;
  /** Set when a `customDomain` was supplied AND the set-domain tx succeeded. */
  readonly custom_domain?: string;
  /** Set when a `serviceName` was supplied alongside a successful `customDomain` set. */
  readonly service_name?: string;
}
