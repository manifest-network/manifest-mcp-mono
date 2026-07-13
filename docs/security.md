# Security model

This page describes the trust boundaries and assumptions that the Manifest MCP servers operate under, what the wallet sees and signs, what's redacted from outbound payloads, and the boundary between the agent and the human operator.

## Trust boundaries

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Human operator                          │  Owns the password and approves destructive actions
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ types/clicks
┌─────────────────────────────────▼────────────────────────────────────┐
│                MCP host (Claude Desktop, Cursor, …)                  │  Renders prompts, gates broadcasts, surfaces tool results
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ stdio JSON-RPC, full tool surface
┌─────────────────────────────────▼────────────────────────────────────┐
│         Manifest MCP server process (chain/lease/fred/cw/agent)      │  Holds the wallet in memory, builds + signs txs, validates input
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ HTTPS to chain endpoints / providers
┌─────────────────────────────────▼────────────────────────────────────┐
│                      Chain RPC/REST + Fred provider                  │  Independently verifies signatures and authorisations
└──────────────────────────────────────────────────────────────────────┘
```

The MCP server process is **inside** the human's trust boundary — it holds the wallet and can broadcast on behalf of the user. The agent (LLM) is **outside** that boundary: it can request actions but cannot be relied on to refuse destructive ones. The `manifest-agent` plugin and the host UI are the gates that enforce confirmation before broadcast.

## Wallet handling

Wallets resolve in this order:
1. Keyfile at `MANIFEST_KEY_FILE` (default `~/.manifest/key.json`) — encrypted, or a plaintext mnemonic (loaded with a startup warning). The `keygen` and `import` subcommands write the file with mode `0600`.
2. `COSMOS_MNEMONIC` env var (only used when no keyfile exists).
3. Fatal exit.

The mnemonic and decrypted private key are held in memory for the lifetime of the server process. The `WalletProvider` interface declares an optional `disconnect()` method and both providers implement it (it nulls the mnemonic/wallet refs and locks the instance against reconnection), but the bootstrap doesn't invoke it — there's no MCP tool, CLI subcommand, or signal handler that calls `disconnect()` during normal operation, so in practice references are dropped on process exit. Library consumers embedding the providers can call `disconnect()` themselves to clear earlier. JavaScript strings are immutable, so the cleared references rely on garbage collection regardless — there's no zeroing of the underlying memory.

Both wallet providers maintain **two derived wallets** from the same seed:
- A `DirectSecp256k1HdWallet` for proto signing (transactions).
- A `Secp256k1HdWallet` for amino signing (ADR-036 auth tokens).

This is purely an SDK-shape constraint — the underlying key material is the same.

## What gets signed

A typical broadcast looks like:

```
agent -> server: cosmos_tx({ module, subcommand, args })
server: route to per-module msgBuilder + handler
server: simulate (gas estimate)
server: build SignDoc with chainId, accountNumber, sequence, gas, fee, msgs, memo
server: sign locally (offline signer, wallet never leaves the process)
server -> chain: broadcast bytes
```

The server **never** sends the raw mnemonic or private key to the chain or to a provider. The signed bytes that go on the wire are deterministic from the SignDoc.

For ADR-036 (provider auth), the server signs a deterministic message:

```
"<tenant>:<leaseUuid>:<unixTimestamp>"            // generic API calls
"manifest lease data <leaseUuid> <metaHashHex> <unixTimestamp>"   // lease-data uploads
```

The signature, public key, and metadata are base64-encoded into a `Bearer` token (no auth-endpoint round-trip). The provider enforces:
- 30 s max token age.
- 10 s max-future-skew.
- Per-signature replay detection on protected endpoints.

`AuthTimestampTracker` in `packages/fred/src/http/auth.ts` ensures two consecutive calls never share a timestamp, which is what would otherwise let the provider reject the second call as a replay.

> **Known scope limitation.** The current sign-message format binds a token to `(tenant, leaseUuid, timestamp)` but **not** to a specific HTTP operation. If the provider's replay tracker is per-endpoint rather than global, a token issued for a read endpoint could in principle be replayed against a mutating endpoint within the 30-second window. Tightening this requires a coordinated server change to add an operation scope; doing it unilaterally on the client breaks every auth call. There's an in-source security note flagging this in `auth.ts` and a regression test pinning the wire format.

## SSRF protections

Two complementary layers protect against server-side request forgery: URL validation at the boundary, and a runtime IP-level guard on the actual connection. Neither alone is sufficient — the string check can't see where a *hostname* resolves (and, in a browser, no connect guard is available), while the connect guard can't reject a plain-HTTP downgrade and is Node-only — so both run.

### 1. Endpoint-URL validation (boundary check)

The two validators enforce **different** rules, matched to their trust level:

- **`validateEndpointUrl`** in `packages/core/src/config.ts` covers **operator-supplied** env endpoints: `COSMOS_RPC_URL` and `COSMOS_REST_URL` (validated inside `createValidatedConfig`), and `MANIFEST_FAUCET_URL` (validated in `packages/node/src/chain.ts` before the chain server starts). These are operator-trusted, so it is a **scheme check only** — HTTPS always allowed, HTTP only for `localhost` / `127.0.0.1` / `::1` / `[::1]`, anything else rejected. The failure outcomes differ but both prevent boot: an invalid `COSMOS_RPC_URL`/`COSMOS_REST_URL` throws `ManifestMCPError(INVALID_CONFIG)`, while an invalid `MANIFEST_FAUCET_URL` logs to stderr and calls `process.exit(1)`.
- **`validateProviderUrl`** in `packages/fred/src/http/provider.ts` covers **untrusted** provider API URLs returned from chain queries (the `apiUrl` on a `Provider` row, or whatever a lease's `providerUuid` resolves to). Because a malicious provider controls this value, it does the scheme check **plus SSRF IP classification** (ENG-490), delegating to the pure predicate `isUrlSsrfSafe`, and strips trailing slashes. Failures throw `ProviderApiError`.

`isUrlSsrfSafe(url, opts?)` (pure, protocol-agnostic — it also covers the provider **WebSocket** URL, `wss://…`; exported on the fred barrel and `@manifest-network/manifest-sdk/deploy`) classifies the WHATWG-parsed host:

