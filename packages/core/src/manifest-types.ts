// The SINGLE chokepoint for canonical Manifest/Fred value & wire DTO types (spec §5.1, §8).
// Only this file imports manifestjs generated TYPE paths. Pure DATA only — runtime/behavior
// types (PollOptions, TerminalChainStateError, the deploy *Input specs) stay in fred until
// the data-vs-behavior split (Plan 3b). Snake_case wire shapes are preserved verbatim: several
// of these are MCP `outputSchema` DTOs validated against `structuredContent` at runtime.
// NOTE (3b-1): DeployResult id-fields are branded (LeaseUuid/ProviderUuid) via the as* trust-cast
// family at the deployManifest producer. Still non-breaking: brands erase to string in JSON and
// the MCP outputSchema is unchanged.

import type {
  Lease,
  LeaseItem,
  LeaseState,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import type {
  Provider,
  SKU,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/sku/v1/types.js';

// Canonical value re-exports routed through this chokepoint (spec §8): the
// runtime `LeaseState` enum + its JSON converter, plus the `Lease` wire type.
// Core code that needs these (e.g. tools/stopApp.ts) imports them from here so
// only this file touches the manifestjs codegen path directly (dependency-cruiser
// manifestjs-types-chokepoint), rather than joining the grandfathered baseline.
export type { Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
export {
  LeaseState,
  leaseStateToJSON,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

import type {
  Address,
  Fqdn,
  LeaseUuid,
  ProviderUuid,
  SkuUuid,
} from './brands.js';

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

/**
 * Retained-lease item shape Fred emits on /status + /provision when
 * provision_status == "retained" (ENG-329). Snake_case wire DTO — distinct from
 * the chain's camelCase LeaseItem. Consumed by restore_app (ENG-599).
 */
export interface FredLeaseItem {
  readonly sku: string;
  readonly quantity?: number;
  readonly service_name?: string;
  readonly custom_domain?: string;
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
  // Retention (present only when provision_status == "retained", ENG-329/ENG-600).
  readonly retained_until?: string; // RFC3339 grace-window deadline
  readonly items?: readonly FredLeaseItem[];
  readonly restore_hint?: string; // server-rendered
  readonly partition?: string; // owner-only sub-tenant grouping key
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
  // Retention (present only when status == "retained", ENG-329/ENG-600).
  readonly retained_until?: string;
  readonly items?: readonly FredLeaseItem[];
  readonly restore_hint?: string;
  readonly partition?: string;
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

// ===== Deploy result wire DTO (relocated VERBATIM from fred/src/tools/deployManifest.ts). KEEPS
// snake_case (it is the `deploy_app` MCP outputSchema validated against structuredContent).
// ids are branded (3b-1) via the as* trust-cast at the deployManifest producer (non-breaking:
// brands erase to string in JSON; MCP outputSchema unchanged; see header NOTE).
// NOTE: agent-core has an UNRELATED public 'DeployResult' (camelCase orchestration projection,
// agent-core/src/types.ts) — a deliberate DTO-vs-domain boundary per spec §5.1, NOT a
// re-declaration. Do not conflate; the snake→camel mapping is pinned by a mapping test. =====
export interface DeployResult {
  readonly lease_uuid: LeaseUuid; // was: string (3a). Branded via as* trust-cast at the producer.
  readonly provider_uuid: ProviderUuid; // was: string (3a). Branded via as* trust-cast at the producer.
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

// ===== Branded read-view types (spec §5.4/§8). Full-passthrough Omit-override over the REAL
// manifestjs camelCase value types: carry EVERY field, brand only the id-bearing ones via the
// as* trust-cast at the producer (tools/reads.ts). Non-breaking — brands erase to string in JSON,
// so MCP outputSchema / wire shape are unchanged. Full-set branding (ENG-309): every scoped id on
// a read return is branded (UUID trio + Address incl. payoutAddress + Fqdn). =====

/** @public — manifestjs LeaseItem with its scoped ids branded. customDomain is a REQUIRED string ('' when unset); asFqdn does NOT reject '' — do NOT change to parseFqdn. */
export interface BrandedLeaseItem
  extends Omit<LeaseItem, 'skuUuid' | 'customDomain'> {
  readonly skuUuid: SkuUuid;
  readonly customDomain: Fqdn;
}
/** @public — full-passthrough branded Lease view: carries EVERY manifestjs Lease field; brands only the 4 id-bearing ones. */
export interface BrandedLease
  extends Omit<Lease, 'uuid' | 'tenant' | 'providerUuid' | 'items'> {
  readonly uuid: LeaseUuid;
  readonly tenant: Address; // Tenant = Address (transparent alias)
  readonly providerUuid: ProviderUuid;
  readonly items: BrandedLeaseItem[];
}
/** @public — branded SKU view. */
export interface BrandedSKU extends Omit<SKU, 'uuid' | 'providerUuid'> {
  readonly uuid: SkuUuid;
  readonly providerUuid: ProviderUuid;
}
/** @public — branded Provider view (address AND payoutAddress are bech32 → Address). */
export interface BrandedProvider
  extends Omit<Provider, 'uuid' | 'address' | 'payoutAddress'> {
  readonly uuid: ProviderUuid;
  readonly address: Address;
  readonly payoutAddress: Address;
}

// Data-only deploy specs (spec §5.1). The 4 runtime-orchestration fields (gasMultiplier/
// onLeaseCreated/abortSignal/pollOptions) are NOT here — they live on fred's DeployCallOptions
// (PollOptions carries an AbortSignal + callbacks, so keeping it here would invert the core→fred DAG).
// The fred-layer Deploy*Input names are permanent compatibility aliases (DeployAppInput = AppDeploySpec,
// DeployManifestInput = ManifestDeploySpec) kept so existing callers keep working; the canonical home is here.
/** Data-only deploy spec; runtime orchestration lives on DeployCallOptions. */
export interface AppDeploySpec {
  image?: string;
  port?: number;
  size: string;
  /** Disambiguate a duplicate SKU name to one provider (ENG-258). Caller-stringly; branded in skuSelectorFromInput. */
  providerUuid?: string;
  /** Pin a specific SKU by uuid (ENG-258). Wins over size/providerUuid. */
  skuUuid?: string;
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
  storage?: string;
  depends_on?: Record<string, { condition: string }>;
  services?: Record<string, ServiceConfig>;
  customDomain?: string;
  serviceName?: string;
}

/** Data-only deploy spec; runtime orchestration lives on DeployCallOptions. */
export interface ManifestDeploySpec {
  manifest: string;
  sku: SkuIntent;
  storage?: string;
  customDomain?: string;
  serviceName?: string;
}

// Unified SKU selector (was fred's `SkuSelector`). byName = resolve/disambiguate by name;
// resolved = caller pre-resolved both ids. uuids are branded; `size` stays plain string (post-v7 scope-down).
// NOTE (trust-cast): the byName `providerUuid`/`skuUuid` are OPTIONAL NARROWING HINTS that `resolveSku`
// resolves authoritatively against chain SKUs by STRING EQUALITY (not UUID-format validation, ENG-258
// "chain is authoritative") — so they are branded via the `as*` TRUST-CAST, never `parse*`. A re-validating
// `parse*` would reject non-canonical-but-chain-valid ids and is NOT the boundary: §5.0's "stringly/MCP face
// → parse+validate" obligation lives at the MCP boundary (register-tools.ts), not at this downstream transform.
export type SkuIntent =
  | {
      kind: 'byName';
      size: string;
      providerUuid?: ProviderUuid;
      skuUuid?: SkuUuid;
    }
  | { kind: 'resolved'; skuUuid: SkuUuid; providerUuid: ProviderUuid };
