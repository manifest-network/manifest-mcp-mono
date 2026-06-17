import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('agent-core barrel hygiene', () => {
  it('does NOT re-export the node-only guarded fetch (browser-safety; ENG-281/287)', () => {
    expect(barrel).not.toHaveProperty('createGuardedFetch');
    expect(barrel).not.toHaveProperty('isBlocked');
  });
});
