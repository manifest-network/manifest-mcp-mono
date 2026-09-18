import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitDevnetMaintenance } from '../examples/sdk-acceptance/src/maintenance-admission.js';
import { assertWireKeys } from './helpers/fred-wire-golden.js';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Full deploy lifecycle E2E test.
 *
 * Prepare prerequisites and images using docs/e2e-setup.md, then start the devnet:
 *   bash e2e/scripts/devnet.sh up
 *
 * Tests run sequentially — each step depends on previous state.
 * Uses two MCP servers: lease (on-chain operations) and fred (provider operations).
 */
// Provider address (matches ADDR1/PROVIDER_ADDRESS in e2e/.env). Hardcoded
// here because vitest does not auto-load .env; keep in sync if the devnet
// provider key ever changes. Hoisted to module scope so it can be referenced
// from earlier tests (get_providers) as well as the tenant-override tests.
const OTHER_TENANT = 'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct';

interface ReleaseSnapshot {
  release_count: number;
  releases: Array<{ version: number; status: string }>;
}

function expectNewActiveRelease(
  before: ReleaseSnapshot,
  after: ReleaseSnapshot,
) {
  expect(after.release_count).toBe(before.release_count + 1);
  const newest = [...after.releases].sort((a, b) => b.version - a.version)[0];
  expect(newest?.status).toBe('active');
  expect(newest?.version).toBeGreaterThan(
    Math.max(0, ...before.releases.map((release) => release.version)),
  );
}

