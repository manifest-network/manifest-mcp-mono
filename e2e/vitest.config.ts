import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    globalSetup: './helpers/global-setup.ts',
    include: ['**/*.e2e.test.ts'],
    testTimeout: 300_000,      // 5 min per test
    hookTimeout: 120_000,      // 2 min for beforeAll/afterAll
    sequence: { concurrent: false },
  },
});
