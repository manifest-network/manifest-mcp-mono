import { describe, expect, it } from 'vitest';
import {
  MAX_LEASE_STATUS_CHARS,
  projectLeaseStatus,
} from './projectLeaseStatus.js';

describe('projectLeaseStatus', () => {
  it('preserves a status that already fits the serialized budget', () => {
    const input = {
      state: 3,
      provision_status: 'ready',
      future_field: { enabled: true },
    };

    expect(projectLeaseStatus(input)).toEqual({
      status: input,
      truncated: false,
    });
  });

  it('keeps operational fields ahead of oversized extension data', () => {
    const projected = projectLeaseStatus({
      giant_extension: 'x'.repeat(MAX_LEASE_STATUS_CHARS),
      services: { web: { instances: [{ status: 'running' }] } },
      provision_status: 'ready',
      state: 3,
    });

    expect(projected.status).toMatchObject({
      state: 3,
      provision_status: 'ready',
      services: { web: { instances: [{ status: 'running' }] } },
    });
    expect(projected.status.giant_extension).toBeUndefined();
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected.status).length).toBeLessThanOrEqual(
      MAX_LEASE_STATUS_CHARS,
    );
  });

  it('counts provider-controlled keys in the serialized budget', () => {
    const hugeKey = 'k'.repeat(MAX_LEASE_STATUS_CHARS);
    const projected = projectLeaseStatus({
      [hugeKey]: '',
      state: 3,
    });

    expect(projected.status).toEqual({ state: 3 });
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected.status).length).toBeLessThanOrEqual(
      MAX_LEASE_STATUS_CHARS,
    );
  });

  it('preserves __proto__ as an own field without changing the output prototype', () => {
    const projected = projectLeaseStatus(
      Object.fromEntries([
        ['state', 3],
        ['__proto__', { polluted: true }],
      ]),
    );

    expect(
      Object.getOwnPropertyDescriptor(projected.status, '__proto__')?.value,
    ).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(projected.status)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
