/**
 * Node-only, SSRF-guarded WebSocket transport backing `ctx.events` (ENG-315). The `ws` client is an
 * exact-pinned OPTIONAL dependency, dynamic-imported so the package stays importable from browsers /
 * Deno (which use a native-`WebSocket`-backed transport instead). Exposed via the node-fenced
 * `@manifest-network/manifest-mcp-core/events-node` subpath — the exact mirror of `/guarded-fetch`.
 *
 * SSRF: undici's guarded dispatcher does NOT cover `ws`, so this transport applies the SAME connect-time
 * guard as the fetch path — `assertUnicastHost` DNS-resolves the target and rejects any non-`'unicast'`
 * address, then connects to the RESOLVED IP (via a pinned `lookup`) while the `ws` client keeps the
 * original hostname for the `Host` header + TLS SNI. This closes the DNS-rebinding window (the IP checked
 * IS the IP connected to). Guarded by default (like `createGuardedFetch`, the library reads no env); a
 * consumer opts out for loopback dev / e2e — or when it guards the URL another way — via `{ guarded: false }`,
 * or by injecting its own `EventTransport`. (If the Fred MCP server later injects this transport it should
 * gate the opt-out behind an env knob alongside `MANIFEST_FRED_FETCH_GUARDED`, mirroring the fetch path;
 * today the server uses the poll fallback and does not open a WebSocket.)
 */
import type { EventSocket, EventTransport } from '../ctx.js';
import { assertUnicastHost } from './ssrf-resolve.js';

export interface NodeEventTransportOptions {
  /**
   * SSRF connect-time guard. `true` (default) DNS-resolves + asserts the host is a public unicast IP and
   * pins the connection to it. `false` connects raw (loopback dev / e2e, or when the caller guards the
   * URL another way) — mirrors injecting an unguarded `fetch`.
   */
  readonly guarded?: boolean;
}

/** Extract the bare host (IPv6 brackets stripped) from a ws/wss URL. */
function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '');
}

/**
 * Build a node WS transport. `open()` establishes ONE connection (reconnection/backoff/liveness live in
 * the consumer). Node-only: throws on non-Node runtimes with actionable guidance, like `createGuardedFetch`.
 */
export function createNodeEventTransport(
  opts?: NodeEventTransportOptions,
): EventTransport {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      'createNodeEventTransport requires a Node.js runtime. In the browser, inject an EventTransport backed by the native WebSocket. See the @manifest-network/manifest-mcp-core README.',
    );
  }
  const guarded = opts?.guarded ?? true;
  return {
    open(url: string): EventSocket {
      return openNodeSocket(url, guarded);
    },
  };
}

// A minimal `ws` instance surface — enough to adapt, without pinning to @types/ws internals.
interface WsLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: (code: number, reason: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(code?: number): void;
  terminate(): void;
}

function openNodeSocket(url: string, guarded: boolean): EventSocket {
  let onMessage: ((data: string) => void) | undefined;
  let onOpen: (() => void) | undefined;
  let onClose: ((code: number, reason: string) => void) | undefined;
  let onError: ((err: Error) => void) | undefined;

  let ws: WsLike | undefined;
  let userClosed = false;
  let closeEmitted = false;

  const emitClose = (code: number, reason: string): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    onClose?.(code, reason);
  };

  // Connect asynchronously so the caller registers its on*() listeners (synchronously, right after
  // open()) BEFORE any event fires. Yield a microtask FIRST so even a synchronous throw in the prefix
  // (e.g. `new URL(url)` on a malformed url) surfaces as onError/onClose AFTER open() returns and the
  // listeners are set — otherwise the synthetic close would fire into undefined listeners and be lost.
  void (async () => {
    await Promise.resolve();
    try {
      const wsUrl = new URL(url);
      const connectOptions: Record<string, unknown> = {};

      if (guarded) {
        // Resolve + assert unicast, then pin the connection to that IP while `ws` keeps the original
        // host for the Host header + SNI (rebinding-safe: the IP checked is the IP connected to).
        const ip = await assertUnicastHost(hostOf(url));
        if (userClosed) return;
        const net = await import('node:net');
        const family = net.isIP(ip); // 4 | 6 (0 impossible — assertUnicastHost returned a literal)
        connectOptions.lookup = (
          _hostname: string,
          options: { all?: boolean },
          cb: (
            err: Error | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void,
        ): void => {
          if (options?.all) cb(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        };
      }

      const wsMod = await import('ws').catch(() => {
        throw new Error(
          "The 'ws' package is required for the Node WebSocket transport but is not installed. Install `ws`, or inject your own EventTransport. See the @manifest-network/manifest-mcp-core README.",
        );
      });
      if (userClosed) return;
      const WS =
        (wsMod as { WebSocket?: unknown; default?: unknown }).WebSocket ??
        (wsMod as { default?: unknown }).default;
      const socket = new (
        WS as new (
          u: string,
          protocols: undefined,
          options: Record<string, unknown>,
        ) => WsLike
      )(wsUrl.toString(), undefined, connectOptions);
      ws = socket;

      // Forward raw ws events. NOTE: a `ws` close only initiates the closing handshake, so a frame
      // buffered in the receive window can still arrive after the consumer calls close(); the DRIVER
      // guards against acting on a post-settle frame (runWsConnection's `settled` checks). We do NOT
      // suppress onClose here — a consumer that called close() still expects the close notification.
      socket.on('open', () => onOpen?.());
      socket.on('message', (data: unknown) => onMessage?.(frameToString(data)));
      socket.on('close', (code: number, reason: unknown) =>
        emitClose(code, frameToString(reason)),
      );
      socket.on('error', (err: Error) => onError?.(err));
    } catch (err) {
      // Guard rejection / ws-missing / bad URL — surface as an error + a synthetic close so the consumer
      // can fall back. 1006 = abnormal closure (no close frame), matching a failed connection.
      if (userClosed) return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
      emitClose(1006, err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    onMessage(listener) {
      onMessage = listener;
    },
    onOpen(listener) {
      onOpen = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
    onError(listener) {
      onError = listener;
    },
    close(code?: number) {
      userClosed = true;
      if (ws) {
        try {
          ws.close(code);
        } catch {
          ws.terminate();
        }
      } else {
        // Closed DURING the async connect setup, before the `ws` instance existed: the connect task will
        // early-return on `userClosed` and never wire the real close event, so emit a synthetic one here
        // — otherwise a consumer awaiting onClose after calling close() would hang. Idempotent via emitClose.
        emitClose(code ?? 1000, 'closed before connect');
      }
    },
  };
}

/** Normalize a `ws` frame (Buffer | ArrayBuffer | Buffer[] | string) to a UTF-8 string. */
function frameToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data))
    return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data && typeof (data as { toString?: unknown }).toString === 'function') {
    return (data as Buffer).toString('utf8');
  }
  return String(data);
}
