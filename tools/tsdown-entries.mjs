/** Shared package entry policy: source modules only, never runtime or type tests. */
export function packageEntries() {
  return ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.test-d.ts'];
}
