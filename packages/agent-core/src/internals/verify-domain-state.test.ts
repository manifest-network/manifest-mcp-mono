import { describe, expect, it } from 'vitest';
import { verifyDomainState } from './verify-domain-state.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('verifyDomainState — 1:1 port of verify-domain-state.cjs', () => {
  it('match: actual customDomain equals expected (set-mode, multi-item lease)', () => {
    const payload = {
      leases: [
        {
          uuid: UUID,
          items: [{ serviceName: 'web', customDomain: 'app.example.com' }],
        },
      ],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      serviceName: 'web',
      expected: 'app.example.com',
    });
    expect(r.outcome).toBe('match');
    expect(r.actual).toBe('app.example.com');
  });

  it('mismatch: actual differs from expected (set-mode)', () => {
    const payload = {
      leases: [
        {
          uuid: UUID,
          items: [{ serviceName: 'web', customDomain: 'old.example.com' }],
        },
      ],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      serviceName: 'web',
      expected: 'new.example.com',
    });
    expect(r.outcome).toBe('mismatch');
    expect(r.actual).toBe('old.example.com');
  });

  it('clear-mode: expected "" matches when customDomain is empty', () => {
    const payload = {
      leases: [
        { uuid: UUID, items: [{ serviceName: 'web', customDomain: '' }] },
      ],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      serviceName: 'web',
      expected: '',
    });
    expect(r.outcome).toBe('match');
    expect(r.actual).toBe('');
  });

  it('clear-mode: expected "" mismatches when customDomain is still set', () => {
    const payload = {
      leases: [
        {
          uuid: UUID,
          items: [{ serviceName: 'web', customDomain: 'leftover.example.com' }],
        },
      ],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      serviceName: 'web',
      expected: '',
    });
    expect(r.outcome).toBe('mismatch');
    expect(r.actual).toBe('leftover.example.com');
  });

  it('not_found: lease UUID not in tenant payload', () => {
    const r = verifyDomainState(
      { leases: [] },
      { leaseUuid: UUID, expected: 'app.example.com' },
    );
    expect(r.outcome).toBe('not_found');
    expect(r.reason).toMatch(/lease UUID not found in verification payload/);
  });

  it('not_found: multi-item lease but serviceName omitted', () => {
    const payload = {
      leases: [
        {
          uuid: UUID,
          items: [
            { serviceName: 'web', customDomain: '' },
            { serviceName: 'db', customDomain: '' },
          ],
        },
      ],
    };
    const r = verifyDomainState(payload, { leaseUuid: UUID, expected: '' });
    expect(r.outcome).toBe('not_found');
    expect(r.reason).toMatch(
      /multiple items but --service-name was not supplied/,
    );
  });

  it('not_found: serviceName not in lease items', () => {
    const payload = {
      leases: [
        { uuid: UUID, items: [{ serviceName: 'web', customDomain: '' }] },
      ],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      serviceName: 'missing',
      expected: '',
    });
    expect(r.outcome).toBe('not_found');
    expect(r.reason).toMatch(/service-name "missing" not found/);
  });

  it('single-item lease with empty serviceName: serviceName arg ignored', () => {
    // Legacy 1-item leases have serviceName === '' on their only item. The
    // verifier should match the only item regardless of args.serviceName.
    const payload = {
      leases: [{ uuid: UUID, items: [{ customDomain: 'app.example.com' }] }],
    };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      expected: 'app.example.com',
    });
    expect(r.outcome).toBe('match');
  });

  it('throws TypeError for non-string leaseUuid', () => {
    expect(() =>
      verifyDomainState(
        {},
        { leaseUuid: 42 as unknown as string, expected: '' },
      ),
    ).toThrow(TypeError);
  });

  it('throws TypeError for non-UUID leaseUuid', () => {
    expect(() =>
      verifyDomainState({}, { leaseUuid: '../etc/passwd', expected: '' }),
    ).toThrow(/must be a UUID/);
  });

  it('throws TypeError for non-string expected', () => {
    expect(() =>
      verifyDomainState(
        { leases: [] },
        { leaseUuid: UUID, expected: undefined as unknown as string },
      ),
    ).toThrow(/expected must be a string/);
  });

  it('handles missing items array gracefully (treats as 0 items)', () => {
    const payload = { leases: [{ uuid: UUID /* no items */ }] };
    const r = verifyDomainState(payload, {
      leaseUuid: UUID,
      expected: '',
    });
    // 0 items isn't single_item (which requires exactly 1), so falls into
    // the multi-item branch and requires serviceName.
    expect(r.outcome).toBe('not_found');
    expect(r.reason).toMatch(/multiple items but/);
  });
});
