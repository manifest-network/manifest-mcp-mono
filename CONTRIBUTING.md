# Contributing

Thanks for your interest in contributing to Manifest MCP.

## Getting started

```bash
git clone <repo-url>
cd manifest-mcp-mono
git submodule update --init --recursive   # required for E2E tests
npm install
npm run build
```

Node.js 22.19+ (declared via `engines` on every package) and npm 10+ (ships with Node 22) are required. `nvm use` will pick up `.nvmrc`.

## Development workflow

1. Create a branch from `main` (e.g. `feat/<topic>` or `fix/<topic>`).
2. Make your changes. Co-locate `*.test.ts` files next to the source they cover.
3. Run the local checks before opening a PR:

```bash
npm run build          # Build all packages (tsdown)
npm run lint           # Type-check workspace packages (tsc --noEmit)
npm run lint:e2e       # Rebuild dependencies, then type-check the E2E suite
npm run test           # Unit tests (vitest)
npm run check          # Biome: format + lint + import sorting, including E2E TypeScript
npm run check:workflows # Immutable action references + policy regression tests
npm run check:dependency-hygiene # Validator resolution + E2E gate regression tests
npm run audit:dependencies      # Full dependency graph; high/critical findings fail
npm run check:fix      # Auto-fix anything Biome can fix
```

4. If your changes touch chain interactions, also run the E2E suite:

```bash
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

5. Open a pull request against `main`. CI runs the same checks.

## GitHub Actions updates

External actions and reusable workflows must use a full 40-character commit SHA
with an adjacent release-version comment, for example `# v7.0.1`. Local `./`
references are allowed; Docker actions must use an immutable `@sha256:` digest
and a version comment. `npm run check:workflows` parses every `.yml` and `.yaml`
workflow and tests the policy before CI or release validation builds the code.

Every workflow, including newly added files, must declare
`permissions: { contents: read }`. Non-release jobs inherit that default or
narrow it to `permissions: {}`; only the isolated publishing and GitHub Release
jobs in `release.yml` may grant their required write permissions. Every
`actions/checkout` step must set `persist-credentials: false`.

Local composite action metadata (`action.yml` / `action.yaml`) is not scanned;
review and pin its external `runs.steps` references manually.

