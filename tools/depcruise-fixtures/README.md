# dependency-cruiser known-bad meta-fixtures (ENG-309, ENG-641)

These files are **deliberately broken** and are **NOT compiled into any package** (they live
outside `packages/` + `examples/`, so no workspace `tsconfig` includes them, and the root
`npm run depcruise` cruises `packages examples` only — never this directory). They exist solely to
PROVE that the production
`.dependency-cruiser.cjs` rules actually bite: the meta-test
`packages/sdk/scripts/cast-guard.test.ts` cruises these directories with
`.dependency-cruiser.fixtures.cjs` and asserts each rule fires **by name**.

Run them by hand from the **repo root** (not from this directory — see the config header for why):

```bash
npx depcruise tools/depcruise-fixtures/{pkg-src,browser-src,example-src,core-src,fred-src} \
  --config tools/depcruise-fixtures/.dependency-cruiser.fixtures.cjs
```

The fixtures cover every import-edge rule the production config enforces (spec §8/§9/§13):

- `core-src/bad-fred-import.ts` and `core-src/bad-agent-core-import.ts` — a (simulated)
  `packages/core/src` file reaching UP into fred / agent-core. core is the dependency sink. MUST be
  flagged by `no-core-to-fred-or-agentcore` (one fixture per arm of its `to` matcher).
- `fred-src/bad-agent-core-import.ts` — a (simulated) `packages/fred/src` file reaching UP into
  agent-core, inverting `agent-core -> fred -> core`. MUST be flagged by `no-fred-to-agentcore`.
- `pkg-src/bad-manifestjs-type-import.ts` — a (simulated) downstream-package `src` file importing a
  manifestjs **generated TYPE path** (`…/codegen/.../types.js`) from OUTSIDE the
  `core/src/manifest-types.ts` chokepoint. MUST be flagged by `manifestjs-types-chokepoint`.
- `browser-src/bad-static-node-import.ts` — a (simulated) browser-safe `src` barrel STATICALLY
  importing a `node:` builtin + `undici`. MUST be flagged by `no-static-node-in-browser-src`.
- `example-src/bad-import.ts` — a (simulated) `examples/**/src` file importing a node_modules package
  OUTSIDE the compose-only allowlist (here: `@cosmjs/proto-signing`; the SDK + manifestjs are the
  ONLY permitted runtime deps). MUST be flagged by the ALLOWLIST rule `example-composes-only-sdk`.
- `example-src/bad-workspace-import.ts` — the same §9 invariant from the other side: an example
  reaching past the public SDK into another workspace package's SOURCE. MUST be flagged by
  `no-example-to-non-sdk-package`. Two rules, because a workspace sibling is a first-party edge, not
  an `npm` one, so the allowlist above (keyed on `dependencyTypes: npm…`) cannot see it.

The cross-package fixtures import **by package name** — `@manifest-network/manifest-mcp-fred`, not
`../../packages/fred/src/index.js`. That is deliberate and load-bearing. ENG-641: the two DAG rules
shipped unfireable for their whole life precisely because a package-name import resolved into
`packages/<pkg>/dist/` (dropped by the production `exclude`) or, for a subpath import, did not
resolve at all. A relative cross-package import would have matched all along — and would therefore
have proven nothing, since nobody writes one. `.dependency-cruiser.cjs`'s `webpackConfig` alias is
what makes the realistic form resolve to `src`; these fixtures are what keeps it honest.

There is intentionally **NO "brand cast outside brands.ts" fixture**: a TypeScript type assertion
(`x as Address`) produces no import edge, so dependency-cruiser can never see it. That guard ships
as the grep/biome meta-test in `cast-guard.test.ts` instead.

Fixtures alone are not sufficient — they cruise a re-anchored clone of the rules. Each rule ALSO has
a positive control in `cast-guard.test.ts` that writes a probe into a real package and cruises the
**production** config, so a resolution or `exclude` change cannot quietly revive a no-op.
