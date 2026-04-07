import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Chain-only E2E tests for base tools.
 *
 * Requires at least the chain service to be running:
 *   docker compose -f e2e/docker-compose.yml up -d --wait
 */
describe('Chain tools', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
  });

  afterAll(async () => {
    await client.close();
  });

  it('get_account_info returns address and key name', async () => {
    const result = await client.callTool<{ address: string }>('get_account_info');
    expect(result.address).toMatch(/^manifest1/);
  });

  it('list_modules returns query and tx modules', async () => {
    const result = await client.callTool<{
      queryModules: Array<{ name: string; description: string }>;
      txModules: Array<{ name: string; description: string }>;
    }>('list_modules');

    const queryNames = result.queryModules.map((m) => m.name);
    const txNames = result.txModules.map((m) => m.name);
    expect(queryNames).toContain('bank');
    expect(txNames).toContain('bank');
  });

  it('list_module_subcommands returns bank query subcommands', async () => {
    const result = await client.callTool<{
      type: string;
      module: string;
      subcommands: Array<{ name: string; description: string }>;
    }>('list_module_subcommands', { type: 'query', module: 'bank' });

    const subNames = result.subcommands.map((s) => s.name);
    expect(subNames).toContain('balances');
  });

  it('cosmos_query bank balances returns account balances', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    const result = await client.callTool<{
      module: string;
      subcommand: string;
      result: { balances: Array<{ denom: string; amount: string }> };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balances',
      args: [address],
    });

    expect(result.module).toBe('bank');
    expect(result.result.balances.length).toBeGreaterThan(0);

    const umfx = result.result.balances.find((b) => b.denom === 'umfx');
    expect(umfx).toBeDefined();
    expect(Number(umfx!.amount)).toBeGreaterThan(0);
  });

  it('cosmos_tx bank send transfers tokens to self', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    const result = await client.callTool<{
      transactionHash: string;
      code: number;
    }>('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
      wait_for_confirmation: true,
    });

    expect(result.transactionHash).toBeTruthy();
    expect(result.code).toBe(0);
  });

  it('cosmos_estimate_fee bank send returns gas/fee without broadcasting', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    // Query balance before
    const balanceBefore = await client.callTool<{
      result: { balances: { denom: string; amount: string }[] };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balances',
      args: [address],
    });
    const umfxBefore = balanceBefore.result.balances.find(
      (b) => b.denom === 'umfx',
    );

    const result = await client.callTool<{
      module: string;
      subcommand: string;
      gasEstimate: string;
      fee: { amount: { denom: string; amount: string }[]; gas: string };
    }>('cosmos_estimate_fee', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
    });

    expect(result.module).toBe('bank');
    expect(result.subcommand).toBe('send');
    expect(Number(result.gasEstimate)).toBeGreaterThan(0);
    expect(Number(result.fee.gas)).toBeGreaterThanOrEqual(
      Number(result.gasEstimate),
    );
    expect(result.fee.amount[0].denom).toBe('umfx');

    // Query balance after — should be unchanged (no broadcast)
    const balanceAfter = await client.callTool<{
      result: { balances: { denom: string; amount: string }[] };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balances',
      args: [address],
    });
    const umfxAfter = balanceAfter.result.balances.find(
      (b) => b.denom === 'umfx',
    );
    expect(umfxAfter?.amount).toBe(umfxBefore?.amount);
  });

  it('listTools returns all expected chain tools', async () => {
    const tools = await client.listTools();

    expect(tools).toContain('get_account_info');
    expect(tools).toContain('cosmos_query');
    expect(tools).toContain('cosmos_tx');
    expect(tools).toContain('cosmos_estimate_fee');
    expect(tools).toContain('list_modules');
    expect(tools).toContain('list_module_subcommands');
    expect(tools).toHaveLength(6);
  });
});
