type Expect<T extends true> = T;

// This file intentionally has no runtime tests. When Vitest treats it as a
// type-test, the expected error below is consumed. Without typechecking, a
// direct invocation cannot report a false-green runtime assertion (ENG-648).
// The export is load-bearing: an unused local alias would raise TS6196, which
// could mask TS2578 if this deliberately false assertion ever stopped failing.
// @ts-expect-error -- `false` must not satisfy the canary's `true` constraint.
export type TypecheckHarnessCanary = Expect<false>;
