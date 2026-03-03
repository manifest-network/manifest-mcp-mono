import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Force CJS resolution for this module. The .mjs entry point in manifestjs
      // has broken internal imports (missing .mjs extensions on relative paths),
      // which causes "Cannot find module .../coin" errors at runtime.
      '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types':
        '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js',
    },
  },
});
