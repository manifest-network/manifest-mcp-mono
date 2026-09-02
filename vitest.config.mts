import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Match the package configs so a root-level single-file run keeps the
    // repository-wide no-network invariant (ENG-705).
    setupFiles: ['./tools/vitest/ban-global-fetch.ts'],
    typecheck: {
      enabled: true,
      include: [
        '**/*.test-d.ts',
        // agent-core deliberately keeps these assertions in a runtime-shaped
        // file; its package config treats the same file as a type test.
        'packages/agent-core/src/types.test.ts',
      ],
      // The root tsconfig is a references-only index with `files: []` and
      // therefore cannot diagnose a selected type-test on its own.
      tsconfig: './tsconfig.type-tests.json',
    },
  },
});
