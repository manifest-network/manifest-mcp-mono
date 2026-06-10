import { describe, expect, it } from 'vitest';
import { parseAddress, parseFqdn, parseLeaseUuid } from './index.js';

describe('brands re-exported from the package barrel', () => {
  it('exposes the constructors', () => {
    expect(typeof parseLeaseUuid).toBe('function');
    expect(typeof parseAddress).toBe('function');
    expect(typeof parseFqdn).toBe('function');
  });
});