- A **literal IP** is default-denied unless its `ipaddr.js` range is `'unicast'` — so loopback, RFC 1918 private, link-local / cloud-metadata (`169.254.169.254`), CGNAT, and reserved ranges are all rejected, **including over HTTPS**. Obfuscated encodings (decimal `2130706433`, hex `0x7f000001`, octal, short-form, IPv4-mapped IPv6) are caught because `new URL()` normalizes them to canonical form before classification, and userinfo (`https://169.254.169.254@evil.com/`) is a non-issue — the classified host is the real connect target (`evil.com`).
- **Loopback** (`localhost` / `127.0.0.1` / `::1`) is default-denied. The fred MCP server re-allows it **only** when its fetch guard is disabled (`MANIFEST_FRED_FETCH_GUARDED=0`), by threading `ctx.allowLoopback = !guarded` into the validation — so both SSRF layers share one switch. This `allowLoopback` opt-in is narrow: it never re-allows RFC 1918 or metadata. Library and browser consumers get the strict default (no relaxation).
- A **DNS hostname** classifies as safe (**fails open**) — the string layer cannot resolve it without `node:dns`, and *resolve-then-validate* is the TOCTOU anti-pattern that DNS-rebinding defeats. This is deliberate defense-in-depth: on Node the connect guard (layer 2) does the authoritative post-resolution check; in a browser, the platform's Private Network Access / CORS backstops it. So the string layer's job is to block the literal-IP case (the realistic attack from an on-chain `apiUrl`), not to be rebinding-proof.

This runs **before** any HTTP call, so a chain row with a hostile `apiUrl` — literal private/metadata IP, obfuscated or not, over HTTP or HTTPS — never produces a request. What layer 1 cannot stop by itself is a *hostname* that DNS-resolves to an internal IP; that is what the second layer handles.

### 2. Runtime IP-level fetch guard (`createGuardedFetch`)

All provider/Fred HTTP is routed through an SSRF-guarded `fetch` — `createGuardedFetch` in `packages/core/src/internals/guarded-fetch.ts`, a native `undici` Dispatcher. It:

- **Resolves the target host inside the connect hook** and substitutes the resolved IP as the connect address, so it inspects the *actual* IP the request reaches and closes the DNS-rebinding / TOCTOU window a hostname-only check leaves open. The hook re-fires on every cross-origin redirect, so a redirect to an internal host is caught too.
- **Default-denies** any address whose `ipaddr.js` `range()` is not `'unicast'` — loopback, link-local, private (RFC 1918), carrier-grade NAT, reserved / benchmarking (`198.18.0.0/15`), and any unrecognised label all block. It is an allow-list of exactly one category (`'unicast'`), so a range the table doesn't know about fails **closed** rather than falling through as allowed. The classifier itself (`isBlocked` + `BLOCKED_RANGES_*`) lives in the pure, `ipaddr.js`-only `packages/core/src/internals/ssrf-classify.ts` (ENG-490), shared by *both* SSRF layers — layer 1's `isUrlSsrfSafe` imports it browser-safely.
- Is gated per server and **on by default**: `MANIFEST_FRED_FETCH_GUARDED` (fred) and `MANIFEST_AGENT_FETCH_GUARDED` (agent). Both accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (case-insensitive); an unrecognised value throws `INVALID_CONFIG`. `fred`'s `FredMCPServer` constructor injects the guarded fetch via `server/fetch-gate.ts`.

