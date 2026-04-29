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
    // Standard cosmos read-only modules wired through the LCD adapter must
    // also be reachable via cosmos_query routing (regression guard for the
    // adapter-vs-registry asymmetry that existed pre-audit).
    expect(queryNames).toEqual(
      expect.arrayContaining(['authz', 'feegrant', 'mint']),
    );
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

  // ------------------------------------------------------------------
  // Routing coverage beyond bank
  //
  // Manifest is a POA chain: staking/gov/distribution are not exercised by
  // the protocol, and `manifest`/`poa` admin txs require a group proposal,
  // so this block focuses on the modules the chain actually uses generically:
  // auth, poa (read-only), tokenfactory, and group.
  // ------------------------------------------------------------------

  it('cosmos_query mint params reaches the chain and returns mint denom', async () => {
    // End-to-end smoke for one of the newly-registered standard cosmos
    // modules (authz/feegrant/mint). Mint is the cleanest probe — no args
    // and a fixed-shape response. POA Manifest still serves x/mint params
    // even though minting is effectively static.
    const result = await client.callTool<{
      result: { params?: { mintDenom: string } };
    }>('cosmos_query', {
      module: 'mint',
      subcommand: 'params',
    });

    expect(result.result.params).toBeDefined();
    expect(typeof result.result.params!.mintDenom).toBe('string');
    expect(result.result.params!.mintDenom.length).toBeGreaterThan(0);
  });

  it('cosmos_query auth account returns the test wallet account', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    const result = await client.callTool<{
      module: string;
      subcommand: string;
      result: { account: { address: string } };
    }>('cosmos_query', {
      module: 'auth',
      subcommand: 'account',
      args: [address],
    });

    expect(result.module).toBe('auth');
    expect(result.subcommand).toBe('account');
    expect(result.result.account.address).toBe(address);
  });

  it('cosmos_query poa authority returns the configured authority', async () => {
    const result = await client.callTool<{
      result: { authority: string };
    }>('cosmos_query', {
      module: 'poa',
      subcommand: 'authority',
    });

    // Authority is the POA admin group-policy address; we don't pin the exact
    // value (it depends on devnet env), just assert the response shape.
    expect(result.result.authority).toMatch(/^manifest1[a-z0-9]+$/);
  });

  it('cosmos_query poa pending-validators returns a list', async () => {
    const result = await client.callTool<{
      result: { pending: unknown[] };
    }>('cosmos_query', {
      module: 'poa',
      subcommand: 'pending-validators',
    });

    expect(Array.isArray(result.result.pending)).toBe(true);
  });

  // Unique subdenom per run — same chain state across reruns means earlier
  // creates persist; collisions would fail MsgCreateDenom.
  const subdenom = `e2e${Date.now()}`;

  it('cosmos_tx tokenfactory create-denom succeeds', async () => {
    const result = await client.callTool<{
      transactionHash: string;
      code: number;
    }>('cosmos_tx', {
      module: 'tokenfactory',
      subcommand: 'create-denom',
      args: [subdenom],
      wait_for_confirmation: true,
    });

    expect(result.transactionHash).toBeTruthy();
    expect(result.code).toBe(0);
  });

  it('cosmos_query tokenfactory denoms-from-creator includes the new denom', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    const result = await client.callTool<{
      result: { denoms: string[] };
    }>('cosmos_query', {
      module: 'tokenfactory',
      subcommand: 'denoms-from-creator',
      args: [address],
    });

    const expected = `factory/${address}/${subdenom}`;
    expect(result.result.denoms).toContain(expected);
  });

  it('cosmos_tx tokenfactory mint credits the test wallet', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');
    const denom = `factory/${address}/${subdenom}`;
    const mintAmount = 12_345n;

    const balanceBefore = await client.callTool<{
      result: { balances: Array<{ denom: string; amount: string }> };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balances',
      args: [address],
    });
    const before = balanceBefore.result.balances.find((b) => b.denom === denom);

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'tokenfactory',
      subcommand: 'mint',
      args: [`${mintAmount}${denom}`, address],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const balanceAfter = await client.callTool<{
      result: { balances: Array<{ denom: string; amount: string }> };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balances',
      args: [address],
    });
    const after = balanceAfter.result.balances.find((b) => b.denom === denom);

    const beforeAmount = before ? BigInt(before.amount) : 0n;
    const afterAmount = after ? BigInt(after.amount) : 0n;
    expect(afterAmount - beforeAmount).toBe(mintAmount);
  });

  it('cosmos_tx group create-group succeeds for a single-member group', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    const result = await client.callTool<{
      transactionHash: string;
      code: number;
    }>('cosmos_tx', {
      module: 'group',
      subcommand: 'create-group',
      // create-group expects [metadata, address:weight, ...members]
      args: ['e2e-test', `${address}:1`],
      wait_for_confirmation: true,
    });

    expect(result.transactionHash).toBeTruthy();
    expect(result.code).toBe(0);
  });

  it('cosmos_estimate_fee tokenfactory create-denom returns gas/fee without broadcasting', async () => {
    const { address } = await client.callTool<{ address: string }>('get_account_info');

    // Snapshot creator's denoms before — estimator must not broadcast.
    const before = await client.callTool<{
      result: { denoms: string[] };
    }>('cosmos_query', {
      module: 'tokenfactory',
      subcommand: 'denoms-from-creator',
      args: [address],
    });

    const probeSubdenom = `est${Date.now()}`;
    const result = await client.callTool<{
      module: string;
      subcommand: string;
      gasEstimate: string;
      fee: { amount: { denom: string; amount: string }[]; gas: string };
    }>('cosmos_estimate_fee', {
      module: 'tokenfactory',
      subcommand: 'create-denom',
      args: [probeSubdenom],
    });

    expect(result.module).toBe('tokenfactory');
    expect(result.subcommand).toBe('create-denom');
    expect(Number(result.gasEstimate)).toBeGreaterThan(0);
    expect(Number(result.fee.gas)).toBeGreaterThanOrEqual(Number(result.gasEstimate));
    expect(result.fee.amount[0].denom).toBe('umfx');

    // No broadcast — denoms list is unchanged.
    const after = await client.callTool<{
      result: { denoms: string[] };
    }>('cosmos_query', {
      module: 'tokenfactory',
      subcommand: 'denoms-from-creator',
      args: [address],
    });
    expect(after.result.denoms).toEqual(before.result.denoms);
  });

  it('list_module_subcommands returns bank tx subcommands', async () => {
    const result = await client.callTool<{
      type: string;
      module: string;
      subcommands: Array<{ name: string }>;
    }>('list_module_subcommands', { type: 'tx', module: 'bank' });

    expect(result.type).toBe('tx');
    expect(result.module).toBe('bank');
    expect(result.subcommands.map((s) => s.name)).toContain('send');
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
