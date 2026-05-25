import ipaddr from 'ipaddr.js';

/**
 * SSRF-guarded `fetch` factory. A Node-native undici Dispatcher that
 * DNS-resolves once at connect time and rejects any address whose
 * `ipaddr.js` range is not `'unicast'`.
 *
 * Why DIY rather than `request-filtering-agent`: the library only works with
 * `http`/`https`.Agent (legacy http API) and explicitly does NOT plug into
 * undici / native `fetch` per its v3.2.0 README. Re-routing the same
 * blocking semantics through undici's Dispatcher hook lets agent-core's
 * `inspectImage` (and future consumers) use native `fetch` while preserving
 * the same SSRF posture.
 *
 * Design (architect-blessed):
 * - **`ipaddr.js`'s `range()` is the source of truth.** Same approach as
 *   `request-filtering-agent`: block any IP whose range is not `'unicast'`.
 *   This covers loopback / private / link-local / multicast / broadcast /
 *   reserved / carrier-grade-NAT / unspecified / ipv4Mapped / etc. via the
 *   library's well-maintained RFC-classification table.
 * - **IPv4-mapped IPv6 normalization** (security-critical). An attacker
 *   writing `::ffff:127.0.0.1` would otherwise sit in `ipaddr.js`'s
 *   `'ipv4Mapped'` IPv6 range — coincidentally blocked, but for the
 *   structural reason ("v4-mapped form") rather than the security reason
 *   ("loopback target"). We normalize first so the block is justified.
 *   Without this step, a v4-mapped form of a PUBLIC IPv4 (`::ffff:8.8.8.8`)
 *   would also be blocked (wrong outcome — public IP is fine via
 *   v4-mapped). Normalization gets both cases right.
 * - **DNS-resolve INSIDE the connect hook** to close the TOCTOU window
 *   between resolve and TCP connect. The resolved IP gets substituted as
 *   the connect hostname so the kernel doesn't re-resolve.
 * - **Module-level singleton Dispatcher**, lazy-instantiated on first
 *   `createGuardedFetch()` invocation. Mirrors the CJS singleton-agent
 *   pattern; avoids the aggressive `setGlobalDispatcher()` side-effect.
 * - **Construction-time runtime check** (`typeof process === 'undefined'`)
 *   throws a clear error on browser/Deno so the failure is actionable, not
 *   a confusing mid-fetch module-resolution error.
 * - **Redirect safety:** undici re-fires the connect hook on every cross-
 *   host redirect; same-host redirects reuse the checked socket. The fetch
 *   closure does NOT need `redirect: 'manual'` — default `follow` is safe
 *   by construction.
 *
 * Blocked-range exports (`BLOCKED_RANGES_IPV4`, `BLOCKED_RANGES_IPV6`) are
 * provided for audit + test purposes: they enumerate the `ipaddr.js`
 * `range()` classifications we treat as non-`unicast` with their RFC
 * citations, so a reviewer can grep the code without consulting the
 * `ipaddr.js` source.
 *
 * Cross-platform note: agent-core's `tsdown.config.ts` targets
 * `platform: 'neutral'`. `ipaddr.js` is isomorphic (pure JS, no node:*
 * imports), so the static import is fine. `undici` and `node:dns/promises`
 * + `node:net` are Node-only — dynamic-imported INSIDE the lazy singleton
 * creation so the package stays importable from browsers / Deno (calling
 * `createGuardedFetch()` from those throws the construction-time error
 * with actionable guidance).
 */

export type GuardedFetch = typeof fetch;

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
 * Supplemental CIDR overlay — ranges that `ipaddr.js` v1.9.1's `range()`
 * MISCLASSIFIES as `'unicast'` (so the allow-list gate would pass them
 * through) but that we must still block.
 *
 * **Why these live OUTSIDE BLOCKED_RANGES_***: those arrays are audit-only
 * — they don't drive the verdict. `isBlocked` returns early on
 * `range() === 'unicast'`, so appending here would be inert AND would break
 * the `toEqual` coverage tests that pin the exact label sets (8 IPv4 / 6
 * IPv6). The verdict for these ranges is instead an explicit CIDR
 * `match()` performed INSIDE the unicast branch, before returning null.
 *
 * **Why ipaddr.js misses them**: v1.9.1's RFC-classification table predates
 * (or omits) these assignments, mapping them to the generic `'unicast'`
 * fallback. Verified empirically: `ipaddr.parse('198.18.0.1').range()` and
 * `ipaddr.parse('100::1').range()` both return `'unicast'` on v1.9.1.
 *
 * Each `cidr` is a pre-parsed `[addr, prefixBits]` tuple (ipaddr.js's
 * `parseCIDR` shape) so the per-request hot path does no string parsing.
 */
