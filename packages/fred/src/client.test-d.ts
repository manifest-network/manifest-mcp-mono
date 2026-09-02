import type { ManifestClient } from '@manifest-network/manifest-mcp-core';
import { describe, expectTypeOf, it } from 'vitest';
import type { FredClient } from './client.js';

// Type-level pins for the FredClient shape. These were `expectTypeOf` calls inside
// `client.test.ts`; as a runtime test they compiled to nothing, so only `npm run lint`
// could ever fail them. As a `.test-d.ts` under the package's `typecheck.include`, a
// mismatch fails `npm test` with the test name attached (ENG-648).
describe('FredClient shape (type-level)', () => {
  it('FredClient is ManifestClient & FredActions; a query-only client is not assignable', () => {
    expectTypeOf<FredClient>().toMatchTypeOf<ManifestClient>();
    expectTypeOf<FredClient>().toHaveProperty('waitForLeaseStatus');
    // A read client (no required signer) is NOT a FredClient.
    type ReadShape = Omit<ManifestClient, 'signer'>;
    expectTypeOf<ReadShape>().not.toMatchTypeOf<FredClient>();
  });
});
