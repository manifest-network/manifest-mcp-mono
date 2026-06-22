import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
import { describe, expectTypeOf, it } from 'vitest';
import type { deployApp } from './deploy-app.js';

// Belt-and-suspenders: hard `tsc --noEmit` error too (not only vitest --typecheck).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
// `true satisfies …` is the hard compile-time equivalence proof: a mismatch
// makes `Equals<…>` resolve to `false`, and `true satisfies Expect<false>`
// fails `tsc --noEmit` (noUnusedLocals-clean — no standalone alias to flag,
// no export to trip biome's noExportsInTest). Belt-and-suspenders alongside
// the `expectTypeOf` runtime-typecheck assertion below.
true satisfies Expect<Equals<Parameters<typeof deployApp>[0], AppDeploySpec>>;

describe('deployApp input type (ENG-310)', () => {
  it('is exactly AppDeploySpec', () => {
    expectTypeOf<
      Parameters<typeof deployApp>[0]
    >().toEqualTypeOf<AppDeploySpec>();
  });
});
