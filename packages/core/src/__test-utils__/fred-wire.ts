/**
 * Fred wire-response fixtures, parameterized by provider era (ENG-638).
 *
 * WHY THIS EXISTS. Fred's tenant wire shapes are mirrored by hand in
 * `manifest-types.ts`, and before this module every test fixture for them was
 * an inline object literal at a mock call site — roughly forty of them, all
 * modelling the pre-ENG-508 shape. When Fred removed `last_error` the entire
 * suite stayed green, because the fixtures agreed with each other rather than
 * with Fred. Centralising the shape does not make it verified, but it makes a
 * wire change a single reviewable diff instead of forty invisible ones.
 *
 * WHY `Record<string, unknown>` AND NOT `FredLeaseStatus`. These are *provider*
 * payloads, not mono's view of them. Typing them as mono's interface would stop
 * a fixture from expressing the very drift it exists to model: the pre-era
 * fixture could not carry `last_error` once that field is finally dropped from
 * the interface, and a fixture could never represent a field Fred sends that
 * mono does not model. Consumers cast at the mock boundary, as they already do.
 *
 * ERA IS AN EXPLICIT PARAMETER, not two unrelated factories, so a consumer can
 * loop over `FRED_WIRE_ERAS` and prove BOTH paths from one call site. The
 * provider fleet upgrades independently of this client, so a test that pins
 * only one era cannot catch a fix that reads only one shape.
 */

/**
 * Which generation of Fred produced a response.
 *
 * `pre-eng508`: Fred ≤ v0.12.0 — verbose `last_error` (`/status`, `/provision`)
 * and `error` (`/releases`).
 * `post-eng508`: Fred > v0.12.0 — curated `reason` + `message` on all three.
 */
export type FredWireEra = 'pre-eng508' | 'post-eng508';

export const FRED_WIRE_ERAS = ['pre-eng508', 'post-eng508'] as const;

/** How each era spells the same failure. */
function failureFields(
  era: FredWireEra,
  opts: {
    reason?: string;
    message?: string;
    legacyKey?: 'last_error' | 'error';
  } = {},
): Record<string, unknown> {
  const {
    reason = 'ContainerExited',
    message = 'container exited unexpectedly',
    legacyKey = 'last_error',
  } = opts;
  return era === 'post-eng508'
    ? { reason, message }
    : // The verbose value ENG-508 redacted: host paths + raw exec output. Kept
      // realistic on purpose — a fallback path that only ever sees a tidy
      // string is not exercising what a real old provider sends.
      {
        [legacyKey]:
          'container 0 exited during startup (status: exited): exit_code=1; logs:\nError: config file not found',
      };
}

/**
 * `GET /v1/leases/{uuid}/status` — the LeaseStatusResponse wire shape.
 *
 * Includes the fields Fred actually sends that mono does not model
 * (`tenant`, `requires_payload`, `payload_received`, `provisioning_started`):
 * their absence from every previous fixture is exactly why nobody noticed the
 * gap. `overrides` is applied last so a test can add or clobber any key.
 */
export function leaseStatusWire(opts: {
  era: FredWireEra;
  outcome: 'provisioning' | 'ready' | 'failed' | 'retained';
  leaseUuid?: string;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    era,
    outcome,
    leaseUuid = '550e8400-e29b-41d4-a716-446655440000',
    overrides = {},
  } = opts;
  const base: Record<string, unknown> = {
    lease_uuid: leaseUuid,
    tenant: 'manifest1tenant',
    provider_uuid: '11111111-2222-3333-4444-555555555555',
    state: outcome === 'retained' ? 'LEASE_STATE_CLOSED' : 'LEASE_STATE_ACTIVE',
    requires_payload: true,
    payload_received: true,
    provisioning_started: true,
    provision_status: outcome,
  };
  if (outcome === 'failed') {
    Object.assign(base, { fail_count: 3 }, failureFields(era));
  }
  if (outcome === 'retained') {
    Object.assign(base, {
      retained_until: '2026-09-01T00:00:00Z',
      items: [{ sku: 'docker-micro', quantity: 1 }],
      restore_hint:
        'create a fresh PENDING lease of matching shape, then restore',
    });
  }
  return { ...base, ...overrides };
}

/** `GET /v1/leases/{uuid}/provision` — the LeaseProvisionResponse wire shape. */
export function leaseProvisionWire(opts: {
  era: FredWireEra;
  outcome: 'provisioning' | 'ready' | 'failed' | 'retained';
  leaseUuid?: string;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    era,
    outcome,
    leaseUuid = '550e8400-e29b-41d4-a716-446655440000',
    overrides = {},
  } = opts;
  const base: Record<string, unknown> = {
    lease_uuid: leaseUuid,
    tenant: 'manifest1tenant',
    provider_uuid: '11111111-2222-3333-4444-555555555555',
    status: outcome,
    // NOT omitempty on Fred's LeaseProvisionResponse — always present, unlike
    // the same field on /status. The asymmetry is real; do not "fix" it.
    fail_count: outcome === 'failed' ? 3 : 0,
  };
  if (outcome === 'failed') Object.assign(base, failureFields(era));
  if (outcome === 'retained') {
    Object.assign(base, {
      retained_until: '2026-09-01T00:00:00Z',
      items: [{ sku: 'docker-micro', quantity: 1 }],
      restore_hint:
        'create a fresh PENDING lease of matching shape, then restore',
    });
  }
  return { ...base, ...overrides };
}

/**
 * `GET /v1/leases/{uuid}/releases` — the LeaseReleasesResponse wire shape.
 *
 * Note the legacy failure key here is `error`, not `last_error`: Fred spelled
 * the pre-ENG-508 field differently on this endpoint.
 */
export function leaseReleasesWire(opts: {
  era: FredWireEra;
  leaseUuid?: string;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    era,
    leaseUuid = '550e8400-e29b-41d4-a716-446655440000',
    overrides = {},
  } = opts;
  return {
    lease_uuid: leaseUuid,
    tenant: 'manifest1tenant',
    provider_uuid: '11111111-2222-3333-4444-555555555555',
    releases: [
      {
        version: 1,
        image: 'nginx:1.0',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        version: 2,
        image: 'nginx:2.0',
        status: 'failed',
        created_at: '2025-01-02T00:00:00Z',
        ...failureFields(era, {
          reason: 'UpdateFailed',
          message: 'update failed; rolled back',
          legacyKey: 'error',
        }),
      },
    ],
    ...overrides,
  };
}
