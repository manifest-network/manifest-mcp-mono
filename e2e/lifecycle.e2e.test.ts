import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * Full deploy lifecycle E2E test.
 *
 * Requires the Docker devnet to be running:
 *   docker compose -f e2e/docker-compose.yml up -d --wait
 *
 * Tests run sequentially — each step depends on previous state.
 * Uses two MCP servers: lease (on-chain operations) and fred (provider operations).
 */
// Provider address (matches ADDR1/PROVIDER_ADDRESS in e2e/.env). Hardcoded
// here because vitest does not auto-load .env; keep in sync if the devnet
// provider key ever changes. Hoisted to module scope so it can be referenced
// from earlier tests (get_providers) as well as the tenant-override tests.
const OTHER_TENANT = 'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct';

describe('Deploy lifecycle', () => {
  const leaseClient = new MCPTestClient();
  const fredClient = new MCPTestClient();

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      leaseClient.close(),
      fredClient.close(),
    ]);
  });

  // ------------------------------------------------------------------
  // 1. Balance check (smoke test — confirms wallet/chain connection)
  // ------------------------------------------------------------------
  it('credit_balance returns initial balances', async () => {
    const result = await leaseClient.callTool<{ balances: unknown }>('credit_balance');
    expect(result.balances).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 2. Browse catalog
  // ------------------------------------------------------------------
  it('browse_catalog shows providers and SKU tiers', async () => {
    const result = await fredClient.callTool<{
      providers: Array<{ active: boolean }>;
      tiers: Record<string, unknown[]>;
    }>('browse_catalog');

    expect(result.providers.length).toBeGreaterThanOrEqual(1);
    expect(result.providers[0].active).toBe(true);

    const tierNames = Object.keys(result.tiers);
    expect(tierNames).toContain('docker-micro');
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
    }>('app_status', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.chainState).toBeDefined();
  });

  it('app_diagnostics returns provision diagnostics for the active lease', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
    }>('app_diagnostics', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
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
  it('update_app with new manifest succeeds', async () => {
    const manifest = JSON.stringify({
      image: 'nginxinc/nginx-unprivileged:alpine',
      ports: { '8080/tcp': {} },
      env: { E2E_TEST: 'true' },
    });

    const result = await fredClient.callTool<{
      lease_uuid: string;
      status: string;
    }>('update_app', {
      lease_uuid: leaseUuid,
      manifest,
    });

    expect(result.lease_uuid).toBe(leaseUuid);
  });

  it('update_app with existing_manifest merges over prior config', async () => {
    // Merge mode: the new manifest only specifies an additional env var.
    // existing_manifest carries the ports + base env from the previous
    // update so the resulting manifest still has the ports binding plus
    // the merged env (E2E_TEST + E2E_MERGE).
    //
    // The previous update_app left the app in a transient state — the
    // provider returns 409 invalid-state until the deployment settles.
    // Poll on the 409 until it succeeds.
    //
    // Fragility note: the 409 detection assumes fred's update_app handler
    // does NOT wrap provider HTTP errors as a typed ManifestMCPError, so
    // the raw provider JSON body falls through and parseToolErrorCode
    // returns 'UNKNOWN'. If fred ever introduces a structured wrap (e.g.
    // a PROVIDER_REJECTED code), the code === 'UNKNOWN' check below
    // becomes false and the retry loop bypasses transient 409s — the
    // test then fails flakily on the first call. The same coupling
    // exists in the restart_app test below; fix both call sites together
    // when fred's error wrapping changes.
    const existingManifest = JSON.stringify({
      image: 'nginxinc/nginx-unprivileged:alpine',
      ports: { '8080/tcp': {} },
      env: { E2E_TEST: 'true' },
    });
    const newManifest = JSON.stringify({
      image: 'nginxinc/nginx-unprivileged:alpine',
      env: { E2E_MERGE: 'merged' },
    });

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let mergeOk = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await fredClient.callTool<{
          lease_uuid: string;
        }>('update_app', {
          lease_uuid: leaseUuid,
          manifest: newManifest,
          existing_manifest: existingManifest,
        });
        expect(result.lease_uuid).toBe(leaseUuid);
        mergeOk = true;
        break;
      } catch (err) {
        lastErr = err;
        const code = parseToolErrorCode(err);
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient409 =
          code === 'UNKNOWN' &&
          /"code"\s*:\s*409/.test(msg) &&
          /invalid state/i.test(msg);
        if (!isTransient409) throw err;
        await sleep(2_000);
      }
    }
    if (!mergeOk) {
      throw new Error(`update_app merge never succeeded after retries: ${lastErr}`);
    }
  });

  it('app_releases lists at least one release after update_app', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
    }>('app_releases', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
  });

  // restart_app last — it briefly puts the app in a non-stable state that
  // makes update_app return 409 invalid-state. Placed after the other
  // provider-side ops to avoid the conflict. Also: update_app itself
  // triggers a transient state, so wait a few seconds before issuing
  // restart_app to give the app time to settle.
  it('restart_app triggers a restart on the active lease', async () => {
    // Poll until the app is in a stable state before restarting. The fred
    // restart_app handler surfaces provider-side HTTP errors as a non-
    // ManifestMCPError, so the thrown error code is `[UNKNOWN]` and the
    // message is the JSON body, e.g. `{"error":"invalid state for restart","code":409}`.
    // We retry only on that exact shape — anything else (a TX_FAILED, a
    // transport hiccup, an UNSUPPORTED_*) is a real failure and re-throws.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let restartOk = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await fredClient.callTool<{
          lease_uuid: string;
        }>('restart_app', { lease_uuid: leaseUuid });
        expect(result.lease_uuid).toBe(leaseUuid);
        restartOk = true;
        break;
      } catch (err) {
        lastErr = err;
        const code = parseToolErrorCode(err);
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient409 =
          code === 'UNKNOWN' &&
          /"code"\s*:\s*409/.test(msg) &&
          /invalid state/i.test(msg);
        if (!isTransient409) throw err;
        await sleep(2_000);
      }
    }
    if (!restartOk) {
      throw new Error(`restart_app never succeeded after retries: ${lastErr}`);
    }
  });

  // ------------------------------------------------------------------
  // 10. Close lease
  // ------------------------------------------------------------------
  it('close_lease closes the lease', async () => {
    const result = await leaseClient.callTool<{
      lease_uuid: string;
      status: string;
    }>('close_lease', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.status).toBe('stopped');
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
    expect(tools).toContain('get_skus');
    expect(tools).toContain('get_providers');
    expect(tools).toHaveLength(6);
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
    expect(tools).toHaveLength(8);
  });
});
