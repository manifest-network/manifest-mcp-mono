# dependency-cruiser known-bad meta-fixtures (ENG-309)

These files are **deliberately broken** and are **NOT compiled into any package** (they live
outside `packages/`, so no workspace `tsconfig` includes them, and the root `npm run depcruise`
cruises `packages` only — never this directory). They exist solely to PROVE that the production
`.dependency-cruiser.cjs` rules actually bite: the meta-test
`packages/sdk/scripts/cast-guard.test.ts` cruises this directory with
`.dependency-cruiser.fixtures.cjs` and asserts each rule fires.

The two fixtures mirror the two import-edge rules that the production config enforces (spec §8):

- `pkg-src/bad-manifestjs-type-import.ts` — a (simulated) downstream-package `src` file importing a
  manifestjs **generated TYPE path** (`…/codegen/.../types.js`) from OUTSIDE the
  `core/src/manifest-types.ts` chokepoint. MUST be flagged by `manifestjs-types-chokepoint`.
- `browser-src/bad-static-node-import.ts` — a (simulated) browser-safe `src` barrel STATICALLY
  importing a `node:` builtin + `undici`. MUST be flagged by `no-static-node-in-browser-src`.

There is intentionally **NO "brand cast outside brands.ts" fixture**: a TypeScript type assertion
(`x as Address`) produces no import edge, so dependency-cruiser can never see it. That guard ships
as the grep/biome meta-test in `cast-guard.test.ts` instead.
