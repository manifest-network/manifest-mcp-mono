import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * ENG-604 phase 2 — end-to-end restore roundtrip.
 *
 * Proves the two cross-system assumptions the restoreApp unit tests can only
 * mock: (1) a fresh lease built from the source's reused metaHash is accepted
 * and the provider ADOPTS the retained volume (data survives), and (2) closing
 * releases reserved credit. Requires a retention-capable devnet (docker-small
 * is stateful, docker-backend on XFS pquota with retain_on_close — see
 * e2e/scripts/init_billing.sh + docker-compose.yml).
 *
 * The saga's failure/compensation branches (terminal-4xx→cancel, 503→retryable,
 * in-doubt→orphan) are covered deterministically by restoreApp.test.ts with
 * mocked provider responses and are DELIBERATELY not reproduced here: an e2e
 * gate must not depend on a TOCTOU race to force a mid-saga rollback (design
 * spec §5). The one deterministic negative — restore of a non-retained source
 * → RESTORE_NOT_RETAINED with zero side effects — IS covered below.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CreditBalance {
  credits?: {
    active_leases: string;
    reserved_amounts: Array<{ denom: string; amount: string }>;
  };
}

describe('Restore roundtrip (ENG-604)', () => {
  const leaseClient = new MCPTestClient();
  const fredClient = new MCPTestClient();

  let skuDenom: string;
  let sourceUuid: string;
  let restoredUuid: string;
  let negativeUuid: string | undefined;

  const reserved = (b: CreditBalance) =>
    b.credits?.reserved_amounts?.find((c) => c.denom === skuDenom)?.amount ?? '0';

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);
  });

  afterAll(async () => {
    // Best-effort cleanup of leases left ACTIVE (the golden source is already
    // closed on-chain; the restored lease and the negative-path lease are not).
    // The suite shares one wallet + devnet, so a leaked reservation/container
    // could perturb later e2e files.
    for (const uuid of [restoredUuid, negativeUuid]) {
      if (!uuid) continue;
      try {
        await leaseClient.callTool('close_lease', { lease_uuid: uuid });
      } catch {
        /* best-effort */
      }
    }
    await Promise.all([leaseClient.close(), fredClient.close()]);
  });

  it('funds credit', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const small = skus.skus.find((s) => s.name === 'docker-small');
    expect(small).toBeDefined();
    skuDenom = small!.basePrice.denom; // all SKUs share the PWR denom
    const r = await leaseClient.callTool<{ code: number }>('fund_credit', {
      amount: `50000000${skuDenom}`,
    });
    expect(r.code).toBe(0);
  });

  it('deploys a stateful redis and writes a persistent marker (MARKER_COUNT=1)', async () => {
    const r = await fredClient.callTool<{ lease_uuid: string; state: LeaseState }>(
      'deploy_app',
      {
        image: 'redis:7', // declares VOLUME /data → a managed, retainable volume at disk_mb>0
        port: 6379,
        size: 'docker-small',
        command: [
          'sh',
          '-c',
          'echo boot >> /data/boots.log; echo "MARKER_COUNT=$(wc -l < /data/boots.log)"; exec sleep 3600',
        ],
      },
    );
    expect(r.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    sourceUuid = r.lease_uuid;
    const logs = await fredClient.callTool<{ logs: unknown }>('get_logs', {
      lease_uuid: sourceUuid,
      tail: 20,
    });
    expect(JSON.stringify(logs.logs)).toContain('MARKER_COUNT=1');
  });

  it('closes with retention and releases reserved credit (single-shot, on-chain)', async () => {
    const before = await leaseClient.callTool<CreditBalance>('credit_balance');
    const c = await leaseClient.callTool<{ lease_state: string }>('close_lease', {
      lease_uuid: sourceUuid,
    });
    expect(c.lease_state).toBe('LEASE_STATE_CLOSED');
    const after = await leaseClient.callTool<CreditBalance>('credit_balance');
    expect(BigInt(reserved(after))).toBeLessThan(BigInt(reserved(before)));
  });

  it('surfaces retained metadata once the async deprovision completes', async () => {
    // Provider retain is async vs the on-chain close — poll (container_stop_timeout:1s
    // keeps this within seconds; bound clears the 30s reconciler fallback). Not
    // wait_for_app_ready: a CLOSED-retained lease never reaches ACTIVE.
    let fredStatus: { retained_until?: string; restore_hint?: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const st = await fredClient.callTool<{
        fredStatus?: { retained_until?: string; restore_hint?: string };
      }>('app_status', { lease_uuid: sourceUuid });
      if (st.fredStatus?.retained_until) {
        fredStatus = st.fredStatus;
        break;
      }
      await sleep(2000);
    }
    expect(fredStatus?.retained_until).toBeTruthy();
    expect(fredStatus?.restore_hint).toBeTruthy();
  });

  it('restores onto a fresh lease; the marker data survived (MARKER_COUNT=2)', async () => {
    const r = await fredClient.callTool<{ lease_uuid: string; status: string }>(
      'restore_app',
      { source_lease_uuid: sourceUuid },
    );
    expect(r.status).toBe('provisioning'); // pollOptions:false → returns immediately
    restoredUuid = r.lease_uuid;
    const ready = await fredClient.callTool<{ state: string }>('wait_for_app_ready', {
      lease_uuid: restoredUuid,
      timeout_seconds: 120,
      interval_seconds: 3,
    });
    expect(ready.state).toBe('LEASE_STATE_ACTIVE');
    const logs = await fredClient.callTool<{ logs: unknown }>('get_logs', {
      lease_uuid: restoredUuid,
      tail: 20,
    });
    // Adopted volume already had boots.log (1 line) → this boot appends → 2.
    // A fresh (non-adopted) volume would show MARKER_COUNT=1.
    expect(JSON.stringify(logs.logs)).toContain('MARKER_COUNT=2');
  });

  it('leaves the source lease closed', async () => {
    const closed = await leaseClient.callTool<{
      leases: Array<{ uuid: string; stateLabel: string }>;
    }>('leases_by_tenant', { state: 'closed' });
    expect(closed.leases.find((l) => l.uuid === sourceUuid)?.stateLabel).toBe('closed');
  });

  it('restore_app on a non-retained (ACTIVE) source → RESTORE_NOT_RETAINED, zero side effects', async () => {
    // A still-ACTIVE ephemeral lease: /provision returns 2xx status!=='retained'
    // → the pre-flight guard throws RESTORE_NOT_RETAINED BEFORE createLease, so
    // no lease is created and no credit reserved. (A closed-then-deprovisioned
    // lease would 404 instead — design spec §6.) Do NOT close it first.
    const dep = await fredClient.callTool<{ lease_uuid: string; state: LeaseState }>(
      'deploy_app',
      { image: 'nginxinc/nginx-unprivileged:alpine', port: 8080, size: 'docker-micro' },
    );
    expect(dep.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    negativeUuid = dep.lease_uuid;

    const beforeLeases = await leaseClient.callTool<{ leases: unknown[] }>(
      'leases_by_tenant',
      { state: 'active' },
    );
    const beforeCredit = await leaseClient.callTool<CreditBalance>('credit_balance');

    const err = await fredClient.callToolExpectError('restore_app', {
      source_lease_uuid: negativeUuid,
    });
    expect(err.code).toBe('RESTORE_NOT_RETAINED');

    const afterLeases = await leaseClient.callTool<{ leases: unknown[] }>(
      'leases_by_tenant',
      { state: 'active' },
    );
    const afterCredit = await leaseClient.callTool<CreditBalance>('credit_balance');
    expect(afterLeases.leases.length).toBe(beforeLeases.leases.length); // no lease created
    expect(reserved(afterCredit)).toBe(reserved(beforeCredit)); // no credit reserved
  });
});