describe('Deploy lifecycle', () => {
  const leaseClient = new MCPTestClient();
  const fredClient = new MCPTestClient();

  // The restart test waits three times: 3 × 55s leaves 135s of the 300s
  // test budget for submissions and release assertions. The tool expires first
  // so its diagnostic reaches the client before the MCP request deadline.
  const waitForMaintenanceReady = (uuid: string) =>
    fredClient.callTool(
      'wait_for_app_ready',
      { lease_uuid: uuid, timeout_seconds: 45, interval_seconds: 2 },
      { timeoutMs: 55_000 },
    );

  const submitMaintenance = <T>(
    operation: 'restart' | 'update',
    input: Record<string, unknown>,
    before: ReleaseSnapshot,
  ) =>
    submitDevnetMaintenance<T>({
      operation,
      createKey: () => crypto.randomUUID(),
      submit: (key) =>
        fredClient.callTool(`${operation}_app`, {
          ...input,
          idempotency_key: key,
        }),
      reconcile: async () => {
        const status = await fredClient.callTool<{
          fredStatus?: { provision_status?: string };
        }>('app_status', { lease_uuid: input.lease_uuid });
        const current = await fredClient.callTool<ReleaseSnapshot>(
          'app_releases',
          { lease_uuid: input.lease_uuid },
        );
        return (
          status.fredStatus?.provision_status === 'ready' &&
          JSON.stringify(current) === JSON.stringify(before)
        );
      },
    });

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([leaseClient.close(), fredClient.close()]);
  });

  // ------------------------------------------------------------------
  // 1. Balance check (smoke test — confirms wallet/chain connection)
  // ------------------------------------------------------------------
  it('credit_balance returns initial balances', async () => {
    const result = await leaseClient.callTool<{ balances: unknown }>(
      'credit_balance',
    );
    expect(result.balances).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 2. Browse catalog
  // ------------------------------------------------------------------
  it('browse_catalog shows providers and SKUs', async () => {
    const result = await fredClient.callTool<{
      providers: unknown[];
      skus: Array<{
        name: string;
        sku_uuid: string;
        provider_uuid: string;
        provider_url: string | null;
        price: string | null;
        unit: string | null;
        active: boolean;
      }>;
    }>('browse_catalog');

    expect(result.providers.length).toBeGreaterThanOrEqual(1);
    expect(result.skus.length).toBeGreaterThan(0);
    expect(result.skus.map((s) => s.name)).toContain('docker-micro');
  });

  it('get_providers lists registered providers (default: active only)', async () => {
    const result = await leaseClient.callTool<{
      providers: Array<{ uuid: string; address: string; active: boolean }>;
    }>('get_providers');

    expect(result.providers.length).toBeGreaterThanOrEqual(1);
    // All returned providers should be active by default.
    expect(result.providers.every((p) => p.active)).toBe(true);
    // The provider registered by init_billing.sh must appear.
    expect(
      result.providers.find((p) => p.address === OTHER_TENANT),
    ).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 3. Fund credits (discovers SKU pricing denom via get_skus)
  // ------------------------------------------------------------------
  it('fund_credit succeeds', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    expect(micro).toBeDefined();
    const skuDenom = micro!.basePrice.denom;

    const result = await leaseClient.callTool<{
      code: number;
      transactionHash: string;
    }>('fund_credit', { amount: `10000000${skuDenom}` });

    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // 4. Verify credits
  // ------------------------------------------------------------------
  it('credit_balance reflects funded credits', async () => {
    const result = await leaseClient.callTool<{
      credits?: { balance?: unknown };
    }>('credit_balance');

    expect(result.credits).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 5. Deploy app
  // ------------------------------------------------------------------
  let leaseUuid: string;

  it('deploy_app deploys nginx', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      provider_uuid: string;
      provider_url: string;
      state: LeaseState;
    }>('deploy_app', {
      image: 'nginxinc/nginx-unprivileged:alpine',
      port: 8080,
      size: 'docker-micro',
    });

    expect(result.lease_uuid).toBeTruthy();
    expect(result.provider_uuid).toBeTruthy();
    expect(result.provider_url).toBeTruthy();
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);

    leaseUuid = result.lease_uuid;
  });

  // ------------------------------------------------------------------
  // 6. List leases
  // ------------------------------------------------------------------
  it('leases_by_tenant includes the deployed lease', async () => {
    const result = await leaseClient.callTool<{
      leases: Array<{ uuid: string; stateLabel: string }>;
    }>('leases_by_tenant', { state: 'active' });

    const lease = result.leases.find((l) => l.uuid === leaseUuid);
    expect(lease).toBeDefined();
    expect(lease!.stateLabel).toBe('active');
  });

  // ------------------------------------------------------------------
  // 6b. Tenant overrides — same wiring, different target account
  // ------------------------------------------------------------------

  it('fund_credit funds a different tenant when `tenant` is provided', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    const skuDenom = micro!.basePrice.denom;

    const result = await leaseClient.callTool<{
      sender: string;
      tenant: string;
      amount: string;
      code: number;
      transactionHash: string;
    }>('fund_credit', {
      amount: `1000000${skuDenom}`,
      tenant: OTHER_TENANT,
    });

    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
    expect(result.tenant).toBe(OTHER_TENANT);
    expect(result.sender).not.toBe(OTHER_TENANT);
  });

  it('credit_balance queries a different tenant when `tenant` is provided', async () => {
    const result = await leaseClient.callTool<{
      credits?: unknown;
      balances: unknown;
    }>('credit_balance', { tenant: OTHER_TENANT });

    expect(result.balances).toBeDefined();
  });

  it('leases_by_tenant lists a different tenant when `tenant` is provided', async () => {
    const result = await leaseClient.callTool<{
      leases: Array<{ uuid: string }>;
    }>('leases_by_tenant', { tenant: OTHER_TENANT });

    expect(result.leases.find((l) => l.uuid === leaseUuid)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // 7. App status
  // ------------------------------------------------------------------
  it('app_status returns chain state and connection info', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      chainState: unknown;
      fredStatus?: Record<string, unknown>;
    }>('app_status', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.chainState).toBeDefined();
    // fredStatus is a looseObject fed from the raw provider response, so these
    // are Fred's own keys — the closest thing this suite has to a direct
    // observation of the wire contract (ENG-638).
    expect(result.fredStatus).toBeDefined();
    assertWireKeys('status', Object.keys(result.fredStatus ?? {}));
  });

  it('app_diagnostics returns provision diagnostics for the active lease', async () => {
    const result = await fredClient.callTool<Record<string, unknown>>(
      'app_diagnostics',
      { lease_uuid: leaseUuid },
    );

    expect(result.lease_uuid).toBe(leaseUuid);
    assertWireKeys('diagnostics_projection', Object.keys(result));
  });

  // ------------------------------------------------------------------
  // 8. Get logs
  // ------------------------------------------------------------------
  it('get_logs returns log data', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      logs: unknown;
    }>('get_logs', { lease_uuid: leaseUuid, tail: 10 });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.logs).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 9. Update app
  // ------------------------------------------------------------------
  it('update_app with new manifest succeeds and returns its command key', async () => {
    const beforeUpdate = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    const manifest = JSON.stringify({
      image: 'nginxinc/nginx-unprivileged:alpine',
      ports: { '8080/tcp': {} },
      env: { E2E_TEST: 'true' },
    });

    const result = await submitMaintenance<{
      lease_uuid: string;
      status: string;
      idempotency_key: string;
    }>(
      'update',
      {
        lease_uuid: leaseUuid,
        manifest,
      },
      beforeUpdate,
    );

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await waitForMaintenanceReady(leaseUuid);
    const afterUpdate = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    expectNewActiveRelease(beforeUpdate, afterUpdate);
  });

  it('update_app merges config and replays an exact command without a new release', async () => {
    const beforeUpdate = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    const input = {
      lease_uuid: leaseUuid,
      existing_manifest: JSON.stringify({
        image: 'nginxinc/nginx-unprivileged:alpine',
        ports: { '8080/tcp': {} },
        env: { E2E_TEST: 'true' },
      }),
      manifest: JSON.stringify({
        image: 'nginxinc/nginx-unprivileged:alpine',
        env: { E2E_MERGE: 'merged' },
      }),
    };
    const result = await submitMaintenance<{
      lease_uuid: string;
      idempotency_key: string;
    }>('update', input, beforeUpdate);
    expect(result.lease_uuid).toBe(leaseUuid);
    const idempotencyKey = result.idempotency_key;
    const exactInput = { ...input, idempotency_key: idempotencyKey };
    await waitForMaintenanceReady(leaseUuid);
    const beforeReplay = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    // Ready also describes a successful rollback; require this new release to
    // be active before testing that a replay leaves release history unchanged.
    expectNewActiveRelease(beforeUpdate, beforeReplay);

    const replay = await fredClient.callTool<{ idempotency_key: string }>(
      'update_app',
      exactInput,
    );
    expect(replay.idempotency_key).toBe(idempotencyKey);
    await waitForMaintenanceReady(leaseUuid);
    const afterReplay = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    expect(afterReplay.releases).toEqual(beforeReplay.releases);
    expect(afterReplay.release_count).toBe(beforeReplay.release_count);

    // Same identity with different bytes must never become a second command.
    const conflict = await fredClient.callToolExpectError('update_app', {
      ...exactInput,
      manifest: JSON.stringify({
        image: 'nginxinc/nginx-unprivileged:alpine',
        env: { E2E_MERGE: 'different' },
      }),
    });
    expect(conflict.code).toBe('MAINTENANCE_REQUEST_FAILED');
    expect(conflict.message).toContain(
      'Idempotency-Key conflicts with a prior maintenance command',
    );
    expect(conflict.details).toMatchObject({
      provider_status: 409,
      idempotency_key: idempotencyKey,
    });
  });

  it('app_releases lists at least one release after update_app', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      releases: Array<Record<string, unknown>>;
      release_count: number;
      truncated: boolean;
    }>('app_releases', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.releases.length).toBeGreaterThan(0);
    expect(result.release_count).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    // Release elements are forwarded through a looseObject, so these are
    // Fred's own keys — a real observation of the wire (ENG-638).
    for (const release of result.releases) {
      assertWireKeys('release', Object.keys(release));
      expect(release).not.toHaveProperty('manifest');
    }
    // `not.toHaveProperty('manifest')` alone would pass just as happily if Fred had
    // STOPPED sending the blob — it cannot tell "mono stripped it" from "it was never
    // there". `manifest_bytes` is derived only from a present, valid, non-empty base64
    // manifest, so a positive value is the observation that the wire really carried it
    // and mono removed it (ENG-669).
    expect(
      result.releases.some(
        (r) => typeof r.manifest_bytes === 'number' && r.manifest_bytes > 0,
      ),
    ).toBe(true);
  });

  it('restart_app creates one active release and preserves it on exact replay', async () => {
    await waitForMaintenanceReady(leaseUuid);
    const beforeRestart = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    const input = {
      lease_uuid: leaseUuid,
    };
    const result = await submitMaintenance<{
      lease_uuid: string;
      idempotency_key: string;
    }>('restart', input, beforeRestart);
    expect(result.lease_uuid).toBe(leaseUuid);
    const exactInput = { ...input, idempotency_key: result.idempotency_key };
    await waitForMaintenanceReady(leaseUuid);
    const beforeReplay = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    expectNewActiveRelease(beforeRestart, beforeReplay);
    const replay = await fredClient.callTool<{ idempotency_key: string }>(
      'restart_app',
      exactInput,
    );
    expect(replay.idempotency_key).toBe(exactInput.idempotency_key);
    await waitForMaintenanceReady(leaseUuid);
    const afterReplay = await fredClient.callTool<ReleaseSnapshot>(
      'app_releases',
      { lease_uuid: leaseUuid },
    );
    expect(afterReplay.releases).toEqual(beforeReplay.releases);
    expect(afterReplay.release_count).toBe(beforeReplay.release_count);
  });

  // ------------------------------------------------------------------
  // 10. Close lease
  // ------------------------------------------------------------------
  it('close_lease closes the lease', async () => {
    const result = await leaseClient.callTool<{
      lease_uuid: string;
      outcome: string;
      lease_state: string;
    }>('close_lease', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.outcome).toBe('stopped');
    expect(result.lease_state).toBe('LEASE_STATE_CLOSED');
  });

  // ------------------------------------------------------------------
  // 11. Verify stopped
  // ------------------------------------------------------------------
  it('leases_by_tenant shows lease as closed', async () => {
    const result = await leaseClient.callTool<{
      leases: Array<{ uuid: string; stateLabel: string }>;
    }>('leases_by_tenant', { state: 'closed' });

    const lease = result.leases.find((l) => l.uuid === leaseUuid);
    expect(lease).toBeDefined();
    expect(lease!.stateLabel).toBe('closed');
  });

  // ------------------------------------------------------------------
  // 12. Verify tool lists
  // ------------------------------------------------------------------
  it('lease server lists all expected tools', async () => {
    const tools = await leaseClient.listTools();

    expect(tools).toContain('credit_balance');
    expect(tools).toContain('fund_credit');
    expect(tools).toContain('leases_by_tenant');
    expect(tools).toContain('close_lease');
    expect(tools).toContain('set_item_custom_domain');
    expect(tools).toContain('lease_by_custom_domain');
    expect(tools).toContain('get_skus');
    expect(tools).toContain('get_providers');
    expect(tools).toHaveLength(8);
  });

  it('fred server lists all expected tools', async () => {
    const tools = await fredClient.listTools();

    expect(tools).toContain('browse_catalog');
    expect(tools).toContain('deploy_app');
    expect(tools).toContain('app_status');
    expect(tools).toContain('get_logs');
    expect(tools).toContain('restart_app');
    expect(tools).toContain('update_app');
    expect(tools).toContain('app_diagnostics');
    expect(tools).toContain('app_releases');
    expect(tools).toContain('wait_for_app_ready');
    expect(tools).toContain('build_manifest_preview');
    expect(tools).toContain('check_deployment_readiness');
    expect(tools).toContain('restore_app');
    expect(tools).toHaveLength(12);
  });
});
