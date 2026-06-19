/**
 * dependency-cruiser boundary + DAG guard for the manifest-mcp-mono SDK spine (ENG-309).
 *
 * Encodes the spec §8 / §13 machine-checkable invariants:
 *   - the package DAG direction (core never reaches up into fred/agent-core; fred never into agent-core);
 *   - the manifestjs generated-TYPE-path chokepoint (spec §5.1 / §8 line 273): downstream packages must
 *     consume the canonical Manifest/Fred DTO types via `core`'s re-exports, never reach into the
 *     `@manifest-network/manifestjs/dist/codegen/.../types.js` generated paths directly;
 *   - no STATIC `node:`/`undici`/`ws` import in a browser-safe `src` barrel (a runtime-gated dynamic
 *     `import('node:fs')` is browser-safe and ALLOWED — only the static top-level edge fails the browser
 *     build, the load-bearing ENG-281/287 invariant a Node-run vitest cannot catch).
 *
 * The brand-cast-only-in-`brands.ts` + no-`parse*`-in-`lcd-adapter.ts` guards (spec §8) are NOT
 * expressible as import-edge rules (a type assertion produces no import edge) — they ship as a
 * grep/biome meta-test (packages/sdk/scripts/cast-guard.test.ts). The known-bad fixtures that PROVE
 * these rules bite live in tools/depcruise-fixtures/ (cruised explicitly by the fixtures step, not
 * compiled into any package).
 *
 * `tsPreCompilationDeps: true` (spec B3) makes the `import type` edges visible so the chokepoint rule
 * sees a type-only `import type { Lease } from '…/types.js'`. We cruise first-party SOURCE: `exclude`
 * drops ONLY workspace build output (`^packages/<pkg>/dist/`) — crucially NOT node_modules codegen
 * `dist/`, which must stay a matchable `to` target for the chokepoint — and `doNotFollow:node_modules`
 * keeps deps from being crawled (matchable-but-not-followed). The chokepoint positive-control in
 * cast-guard.test.ts cruises THIS production config (not a clone) to prove the rule actually bites.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    // DAG direction: core is the sink; it must never reach up into fred/agent-core.
    {
      name: 'no-core-to-fred-or-agentcore',
      comment: 'core is the dependency sink — it must not import from fred or agent-core (DAG; spec §13).',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(fred|agent-core)/src' },
    },
    // DAG direction: fred must never reach up into agent-core (agent-core -> fred, never reverse).
    {
      name: 'no-fred-to-agentcore',
      comment: 'fred must not import from agent-core (DAG: agent-core -> fred -> core; spec §13).',
      severity: 'error',
      from: { path: '^packages/fred/src' },
      to: { path: '^packages/agent-core/src' },
    },
    // manifestjs generated-TYPE-path chokepoint (spec §5.1 / §8 line 273).
    // Scope to the GENERATED TYPE paths only — legit codec/value imports of manifestjs elsewhere
    // (message composers, registries) are allowed; only the `…/codegen/.../types.js` shape DTOs route
    // through `core`. The chokepoint is `core/src/manifest-types.ts`. The other `core/src` importers
    // are the GRANDFATHERED baseline that predates the SDK chokepoint and is a NAMED deferral, NOT a
    // §8 violation (spec line 273): the `core/src/index.ts` `LeaseState`/`leaseStateFromJSON`/
    // `leaseStateToJSON` VALUE re-export is a runtime enum (not a type path); `core/src/types.ts` is
    // the pre-existing stringly-face query-result type aggregator; `core/src/tools/reads.ts` is a
    // typed-read internal. Test files + `__test-utils__` legitimately import codegen for fixtures.
    // Every package OTHER than `core` is forbidden — that is the real cross-package boundary this
    // guard protects (lease/fred/agent-core/agent/chain/cosmwasm/node/sdk must go through `core`).
    {
      name: 'manifestjs-types-chokepoint',
      comment:
        'Only core/src/manifest-types.ts (the chokepoint) + the grandfathered core baseline may import ' +
        'manifestjs generated TYPE paths. Downstream packages must consume canonical DTOs via core (spec §8).',
      severity: 'error',
      from: {
        path: '^packages',
        pathNot: [
          '^packages/core/src/manifest-types\\.ts$',
          // Grandfathered core baseline (spec §8 line 273 named deferral) + test/fixture importers.
          '^packages/core/src/(index|types)\\.ts$',
          '^packages/core/src/tools/reads\\.ts$',
          '^packages/core/src/__test-utils__/',
          '\\.test\\.ts$',
        ],
      },
      to: { path: '@manifest-network/manifestjs/dist/codegen/.+/types(\\.js)?$' },
    },
    // No STATIC node:/undici/ws import in a browser-safe src barrel (M2). A dynamic
    // `import('node:fs')` behind a runtime guard is browser-safe and ALLOWED (dependencyTypesNot:
    // ['dynamic-import']); only the static top-level edge fails the browser build. The exempt paths
    // are the legitimately node-only ones: the SSRF-guarded fetch, the `/node.ts` subpath barrels,
    // and the MCP `server/` runtimes.
    //
    // Two sibling rules because dependency-cruiser AND-s every attribute inside one `to`: node
    // builtins are identified by `dependencyTypes: ['core']` (depcruise resolves `node:fs` -> the
    // bare `fs`, stripping the `node:` prefix, so a `^node:` path match would never fire — the
    // builtin-ness is carried by the `core` dependency type, not the specifier text), while
    // `undici`/`ws` are ordinary npm modules matched by their resolved `node_modules/…` path.
    {
      name: 'no-static-node-in-browser-src',
      comment:
        'Browser-safe src must not STATICALLY import a node: builtin — only via runtime-gated dynamic ' +
        'import. A static edge hard-fails the browser build before tree-shaking (ENG-281/287).',
      severity: 'error',
      from: {
        path: '^packages/(core|fred|agent-core|sdk)/src',
        // Exempt the legitimately node-only paths (SSRF-guarded fetch, `/node.ts` subpath barrels,
        // MCP `server/` runtimes) and test files (never part of the shipped browser bundle).
        pathNot: ['guarded-fetch', '/node\\.ts$', '/server/', '\\.test\\.ts$'],
      },
      to: {
        dependencyTypes: ['core'],
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    {
      name: 'no-static-undici-ws-in-browser-src',
      comment:
        'Browser-safe src must not STATICALLY import undici/ws (the node-only HTTP/WS stacks) — only ' +
        'via runtime-gated dynamic import (ENG-281/287, sibling of no-static-node-in-browser-src).',
      severity: 'error',
      from: {
        path: '^packages/(core|fred|agent-core|sdk)/src',
        // Exempt the legitimately node-only paths (SSRF-guarded fetch, `/node.ts` subpath barrels,
        // MCP `server/` runtimes) and test files (never part of the shipped browser bundle).
        pathNot: ['guarded-fetch', '/node\\.ts$', '/server/', '\\.test\\.ts$'],
      },
      to: {
        path: 'node_modules/(undici|ws)/',
        dependencyTypesNot: ['dynamic-import'],
      },
    },
    // The acceptance example composes ONLY the public SDK + manifestjs (spec §8 (d) / §9). ALLOWLIST,
    // not denylist: forbid ANY node_modules import except those two, so a stray @cosmjs/* / undici / ws
    // is caught too (test files exempt — they may use manifestjs codecs). Tune the path regex to
    // dependency-cruiser's emitted module paths.
    {
      name: 'example-composes-only-sdk',
      comment: 'examples/**/src may import only @manifest-network/manifest-sdk + @manifest-network/manifestjs (spec §9).',
      severity: 'error',
      from: { path: '^examples/[^/]+/src', pathNot: '\\.test\\.ts$' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-no-pkg', 'npm-unknown'],
        pathNot: 'node_modules/@manifest-network/(manifest-sdk|manifestjs)(/|$)',
      },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    // B3: makes the `import type` edge in manifest-types.ts (and the stringly-face types.ts) visible.
    tsPreCompilationDeps: true,
    // Cruise SOURCE, not built artifacts or deps.
    doNotFollow: { path: 'node_modules' },
    // Exclude FIRST-PARTY build output ONLY (`packages/<pkg>/dist/`). It must NOT be the unanchored
    // `(^|/)dist/` — that also swallowed `node_modules/@manifest-network/manifestjs/dist/codegen/.../types.js`
    // (exclude DROPS modules, unlike doNotFollow), which removed the manifestjs-types-chokepoint rule's
    // ONLY `to` target and made it a silent no-op. node_modules codegen stays a matchable-but-not-followed
    // target (doNotFollow above prevents crawling into it).
    exclude: { path: '^(packages|examples)/[^/]+/dist/' },
  },
};
