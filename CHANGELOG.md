# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Feat(fred): add `check_deployment_readiness` MCP tool — a single-call pre-flight that returns wallet balances, credit account status, SKU availability, and a human-readable `missing_steps` list before `deploy_app`. Lets agents decide whether to fund credits, switch SKU, or top up the wallet without making three separate queries. Provider `allowed_registries` is operator config and not exposed via chain or public API, so `ready: true` does not guarantee `image`'s registry is allowed; the upload step is the runtime gate (ENG-84).
- Feat(fred): `deploy_app` and `wait_for_app_ready` now emit `notifications/progress` when the client passes a `progressToken` (or sets `onprogress` via the SDK). Progress messages cover the lease-created milestone and each provider poll iteration with the current `LeaseState` and `provision_status`. Both tools also forward the request's `AbortSignal` so a cancelled MCP request stops the upload/poll cleanly. No-op when the client doesn't request progress (ENG-84).
- Feat(fred): add `build_manifest_preview` MCP tool that builds, validates, and SHA-256-hashes a deployment manifest without touching the chain or any provider. Accepts a raw JSON `manifest` string OR structured fields mirroring `deploy_app` (image+port, or services). Returns the canonical `manifest_json`, the `meta_hash_hex` that would be recorded on-chain, and an inline `validation` result enumerating any rule violations (env-name blocklist, `fred.*` label prefix, port format, tmpfs limits, RFC 1123 service names, depends_on placement, unknown fields). Use this before `deploy_app` to reject obviously-broken manifests without paying for a lease (ENG-84).
- Feat(fred): export `metaHashHex`, `validateManifest`, and `ManifestValidationResult`/`ManifestFormat` from the package. The same `metaHashHex` helper now backs `deploy_app`'s on-chain meta-hash so a preview's hash is structurally guaranteed to match the eventual lease's `meta_hash` (ENG-84).
- Feat(fred): add `wait_for_app_ready` MCP tool that wraps `pollLeaseUntilReady` so agents can wait on a lease reaching `LEASE_STATE_ACTIVE` without re-implementing the polling loop. Accepts `timeout_seconds` (1–600) and `interval_seconds` (1–60); declares an `outputSchema` with `lease_uuid`, `provider_uuid`, `provider_url`, `state`, and the raw provider `status` payload (ENG-84).
- Feat(core): add `structuredResponse` helper alongside `jsonResponse` for tools that declare an `outputSchema`. Returns both `structuredContent` (the typed payload) and a JSON `text` fallback so older clients keep working (ENG-84).
- Feat(core): add Proof-of-Authority (`poa`), tokenfactory, and IBC transfer (`ibc-transfer`) modules with query and transaction routing through `cosmos_query`/`cosmos_tx`/`cosmos_estimate_fee`. Tokenfactory `update-params` is intentionally not exposed pending an upstream `manifestjs` codegen fix (`MsgUpdateParams.params` is wired to `cosmos.bank.v1beta1.Params` instead of the local tokenfactory `Params`).
- Fix(core): validate `poa create-validator` JSON input with a strict zod schema; reject unknown keys, validate validator address valoper prefix, and base64-decode the `pubkey.value` so `Any.encode` produces correct wire bytes.
- Fix(core): require non-empty `source-port` and `source-channel` on `ibc-transfer transfer` instead of forwarding blank strings to the chain.

## [0.6.2]

