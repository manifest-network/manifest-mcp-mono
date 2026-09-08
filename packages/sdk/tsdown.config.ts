import * as attw from '@arethetypeswrong/core';
import * as publint from 'publint';
import * as publintUtils from 'publint/utils';
import { defineConfig } from 'tsdown';
import { packageEntries } from '../../tools/tsdown-entries.mjs';

export default defineConfig({
  entry: packageEntries(),
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
  // Resolve validators from this workspace even when tsdown is installed elsewhere.
  publint: { module: [publint, publintUtils] },
  attw: { module: attw, profile: 'esm-only', level: 'error' },
});
