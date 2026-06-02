import { describe, expect, it } from 'vitest';
import { createGuardedFetch, isBlocked } from './guarded-fetch.js';

/**
 * The SSRF guard implementation moved to
 * `@manifest-network/manifest-mcp-core` (ENG-268); the substantive test
 * suite lives there (`packages/core/src/internals/guarded-fetch.test.ts`).
 * This smoke test only verifies the agent-core re-export wiring is intact,
 * so a broken re-export fails loudly here rather than at a consumer.
 */
describe('guarded-fetch re-export (moved to core, ENG-268)', () => {
  it('re-exports createGuardedFetch as a function', () => {
    expect(typeof createGuardedFetch).toBe('function');
  });

  it('re-exports a working isBlocked (loopback blocked, public unicast allowed)', () => {
    expect(isBlocked('127.0.0.1')).not.toBeNull();
    expect(isBlocked('8.8.8.8')).toBeNull();
  });
});
