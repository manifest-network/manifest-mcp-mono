import { describe, expect, it } from 'vitest';
import { classifyDeployResponse } from './classify-deploy-response.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';
const PROVIDER_URL = 'https://provider.example.com';

describe('classifyDeployResponse — NEW unit tests (architect plan §"Tests in PR 1")', () => {
  it('#1 active-with-urls: state=ACTIVE + running instance with fqdn → outcome active, https url', () => {
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      provider_uuid: PROVIDER,
      provider_url: PROVIDER_URL,
      connection: {
        instances: [{ status: 'running', fqdn: 'foo.example.com' }],
      },
    });
    expect(r.outcome).toBe('active');
    expect(r.urls).toEqual(['https://foo.example.com/']);
    expect(r.stateName).toBe('LEASE_STATE_ACTIVE');
    expect(r.leaseUuid).toBe(VALID_UUID);
    expect(r.providerUuid).toBe(PROVIDER);
    expect(r.providerUrl).toBe(PROVIDER_URL);
    expect(r.errorSummary).toBeUndefined();
  });

  it('#2 active-with-instances-no-urls: internal-only deploy (running but no fqdn) → outcome active, urls empty', () => {
    // Internal-only services (every port `ingress: false`) have running
    // instances but no FQDN. hasRunningInstances() carries the classification.
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      connection: {
        instances: [{ status: 'running' /* no fqdn */ }],
      },
    });
    expect(r.outcome).toBe('active');
    expect(r.urls).toEqual([]);
    expect(r.stateName).toBe('LEASE_STATE_ACTIVE');
  });

  it('#3 needs-wait: state=PENDING → outcome needs_wait', () => {
    const r = classifyDeployResponse({
      state: 1,
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('needs_wait');
    expect(r.urls).toEqual([]);
    expect(r.stateName).toBe('LEASE_STATE_PENDING');
    expect(r.errorSummary).toBeUndefined();
  });

  it('#4 failed-no-uuid: state=ACTIVE but no lease_uuid → outcome failed, error_summary mentions lease_uuid', () => {
    const r = classifyDeployResponse({ state: 2 });
    expect(r.outcome).toBe('failed');
    expect(r.urls).toEqual([]);
    expect(r.errorSummary).toMatch(/no lease_uuid/);
  });

  it('#5 failed-terminal-CLOSED: state=3 → outcome failed, stateName CLOSED', () => {
    // Under chain-aligned mapping (manifestjs 2.4.1), integer 3 decodes as
    // LEASE_STATE_CLOSED (NOT INSUFFICIENT_FUNDS per stale CJS table).
    // Byte-exact error_summary format pinned by qa-engineer.
    const r = classifyDeployResponse({
      state: 3,
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('failed');
    expect(r.stateName).toBe('LEASE_STATE_CLOSED');
    expect(r.errorSummary).toBe(
      `Lease ${VALID_UUID} reached terminal state LEASE_STATE_CLOSED`,
    );
  });

  it('#6a failed-terminal-REJECTED: state=4 → outcome failed, stateName REJECTED', () => {
    // Replaces the CJS "INSUFFICIENT_FUNDS at int 3" scenario. The current
    // chain emits REJECTED at integer 4 (provider rejected the lease, credit
    // returned to tenant).
    const r = classifyDeployResponse({
      state: 4,
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('failed');
    expect(r.stateName).toBe('LEASE_STATE_REJECTED');
    expect(r.errorSummary).toBe(
      `Lease ${VALID_UUID} reached terminal state LEASE_STATE_REJECTED`,
    );
  });

  it('#6b failed-terminal-EXPIRED: state=5 → outcome failed, stateName EXPIRED', () => {
    // Chain emits EXPIRED at integer 5 (lease expired in PENDING; provider
    // never acknowledged within the timeout). CJS had no entry for 5.
    const r = classifyDeployResponse({
      state: 5,
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('failed');
    expect(r.stateName).toBe('LEASE_STATE_EXPIRED');
    expect(r.errorSummary).toBe(
      `Lease ${VALID_UUID} reached terminal state LEASE_STATE_EXPIRED`,
    );
  });

  it('#7 url-prepend-scheme: top-level url without scheme prepended https; deduped against connection urls', () => {
    // Engineer-added bonus per sub-plan: the CJS handles top-level `url`
    // prepending + dedup. Worth pinning at unit-test layer so PR-3 fixture
    // replay isn't first to detect a regression.
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      url: 'foo.example.com:8080',
      connection: {
        instances: [{ status: 'running', fqdn: 'bar.example.com' }],
      },
    });
    expect(r.outcome).toBe('active');
    expect(r.urls).toEqual([
      'https://foo.example.com:8080/',
      'https://bar.example.com/',
    ]);
  });

  it('#7b url-prepend: existing scheme preserved (no double-prepend)', () => {
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      url: 'http://foo.example.com:8080',
      connection: {
        instances: [{ status: 'running', fqdn: 'bar.example.com' }],
      },
    });
    expect(r.urls[0]).toBe('http://foo.example.com:8080');
  });

  it('#7c url-prepend: dedup against connection urls (no duplicate entry)', () => {
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      url: 'foo.example.com',
      connection: {
        // After scheme prepend the top-level url becomes 'https://foo.example.com/'
        // which exactly matches the connection-derived url. Dedup keeps a single entry.
        instances: [{ status: 'running', fqdn: 'foo.example.com' }],
      },
    });
    expect(r.urls).toEqual(['https://foo.example.com/']);
  });
});

