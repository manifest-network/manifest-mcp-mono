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
    await client.connect({ serverEntry: 'packages/node/dist/cloud.js' });
  });

  afterAll(async () => {
    await client.close();
  });

  // ------------------------------------------------------------------
  // 1. Balance check (smoke test — confirms wallet/chain connection)
  // ------------------------------------------------------------------
  it('get_balance returns initial balances', async () => {
    const result = await client.callTool<{ balances: unknown }>('get_balance');
    expect(result.balances).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 2. Browse catalog
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
  // 3. Fund credits
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
  // 4. Verify credits
  // ------------------------------------------------------------------
  it('get_balance reflects funded credits', async () => {
    const result = await client.callTool<{
      credits?: { balance?: unknown };
    }>('get_balance');

    expect(result.credits).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 5. Deploy app
  // ------------------------------------------------------------------
  let leaseUuid: string;

  it('deploy_app deploys nginx', async () => {
    const result = await client.callTool<{
      lease_uuid: string;
      provider_uuid: string;
      provider_url: string;
      status: string;
    }>('deploy_app', {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
    });

    expect(result.lease_uuid).toBeTruthy();
    expect(result.provider_uuid).toBeTruthy();
    expect(result.provider_url).toBeTruthy();
    expect(['running', 'ready']).toContain(result.status);

    leaseUuid = result.lease_uuid;
  });

  // ------------------------------------------------------------------
  // 6. List apps
  // ------------------------------------------------------------------
  it('list_apps includes the deployed lease', async () => {
    const result = await client.callTool<{
      leases: Array<{ uuid: string; stateLabel: string }>;
    }>('list_apps', { state: 'active' });

    const lease = result.leases.find((l) => l.uuid === leaseUuid);
    expect(lease).toBeDefined();
    expect(lease!.stateLabel).toBe('active');
  });

  // ------------------------------------------------------------------
  // 7. App status
  // ------------------------------------------------------------------
  it('app_status returns chain state and connection info', async () => {
    const result = await client.callTool<{
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
    const result = await client.callTool<{
      lease_uuid: string;
      logs: unknown;
    }>('get_logs', { lease_uuid: leaseUuid, tail: 10 });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.logs).toBeDefined();
  });

  // ------------------------------------------------------------------
  // 9. Restart app
  // ------------------------------------------------------------------
  it('restart_app succeeds', async () => {
    const result = await client.callTool<{
      lease_uuid: string;
      status: string;
    }>('restart_app', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
  });

  // ------------------------------------------------------------------
  // 10. Update app
  // ------------------------------------------------------------------
  it('update_app with new manifest succeeds', async () => {
    const manifest = JSON.stringify({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
      env: { E2E_TEST: 'true' },
    });

    const result = await client.callTool<{
      lease_uuid: string;
      status: string;
    }>('update_app', {
      lease_uuid: leaseUuid,
      manifest,
    });

    expect(result.lease_uuid).toBe(leaseUuid);
  });

  // ------------------------------------------------------------------
  // 11. Stop app
  // ------------------------------------------------------------------
  it('stop_app closes the lease', async () => {
    const result = await client.callTool<{
      lease_uuid: string;
      status: string;
    }>('stop_app', { lease_uuid: leaseUuid });

    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.status).toBe('stopped');
  });

  // ------------------------------------------------------------------
  // 12. Verify stopped
  // ------------------------------------------------------------------
  it('list_apps shows lease as closed', async () => {
    const result = await client.callTool<{
      leases: Array<{ uuid: string; stateLabel: string }>;
    }>('list_apps', { state: 'closed' });

    const lease = result.leases.find((l) => l.uuid === leaseUuid);
    expect(lease).toBeDefined();
    expect(lease!.stateLabel).toBe('closed');
  });

  // ------------------------------------------------------------------
  // 13. Verify tool list
  // ------------------------------------------------------------------
  it('listTools returns all expected cloud tools', async () => {
    const tools = await client.listTools();

    expect(tools).toContain('browse_catalog');
    expect(tools).toContain('get_balance');
    expect(tools).toContain('fund_credits');
    expect(tools).toContain('list_apps');
    expect(tools).toContain('app_status');
    expect(tools).toContain('get_logs');
    expect(tools).toContain('deploy_app');
    expect(tools).toContain('stop_app');
    expect(tools).toContain('restart_app');
    expect(tools).toContain('update_app');
    expect(tools).toHaveLength(10);
  });
});
