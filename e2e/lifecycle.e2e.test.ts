import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Full deploy lifecycle E2E test.
 *
 * Requires the Docker devnet to be running:
 *   docker compose -f e2e/docker-compose.yml up -d --wait
 *
 * Tests run sequentially — each step depends on previous state.
 * Uses two MCP servers: lease (on-chain operations) and fred (provider operations).
 */
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
  // Provider address (matches ADDR1/PROVIDER_ADDRESS in e2e/.env). Hardcoded
  // here because vitest does not auto-load .env; keep in sync if the devnet
  // provider key ever changes.
  const OTHER_TENANT = 'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct';

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