export const SUPPLEMENTAL_RANGES_IPV4: ReadonlyArray<{
  readonly cidr: [ipaddr.IPv4, number];
  readonly range: string;
  readonly rfc: string;
}> = [
  {
    cidr: ipaddr.IPv4.parseCIDR('198.18.0.0/15'),
    range: 'reserved',
    rfc: 'RFC 2544 — 198.18.0.0/15 (benchmarking)',
  },
];

/**
 * IPv6 counterpart to {@link SUPPLEMENTAL_RANGES_IPV4}. See that comment
 * for why these are checked separately from BLOCKED_RANGES_IPV6.
 */
export const SUPPLEMENTAL_RANGES_IPV6: ReadonlyArray<{
  readonly cidr: [ipaddr.IPv6, number];
  readonly range: string;
  readonly rfc: string;
}> = [
  {
    cidr: ipaddr.IPv6.parseCIDR('100::/64'),
    range: 'discard',
    rfc: 'RFC 6666 — 100::/64 (discard-only)',
  },
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
    // Supplemental overlay: a handful of reserved ranges that ipaddr.js
    // v1.9.1 misclassifies as `'unicast'`. Check explicit CIDRs before
    // letting the address through. See SUPPLEMENTAL_RANGES_* doc-comments.
    if (parsed.kind() === 'ipv4') {
      const v4 = parsed as ipaddr.IPv4;
      for (const entry of SUPPLEMENTAL_RANGES_IPV4) {
        if (v4.match(entry.cidr)) {
          return { range: entry.range, rfc: entry.rfc };
        }
      }
    } else {
      const v6 = parsed as ipaddr.IPv6;
      for (const entry of SUPPLEMENTAL_RANGES_IPV6) {
        if (v6.match(entry.cidr)) {
          return { range: entry.range, rfc: entry.rfc };
        }
      }
    }
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

interface DispatcherCache {
  dispatcher: unknown;
  fetch: typeof fetch;
}

/**
 * Cache the in-flight Promise (not the resolved value) so concurrent first-
 * call racers share the same construction and don't double-build the
 * undici Agent. Resolves to the singleton DispatcherCache. After
 * resolution, subsequent calls await the already-settled Promise (cheap).
 */
let cachedP: Promise<DispatcherCache> | undefined;

/**
 * Build the SSRF-guarded fetch closure. Construction-time runtime check
 * gates Node-only — browser / Deno consumers either pass their own
 * `opts.fetch` to consumers like `inspectImage` or accept this error.
 *
 * The returned function matches `typeof fetch` and lazy-instantiates the
 * undici Dispatcher on first invocation. Subsequent calls share the
 * cached singleton.
 *
 * **Important: uses undici's own `fetch`**, not Node's built-in. Node's
 * built-in fetch is backed by its bundled undici, which is pinned to
 * Node's release-cycle version (Node 22 → undici 6.x). The npm-installed
 * `undici` package may be newer, and the Dispatcher protocol between
 * versions isn't guaranteed compatible (we observed "invalid
 * onRequestStart method" when mixing Node 22's fetch with undici@8 Agent).
 * Routing through undici's own fetch (same package version as the Agent)
 * sidesteps the mismatch. The function signature stays identical to
 * Node's `fetch` so consumers can't tell the difference.
 */
export function createGuardedFetch(): GuardedFetch {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      'createGuardedFetch requires a Node.js runtime. On browser/Deno consumers, pass `opts.fetch` directly with your own SSRF-guarded implementation. See agent-core README.',
    );
  }

  return async (input, init) => {
    // Cache the Promise rather than the resolved value to dedup concurrent
    // first-call construction. Two callers racing through the lazy path
    // would otherwise both call `buildSsrfDispatcher()` and end up with
    // two undici Agents (no correctness bug, just double resource).
    //
    // Catch-and-reset on rejection: if `buildSsrfDispatcher()` ever fails
    // (e.g., dynamic `import('undici')` throws on a runtime that masquerades
    // as Node but lacks the module), the rejected Promise must NOT stay
    // cached — otherwise every subsequent `createGuardedFetch()` call would
    // re-throw the same error permanently. Clearing `cachedP` in the catch
    // arm lets a future caller retry construction.
    if (!cachedP) {
      cachedP = buildSsrfDispatcher().catch((err: unknown) => {
        cachedP = undefined;
        throw err;
      });
    }
    const c = await cachedP;
    // undici's fetch accepts a `dispatcher` option natively. Cast the init
    // to undici's expected shape — undici's fetch signature is structurally
    // compatible with global fetch but TS can't see through the dispatcher
    // field without a cast.
    const initWithDispatcher = {
      ...(init ?? {}),
      dispatcher: c.dispatcher,
    } as RequestInit;
    return c.fetch(input, initWithDispatcher);
  };
}

