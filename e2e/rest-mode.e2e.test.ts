import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * Live coverage for REST/LCD-only mode and REST-preferred-when-both-set
 * behavior of CosmosClientManager.
 *
 * The CosmosClientManager (packages/core/src/client.ts) supports two modes:
 *   1. Full mode — COSMOS_RPC_URL + COSMOS_GAS_PRICE → queries via RPC
 *      and signing via SigningStargateClient.
 *   2. Query-only mode — COSMOS_REST_URL alone → queries via the LCD
 *      adapter (packages/core/src/lcd-adapter.ts), getSigningClient()
 *      throws INVALID_CONFIG.
 *
 * When *both* are configured, REST is preferred for queries (per
 * CLAUDE.md). This file pins both behaviors:
 *   - REST-only: queries succeed; cosmos_tx surfaces INVALID_CONFIG.
 *   - Both: queries still succeed even when the RPC URL points at a
 *     closed port, proving the LCD path is taken.
 *
 * Notes:
 *   - The chain container exposes LCD on host port 1317.
 *   - The unsupported-module path (`cosmos.orm`, `liftedinit.manifest.v1`)
 *     in lcd-adapter.ts is not reachable through any registered query
 *     module today, so it is not covered here. Adding a test fixture
 *     that registers `cosmos.orm` would be the way to cover it.
 */

const REST_URL = 'http://localhost:1317';
// Closed port — connection refused. Used to prove queries don't fall
// back to RPC when REST is configured.
const UNREACHABLE_RPC = 'http://localhost:1';

describe('REST/LCD mode', () => {
  describe('REST-only (no RPC)', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({
        serverEntry: 'packages/node/dist/chain.js',
        restUrl: REST_URL,
        disableRpc: true,
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it('cosmos_query bank balances returns the same shape as RPC', async () => {
      const { address } = await client.callTool<{ address: string }>(
        'get_account_info',
      );
      const result = await client.callTool<{
        result: { balances: Array<{ denom: string; amount: string }> };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
        args: [address],
      });

      expect(Array.isArray(result.result.balances)).toBe(true);
      expect(result.result.balances.length).toBeGreaterThan(0);
      const umfx = result.result.balances.find((b) => b.denom === 'umfx');
      expect(umfx).toBeDefined();
      expect(BigInt(umfx!.amount)).toBeGreaterThan(0n);
    });

    it('cosmos_query auth account works through the LCD adapter', async () => {
      const { address } = await client.callTool<{ address: string }>(
        'get_account_info',
      );
      const result = await client.callTool<{
        result: { account: { address: string } };
      }>('cosmos_query', {
        module: 'auth',
        subcommand: 'account',
        args: [address],
      });
      expect(result.result.account.address).toBe(address);
    });

    it('cosmos_query tokenfactory params works through the LCD adapter', async () => {
      const result = await client.callTool<{
        result: { params: unknown };
      }>('cosmos_query', { module: 'tokenfactory', subcommand: 'params' });
      expect(result.result.params).toBeDefined();
    });

    it('cosmos_tx throws INVALID_CONFIG (signing requires RPC + gasPrice)', async () => {
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        // Args are valid; the rejection is at the signing-client level,
        // not at the message-building level.
        args: [
          'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct',
          '1000umfx',
        ],
      });
      expect(err.code).toBe('INVALID_CONFIG');
      expect(err.message).toMatch(/rpcUrl|gasPrice|query-only/i);
    });

    it('cosmos_estimate_fee also throws INVALID_CONFIG (needs signing client to simulate)', async () => {
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: [
          'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct',
          '1000umfx',
        ],
      });
      expect(err.code).toBe('INVALID_CONFIG');
    });
  });

  describe('REST + RPC both set — REST preferred for queries', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      // RPC at a closed port would fail any tx attempt — but queries
      // should be unaffected because the manager prefers REST when
      // restUrl is configured.
      await client.connect({
        serverEntry: 'packages/node/dist/chain.js',
        rpcUrl: UNREACHABLE_RPC,
        restUrl: REST_URL,
        gasPrice: '0.01umfx',
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it('cosmos_query succeeds even though RPC is unreachable', async () => {
      const { address } = await client.callTool<{ address: string }>(
        'get_account_info',
      );
      const result = await client.callTool<{
        result: { balances: Array<{ denom: string }> };
      }>('cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
        args: [address],
      });
      expect(Array.isArray(result.result.balances)).toBe(true);
    });

    it('cosmos_tx fails (RPC is unreachable) — confirms RPC is still used for signing', async () => {
      // When both URLs are set, queries go to REST but signing/broadcast
      // still requires RPC. With the RPC port closed, the signing client
      // initialization should surface a transient/connection error.
      let err: unknown;
      try {
        await client.callTool('cosmos_tx', {
          module: 'bank',
          subcommand: 'send',
          args: [
            'manifest1hj5fveer5cjtn4wd6wstzugjfdxzl0xp8ws9ct',
            '1000umfx',
          ],
          wait_for_confirmation: true,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      // The exact code depends on retry classification of connection
      // failures. RPC_CONNECTION_FAILED is the documented one.
      const code = parseToolErrorCode(err);
      expect(code).toMatch(/RPC_CONNECTION_FAILED|TX_FAILED|UNKNOWN/);
    });
  });
});
