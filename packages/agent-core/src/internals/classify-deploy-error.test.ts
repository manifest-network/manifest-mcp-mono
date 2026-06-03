import { describe, expect, it } from 'vitest';
import { classifyDeployError } from './classify-deploy-error.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('classifyDeployError (ENG-280 discriminant + legacy prefix fallback)', () => {
  it('partial-success: extracts leaseUuid from details when present', () => {
    const r = classifyDeployError({
      message: `Deploy partially succeeded: lease ${VALID_UUID} was created but subsequent steps failed.`,
      details: { lease_uuid: VALID_UUID },
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBe(VALID_UUID);
  });

  it('partial-success: falls back to UUID extracted from message text', () => {
    // Some upstream paths emit the partial-success message without populating
    // details.lease_uuid. The classifier must still recover the UUID via the
    // message text — orphaning a billing lease is the worst outcome here.
    const r = classifyDeployError({
      message: `Deploy partially succeeded: lease ${VALID_UUID} was created but subsequent steps failed. Close this lease with close_lease if needed. Error: set-domain failed`,
      details: {},
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBe(VALID_UUID);
  });

  it('partial-success: tolerates {error: {...}} wrapping (some SDK shapes)', () => {
    const r = classifyDeployError({
      error: {
        message: `Deploy partially succeeded: lease ${VALID_UUID} was created.`,
        details: { lease_uuid: VALID_UUID },
      },
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBe(VALID_UUID);
  });

  it('non-partial error → outcome: failed (no lease to clean up)', () => {
    const r = classifyDeployError({
      message: 'broadcast rejected: insufficient funds',
    });
    expect(r.outcome).toBe('failed');
    expect(r.leaseUuid).toBeUndefined();
    expect(r.reason).toMatch(/insufficient funds/);
  });

  it('looser prefix is NOT classified as partial-success', () => {
    // Defense against false-positive: a message containing "partially
    // succeeded" but not at the start (e.g. nested in a wrapping error)
    // must not trigger the cleanup branch.
    const r = classifyDeployError({
      message:
        'Wrapped error: Deploy partially succeeded was the inner cause but...',
    });
    expect(r.outcome).toBe('failed');
  });

  it('expected-custom-domain is echoed back when provided', () => {
    const r = classifyDeployError(
      {
        message: `Deploy partially succeeded: lease ${VALID_UUID}`,
        details: { lease_uuid: VALID_UUID },
      },
      { expectedCustomDomain: 'app.example.com' },
    );
    expect(r.requestedCustomDomain).toBe('app.example.com');
  });

  it('expected-custom-domain echoed even on plain-failure path', () => {
    const r = classifyDeployError(
      { message: 'broadcast rejected' },
      { expectedCustomDomain: 'app.example.com' },
    );
    expect(r.outcome).toBe('failed');
    expect(r.requestedCustomDomain).toBe('app.example.com');
  });

  it('empty error envelope produces a deterministic failed result', () => {
    const r = classifyDeployError({});
    expect(r.outcome).toBe('failed');
    expect(r.reason).toMatch(/empty error/);
  });

  it('non-object input → outcome: failed (always returns a stable shape)', () => {
    // CJS does `console.log` even on malformed envelope and exits 0;
    // TS port returns a deterministic classification so callers branch on it.
    expect(classifyDeployError(null).outcome).toBe('failed');
    expect(classifyDeployError(undefined).outcome).toBe('failed');
    expect(classifyDeployError('not-an-envelope').outcome).toBe('failed');
    expect(classifyDeployError(42).outcome).toBe('failed');
  });

  it('partial-success with no leaseUuid anywhere → outcome partially_succeeded, leaseUuid undefined', () => {
    // Edge case the CJS preserves: prefix matches but neither details
    // nor message text carries a UUID. Caller has to recover or surface
    // the bare partial-success outcome.
    const r = classifyDeployError({
      message: 'Deploy partially succeeded: <no uuid visible here>',
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBeUndefined();
  });

  it('details with non-string lease_uuid is ignored (falls back to message regex)', () => {
    const r = classifyDeployError({
      message: `Deploy partially succeeded: lease ${VALID_UUID} was created`,
      details: { lease_uuid: 42 /* wrong type */ },
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBe(VALID_UUID); // recovered from message
  });

  it('partial via details.partial with an empty message uses a stable reason placeholder', () => {
    // After the ENG-280 discriminant migration, partial-success can fire on
    // details.partial === true even when the envelope omits `message`. reason
    // must still be a non-empty placeholder, matching the failed-path contract.
    const r = classifyDeployError({
      message: '',
      details: { partial: true, lease_uuid: VALID_UUID },
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('classifies via details.partial === true (no prefix needed)', () => {
    const r = classifyDeployError({
      message: 'something failed',
      details: { partial: true, lease_uuid: 'abc' },
    });
    expect(r.outcome).toBe('partially_succeeded');
    expect(r.leaseUuid).toBe('abc');
  });

  it('still classifies via the legacy prefix when details.partial is absent', () => {
    const r = classifyDeployError({
      message: 'Deploy partially succeeded: lease abc ...',
      details: {},
    });
    expect(r.outcome).toBe('partially_succeeded');
  });
});
