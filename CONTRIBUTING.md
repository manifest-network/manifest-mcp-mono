# Contributing

Thanks for your interest in contributing to Manifest MCP.

## Getting started

```bash
git clone <repo-url>
cd manifest-mcp-mono
npm install
npm run build
```

## Development workflow

1. Create a branch from `main`
2. Make your changes
3. Run checks before committing:

```bash
npm run build          # Build all packages
npm run lint           # Type-check (tsc --noEmit)
npm run test           # Unit tests (vitest)
npm run check          # Biome: formatting, linting, import sorting
```

4. If your changes affect chain interactions, run E2E tests:

```bash
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

5. Open a pull request against `main`

## Code style

- **Formatter/linter**: [Biome](https://biomejs.dev/) -- run `npm run check:fix` to auto-fix
- **ESM-only**: use `.js` extensions in imports (e.g., `'./client.js'`)
- **Tests**: co-located `*.test.ts` files next to the source they test

## Project structure

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for a detailed design overview.

Dependency direction: **node -> {chain, lease, fred, cosmwasm} -> core** (never reverse).

## Adding a new Cosmos SDK module

1. Create a query handler in `packages/core/src/queries/<module>.ts`
2. Create a transaction handler in `packages/core/src/transactions/<module>.ts`
3. Register both in the `QUERY_MODULES` / `TX_MODULES` maps in `packages/core/src/modules.ts`
4. Add tests for the new handlers

## Releasing

Releases are handled by maintainers. See the [Releasing section](README.md#releasing) in the README.