Provider URLs come from on-chain SKU/provider records, so this guard is what stops a malicious provider whose `apiUrl` is a *hostname* that DNS-resolves to an internal host — the case layer 1's string check cannot see — even over HTTPS. (A literal internal IP is already rejected at layer 1.)

`ipaddr.js` is force-pinned to `2.4.0` tree-wide (root `package.json` `overrides`): an older copy (e.g. `1.9.1`, pulled transitively by `proxy-addr`) carries a stale RFC table that misclassifies reserved ranges as `'unicast'` and would silently weaken the guard.

The guard ships from a **Node-only** subpath — `@manifest-network/manifest-mcp-core/guarded-fetch` (and, mirrored, `@manifest-network/manifest-agent-core/guarded-fetch`) — deliberately kept off the package barrel so browser bundles of `core` don't drag in `undici` / `node:async_hooks`. Import it from that subpath, never the barrel. The *pure* classifier (no `undici`) is exposed separately on the **universal** `@manifest-network/manifest-mcp-core/ssrf` subpath (also off the barrel, to keep that low-level primitive out of the public surface), which is what fred's browser-safe `isUrlSsrfSafe` imports.

## Input validation

The MCP server parses input through Zod schemas (registered alongside each tool) before it reaches a handler. Then `validation.ts` helpers (`requireString`, `requireUuid`, `requireStringEnum`, `parseArgs`, `optionalBoolean`, …) check semantic shape before the handler builds chain messages. A static-shape violation from these helpers surfaces as `QUERY_FAILED` (query tools) or `TX_FAILED` (tx tools) — the helpers default to `QUERY_FAILED` and take an explicit error-code argument that tx handlers pass as `TX_FAILED` — with `INVALID_ADDRESS` for a wrong bech32 prefix. `INVALID_CONFIG` is reserved for server/config validation (`createValidatedConfig`) plus structural tool-boundary checks (e.g. mutually-exclusive `fee`/`gasMultiplier` overrides), not routine input shape.

Address validation enforces the configured bech32 prefix (default `manifest`). Cross-prefix addresses (`cosmos1…` against a `manifest`-prefix server) raise `INVALID_ADDRESS` before any chain round-trip.

## Output redaction

Errors returned to the MCP client and lines written to stderr are run through `sanitizeForLogging`:

- A configurable set of sensitive field names (`mnemonic`, `password`, `secret`, `privateKey`, `apikey`, `auth_token`, …) is redacted as `[REDACTED]` regardless of where they appear in nested objects/arrays.
- Strings that look like BIP-39 mnemonics (12/15/18/21/24 lowercase-alpha words) are redacted as `[REDACTED - possible mnemonic]`. The whitespace tolerance is intentional — it catches mnemonics inside error messages.
- When an error message gets redacted, the **stack trace is suppressed entirely** (rather than emitting a half-sanitised trace). Stack traces typically embed the original error message verbatim, which would re-leak the redacted string.

The bare keys `key` and `token` are **not** in the sensitive field list (they would match pagination keys, tokenfactory denoms, and other non-sensitive values). Use compound names (`api_key`, `auth_token`, …) when introducing new fields.

## What the agent should not be trusted with

Treat these as policy, not technical guarantees:

- The agent should never run a tool with `_meta.manifest.broadcasts: true` without explicit user confirmation.
- The agent should never run a tool with `annotations.destructiveHint: true` (e.g. `close_lease`) without confirmation.
- The host should treat tool-arg sanitisation as defence-in-depth — an agent can craft inputs the user would never type. The Zod schemas + `validation.ts` checks + chain-side validation are all expected to converge.

The MCP `annotations` and `_meta.manifest` flags are advisory. The security boundary is the `manifest-agent` plugin's `PreToolUse` hook regex (or whatever equivalent gating the host enforces).

## Reporting issues

Security issues should not be filed as public GitHub issues. See [`SECURITY.md`](../SECURITY.md) for the disclosure process and reporting address.
