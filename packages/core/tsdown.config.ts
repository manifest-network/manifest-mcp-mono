import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: 'esm',
  unbundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'neutral',
  fixedExtension: false,
  // Keep vitest (and its sub-packages) out of the bundler's chunk graph.
  // `__test-utils__/mocks.ts` imports `vi` at runtime (it's part of core's
  // public exports via the `./__test-utils__/mocks.js` entry); with
  // `unbundle: true` rolldown would otherwise walk vitest's entire transitive
  // graph (tinyrainbow, @vitest/expect, expect-type, …) and try to emit each
  // as a separate chunk. The matching `@vitest/*` pattern keeps the dts pass
  // from inlining `@vitest/spy` types referenced via `vi.Mock<Procedure>`.
  // On worktree paths containing characters rolldown's filename sanitizer
  // mangles (notably `+`), the `[name]` substitution produces an invalid
  // relative path and the build fails outright. See rolldown's filename
  // sanitization rules for entryFileNames.
  deps: { neverBundle: ['vitest', /^@vitest\//] },
});
