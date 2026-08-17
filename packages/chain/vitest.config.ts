import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // No unit test may reach the network — see the module for the rationale (ENG-705).
    setupFiles: ['../../tools/vitest/ban-global-fetch.ts'],
  },
});