describe('classifyDeployResponse — edge cases', () => {
  it('failed + connectionError present: passes through verbatim', () => {
    const r = classifyDeployResponse({
      state: 3,
      lease_uuid: VALID_UUID,
      connectionError: 'verbatim provider error',
    });
    expect(r.outcome).toBe('failed');
    expect(r.errorSummary).toBe('verbatim provider error');
  });

  it('connectionError on a non-failed outcome is not surfaced', () => {
    // The CJS only emits error_summary when outcome === 'failed'. Active
    // outcome with a connectionError field (rare) shouldn't propagate it.
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      connectionError: 'transient note',
      connection: {
        instances: [{ status: 'running', fqdn: 'foo.example.com' }],
      },
    });
    expect(r.outcome).toBe('active');
    expect(r.errorSummary).toBeUndefined();
  });

  it('unknown state integer → outcome needs_wait, stateName undefined', () => {
    // Forward-compat: future chain variants emit integers we don't know.
    // Treat as "still working on it" rather than failing fast.
    const r = classifyDeployResponse({
      state: 99,
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('needs_wait');
    expect(r.stateName).toBeUndefined();
  });

  it('state as canonical string passes through stateName', () => {
    const r = classifyDeployResponse({
      state: 'LEASE_STATE_PENDING',
      lease_uuid: VALID_UUID,
    });
    expect(r.stateName).toBe('LEASE_STATE_PENDING');
    expect(r.outcome).toBe('needs_wait');
  });

  it('active state but no running instance → outcome needs_wait (not active)', () => {
    // The CJS rules require BOTH stateName ACTIVE AND at least one running
    // instance (or non-empty urls). State=ACTIVE alone falls through to
    // needs_wait so the orchestrator polls wait_for_app_ready.
    const r = classifyDeployResponse({
      state: 2,
      lease_uuid: VALID_UUID,
      connection: { instances: [{ status: 'pending' }] },
    });
    expect(r.outcome).toBe('needs_wait');
  });

  it('terminal-state INSUFFICIENT_FUNDS string (legacy/unreachable from int decode) still classifies failed', () => {
    // Defense-in-depth: if a future chain regression emits this state via
    // string passthrough, isTerminal() still routes correctly.
    const r = classifyDeployResponse({
      state: 'LEASE_STATE_INSUFFICIENT_FUNDS',
      lease_uuid: VALID_UUID,
    });
    expect(r.outcome).toBe('failed');
    expect(r.stateName).toBe('LEASE_STATE_INSUFFICIENT_FUNDS');
    expect(r.errorSummary).toBe(
      `Lease ${VALID_UUID} reached terminal state LEASE_STATE_INSUFFICIENT_FUNDS`,
    );
  });

  it('no fields → outcome failed (no lease, no state, empty urls)', () => {
    const r = classifyDeployResponse({});
    expect(r.outcome).toBe('failed');
    expect(r.urls).toEqual([]);
    expect(r.errorSummary).toBe('deploy_app returned no lease_uuid');
  });

  it('does NOT emit providerUuid/providerUrl when they are not strings', () => {
    const r = classifyDeployResponse({
      state: 1,
      lease_uuid: VALID_UUID,
      provider_uuid: 42 as unknown as string,
      provider_url: null as unknown as string,
    });
    expect(r.providerUuid).toBeUndefined();
    expect(r.providerUrl).toBeUndefined();
  });
});
