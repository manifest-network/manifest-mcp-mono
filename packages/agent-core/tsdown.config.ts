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
});
