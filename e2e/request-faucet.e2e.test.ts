import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Live coverage of the chain server's `request_faucet` tool, which is
 * registered conditionally when `MANIFEST_FAUCET_URL` is set. The faucet
 * sidecar is a CosmJS faucet patched to handle tokenfactory denoms (with
 * slashes) — see e2e/docker/faucet/apply-patches.js.
 *
 * The faucet is configured to drip:
 *   - umfx
 *   - factory/${POA_ADMIN_ADDRESS}/upwr (PWR)
 *
 * Both at FAUCET_CREDIT_AMOUNT_{MFX,PWR} per call (10_000_000 each in the
 * default e2e .env). Cooldown is 0 so multiple drips per address work.
 */

const POA_ADMIN_ADDRESS =
  'manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj';
const PWR_DENOM = `factory/${POA_ADMIN_ADDRESS}/upwr`;
const FAUCET_URL = 'http://localhost:8000';
const DRIP_AMOUNT = 10_000_000n;

interface FaucetResult {
  denom: string;
  success: boolean;
  error?: string;
}

describe('request_faucet', () => {
  // Two clients pointed at the same chain: faucetClient is started with
  // MANIFEST_FAUCET_URL set so the conditional `request_faucet` tool gets
  // registered, queryClient is started without it (default no-faucet
  // chain server) and is used for balance checks before/after each drip.
  // Splitting the work this way also doubles as a sanity check that the
  // conditional registration is per-process: queryClient's tool list
  // does NOT include request_faucet (this is not asserted here — see
  // tool-annotations.e2e.test.ts for the explicit pin).
  const faucetClient = new MCPTestClient();
  const queryClient = new MCPTestClient();

  let address: string;

  beforeAll(async () => {
    await Promise.all([
      faucetClient.connect({
        serverEntry: 'packages/node/dist/chain.js',
        faucetUrl: FAUCET_URL,
      }),
      queryClient.connect({ serverEntry: 'packages/node/dist/chain.js' }),
    ]);
    const acct = await faucetClient.callTool<{ address: string }>(
      'get_account_info',
    );
    address = acct.address;
  });

  afterAll(async () => {
    await Promise.all([faucetClient.close(), queryClient.close()]);
  });

  const queryBalance = async (denom: string): Promise<bigint> => {
    const res = await queryClient.callTool<{
      result: { balance: { amount: string } };
    }>('cosmos_query', {
      module: 'bank',
      subcommand: 'balance',
      args: [address, denom],
    });
    return BigInt(res.result.balance.amount);
  };

  it('listTools includes request_faucet when MANIFEST_FAUCET_URL is set', async () => {
    const tools = await faucetClient.listTools();
    expect(tools).toContain('request_faucet');
  });

  it('request_faucet drips a single requested denom (umfx)', async () => {
    const before = await queryBalance('umfx');

    const result = await faucetClient.callTool<{
      address: string;
      results: FaucetResult[];
    }>('request_faucet', { denom: 'umfx' });

    expect(result.address).toBe(address);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].denom).toBe('umfx');
    expect(result.results[0].success).toBe(true);

    const after = await queryBalance('umfx');
    expect(after - before).toBe(DRIP_AMOUNT);
  });

  it('request_faucet drips a tokenfactory denom (PWR) directly when requested', async () => {
    const before = await queryBalance(PWR_DENOM);

    const result = await faucetClient.callTool<{
      address: string;
      results: FaucetResult[];
    }>('request_faucet', { denom: PWR_DENOM });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].denom).toBe(PWR_DENOM);
    expect(result.results[0].success).toBe(true);

    const after = await queryBalance(PWR_DENOM);
    expect(after - before).toBe(DRIP_AMOUNT);
  });

  it('request_faucet without a denom fans out across every faucet token', async () => {
    const umfxBefore = await queryBalance('umfx');
    const pwrBefore = await queryBalance(PWR_DENOM);

    const result = await faucetClient.callTool<{
      address: string;
      results: FaucetResult[];
    }>('request_faucet');

    expect(result.address).toBe(address);
    // The faucet exposes umfx + PWR — both should be in the results list.
    const denomsReturned = result.results.map((r) => r.denom);
    expect(denomsReturned).toContain('umfx');
    expect(denomsReturned).toContain(PWR_DENOM);
    expect(result.results.every((r) => r.success)).toBe(true);

    const umfxAfter = await queryBalance('umfx');
    const pwrAfter = await queryBalance(PWR_DENOM);
    expect(umfxAfter - umfxBefore).toBe(DRIP_AMOUNT);
    expect(pwrAfter - pwrBefore).toBe(DRIP_AMOUNT);
  });
});
