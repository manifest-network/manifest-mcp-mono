import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('manifest-types are reachable + are pure types (no runtime emit)', () => {
  it('the barrel exposes the value exports it should and no accidental runtime value for the types', () => {
    // Types erase; this asserts the relocation did not accidentally export a runtime value
    // named like a type. The brand parse* + logger/options values remain present.
    expect(typeof barrel.parseLeaseUuid).toBe('function');
    expect((barrel as Record<string, unknown>).DeployResult).toBeUndefined();
    expect((barrel as Record<string, unknown>).FredLeaseStatus).toBeUndefined();
    expect((barrel as Record<string, unknown>).PortConfig).toBeUndefined();
    expect((barrel as Record<string, unknown>).ServiceConfig).toBeUndefined();
  });
});