Weekly GitHub Actions updates are already enabled in `.github/dependabot.yml`.
Review these PRs normally; do not auto-approve or auto-merge them. Check the
upstream release notes and verify the proposed SHA against the release tag in
the action's official repository, not a fork:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq '.object'
```

For an annotated tag (`type: tag`), follow its object through the repository's
`git/tags/<sha>` endpoint until the object is a commit. Compare that full commit
SHA with `uses:` and keep the release-version comment current. The offline
policy validates pin syntax and comments, not upstream provenance. GitHub
documents this approach in its [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
Required-review enforcement is a repository ruleset setting, not part of
Dependabot configuration.

## Dependency updates

`npm run audit:dependencies` checks the complete locked tree, including development,
optional, and peer dependencies. CI's `audit` job and release validation fail on high
or critical advisories; lower-severity findings stay visible. Registry failures also
fail the command. Root overrides must be rechecked against current advisories when
updating dependencies; a previously safe exact pin can become vulnerable.

Deploy-relevant changes (including the root lockfile) require a successful
`acceptance-single` run. `e2e-gate` fails when that run is skipped, including on
Dependabot and fork PRs that cannot access the private-submodule checkout secret.
A maintainer must carry the reviewed changes onto a same-repository, non-Dependabot
PR to obtain acceptance coverage. Docs-only changes can still pass without live E2E.

Configure `test`, `audit`, and `e2e-gate` as required status checks in the `main`
ruleset to enforce these results at merge time. Workflow definitions alone do not
make a check required.

The SDK build resolves publint and AreTheTypesWrong explicitly from its own config.
The browser tests reject ManifestJS's package-wide codegen barrel; use its narrower
namespace entries. See [dependency hygiene](docs/dependency-hygiene.md) for bundle
measurements and the limits on further narrowing.

## Commit and PR conventions

- **Commit messages**: short, imperative subject line; body explains the *why*. Conventional-commit-ish prefixes are common but not enforced (`feat`, `fix`, `chore`, `docs`, `test`, `refactor`).
- **PRs**: one focused change per PR. Update `CHANGELOG.md` (under `[Unreleased]`) for any user-facing change. Keep tests close to the code they cover; update them in the same PR.
- **Reviews**: a maintainer reviews; address feedback with new commits rather than amending unless requested.
- **Merging**: maintainers merge. Don't merge to `main` from your own branch.

## Code style

- **Formatter / linter / import sorter**: [Biome](https://biomejs.dev/). Run `npm run check:fix` before committing.
- **ESM-only**: every package is `"type": "module"`. Use `.js` extensions in relative imports (`'./client.js'`, not `'./client'`) — TypeScript's ESM rules require it.
- **No `any`**: prefer `unknown` + narrowing. There are a few targeted `any` casts (e.g. in `withErrorHandling` to preserve generic SDK signatures) — those carry inline `eslint-disable` comments and a justification.
- **Tests**: Vitest, co-located `*.test.ts`. Mocks live in `packages/core/src/__test-utils__/` and are imported cross-package by chain/lease/fred tests.
- **Comments**: keep them rare and load-bearing. Prefer expressive code over describing what the code does. Document *why* — invariants, constraints, surprising behaviour. Don't write "added for X feature" — that belongs in the commit message and rots over time.
- **Error handling**: throw `ManifestMCPError` with a `ManifestMCPErrorCode` from the enumeration. Use `INVALID_CONFIG` for static rule violations, `QUERY_FAILED` / `TX_FAILED` only for chain-side rejections. Surfacing the same logical issue with two different codes across two paths is a bug — see the v0.8.0 alignment work for an example.

## Project structure

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a detailed design overview. The short version:

- `packages/core` — shared library, no MCP server code here.
- `packages/{chain,lease,fred,cosmwasm,agent}` — one MCP server each.
- `packages/agent-core` — TypeScript orchestration library (consumed by `agent`).
- `packages/node` — CLI entry points + keyfile wallet, depends on core + the servers.
- `packages/sdk` — `@manifest-network/manifest-sdk`, the aggregating app-building SDK (composes core + fred + agent-core).

Dependency direction is **node → {chain, lease, fred, cosmwasm, agent} → core** and **agent → agent-core → {core, fred}**. Never reverse it. Core's static import graph stays browser-compatible (`platform: "neutral"`). Any Node.js-specific code in the `neutral` packages (e.g. the SSRF guarded-fetch in core/fred/agent-core, which uses undici + `node:dns`) must be isolated behind a dynamic `import()` and exposed only via a `node`-gated subpath export, never the package barrel; the `node` package is free to use Node.js APIs directly.

## Adding a new Cosmos SDK module

1. Implement the query handler in `packages/core/src/queries/<module>.ts` exporting `routeXxxQuery(queryClient, subcommand, args)`.
2. Implement the transaction handler in `packages/core/src/transactions/<module>.ts` exporting `routeXxxTransaction(client, senderAddress, subcommand, args, waitForConfirmation, options?, context?)` and a pure `buildXxxMessages(senderAddress, subcommand, args, context?)` for fee estimation.
3. Register both in the `QUERY_MODULES` / `TX_MODULES` maps in `packages/core/src/modules.ts` with a description and a `subcommands` list (the `args` strings power `list_module_subcommands`).
4. Add unit tests for both handlers next to the source.
5. Add an e2e test in `e2e/` that exercises the surface against a real chain, and run `npm run lint:e2e`. The repo's existing `chain-routing.e2e.test.ts` and `*-lifecycle.e2e.test.ts` files are good templates.
6. Update `README.md`'s supported-modules list and `packages/core/README.md`'s module table.

Once the module is registered, it's automatically reachable through `cosmos_query` / `cosmos_tx` and discoverable via `list_modules` / `list_module_subcommands`.

## Adding a new MCP tool, resource, or prompt

- **Tool**: pick the right server (chain / lease / fred / cosmwasm / agent). Register via `mcpServer.registerTool(name, { description, inputSchema, annotations, _meta }, handler)`. Required: pass `annotations` built via `readOnlyAnnotations()` or `mutatingAnnotations()`, and `_meta` built via `manifestMeta({ broadcasts, estimable })`. Wrap the handler in `withErrorHandling(toolName, fn)`. The annotation matrix is pinned by both the per-server `describe('tool annotations + _meta.manifest', ...)` blocks in each `server.test.ts` and the cross-server `e2e/tool-annotations.e2e.test.ts` — update both when adding or changing a tool.
- **Resource** (fred only today): `mcpServer.registerResource(name, uri, { title, description, mimeType }, handler)`. Acquire a rate-limit token before any chain read.
- **Prompt** (fred only today): `mcpServer.registerPrompt(name, { title, description, argsSchema? }, handler)`. The handler returns a single user-role message that walks the agent through the workflow.

For each, update the package README's tool/resource/prompt table and the relevant section of `docs/`.

## Releasing

Releases are handled by maintainers. The flow:

```bash
# Bump versions across the workspace + lockfile (also bumps packages/core/src/version.ts)
npm run release:version -- 0.9.0

# Commit, tag, push
git add -A
git commit -m "chore: release v0.9.0"
git tag v0.9.0
git push origin main --tags
```

Pushing a `vMAJOR.MINOR.PATCH` tag triggers `.github/workflows/release.yml`, which validates that the tag matches every `package.json`, runs the full check + test suite, then publishes all nine packages to npm with provenance via OIDC trusted publishing (no `NPM_TOKEN` secret needed). Publish order is `core → chain → lease → fred → cosmwasm → agent-core → agent → node → sdk`; `.github/workflows/release.yml` is the authoritative list.

Validation runs with read-only repository access. The separate npm publishing
job runs only after validation, checks out the same tag commit, and repeats the
locked install and build with `contents: read` and `id-token: write`. Repository
write access is restricted to a final GitHub Release job, which has no checkout
or OIDC permission. That job creates a GitHub Release with auto-generated notes;
creation remains best-effort — publish succeeds even if Release creation fails.

The release body is auto-generated from merged PRs via `gh release create --generate-notes` — the workflow does not read `CHANGELOG.md`. Keep the `[Unreleased]` section of `CHANGELOG.md` current anyway: it is the human-authored changelog of record.

## Reporting issues

Open issues at <https://github.com/manifest-network/manifest-mcp-mono/issues>. Use the bug-report and feature-request templates in `.github/ISSUE_TEMPLATE/`. **Security issues**: do not file publicly — follow the disclosure process in [`SECURITY.md`](SECURITY.md). The threat-model and what's redacted in logs/responses is described in [`docs/security.md`](docs/security.md).
