import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
