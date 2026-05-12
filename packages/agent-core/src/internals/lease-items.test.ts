import { describe, expect, it } from 'vitest';
import { findLease, normalizeItem, pickLeasesArray } from './lease-items.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('pickLeasesArray', () => {
  it('returns leases[] from {leases: […]} shape', () => {
    const result = pickLeasesArray({ leases: [{ uuid: UUID }] });
    expect(result).toEqual([{ uuid: UUID }]);
  });

  it('returns a bare array unchanged', () => {
    const result = pickLeasesArray([{ uuid: UUID }]);
    expect(result).toEqual([{ uuid: UUID }]);
  });

  it('returns [] from {leases: []}', () => {
    expect(pickLeasesArray({ leases: [] })).toEqual([]);
  });

  it('throws on unrecognized shape', () => {
    expect(() => pickLeasesArray({})).toThrow(/expected `leases\[\]`/);
    expect(() => pickLeasesArray(null)).toThrow(/expected `leases\[\]`/);
    expect(() => pickLeasesArray('not-a-thing')).toThrow(
      /expected `leases\[\]`/,
    );
    expect(() => pickLeasesArray(42)).toThrow(/expected `leases\[\]`/);
  });
});

describe('normalizeItem', () => {
  it('reads camelCase fields', () => {
    expect(
      normalizeItem({ serviceName: 'web', customDomain: 'app.example.com' }),
    ).toEqual({ serviceName: 'web', customDomain: 'app.example.com' });
  });

  it('reads snake_case fields', () => {
    expect(
      normalizeItem({ service_name: 'web', custom_domain: 'app.example.com' }),
    ).toEqual({ serviceName: 'web', customDomain: 'app.example.com' });
  });

  it('camelCase wins when both shapes are present', () => {
    expect(
      normalizeItem({
        serviceName: 'camel',
        service_name: 'snake',
        customDomain: 'camel.example.com',
        custom_domain: 'snake.example.com',
      }),
    ).toEqual({
      serviceName: 'camel',
      customDomain: 'camel.example.com',
    });
  });

  it('defaults missing fields to empty strings', () => {
    expect(normalizeItem({})).toEqual({ serviceName: '', customDomain: '' });
    expect(normalizeItem({ serviceName: 'web' })).toEqual({
      serviceName: 'web',
      customDomain: '',
    });
  });

  it('treats non-string field values as empty', () => {
    expect(normalizeItem({ serviceName: 42, customDomain: null })).toEqual({
      serviceName: '',
      customDomain: '',
    });
  });

  it('returns defaults for null / non-object inputs', () => {
    expect(normalizeItem(null)).toEqual({ serviceName: '', customDomain: '' });
    expect(normalizeItem(undefined)).toEqual({
      serviceName: '',
      customDomain: '',
    });
    expect(normalizeItem('string')).toEqual({
      serviceName: '',
      customDomain: '',
    });
  });
});

describe('findLease', () => {
  it('finds a lease by uuid (camelCase shape)', () => {
    const payload = {
      leases: [
        { uuid: UUID, items: [{ serviceName: 'web' }] },
        { uuid: '22222222-2222-4222-8222-222222222222', items: [] },
      ],
    };
    expect(findLease(payload, UUID)).toEqual({
      uuid: UUID,
      items: [{ serviceName: 'web' }],
    });
  });

  it('finds a lease by snake_case lease_uuid field', () => {
    const payload = { leases: [{ lease_uuid: UUID, items: [] }] };
    expect(findLease(payload, UUID)).toEqual({ lease_uuid: UUID, items: [] });
  });

  it('finds a lease by leaseUuid alternate spelling', () => {
    const payload = { leases: [{ leaseUuid: UUID, items: [] }] };
    expect(findLease(payload, UUID)).toEqual({ leaseUuid: UUID, items: [] });
  });

  it('match is case-insensitive', () => {
    const upper = UUID.toUpperCase();
    const payload = { leases: [{ uuid: upper, items: [] }] };
    expect(findLease(payload, UUID)).toEqual({ uuid: upper, items: [] });
  });

  it('returns null when no lease matches', () => {
    expect(findLease({ leases: [] }, UUID)).toBeNull();
    expect(
      findLease(
        { leases: [{ uuid: '99999999-9999-4999-8999-999999999999' }] },
        UUID,
      ),
    ).toBeNull();
  });

  it('accepts a bare array payload', () => {
    expect(findLease([{ uuid: UUID, items: [] }], UUID)).toEqual({
      uuid: UUID,
      items: [],
    });
  });

  it('throws TypeError on non-string leaseUuid', () => {
    expect(() => findLease({ leases: [] }, 42 as unknown as string)).toThrow(
      TypeError,
    );
    expect(() => findLease({ leases: [] }, null as unknown as string)).toThrow(
      /leaseUuid must be a string, got null/,
    );
    expect(() =>
      findLease({ leases: [] }, undefined as unknown as string),
    ).toThrow(/got undefined/);
  });

  it('propagates pickLeasesArray throw on malformed payload', () => {
    expect(() => findLease({}, UUID)).toThrow(/expected `leases\[\]`/);
  });
});