- Fix(core): surface dropped proto fields in query handlers and `getBalance` (#41)

## [0.6.1]

- Feat(fred): add `checkChainState`, `onLeaseCreated`, `abortSignal`, and `pollOptions` hooks to `deployApp` and `pollLeaseUntilReady`; introduce `TerminalChainStateError` for chain-reported terminal lease states (#40)

## [0.6.0]

- Feat(lease): `fund_credit`, `credit_balance`, and `leases_by_tenant` accept optional `tenant` to operate on a third-party account (#38)
- Feat(lease): support optional `tenant` on more methods (#39)
- Chore(deps): bump `@manifest-network/manifestjs` to 2.3.0

## [0.5.0]

- Feat(chain): add `cosmos_estimate_fee` MCP tool (#35)

## [0.4.7]

- Fix(core): re-encode wasm LCD response data for fromJSON compatibility (#34)

## [0.4.6]

- Fix(core): base64-encode wasm `queryData` in LCD adapter (#33)

## [0.4.5]

- Fix(ci): re-release v0.4.4 which failed to publish all packages due to npm registry propagation delay

## [0.4.4]

- Fix(ci): pin npm to 11.5.1 for OIDC trusted publishing (10.9.2 was too old, lacked OIDC auth support)

## [0.4.3]

- Fix(ci): use `npx npm@10.9.2` to bootstrap npm upgrade, bypassing broken bundled npm on GitHub Actions runners

## [0.4.2]

- Fix(ci): use `--ignore-scripts` for npm self-upgrade in release workflow (insufficient — see 0.4.3)

## [0.4.1]

- Docs: add cosmwasm package across all documentation, fix stale tool/server/CLI counts, add missing env vars
- Fix(ci): add cosmwasm package to npm publish list in release workflow
- Fix(ci): update setup instructions from NPM_TOKEN to OIDC trusted publishing
- Fix(ci): remove npm self-upgrade step from release workflow (broke OIDC publishing — see 0.4.2)

## [0.4.0]

- Feat(cosmwasm): add new `packages/cosmwasm` MCP server with `get_mfx_to_pwr_rate` and `convert_mfx_to_pwr` tools for the on-chain MFX-to-PWR converter contract
- Feat(core): add CosmWasm query and transaction routing to the module registry
- Feat(core): per-transaction `gas_multiplier` override on `cosmos_tx`, allowing callers to adjust gas simulation per call
- Feat(node): add `manifest-mcp-cosmwasm` CLI entry point

## [0.3.5]

- Feat(core): configurable gas multiplier via `COSMOS_GAS_MULTIPLIER` env var (default `1.5`, must be >= 1)
- Fix(core): support factory and IBC denoms in gas price validation (e.g. `factory/manifest1.../umfx`, `ibc/...`)

## [0.3.4]

- Fix(chain): handle plain-text faucet `/credit` responses from CosmJS faucet (was crashing on `res.json()`)
- **Breaking**: remove `transactionHash` from `FaucetDripResult` (the CosmJS faucet never returns one)
- Test(chain): add faucet tests for all faucet HTTP status codes (200, 400, 405, 422, 500)

## [0.3.3]

- Fix(chain): align `FaucetStatusResponse` with real faucet API (`availableTokens` string[] instead of `tokens` Coin[])
- Fix(chain): handle plain-text `/credit` responses from CosmJS faucet (was crashing on `res.json()`)
- Fix(chain): validate full faucet `/status` response shape with zod
- Refactor(chain): consolidate faucet types (`FaucetHolder`/`FaucetDistributor` -> `FaucetAccount`)
- **Breaking**: remove `transactionHash` from `FaucetDripResult` (the CosmJS faucet never returns one)
- Test(chain): add faucet tests for all faucet HTTP status codes (200, 400, 405, 422, 500)

## [0.3.2]

- Fix(core): bump gas simulation multiplier to 1.5 to match CLI `--gas-adjustment`
- Fix(fred): add `AuthTimestampTracker` to guarantee unique auth token timestamps, preventing replay rejection on protected endpoints
- Fix(fred): send JSON with base64-encoded payload in `updateLease` instead of raw octet-stream
- Fix(fred): generate separate auth tokens for status and connection requests in `appStatus`
- Fix(e2e): use unprivileged nginx image, discover SKU denom dynamically, disable file parallelism

## [0.3.1]

- Fix: re-export faucet functions and types (`requestFaucet`, `requestFaucetCredit`, `fetchFaucetStatus`) from chain package entry

## [0.3.0]

- Feat: add `request_faucet` tool for chain server (enabled when `MANIFEST_FAUCET_URL` is set)
- Docs: fix inaccuracies and fill gaps across all documentation

## [0.2.3]

- Fix: include `--ignore-scripts` in lockfile sync recovery instructions
- Fix: make GitHub Release step idempotent on workflow re-runs

## [0.2.2]

- Fix: improve README accuracy and validate workspace package names
- Fix: add `--ignore-scripts` to lockfile sync, use `fileURLToPath` for Node 20.0 compatibility
- Docs: clarify GitHub Release creation is best-effort

## [0.2.1]

- Fix: set vitest root so E2E global setup and tests resolve correctly
- Fix: validate all workspace versions match tag, improve error message
- Feat: add tag-triggered npm release workflow and version script

## [0.2.0]

Initial public release.

- Three MCP servers: chain (5 tools), lease (6 tools), fred (8 tools)
- LCD/REST query-only mode for browser consumers
- ADR-036 provider authentication
- Encrypted keyfile wallet with `keygen` and `import` CLI subcommands
- Multi-service stack deployment support
- E2E test infrastructure with Docker Compose
- Biome for formatting, linting, and import sorting
- Tag-triggered npm publish workflow with provenance
