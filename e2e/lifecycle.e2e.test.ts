import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Full deploy lifecycle E2E test.
 *
 * Requires the Docker devnet to be running:
 *   docker compose -f e2e/docker-compose.yml up -d --wait
 *
 * Tests run sequentially — each step depends on previous state.
 */
describe('Deploy lifecycle', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
  });

  // ------------------------------------------------------------------
  // 1. Account info
  // ------------------------------------------------------------------
  it('get_account_info returns a manifest address', async () => {
    const result = await client.callTool<{ address: string }>('get_account_info');
    expect(result.address).toMatch(/^manifest1/);
  });

  // ------------------------------------------------------------------
  // 2. Balance check
  // ------------------------------------------------------------------
  it('get_balance returns initial balances', async () => {
    const result = await client.callTool<{ balances: unknown }>('get_balance');
    expect(result.balances).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 3. Browse catalog
  // ------------------------------------------------------------------
  it('browse_catalog shows providers and SKU tiers', async () => {
    const result = await client.callTool<{
      providers: Array<{ active: boolean }>;
      tiers: Record<string, unknown[]>;
    }>('browse_catalog');

    expect(result.providers.length).toBeGreaterThanOrEqual(1);
    expect(result.providers[0].active).toBe(true);

    const tierNames = Object.keys(result.tiers);
    expect(tierNames).toContain('docker-micro');
  });

  // ------------------------------------------------------------------
  // 4. Fund credits
  // ------------------------------------------------------------------
  it('fund_credits succeeds', async () => {
    const result = await client.callTool<{
      code: number;
      transactionHash: string;
    }>('fund_credits', { amount: '10000000umfx' });

    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // 5. Verify credits
  // ------------------------------------------------------------------
  it('get_balance reflects funded credits', async () => {
    const result = await client.callTool<{
      credits?: { balance?: unknown };
    }>('get_balance');

    expect(result.credits).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 6. Deploy app
  // ------------------------------------------------------------------
  let leaseUuid: string;

  it('deploy_app deploys nginx', async () => {
    const result = await client.callTool<{
      app_name: string;
      lease_uuid: string;
      status: string;
    }>('deploy_app', {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
      app_name: 'e2e-nginx',
    });

    expect(result.app_name).toBe('e2e-nginx');
    expect(result.lease_uuid).toBeTruthy();
    expect(['running', 'ready']).toContain(result.status);

    leaseUuid = result.lease_uuid;
  });

  // ------------------------------------------------------------------
  // 7. List apps
  // ------------------------------------------------------------------
  it('list_apps includes the deployed app', async () => {
    const result = await client.callTool<{
      apps: Array<{ name: string; status: string }>;
    }>('list_apps');

    const app = result.apps.find((a) => a.name === 'e2e-nginx');
    expect(app).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 8. App status
  // ------------------------------------------------------------------
  it('app_status returns chain state and connection info', async () => {
    const result = await client.callTool<{
      name: string;
      status: string;
      chainState: unknown;
    }>('app_status', { name: 'e2e-nginx' });

    expect(result.name).toBe('e2e-nginx');
    expect(result.chainState).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 9. Get logs
  // ------------------------------------------------------------------
  it('get_logs returns log data', async () => {
    const result = await client.callTool<{
      app_name: string;
      logs: unknown;
    }>('get_logs', { name: 'e2e-nginx', tail: 10 });

    expect(result.app_name).toBe('e2e-nginx');
    expect(result.logs).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 10. Restart app
  // ------------------------------------------------------------------
  it('restart_app succeeds', async () => {
    const result = await client.callTool<{
      app_name: string;
      status: string;
    }>('restart_app', { app_name: 'e2e-nginx' });

    expect(result.app_name).toBe('e2e-nginx');
  });

  // ------------------------------------------------------------------
  // 11. Update app
  // ------------------------------------------------------------------
  it('update_app with env succeeds', async () => {
    const result = await client.callTool<{
      app_name: string;
      status: string;
    }>('update_app', {
      app_name: 'e2e-nginx',
      env: { E2E_TEST: 'true' },
    });

    expect(result.app_name).toBe('e2e-nginx');
  });

  // ------------------------------------------------------------------
  // 12. Stop app
  // ------------------------------------------------------------------
  it('stop_app closes the lease', async () => {
    const result = await client.callTool<{
      app_name: string;
      status: string;
    }>('stop_app', { app_name: 'e2e-nginx' });

    expect(result.app_name).toBe('e2e-nginx');
    expect(result.status).toBe('stopped');
  });

  // ------------------------------------------------------------------
  // 13. Verify stopped
  // ------------------------------------------------------------------
  it('list_apps shows app as stopped', async () => {
    const result = await client.callTool<{
      apps: Array<{ name: string; status: string }>;
    }>('list_apps');

    const app = result.apps.find((a) => a.name === 'e2e-nginx');
    expect(app).toBeDefined();
    expect(app!.status).toBe('stopped');
  });
});
