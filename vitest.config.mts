import { defineConfig } from 'vitest/config';

// Root entry point for `npx vitest run <path>` from the repository root.
//
// This file defines NO test options of its own: it only delegates to each workspace
// member's `vitest.config.ts`, so a root-invoked run uses exactly the same `typecheck`,
// `setupFiles`, and `exclude` as `npm run test -w <pkg>`. Before it existed, a root run
// used Vitest's defaults instead: a bare run of a `.test-d.ts` found no test files, and
// `--typecheck` pointed tsc at the root `tsconfig.json` — a references-only index with
// `files: []` — so `expectTypeOf` assertions passed with zero analysis, while an
// `expectTypeOf` inside a runtime `.test.ts` compiled to nothing and passed unconditionally
// (ENG-648).
//
// Delegating (rather than repeating the per-package `typecheck.include` here with a shared
// root tsconfig) matters because Vitest spawns `tsc -p <typecheck.tsconfig>` over that
// tsconfig's WHOLE program: a file that Vitest's glob collects but tsc's `include` does
// not reach is reported as passing with zero type analysis. Two hand-maintained lists
// can only agree by accident (Vitest globs with `dot: true`; tsc's `include` skips
// dot-directories), and a repo-wide tsconfig would also have needed every sibling's dist
// built for a core-only run. Per-package configs pair each glob with the tsconfig whose
// `include` already covers it (`src/**/*`). `scripts/check-type-tests.test.mjs` proves both
// halves: a known-bad probe fails a root run, and every collected type-test file is a root
// file of its project's tsconfig.
//
// The globs are anchored at `packages/` and `examples/`, so a nested checkout under
// `.claude/worktrees/**` is never picked up as a project.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'examples/*/vitest.config.ts'],
  },
});
