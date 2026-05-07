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
│         Manifest MCP server process (chain / lease / fred / cw)      │  Holds the wallet in memory, builds + signs txs, validates input
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ HTTPS to chain endpoints / providers
┌─────────────────────────────────▼────────────────────────────────────┐
│                      Chain RPC/REST + Fred provider                  │  Independently verifies signatures and authorisations
└──────────────────────────────────────────────────────────────────────┘
```

The MCP server process is **inside** the human's trust boundary — it holds the wallet and can broadcast on behalf of the user. The agent (LLM) is **outside** that boundary: it can request actions but cannot be relied on to refuse destructive ones. The `manifest-agent` plugin and the host UI are the gates that enforce confirmation before broadcast.

## Wallet handling

Wallets resolve in this order:
1. Encrypted keyfile at `MANIFEST_KEY_FILE` (default `~/.manifest/key.json`). The `keygen` and `import` subcommands write the file with mode `0600`.
2. `COSMOS_MNEMONIC` env var (only used when no keyfile exists).
3. Fatal exit.

The mnemonic and decrypted private key are held in memory for the lifetime of the server process. There is no equivalent of `disconnect()` exposed externally; the keyfile/mnemonic provider clears its references when the process exits. JavaScript strings are immutable, so the cleared references rely on garbage collection — there's no zeroing of the underlying memory.

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

## Endpoint-URL validation

Every URL passed via env (`COSMOS_RPC_URL`, `COSMOS_REST_URL`, `MANIFEST_FAUCET_URL`, provider URLs returned by the chain) is run through `validateEndpointUrl` from core. The rule is:

- HTTPS is always allowed.
- HTTP is allowed only for `localhost` / `127.0.0.1` / `::1` / `[::1]`.
- Anything else is rejected with `INVALID_CONFIG`.

This is the SSRF guard. It runs **before** any HTTP call, so a misconfigured config never produces a request to a non-HTTPS arbitrary host.

## Input validation

The MCP server parses input through Zod schemas (registered alongside each tool) before it reaches a handler. Then `validation.ts` helpers (`requireString`, `requireUuid`, `requireStringEnum`, `parseArgs`, `optionalBoolean`, …) check semantic shape before the handler builds chain messages. A static rule violation is `INVALID_CONFIG`; a chain-side rejection is `QUERY_FAILED` / `TX_FAILED`.

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
