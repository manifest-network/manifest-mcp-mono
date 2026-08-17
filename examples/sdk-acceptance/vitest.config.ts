import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    // No unit test may reach the network — see the module for the rationale (ENG-705).
    // This example is a workspace member, so root `npm test` runs it, and its whole point is
    // that the published SDK composes with an INJECTED transport: a latent globalThis.fetch
    // reaching in here is exactly the regression worth failing on.
    setupFiles: ['../../tools/vitest/ban-global-fetch.ts'],
  },
});
