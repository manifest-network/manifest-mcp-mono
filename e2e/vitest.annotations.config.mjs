import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * PR-safe transport-only metadata gate. Keep the full e2e timeouts for cold
 * runners, but deliberately omit globalSetup: listing tools neither calls the
 * chain nor needs artifacts extracted from the compose devnet.
 */
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['tool-annotations.e2e.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
