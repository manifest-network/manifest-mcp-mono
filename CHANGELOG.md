# Changelog

All notable changes to this project will be documented in this file.

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
