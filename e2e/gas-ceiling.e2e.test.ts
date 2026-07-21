import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * ENG-556: a low COSMOS_MAX_GAS must abort a normal broadcast with
 * GAS_LIMIT_EXCEEDED before signing. `buildGasFee` throws when
 * `ceil(simulate × gasMultiplier)` exceeds the configured ceiling, so no
 * transaction ever reaches the chain — the balance is untouched.
 *
 * Uses its OWN client with a ceiling of 1 gas (the shared chain-tools client
 * has no ceiling). Any real bank send simulates to far more than 1 gas, so the
 * ceiling always trips. The happy-path (no ceiling) is covered by
 * chain-tools.e2e.test.ts; the unit-level ceiling logic lives in
 * packages/core/src/transactions/utils.test.ts.
 */
describe('gas-limit ceiling (COSMOS_MAX_GAS)', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect({
      serverEntry: 'packages/node/dist/chain.js',
      maxGas: '1', // any real tx simulates well above 1 gas
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('aborts cosmos_tx with GAS_LIMIT_EXCEEDED when the estimate exceeds the ceiling', async () => {
    const { address } = await client.callTool<{ address: string }>(
      'get_account_info',
    );

    const err = await client.callToolExpectError('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: [address, '1000umfx'],
      wait_for_confirmation: true,
    });

    expect(err.code).toBe('GAS_LIMIT_EXCEEDED');
    expect(err.tool).toBe('cosmos_tx');
    // buildGasFee attaches { simulatedGas, gasMultiplier, estimatedGas, maxGas };
    // enrichTxError spreads those through, so both survive to the wire.
    const details = err.details as { maxGas?: number; estimatedGas?: number };
    expect(details?.maxGas).toBe(1);
    expect(typeof details?.estimatedGas).toBe('number');
  });
});
