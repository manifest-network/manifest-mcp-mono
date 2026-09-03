import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // No unit test may reach the network — see the module for the rationale (ENG-705).
    setupFiles: ['../../tools/vitest/ban-global-fetch.ts'],
    typecheck: {
      enabled: true,
      // Existing type assertions live in `types.test.ts` (`expectTypeOf` /
      // `toEqualTypeOf`), not a `.test-d.ts` file. Both globs are matched so
      // those assertions are actually enforced under `--typecheck` (a
      // `toEqualTypeOf` mismatch is a runtime no-op, so without this the
      // assertions stay inert — ENG-310).
      // Anchored under `src/` so the globs can only collect files that
      // `tsconfig.json`'s `include: ["src/**/*"]` also compiles (ENG-648).
      include: ['src/**/*.test-d.ts', 'src/**/types.test.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
