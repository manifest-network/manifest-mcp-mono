import { defineConfig } from 'tsdown';
import { packageEntries } from '../../tools/tsdown-entries.mjs';

export default defineConfig({
  // The standalone Ajv output is a source drift/test artifact. Runtime code
  // has no import edge to it, so do not emit/publish its 258 KB implementation.
  entry: [
    ...packageEntries(),
    '!src/generated/fred-manifest-schema-validator.ts',
  ],
  format: 'esm',
  unbundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  platform: 'neutral',
  fixedExtension: false,
});
