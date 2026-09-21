import e2eConfig from './vitest.config.js';

// Vitest's positional file filters are substrings: lifecycle.e2e.test.ts also
// selects group-lifecycle and vote-lifecycle. Keep this PR gate exact while
// inheriting the shared devnet setup, sequential execution, and test deadlines.
export default {
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    include: ['lifecycle.e2e.test.ts', 'restore-roundtrip.e2e.test.ts'],
  },
};
