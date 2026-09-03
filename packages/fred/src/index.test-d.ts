import { describe, expectTypeOf, it } from 'vitest';
import type { PortConfig } from './index.js';

// Type-level pin for the barrel's re-exported manifest port type. Moved out of
// `index.test.ts`, where the assertion was inert at runtime (ENG-648).
describe('fred barrel type exports', () => {
  it('exports the nested manifest port type from the package barrel', () => {
    expectTypeOf<PortConfig>().toEqualTypeOf<{
      readonly host_port?: number;
      readonly ingress?: boolean;
    }>();
  });
});
