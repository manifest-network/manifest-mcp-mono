// Failure-path wire tests that run through the REAL adapter.
//
// fred.test.ts mocks './provider.js' at module scope, so every fixture there is
// handed straight to a vi.fn() — checkedFetch, readBodyCapped and the JSON parse
// are never exercised, and a fixture proves only that the mock returned what it
// was told to. That is the "don't mock what you don't own" gap that let Fred's
// ENG-508 wire change stay invisible to CI (ENG-638).
//
// This file deliberately mocks NOTHING. It injects a `fetchFn` returning a real
// Response and lets the adapter do its actual job, so the assertions below are
// about mono's behaviour against a wire payload rather than about vitest.
//
// Every case runs against BOTH provider eras from one call site: the fleet
// upgrades independently of this client, so a fix that reads only `reason` or
// only `last_error` must fail here.
import { describe, expect, it } from 'vitest';
import {
  getLeaseProvision,
  getLeaseStatus,
  pollLeaseUntilReady,
} from './fred.js';
import { ProviderApiError } from './provider.js';

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';

/** A real Response carrying `body` as JSON — no parse mocking anywhere. */
function jsonFetch(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

const poll = (body: unknown) =>
  pollLeaseUntilReady(
    PROVIDER_URL,
    LEASE_UUID,
    AUTH_TOKEN,
    { intervalMs: 10, timeoutMs: 500 },
    jsonFetch(body),
  );

/**
 * The same failed-provisioning event as each provider era spells it. `expected`
 * is the detail the thrown message must carry.
 */
const ERAS = [
  {
    era: 'pre-ENG-508',
    failure: { last_error: 'OOMKilled' },
    expected: 'OOMKilled',
  },
  {
    era: 'post-ENG-508',
    failure: { reason: 'ImagePullFailed', message: 'image pull failed' },
    expected: 'ImagePullFailed: image pull failed',
  },
] as const;

describe('pollLeaseUntilReady surfaces the failure cause (both wire eras)', () => {
  it.each(ERAS)(
    'reports the cause from a $era provider',
    async ({ failure, expected }) => {
      await expect(
        poll({
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'failed',
          ...failure,
        }),
      ).rejects.toThrow(
        `Lease ${LEASE_UUID} is ACTIVE but provisioning failed: ${expected}`,
      );
    },
  );

  it('carries a reason even when Fred sends no message', async () => {
    // Fred's message is documented as possibly empty; the reason still has to
    // reach the caller, and without a dangling separator.
    await expect(
      poll({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        reason: 'Unknown',
        message: '',
      }),
    ).rejects.toThrow(
      `Lease ${LEASE_UUID} is ACTIVE but provisioning failed: Unknown`,
    );
  });

  it('passes an UNRECOGNIZED reason through rather than swallowing it', async () => {
    // Fred's set is open and add-only: a reason from a newer provider must
    // still reach the operator verbatim.
    await expect(
      poll({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        reason: 'SomeFutureReason',
        message: 'a cause this client has never heard of',
      }),
    ).rejects.toThrow(
      /provisioning failed: SomeFutureReason: a cause this client has never heard of/,
    );
  });

  it('renders no dangling separator when the provider sends no cause at all', async () => {
    let message = '';
    try {
      await poll({ state: 'LEASE_STATE_ACTIVE', provision_status: 'failed' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(
      `Lease ${LEASE_UUID} is ACTIVE but provisioning failed`,
    );
    expect(message).not.toContain('undefined');
    expect(message.endsWith(': ')).toBe(false);
  });

  it('throws ProviderApiError, so existing catchers keep working', async () => {
    await expect(
      poll({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        reason: 'ContainerExited',
      }),
    ).rejects.toBeInstanceOf(ProviderApiError);
  });

  it('RESOLVES a ready lease that carries a rolled-back UpdateFailed reason', async () => {
    // The trap: Fred deliberately retains reason/message on a HEALTHY lease
    // whose last update failed and rolled back to the previous version. Gating
    // readiness on the presence of `reason` would strand every such lease.
    const status = await poll({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'ready',
      reason: 'UpdateFailed',
      message: 'update failed; rolled back',
    });
    expect(status.provision_status).toBe('ready');
    expect(status.reason).toBe('UpdateFailed');
  });
});

describe('the failure pair survives the real parse path', () => {
  it('getLeaseStatus forwards reason/message off the wire', async () => {
    const status = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      jsonFetch({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        fail_count: 3,
        reason: 'ContainerExited',
        message: 'container exited unexpectedly',
      }),
    );
    expect(status.reason).toBe('ContainerExited');
    expect(status.message).toBe('container exited unexpectedly');
  });

  it('getLeaseProvision forwards reason/message off the wire', async () => {
    const provision = await getLeaseProvision(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      jsonFetch({
        status: 'failed',
        fail_count: 2,
        reason: 'ImagePullFailed',
        message: 'image pull failed',
      }),
    );
    expect(provision.reason).toBe('ImagePullFailed');
    expect(provision.message).toBe('image pull failed');
  });

  it('a pre-ENG-508 provider still yields its last_error', async () => {
    const provision = await getLeaseProvision(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      jsonFetch({ status: 'failed', fail_count: 1, last_error: 'OOMKilled' }),
    );
    expect(provision.last_error).toBe('OOMKilled');
    expect(provision.reason).toBeUndefined();
  });
});
