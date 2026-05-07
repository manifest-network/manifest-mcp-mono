# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@liftedinit.org** with:

- A description of the issue and its impact.
- The package(s) and version(s) affected (run `npm ls @manifest-network/manifest-mcp-core` etc.).
- Reproduction steps, proof-of-concept, or a patch — whatever is shortest to convey the bug.
- Any environmental details that matter (chain ID, wallet type, host OS).

You should expect an acknowledgement within **3 business days** and a substantive response within **10 business days**. Encrypted email is welcome but not required; if you'd like a PGP key, ask in the first message.

## Scope

In scope:

- The six published npm packages under `@manifest-network/manifest-mcp-*` and the `manifest-mcp-mono` repository.
- The four CLI binaries (`manifest-mcp-chain`, `manifest-mcp-lease`, `manifest-mcp-fred`, `manifest-mcp-cosmwasm`).
- Library entry points consumed by downstream apps such as Barney.

Out of scope (please report to the appropriate project):

- The Manifest chain itself (`manifest-network/manifest-ledger`).
- The Fred container backend (`manifest-network/fred`).
- Third-party MCP hosts (Claude Desktop, Cursor, etc.).
- Wallets we depend on (cosmos-kit, Keplr, Leap, Web3Auth).

## What we consider a vulnerability

Issues we will treat as security-significant:

- Anything that can leak the wallet's mnemonic, private key, keyfile contents, or `MANIFEST_KEY_PASSWORD` to a log file, an MCP response, a network call, or another process.
- Bypasses of the HTTPS / localhost-only endpoint validation (`validateEndpointUrl` / `validateProviderUrl`) — i.e. a way to make an MCP server fetch from an arbitrary host.
- Auth-token issuance flaws that let one party act as another against a Fred provider.
- Confused-deputy patterns where an agent input causes the server to broadcast a transaction the user did not authorise.
- Hard-to-detect tampering with the install (e.g. a malicious dependency that replaces a package post-publish).

Issues we treat as ordinary bugs (file as a public issue):

- Crashes that don't leak data and don't enable forged actions.
- Misleading error messages.
- Schema/validation gaps that fail loudly rather than silently.

## What's already in place

The current threat-model and the redaction surface are documented in [`docs/security.md`](docs/security.md). In short:

- All endpoint URLs are HTTPS-or-localhost; HTTP to non-localhost is rejected at config time.
- Output sanitization redacts a configured set of sensitive field names, plus BIP-39-shaped strings, in both error responses and stderr logs. When a message is redacted, the corresponding stack trace is suppressed entirely.
- Wallets are held in-memory only. The bootstrap doesn't currently call `disconnect()`, so mnemonics are cleared when the process exits (with the JS-string immutability caveat — references are dropped, but JS strings can't be zeroed deterministically). Both wallet providers expose `disconnect()` if a library consumer wants to clear earlier.
- ADR-036 tokens are constructed client-side, scoped to `(tenant, leaseUuid, timestamp)`, and the provider enforces a 30 s max age plus per-signature replay detection.

## Disclosure timeline

We aim for **coordinated disclosure**:

1. You report the issue privately.
2. We confirm and reproduce.
3. We agree on a fix and an embargo window with you (usually 14–30 days, longer for issues that require an upstream chain or provider change).
4. We publish a patched release and a GitHub Security Advisory crediting you (unless you prefer to remain anonymous).

If a public exploit emerges before we can ship a fix, we'll publish what we have and credit the discovery as appropriate.

## Receipts and credit

Reporters who follow this policy will be acknowledged in the GitHub Security Advisory and the release notes for the patched version. Let us know how you'd like to be credited (full name, handle, employer, anonymous, etc.) when you make the report.
