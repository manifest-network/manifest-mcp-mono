import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient } from './helpers/mcp-client.js';

/**
 * Live coverage for the retry classifier (`packages/core/src/retry.ts`).
 *
 * Unit tests pin every branch of `isRetryableError`, but no e2e test
 * exercises the actual retry loop end-to-end. This file proves both
 * sides of the classifier through the live MCP transport:
 *
 *   1. Transient (network) failures: pointing COSMOS_RPC_URL at a
 *      sentinel local port (nothing listening — ECONNREFUSED) makes
 *      every connection attempt fail. `withRetry()` classifies the
 *      message as transient (`isTransientErrorMessage` matches
 *      "econnrefused") and retries with exponential backoff. The wall
 *      time is bounded below by the first backoff delay
 *      (`baseDelayMs = 1000`), so a successfully-retried call cannot
 *      return faster than ~1s. We assert that lower bound.
 *
 *   2. Permanent failures: a routing-layer error like UNKNOWN_MODULE
 *      throws before `withRetry()` is entered — the handler lookup in
 *      `cosmosQuery` happens before the retry block. Such errors must
 *      surface immediately with no backoff delay; we assert the wall
 *      time is below a generous fast-fail bound.
 *
 * Why bother: the retry config is hard-coded in `DEFAULT_RETRY_CONFIG`
 * with `maxRetries: 3` and `baseDelayMs: 1000`, so one ladder sleeps
 * roughly baseDelay + 2x + 4x ≈ 7s (≤ ~8.75s with the +25% jitter).
 * Connect-retry has exactly ONE owner — `CosmosClientManager`'s
 * initQueryClient — and `cosmos.ts` acquires the client OUTSIDE its own
 * handler-retry (ENG-679), so a dead endpoint costs one ladder and the
 * handler ladder is never entered at all. That upper bound is asserted
 * below: it is the regression guard against re-nesting the two ladders,
 * which multiplied them to 4 x 4 x 5 = 77 connects / ~35s and blew this
 * test's budget. A sentinel-port test against the local loopback is
 * deliberate: ECONNREFUSED is fast (sub-millisecond), so the bulk of the
 * elapsed time is the backoff sleeps, not the network.
 */

// 127.0.0.1:9 is the "discard" port — nothing listens by default, so
// connect() rejects with ECONNREFUSED immediately. Any unbound localhost
// port would do; 9 is conventional and unlikely to be hijacked.
const SENTINEL_RPC_URL = 'http://127.0.0.1:9';

describe('Retry classifier (live)', () => {
  describe('Transient failures retry with backoff', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      await client.connect({
        serverEntry: 'packages/node/dist/chain.js',
        rpcUrl: SENTINEL_RPC_URL,
      });
    });

    afterAll(async () => {
      await client.close();
    });

    it(
      'cosmos_query against a dead RPC eventually fails RPC_CONNECTION_FAILED after retrying',
      async () => {
        const start = Date.now();
        let thrown: unknown;
        try {
          await client.callTool('cosmos_query', {
            module: 'bank',
            subcommand: 'params',
          });
        } catch (err) {
          thrown = err;
        }
        const elapsed = Date.now() - start;

        expect(thrown).toBeDefined();
        const msg = thrown instanceof Error ? thrown.message : String(thrown);
        // The outer retry exhausts and the wrapped error surfaces. Allow
        // for either the wrapped RPC_CONNECTION_FAILED or a related
        // transient code, since the classifier may bubble the inner
        // failure through.
        expect(msg).toMatch(/RPC_CONNECTION_FAILED|ECONNREFUSED/);

        // baseDelayMs is 1000 by default. Even ONE retry forces a sleep
        // of at least ~750ms (jitter floor: 1000 * 0.75). Anything under
        // 750ms means the call returned without any retry — a regression
        // in the classifier or in withRetry's loop.
        expect(elapsed).toBeGreaterThan(750);

        // Upper bound: ONE connect ladder ≈ 7s, ≤ ~8.75s with jitter, plus
        // transport overhead. 15s leaves generous headroom for contended CI
        // while sitting far below any re-nesting (two ladders were ~35s, and
        // ~17-20s even when a latched init promise short-circuited the inner
        // one). Anything above this is retry amplification, not slowness.
        expect(elapsed).toBeLessThan(15_000);
      },
      // Above the 15s assertion so the assertion — which names the cause —
      // reports the failure instead of an opaque test timeout.
      20_000,
    );
  });

  describe('Permanent failures fail-fast (no retry)', () => {
    const client = new MCPTestClient();

    beforeAll(async () => {
      // Use a working RPC URL so the comparison is fair: the only thing
      // that should differ from the transient case is the *classification*,
      // not the network setup.
      await client.connect({
        serverEntry: 'packages/node/dist/chain.js',
      });
      // Warm the stdio + handler path so cold V8 tier-up doesn't show up
      // in the timed call. The diagnostic value is the gap between
      // transient (>750ms forced backoff) and permanent (no backoff),
      // not the absolute floor.
      await client.listTools();
    });

    afterAll(async () => {
      await client.close();
    });

    it('cosmos_query with UNKNOWN_MODULE returns immediately without backoff', async () => {
      const start = Date.now();
      let thrown: unknown;
      try {
        await client.callTool('cosmos_query', {
          module: 'definitely-not-a-module',
          subcommand: 'foo',
        });
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - start;

      expect(thrown).toBeDefined();
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).toMatch(/UNKNOWN_MODULE/);

      // No retry → no backoff sleep. The bound is generous (2000ms) to
      // tolerate contended CI — diagnostic value is that this is well
      // below the >750ms transient lower bound and much further below
      // a single 1000ms backoff cycle. Looser than 2000ms here would
      // overlap the transient case and lose the signal.
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
