import ipaddr from 'ipaddr.js';

/**
 * Pure, browser-safe SSRF IP classification. Extracted from
 * `guarded-fetch.ts` (ENG-490) so the classifier can be shared by BOTH the
 * node connect-time guard (`createGuardedFetch`) and the universal
 * URL-string validator in fred, without dragging undici / node:* into a
 * browser bundle. Uses `ipaddr.js` only (a pure, isomorphic dependency).
 */

/**
 * `ipaddr.js`-classified IPv4 range labels we block (i.e., everything
 * except `'unicast'`). Exposed as a module-level constant so the audit
 * trail is greppable and a future range-list update is a focused edit.
 *
 * RFC citations included for each label for audit visibility — `ipaddr.js`
 * owns the actual CIDR tables that map IPs to these labels.
 */
export const BLOCKED_RANGES_IPV4: ReadonlyArray<{
  readonly range: string;
  readonly rfc: string;
}> = [
  {
    range: 'unspecified',
    rfc: 'RFC 1122 §3.2.1.3 — 0.0.0.0/8 (this network / meta)',
  },
  { range: 'private', rfc: 'RFC 1918 — 10/8, 172.16/12, 192.168/16 (private)' },
  { range: 'loopback', rfc: 'RFC 5735 — 127/8 (loopback)' },
  {
    range: 'linkLocal',
    rfc: 'RFC 3927 — 169.254/16 (link-local, incl. AWS/GCP/Azure metadata at 169.254.169.254)',
  },
  { range: 'carrierGradeNat', rfc: 'RFC 6598 — 100.64/10 (carrier-grade NAT)' },
  { range: 'broadcast', rfc: 'RFC 919 — 255.255.255.255 (limited broadcast)' },
  { range: 'multicast', rfc: 'RFC 5771 — 224/4 (multicast)' },
  {
    range: 'reserved',
    rfc: 'RFC 1112 / 6890 — 240/4, 192.0.0/24, 198.18/15 etc. (reserved)',
  },
];

/**
 * `ipaddr.js`-classified IPv6 range labels we block. Note: `'ipv4Mapped'`
 * is NOT included here because we normalize IPv4-mapped IPv6 addresses to
 * their underlying IPv4 form BEFORE the range check — otherwise a v4-
 * mapped form of a public IP (`::ffff:8.8.8.8`) would be wrongly blocked,
 * and a v4-mapped form of a private IP (`::ffff:127.0.0.1`) would be
 * blocked only structurally (not for the security reason).
 */
export const BLOCKED_RANGES_IPV6: ReadonlyArray<{
  readonly range: string;
  readonly rfc: string;
}> = [
  { range: 'unspecified', rfc: 'RFC 4291 — :: (unspecified)' },
  { range: 'loopback', rfc: 'RFC 4291 — ::1/128 (loopback)' },
  { range: 'linkLocal', rfc: 'RFC 4291 — fe80::/10 (link-local)' },
  { range: 'uniqueLocal', rfc: 'RFC 4193 — fc00::/7 (unique local / private)' },
  { range: 'multicast', rfc: 'RFC 4291 — ff00::/8 (multicast)' },
  { range: 'reserved', rfc: 'RFC 4291 / 5156 — various reserved blocks' },
];

/**
 * SSRF block-check for a single IP string. **Allow-list policy:** only
 * ipaddr.js's `'unicast'` classification is permitted; every other range
 * label is blocked.
 *
 * The prior deny-list implementation iterated BLOCKED_RANGES_* and let
 * anything not explicitly enumerated fall through as "allowed" — a
 * security-critical bias error. IPv6 categories like `6to4` (which can
 * wrap loopback or RFC 1918 IPs as `2002:7f00::/24` etc.), `teredo`,
 * `rfc6052` (NAT64), and `discard` were ALL un-named and therefore
 * allowed-by-omission. Under the allow-list policy, these all
 * default-deny along with any future ipaddr.js classification we
 * haven't audited.
 *
 * Returned `{range, rfc}` descriptor sources:
 *   - **Named in BLOCKED_RANGES_IPV4 / BLOCKED_RANGES_IPV6** → returns
 *     that entry verbatim (carries the audited RFC citation).
 *   - **Unknown non-unicast label** → synthesizes
 *     `{range: <label>, rfc: 'ipaddr.js classification (default-deny non-unicast)'}`.
 *     The audit string is generic but the block decision is correct;
 *     a future PR can promote frequently-seen labels into
 *     BLOCKED_RANGES_* with proper RFC citations.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are normalized to their
 * IPv4 form before the range check so the security verdict tracks the
 * underlying IP, not the structural wrapping.
 *
 * Throws `Error` on unparseable input — callers should catch and treat
 * "unparseable" as "block" (defense-in-depth — better to refuse than to
 * pass through to network on garbage input).
 */
export function isBlocked(ipString: string): {
  range: string;
  rfc: string;
} | null {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(ipString);

  // IPv4-mapped IPv6 normalization — security-critical. See doc-comment.
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    }
  }

  const rangeLabel = parsed.range();

  // Allow-list gate: `'unicast'` is the only category permitted.
  // Everything else defaults to block; the lookup below is for audit info.
  if (rangeLabel === 'unicast') {
    return null;
  }

  const list =
    parsed.kind() === 'ipv4' ? BLOCKED_RANGES_IPV4 : BLOCKED_RANGES_IPV6;
  // Both lists are short; linear scan is fine.
  const named = list.find((r) => r.range === rangeLabel);
  if (named) return named;

  // Default-deny fallback for unknown non-unicast labels (6to4, teredo,
  // rfc6052, discard, future categories ipaddr.js may add). The block
  // decision is correct; the audit string is generic.
  return {
    range: rangeLabel,
    rfc: 'ipaddr.js classification (default-deny non-unicast)',
  };
}

/**
 * True iff `host` is a literal IPv4/IPv6 address (not a DNS hostname).
 * Thin wrapper over `ipaddr.js` so consumers (fred's `isUrlSsrfSafe`) can
 * decide "is this an IP to classify, or a DNS name to fail open on?" without
 * depending on `ipaddr.js` directly. Note: the input must already be a bare
 * host (IPv6 brackets stripped) — WHATWG `URL.hostname` yields `"[::1]"`,
 * callers strip the brackets before calling.
 *
 * Note: `ipaddr.js` also accepts non-canonical IPv4 encodings
 * (hex / octal / decimal / short-form — e.g. `2130706433` for `127.0.0.1`),
 * so this is a "should I classify this host?" predicate, NOT a canonical-IP
 * detector.
 */
export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(host);
}
