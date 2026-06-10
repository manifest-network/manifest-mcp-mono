import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import {
  assertUuid,
  DENOM_RE,
  FQDN_RE,
  SCHEME_PREFIX_RE,
  validateAddress,
} from './validation.js';

/**
 * Nominal brand. STRING tag key (not a `unique symbol`) ON PURPOSE: a unique-symbol brand is
 * non-assignable across DUPLICATED package copies (each copy mints a distinct symbol), breaking
 * the incremental cross-copy adoption this monorepo needs (the worktree/dep-drift hazard in
 * CLAUDE.md). Never exported. A brand is structurally `string`: assignable TO string, not FROM it.
 * INVARIANT: every `as Brand` cast below is preceded by a throwing validator on all paths.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type Address = Brand<string, 'Address'>;
/** A tenant IS an address — intentional transparent alias (branding does not distinguish them). */
export type Tenant = Address;
export type LeaseUuid = Brand<string, 'LeaseUuid'>;
export type ProviderUuid = Brand<string, 'ProviderUuid'>;
export type SkuUuid = Brand<string, 'SkuUuid'>;
export type TierName = Brand<string, 'TierName'>;
export type Fqdn = Brand<string, 'Fqdn'>;
export type Denom = Brand<string, 'Denom'>;
export type ChainId = Brand<string, 'ChainId'>;

const ARG = ManifestMCPErrorCode.INVALID_ARGUMENT;

/**
 * Validate a bech32 address and brand it. With no `expectedPrefix` this validates bech32
 * STRUCTURE only and does NOT pin the chain prefix — callers needing chain affinity (e.g. the
 * Signer adapter) pass the configured `addressPrefix`.
 */
export function parseAddress(value: string, expectedPrefix?: string): Address {
  validateAddress(value, 'address', expectedPrefix);
  return value as Address;
}

export function parseLeaseUuid(value: string): LeaseUuid {
  assertUuid(value, 'leaseUuid', ARG);
  return value as LeaseUuid;
}
export function parseProviderUuid(value: string): ProviderUuid {
  assertUuid(value, 'providerUuid', ARG);
  return value as ProviderUuid;
}
export function parseSkuUuid(value: string): SkuUuid {
  assertUuid(value, 'skuUuid', ARG);
  return value as SkuUuid;
}

/** Reject whitespace-only (stricter than requireString's length check) — a blank tier/chainId is never meaningful. */
function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ManifestMCPError(ARG, `${label} must be a non-empty string`);
  }
}

export function parseTierName(value: string): TierName {
  assertNonEmpty(value, 'size');
  return value as TierName;
}
export function parseChainId(value: string): ChainId {
  assertNonEmpty(value, 'chainId');
  return value as ChainId;
}
export function parseDenom(value: string): Denom {
  if (!DENOM_RE.test(value)) {
    throw new ManifestMCPError(ARG, `denom "${value}" is not a valid denom`);
  }
  return value as Denom;
}

/**
 * Normalize (RFC 4343: DNS is case-insensitive) and validate a custom domain. Rejects scheme
 * prefixes and IPv4 literals (FQDN_RE has a letter-led top-level label). The chain remains the
 * authoritative validator (reserved suffixes, etc.).
 */
export function parseFqdn(value: string): Fqdn {
  if (SCHEME_PREFIX_RE.test(value)) {
    throw new ManifestMCPError(
      ARG,
      `customDomain "${value}" must not include a scheme — pass a bare FQDN`,
    );
  }
  const normalized = value.toLowerCase();
  if (!FQDN_RE.test(normalized)) {
    throw new ManifestMCPError(
      ARG,
      `customDomain "${value}" is not a valid FQDN`,
    );
  }
  return normalized as Fqdn;
}
