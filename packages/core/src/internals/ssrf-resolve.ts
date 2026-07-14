/**
 * Node-only SSRF connect-time guard primitive: resolve a host to the IP the kernel would connect to
 * and assert it is a public `'unicast'` address, or throw. Factored out of `guarded-fetch.ts` (ENG-315)
 * so BOTH the undici connect-guard (`createGuardedFetch`) and the WebSocket transport
 * (`createNodeEventTransport`) share one DNS-resolve + `ipaddr.js` classification, closing the TOCTOU
 * window by handing the caller the resolved IP to connect to directly (with a pinned Host).
 *
 * Node-only: dynamic-imports `node:dns/promises` + `node:net` so the module stays importable from a
 * browser bundle (the classifier `isBlocked` is pure/isomorphic). Callers on non-Node runtimes should
 * not reach this — the node-fenced subpaths (`/guarded-fetch`, `/events-node`) gate it.
 */
import { isBlocked } from './ssrf-classify.js';

/**
 * The two host-resolution primitives `assertUnicastHost` needs, injectable for tests. Defaults to
 * `node:net`.isIP + `node:dns/promises`.lookup (dynamic-imported so this module stays browser-importable).
 */
export interface ResolveDeps {
  /** `node:net.isIP` — 0 for a DNS name, 4/6 for an IP literal. */
  isIP(host: string): number;
  /** `node:dns/promises.lookup(host, { verbatim: true })` — kernel-order (hosts→nsswitch→DNS) resolution. */
  lookup(host: string): Promise<{ address: string }>;
}

async function loadNodeResolveDeps(): Promise<ResolveDeps> {
  const [dnsModule, netModule] = await Promise.all([
    import('node:dns/promises'),
    import('node:net'),
  ]);
  return {
    isIP: netModule.isIP,
    lookup: (host) => dnsModule.lookup(host, { verbatim: true }),
  };
}

/**
 * Resolve `hostname` and assert it is a public unicast address; returns the resolved IP to connect to.
 *
 * - An IP literal is classified directly (no DNS).
 * - A DNS name is resolved via `dns.lookup` (`getaddrinfo`, `verbatim: true`) — the SAME path the kernel
 *   uses at `connect(2)` (hosts file → nsswitch → DNS), so the IP checked IS the IP connected to
 *   (DNS-rebinding mitigation; matches `guarded-fetch.ts`'s deliberate divergence from `resolve4/6`).
 * - A non-`'unicast'` result throws `SSRF blocked: <host> resolves to <ip> which is in blocked range
 *   '<range>' (<rfc>)`. An unresolvable/malformed host or an unparseable IP fails CLOSED with
 *   `SSRF blocked: refused to connect to <host>: <reason>`.
 *
 * The caller should connect to the returned IP with the ORIGINAL hostname pinned as the `Host` header /
 * TLS SNI so the resolved IP is not re-resolved.
 */
export async function assertUnicastHost(
  hostname: string,
  deps?: ResolveDeps,
): Promise<string> {
  const { isIP, lookup } = deps ?? (await loadNodeResolveDeps());

  let ip: string;
  try {
    if (isIP(hostname) !== 0) {
      ip = hostname;
    } else {
      const result = await lookup(hostname);
      ip = result.address;
    }
  } catch (err) {
    // Fail closed — unresolvable / malformed hostnames are rejected, never passed through.
    throw new Error(
      `SSRF blocked: refused to connect to ${hostname}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let blocked: { range: string; rfc: string } | null;
  try {
    // `isBlocked` throws on unparseable IPs — treat that as a block (defense-in-depth).
    blocked = isBlocked(ip);
  } catch (err) {
    throw new Error(
      `SSRF blocked: refused to connect to ${hostname}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (blocked) {
    throw new Error(
      `SSRF blocked: ${hostname} resolves to ${ip} which is in blocked range '${blocked.range}' (${blocked.rfc})`,
    );
  }
  return ip;
}
