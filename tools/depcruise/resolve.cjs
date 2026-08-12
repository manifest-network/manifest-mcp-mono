/**
 * Resolver alias map: first-party package-name imports -> that package's `src` (ENG-641).
 *
 * WHY A WEBPACK-SHAPED FILE IN A REPO WITH NO WEBPACK: `options.webpackConfig` is dependency-
 * cruiser's ONLY schema-legal hook for handing enhanced-resolve an `alias` map — its config schema
 * declares `enhancedResolveOptions` with `additionalProperties: false` and no `alias` key, so
 * putting the map there makes the whole config fail validation. depcruise imports this file and
 * takes its `resolve` block verbatim (src/config-utl/extract-webpack-resolve-config.mjs).
 *
 * WHY IT IS LOAD-BEARING: without it, a cross-package import written the way everyone actually
 * writes it — by package name — is INVISIBLE to the cruiser, and the two DAG rules that encode the
 * repo's central invariant cannot fire. Two independent reasons, both fixed here:
 *   1. `@manifest-network/manifest-mcp-fred` resolves through the workspace symlink to
 *      `packages/fred/dist/index.js`, which `exclude` DROPS from the graph (see the `exclude`
 *      comment in `.dependency-cruiser.cjs`) — taking the edge with it. Nothing else could match:
 *      there is not one relative cross-package import (`../../fred/src/x.js`) in the repo.
 *   2. Every SUBPATH import (`…/ssrf`, `…/gas`, `…/node`, `…/guarded-fetch`, `…/__test-utils__/*`)
 *      failed to resolve at all: depcruise hard-defaults `exportsFields: []` (a deliberate
 *      enhanced-resolve 4 back-compat choice, its normalize.mjs), so `exports` maps are ignored —
 *      and every package here publishes only through `exports`, pointing at `dist/`.
 *
 * Aliasing to `src` also makes the guard BUILD-INDEPENDENT. Matching against `dist` would work only
 * on a built tree, so `npm run depcruise` on a fresh checkout would go silently green again — the
 * exact failure mode ENG-641 exists to kill.
 *
 * The map is COMPUTED from the workspace, not written out: a newly added package is covered the
 * moment it exists, so the alias can never silently drift out of date the way a hand-maintained
 * list would.
 */
const { existsSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');

/** @type {Record<string, string>} */
const alias = {};

for (const base of ['packages', 'examples']) {
  for (const entry of readdirSync(join(ROOT, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(ROOT, base, entry.name, 'package.json');
    const src = join(ROOT, base, entry.name, 'src');
    // A workspace member without a package.json or without a `src/` has nothing to alias.
    if (!existsSync(manifest) || !existsSync(src)) continue;
    alias[require(manifest).name] = src;
  }
}

module.exports = { resolve: { alias } };
