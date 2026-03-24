import { fromBase64 } from '@cosmjs/encoding';
import { describe, expect, it } from 'vitest';
import {
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

describe('createSignMessage', () => {
  it('formats tenant:leaseUuid:timestamp', () => {
    expect(createSignMessage('t1', 'uuid1', 1735689600)).toBe(
      't1:uuid1:1735689600',
    );
  });
});

describe('createLeaseDataSignMessage', () => {
  it('formats with manifest lease data prefix', () => {
    expect(createLeaseDataSignMessage('uuid1', 'abc123', 1735689600)).toBe(
      'manifest lease data uuid1 abc123 1735689600',
    );
  });
});

describe('createAuthToken', () => {
  it('creates base64-encoded JSON token without meta_hash', () => {
    const token = createAuthToken(
      'tenant1',
      'lease1',
      1735689600,
      'pk1',
      'sig1',
    );
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.tenant).toBe('tenant1');
    expect(decoded.lease_uuid).toBe('lease1');
    expect(decoded.timestamp).toBe(1735689600);
    expect(decoded.pub_key).toBe('pk1');
    expect(decoded.signature).toBe('sig1');
    expect(decoded.meta_hash).toBeUndefined();
  });

  it('includes meta_hash when provided', () => {
    const token = createAuthToken(
      't',
      'l',
      1735689600,
      'pk',
      'sig',
      'deadbeef',
    );
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.meta_hash).toBe('deadbeef');
  });
});