/**
 * Lazy dynamic-import of Node-only modules so the package stays importable
 * from non-Node consumers. The runtime check in `createGuardedFetch`
 * already gates Node-only — this function is only reached on Node.
 *
 * Returns BOTH the dispatcher and undici's own `fetch` so the
 * `createGuardedFetch` closure can route through undici directly (avoiding
 * Node-bundled-undici vs npm-undici Dispatcher protocol mismatches).
 */
async function buildSsrfDispatcher(): Promise<DispatcherCache> {
  const [undici, dnsModule, netModule] = await Promise.all([
    import('undici'),
    import('node:dns/promises'),
    import('node:net'),
  ]);

  const baseConnect = undici.buildConnector({});

  const dispatcher = new undici.Agent({
    connect: (options, callback) => {
      // Defensive: undici's Connect signature carries hostname + port + others.
      // We snapshot the original hostname for error messages; the resolved
      // IP gets substituted into `options` before the underlying TCP connect
      // so the kernel doesn't re-resolve (DNS-rebinding mitigation).
      const hostname = (options as { hostname?: string }).hostname ?? '';

      resolveAndCheck(hostname, netModule, dnsModule)
        .then((resolved) => {
          if (resolved.blocked) {
            callback(
              new Error(
                `SSRF blocked: ${hostname} resolves to ${resolved.ip} which is in blocked range '${resolved.blocked.range}' (${resolved.blocked.rfc})`,
              ),
              null,
            );
            return;
          }
          // Substitute the resolved IP so the kernel doesn't re-resolve.
          baseConnect(
            { ...options, hostname: resolved.ip } as Parameters<
              typeof baseConnect
            >[0],
            callback,
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Fail closed — unparseable / unresolvable hostnames get rejected
          // rather than passed through. This keeps the SSRF posture intact
          // against DNS errors that might otherwise leak through.
          callback(
            new Error(
              `SSRF blocked: refused to connect to ${hostname}: ${msg}`,
            ),
            null,
          );
        });
    },
  });

  // undici's fetch has a structurally compatible signature with global fetch.
  // Cast at the boundary; downstream consumers see `typeof fetch`.
  return {
    dispatcher,
    fetch: undici.fetch as unknown as typeof fetch,
  };
}

/**
 * Resolve the connection target's IP and check against the blocked-range
 * sets. Handles three input cases:
 *   1. Hostname is already an IP literal → check directly (no DNS lookup).
 *   2. Hostname is an FQDN → resolve via `dns.lookup` (returns first
 *      address; matches Node's default connection behavior).
 *   3. Resolution failure → throws, which the caller's `.catch` translates
 *      into a fail-closed SSRF-block error.
 *
 * **DELIBERATE DIVERGENCE FROM SPEC** — architect's spec said
 * `dns.resolve4` / `dns.resolve6`; this implementation uses `dns.lookup`.
 * Rationale: `dns.lookup` matches the kernel's actual connection-time
 * resolution path (hosts file + nsswitch.conf + DNS in order), so the IP
 * we check IS the IP the kernel would connect to. Using `resolve4/6`
 * would consult DNS only and miss the hosts-file path — if an attacker
 * could write to `/etc/hosts` (root only) the check would be incomplete
 * because the kernel's actual connect would use a different address than
 * the one we checked. Per threat model: hosts-file writes require root,
 * so an attacker capable of writing there already owns the machine; this
 * is "fixing the right problem" — the check should track what the kernel
 * does, not its own model of resolution.
 *
 * Documented in PR 2 description for reviewer awareness. If the threat
 * model expands to include shared-host scenarios where attacker-controlled
 * hosts entries are realistic, switch to `resolve4/6` and accept the
 * connect-time-mismatch risk.
 */
async function resolveAndCheck(
  hostname: string,
  netModule: typeof import('node:net'),
  dnsModule: typeof import('node:dns/promises'),
): Promise<{
  ip: string;
  blocked: { range: string; rfc: string } | null;
}> {
  let ip: string;
  if (netModule.isIP(hostname) !== 0) {
    ip = hostname;
  } else {
    // `dns.lookup` calls `getaddrinfo` and follows the kernel's resolution
    // order (hosts → nsswitch → DNS, OS-defined), so the IP we check IS
    // the IP the kernel uses at connect(2) time. `dns.resolve4`/`resolve6`
    // would query system DNS only and miss `/etc/hosts` entries — a
    // `/etc/hosts evil.example.com 127.0.0.1` line would slip past the
    // SSRF check (DNS returns a clean IP) while the kernel connects to
    // loopback. Architect-endorsed correction to the original spec.
    //
    // `verbatim: true` preserves OS-defined IPv4/IPv6 ordering to avoid
    // reorder-induced check-vs-connect drift in mixed-family DNS responses.
    const result = await dnsModule.lookup(hostname, { verbatim: true });
    ip = result.address;
  }
  // Defense-in-depth: treat parse failures as blocks. ipaddr.parse throws
  // for malformed input — catch in the caller via the .catch wiring.
  const blocked = isBlocked(ip);
  return { ip, blocked };
}
