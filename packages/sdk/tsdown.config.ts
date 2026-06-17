import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: 'esm',
  unbundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'neutral',
  fixedExtension: false,
  // Keep external (non-`@manifest-network`) types as external `import` references in the
  // emitted `.d.ts` instead of inlining them. `/deploy` re-exports `EncodeObject` from
  // `@cosmjs/proto-signing` (type-only, for `executeTx` ergonomics); inlining it would drag
  // the dts-rollup into `@cosmjs/proto-signing`'s deep declaration graph (`registry.d.ts` →
  // `protobufjs`), which fails to bundle. This mirrors core/fred, which leave the same cosmjs
  // types as external dts imports. (ENG-309)
  deps: { dts: { neverBundle: [/^@cosmjs\//, 'protobufjs'] } },
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
});
