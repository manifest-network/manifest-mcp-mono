import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    typecheck: {
      enabled: true,
      // Existing type assertions live in `types.test.ts` (`expectTypeOf` /
      // `toEqualTypeOf`), not a `.test-d.ts` file. Both globs are matched so
      // those assertions are actually enforced under `--typecheck` (a
      // `toEqualTypeOf` mismatch is a runtime no-op, so without this the
      // assertions stay inert — ENG-310).
      include: ['**/*.test-d.ts', '**/types.test.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
