import { assertUuid } from './internals/uuid.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { FQDN_RE, SCHEME_PREFIX_RE, validateAddress } from './validation.js';

/**
 * Nominal brand. STRING tag key (not a `unique symbol`) ON PURPOSE: a unique-symbol brand is
 * non-assignable across DUPLICATED package copies (each copy mints a distinct symbol), breaking
 * the incremental cross-copy adoption this monorepo needs (the worktree/dep-drift hazard in
 * CLAUDE.md). Never exported. A brand is structurally `string`: assignable TO string, not FROM it.
 *
 * TWO sanctioned producer families, one per boundary trust-model (spec §5.0):
 *   - parse*  — VALIDATE + brand at the UNTRUSTED boundary (stringly/MCP input, provider HTTP,
 *               wallet-in). Throwing, type-narrowing. Each `as Brand` cast here is preceded by a
 *               throwing validator on all paths.
 *   - as*     — TRUST-CAST at the TRUSTED boundary (chain/codegen reads, already-resolved ids).
 *               Brands WITHOUT validation and NEVER throws — the chain is the source of truth, and
 *               re-validating would both waste work and throw on non-canonical ids (ENG-258 parse-once).
 * BOTH families confine the lone `as Brand` cast to this file (§8).
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type Address = Brand<string, 'Address'>;
/** A tenant IS an address — intentional transparent alias (branding does not distinguish them). */
export type Tenant = Address;
export type LeaseUuid = Brand<string, 'LeaseUuid'>;
export type ProviderUuid = Brand<string, 'ProviderUuid'>;
export type SkuUuid = Brand<string, 'SkuUuid'>;
export type Fqdn = Brand<string, 'Fqdn'>;

// NOTE (v7 scope-down): `tierName`/`denom`/`chainId` are intentionally PLAIN `string`, not branded.
// They are single-role-per-call-site with low confusion risk, and the whole Cosmos stack
// (cosmjs/Telescope/InterchainJS) uses bare `string` for them — branding them would tax every
// interop boundary for little safety. Brands are kept only where a mix-up is plausible AND costly:
// the same-shaped Lease/Provider/Sku UUID trio, Address, and Fqdn (which also normalizes).

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

// ===== as* — trust-cast family (no validation, never throws); see the two-family note above. =====
export function asLeaseUuid(value: string): LeaseUuid {
  return value as LeaseUuid;
}
export function asProviderUuid(value: string): ProviderUuid {
  return value as ProviderUuid;
}
export function asSkuUuid(value: string): SkuUuid {
  return value as SkuUuid;
}
export function asAddress(value: string): Address {
  return value as Address;
}
// NOTE: unlike parseFqdn, asFqdn does NOT lowercase — chain reads are already canonical
// (re-normalizing would break parse-once, ENG-258) — and does NOT reject '' (trust-cast).
export function asFqdn(value: string): Fqdn {
  return value as Fqdn;
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
