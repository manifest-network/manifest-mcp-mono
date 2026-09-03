import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // No unit test may reach the network — see the module for the rationale (ENG-705).
    setupFiles: ['../../tools/vitest/ban-global-fetch.ts'],
    typecheck: {
      enabled: true,
      // Anchored under `src/` so the glob can only collect files that `tsconfig.json`'s
      // `include: ["src/**/*"]` also compiles. Vitest reports a collected file that tsc's
      // program never reaches as passing with zero type analysis (ENG-648).
      include: ['src/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
