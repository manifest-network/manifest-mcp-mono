import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * E2E tests for the cosmwasm MCP server (MFX → PWR converter).
 *
 * Requires the Docker devnet to be running with the converter contract
 * deployed by `init_billing.sh`:
 *   docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
 *
 * The contract address is extracted from the chain container's
 * /shared/converter.env by `helpers/global-setup.ts` and passed through
 * MANIFEST_CONVERTER_ADDRESS to the spawned cosmwasm MCP server.
 *
 * Uses two MCP clients: cosmwasm (for the converter tools) and chain
 * (for `cosmos_query bank balances` to assert balance deltas).
 */
describe('Cosmwasm tools', () => {
  const cosmwasmClient = new MCPTestClient();
  const chainClient = new MCPTestClient();

  beforeAll(async () => {
    if (!process.env.MANIFEST_CONVERTER_ADDRESS) {
      throw new Error(
        'MANIFEST_CONVERTER_ADDRESS is not set. The chain container did not produce ' +
          '/shared/converter.env — check the init service logs from ' +
          '`docker compose -f e2e/docker-compose.yml logs init`.',
      );
    }

    await Promise.all([
      cosmwasmClient.connect({ serverEntry: 'packages/node/dist/cosmwasm.js' }),
      chainClient.connect({ serverEntry: 'packages/node/dist/chain.js' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([cosmwasmClient.close(), chainClient.close()]);
  });

  it('listTools returns exactly the two converter tools', async () => {
    const tools = await cosmwasmClient.listTools();
    expect(tools).toContain('get_mfx_to_pwr_rate');
    expect(tools).toContain('convert_mfx_to_pwr');
    expect(tools).toHaveLength(2);
  });

  it('get_mfx_to_pwr_rate returns the configured rate and denoms', async () => {
    const result = await cosmwasmClient.callTool<{
      rate: string;
      source_denom: string;
      target_denom: string;
      paused: boolean;
      converter_address: string;
      preview?: unknown;
    }>('get_mfx_to_pwr_rate');

    expect(result.rate).toBe('0.379');
    expect(result.source_denom).toBe('umfx');
    expect(result.target_denom).toMatch(/^factory\/manifest1[a-z0-9]+\/upwr$/);
    expect(result.paused).toBe(false);
    expect(result.converter_address).toBe(process.env.MANIFEST_CONVERTER_ADDRESS);
    expect(result.preview).toBeUndefined();
  });

  it('get_mfx_to_pwr_rate with amount returns a preview', async () => {
    const result = await cosmwasmClient.callTool<{
      preview: {
        input_amount: string;
        input_denom: string;
        output_amount: string;
        output_denom: string;
      };
    }>('get_mfx_to_pwr_rate', { amount: '1000000' });

    // floor(1_000_000 * 0.379) = 379_000
    expect(result.preview.input_amount).toBe('1000000');
    expect(result.preview.input_denom).toBe('umfx');
    expect(result.preview.output_amount).toBe('379000');
    expect(result.preview.output_denom).toMatch(/^factory\/.*\/upwr$/);
  });

  it('convert_mfx_to_pwr deducts umfx and credits PWR at the configured rate', async () => {
    const { address } = await chainClient.callTool<{ address: string }>(
      'get_account_info',
    );

    const queryBalances = async (): Promise<Map<string, bigint>> => {
      const res = await chainClient.callTool<{
        result: { balances: Array<{ denom: string; amount: string }> };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
        args: [address],
      });
      return new Map(res.result.balances.map((b) => [b.denom, BigInt(b.amount)]));
    };

    const rate = await cosmwasmClient.callTool<{ target_denom: string }>(
      'get_mfx_to_pwr_rate',
    );
    const pwrDenom = rate.target_denom;

    const before = await queryBalances();
    const umfxBefore = before.get('umfx') ?? 0n;
    const pwrBefore = before.get(pwrDenom) ?? 0n;

    const amount = 1_000_000n;
    const result = await cosmwasmClient.callTool<{
      transactionHash: string;
      code: number;
      input: { amount: string; denom: string };
      expected_output: { amount: string; denom: string };
      rate: string;
    }>('convert_mfx_to_pwr', { amount: amount.toString() });

    expect(result.code).toBe(0);
    expect(result.transactionHash).toBeTruthy();
    expect(result.input).toEqual({ amount: amount.toString(), denom: 'umfx' });
    expect(result.expected_output.amount).toBe('379000');
    expect(result.expected_output.denom).toBe(pwrDenom);
    expect(result.rate).toBe('0.379');

    const after = await queryBalances();
    const umfxAfter = after.get('umfx') ?? 0n;
    const pwrAfter = after.get(pwrDenom) ?? 0n;

    // umfx: drops by `amount` plus gas fees (paid in umfx)
    expect(umfxBefore - umfxAfter).toBeGreaterThanOrEqual(amount);

    // PWR: contract mints exactly floor(amount * rate)
    expect(pwrAfter - pwrBefore).toBe(379_000n);
  });
});
