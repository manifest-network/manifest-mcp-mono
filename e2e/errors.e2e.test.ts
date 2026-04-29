import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Live coverage of the error path through the MCP transport: tools that
 * fail on bad input, unknown routing, sensitive-data sanitization, and
 * the structured shape of the error response.
 *
 * The success paths exercise withErrorHandling's wrapper indirectly; this
 * file exercises the catch branch — error code propagation, sanitization
 * of input args via sanitizeForLogging, and the JSON shape that the
 * manifest-agent plugin consumes when isError is true.
 *
 * Out of scope here:
 *   - INVALID_CONFIG signing-without-rpc — covered by ENG-51 (REST-only
 *     mode). Adding it here would require a second MCPTestClient with a
 *     different env, which ENG-51 will set up holistically.
 *   - Retry classification — would need a mock HTTP/RPC server that
 *     returns 503; deferred.
 */

describe('Error paths through MCP transport', () => {
  const client = new MCPTestClient();

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
  });

  afterAll(async () => {
    await client.close();
  });

  // ==========================================================================
  // Routing errors — UNKNOWN_MODULE / UNSUPPORTED_QUERY / UNSUPPORTED_TX
  // ==========================================================================
  describe('Routing errors', () => {
    it('UNKNOWN_MODULE for an unregistered query module', async () => {
      const err = await client.callToolExpectError('cosmos_query', {
        module: 'not-a-real-module',
        subcommand: 'foo',
      });
      expect(err.code).toBe('UNKNOWN_MODULE');
      expect(err.tool).toBe('cosmos_query');
      // Handler attaches `availableModules` so callers can self-correct.
      const details = err.details as { availableModules?: string[] };
      expect(Array.isArray(details?.availableModules)).toBe(true);
      expect(details!.availableModules!.length).toBeGreaterThan(0);
    });

    it('UNKNOWN_MODULE for an unregistered tx module', async () => {
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'not-a-real-module',
        subcommand: 'foo',
        // cosmos_tx requires args (no .default([]) on the schema), so even
        // a routing-error probe must pass args explicitly to satisfy zod.
        args: [],
      });
      expect(err.code).toBe('UNKNOWN_MODULE');
      expect(err.tool).toBe('cosmos_tx');
      const details = err.details as { availableModules?: string[] };
      expect(Array.isArray(details?.availableModules)).toBe(true);
    });

    it('UNSUPPORTED_QUERY for an unknown subcommand on a known module', async () => {
      const err = await client.callToolExpectError('cosmos_query', {
        module: 'bank',
        subcommand: 'not-a-real-subcommand',
      });
      expect(err.code).toBe('UNSUPPORTED_QUERY');
      const details = err.details as { availableSubcommands?: string[] };
      expect(details?.availableSubcommands).toContain('balances');
    });

    it('UNSUPPORTED_TX for an unknown subcommand on a known module', async () => {
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'bank',
        subcommand: 'not-a-real-subcommand',
        args: [],
      });
      expect(err.code).toBe('UNSUPPORTED_TX');
      const details = err.details as { availableSubcommands?: string[] };
      expect(details?.availableSubcommands).toContain('send');
    });
  });

  // ==========================================================================
  // Argument validation — QUERY_FAILED / TX_FAILED
  // ==========================================================================
  describe('Argument validation', () => {
    it('QUERY_FAILED when required args are missing', async () => {
      // bank balances requires [address]; passing args: [] triggers
      // requireArgs which throws QUERY_FAILED.
      const err = await client.callToolExpectError('cosmos_query', {
        module: 'bank',
        subcommand: 'balances',
        args: [],
      });
      expect(err.code).toBe('QUERY_FAILED');
      expect(err.message).toMatch(/balances/i);
    });

    it('TX_FAILED when required tx args are missing', async () => {
      // bank send requires [recipient, amount]; passing args: [] triggers
      // requireArgs which throws TX_FAILED.
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: [],
      });
      expect(err.code).toBe('TX_FAILED');
      expect(err.message).toMatch(/send/i);
    });

    it('INVALID_ADDRESS for a malformed recipient on bank send', async () => {
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: ['not-a-bech32-address', '100umfx'],
      });
      // validateAddress() throws INVALID_ADDRESS directly (more specific
      // than the generic TX_FAILED catch-all).
      expect(err.code).toBe('INVALID_ADDRESS');
      expect(err.message).toMatch(/address|bech32|invalid/i);
    });
  });

  // ==========================================================================
  // Sensitive-data sanitization
  //
  // withErrorHandling runs sanitizeForLogging() on the input args object
  // before embedding it in the error response. The sanitizer redacts:
  //   - object KEYS in SENSITIVE_FIELDS (e.g. "mnemonic", "private_key")
  //   - string VALUES that look like a BIP-39 mnemonic (12/15/18/21/24
  //     all-lowercase-alpha words)
  //
  // Test wallet's actual mnemonic from MCPTestClient is in process.env, not
  // in tool args, so we use a known-test mnemonic literal here. It has the
  // right shape but is not a real wallet.
  // ==========================================================================
  describe('Sanitization', () => {
    // 12-word BIP-39-shaped phrase (test fixture only — the all-`abandon`
    // sequence is a valid public test mnemonic shipped by BIP-39 reference
    // implementations and used as a placeholder in many wallet libraries).
    const FAKE_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    it('redacts a mnemonic-shaped string passed as a positional arg', async () => {
      // Pass the mnemonic where bank send expects a recipient address. The
      // address validator throws; the error response includes `input.args`
      // sanitized.
      const err = await client.callToolExpectError('cosmos_tx', {
        module: 'bank',
        subcommand: 'send',
        args: [FAKE_MNEMONIC, '100umfx'],
      });
      // The mnemonic happens to fail address validation first.
      expect(err.code).toBe('INVALID_ADDRESS');

      const input = err.input as { args?: string[] };
      expect(input.args).toBeDefined();
      // First arg (the mnemonic) must be redacted; the second (`100umfx`)
      // is a normal value and should pass through unchanged.
      expect(input.args![0]).toBe('[REDACTED - possible mnemonic]');
      expect(input.args![1]).toBe('100umfx');
    });

    it('passes non-mnemonic strings through unchanged in input echo', async () => {
      const err = await client.callToolExpectError('cosmos_query', {
        module: 'bank',
        subcommand: 'not-a-real-subcommand',
      });
      const input = err.input as { module: string; subcommand: string };
      expect(input.module).toBe('bank');
      expect(input.subcommand).toBe('not-a-real-subcommand');
    });
  });

  // ==========================================================================
  // cosmos_estimate_fee error paths
  //
  // The estimator shares the same routing/validation/simulation pipeline as
  // cosmos_tx but never broadcasts. Coverage here mirrors the routing and
  // argument-validation tests above for cosmos_query/cosmos_tx, plus the
  // simulator-failure path that's unique to the estimator (no broadcast =
  // no on-chain side-effect when simulation rejects).
  //
  // Happy-path coverage lives in chain-tools.e2e.test.ts. INVALID_CONFIG
  // (estimate_fee without a gas price) lives in rest-mode.e2e.test.ts.
  // ==========================================================================
  describe('cosmos_estimate_fee error paths', () => {
    it('UNKNOWN_MODULE for an unregistered module', async () => {
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'not-a-real-module',
        subcommand: 'send',
        args: [],
      });
      expect(err.code).toBe('UNKNOWN_MODULE');
      expect(err.tool).toBe('cosmos_estimate_fee');
      const details = err.details as { availableModules?: string[] };
      expect(Array.isArray(details?.availableModules)).toBe(true);
      expect(details!.availableModules!.length).toBeGreaterThan(0);
    });

    it('UNSUPPORTED_TX for an unknown subcommand on a known module', async () => {
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'not-a-real-subcommand',
        args: [],
      });
      expect(err.code).toBe('UNSUPPORTED_TX');
      const details = err.details as { availableSubcommands?: string[] };
      expect(details?.availableSubcommands).toContain('send');
    });

    it('TX_FAILED when required args are missing', async () => {
      // bank send requires [recipient, amount]; the message builder runs
      // before simulation, so requireArgs surfaces the same TX_FAILED that
      // cosmos_tx would surface.
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: [],
      });
      expect(err.code).toBe('TX_FAILED');
      expect(err.message).toMatch(/send/i);
    });

    it('INVALID_ADDRESS for a malformed recipient', async () => {
      // validateAddress in the bank-send builder fires before simulate, so
      // the error code is INVALID_ADDRESS (not the generic SIMULATION_FAILED
      // wrapper). Important: callers must be able to distinguish "your input
      // is malformed" from "the chain rejected the message", because only
      // the latter warrants a retry against a different node.
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: ['not-a-bech32-address', '100umfx'],
      });
      expect(err.code).toBe('INVALID_ADDRESS');
    });

    it('SIMULATION_FAILED when the chain rejects (insufficient funds)', async () => {
      const { address } = await client.callTool<{ address: string }>(
        'get_account_info',
      );

      // Send an amount well above any plausible test wallet balance. The
      // devnet genesis funds the test wallet with ~1e29 umfx (see
      // e2e/scripts/init_chain.sh), so we pick 1e35 — six orders of
      // magnitude past the ceiling — to guarantee the bank insufficient-
      // funds check fires inside simulate.
      const err = await client.callToolExpectError('cosmos_estimate_fee', {
        module: 'bank',
        subcommand: 'send',
        args: [
          address,
          '100000000000000000000000000000000000umfx',
        ],
      });
      expect(err.code).toBe('SIMULATION_FAILED');
      // The wrapper preserves module/subcommand/args context for callers.
      const details = err.details as {
        module?: string;
        subcommand?: string;
        args?: unknown;
      };
      expect(details.module).toBe('bank');
      expect(details.subcommand).toBe('send');
    });
  });

  // ==========================================================================
  // Error response shape
  // ==========================================================================
  describe('Error response shape', () => {
    it('includes error: true, tool, code, message, details, input', async () => {
      const err = await client.callToolExpectError('cosmos_query', {
        module: 'bank',
        subcommand: 'unknown',
      });
      expect(err.error).toBe(true);
      expect(err.tool).toBe('cosmos_query');
      expect(typeof err.code).toBe('string');
      expect(typeof err.message).toBe('string');
      expect(err.details).toBeDefined();
      expect(err.input).toBeDefined();
    });
  });
});
