import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * End-to-end coverage for every billing/sku tx subcommand routed through
 * cosmos_tx, exercising both the provider and tenant paths from a single
 * signing key.
 *
 * Setup: init_chain.sh now seeds ADDR2 (the test wallet, MNEMO2) into
 * `sku.params.allowed_list` and `billing.params.allowed_list`, so the
 * test wallet can register itself as a provider. The test then *attempts*
 * to self-acknowledge its own leases; if the chain rejects this (e.g. a
 * future keeper version forbids tenant=provider), the close-lease and
 * withdraw flows skip with a console.warn while flows B (reject) and C
 * (cancel) remain valid as standalone routing-coverage tests.
 * ADDR1's provider (registered by init_billing.sh) is left untouched —
 * the lifecycle test continues to use it for deploy_app.
 *
 * Order of operations (chain state must match for each step):
 *   1. SKU side: create-provider, update-provider, create-sku, update-sku
 *   2. Tenant funds a credit account (so leases have something to drain)
 *   3. Billing flow A — full lifecycle: create-lease → acknowledge-lease
 *      → withdraw → close-lease
 *   4. Billing flow B — rejection: create-lease → reject-lease
 *   5. Billing flow C — cancellation: create-lease → cancel-lease
 *   6. SKU cleanup: deactivate-sku, deactivate-provider
 *
 * `update-params` for both modules is governance-only (POA admin via
 * group proposal) and remains out of scope here.
 * `create-lease-for-tenant` is admin-gated by billing.params.allowed_list,
 * which init_chain.sh seeds with the test wallet (so create-provider can
 * self-register). The probe at the end of the file exercises this path
 * as a positive case and cancels the resulting lease to avoid leaking
 * state into the deactivate-sku test that follows.
 *
 * Re-runnability: this file assumes a fresh chain state (the suite-wide
 * convention — `docker compose -f e2e/docker-compose.yml down -v` between
 * runs). `sku create-provider` is keyed by address and can only be run
 * once per address per chain, so a re-run against a persistent devnet
 * would fail at provider registration. Other create-* tests in the
 * suite (groups, leases, wasm code IDs) follow the same convention.
 * Mutations that *can* be made re-runnable use a timestamp suffix —
 * see `SKU_NAME` below.
 */

const POA_ADMIN_ADDRESS =
  'manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj';
const PWR_DENOM = `factory/${POA_ADMIN_ADDRESS}/upwr`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Billing/SKU lifecycle', () => {
  const client = new MCPTestClient();

  // Unique SKU name per run — matches the convention used in chain-tools
  // (`e2e${Date.now()}` subdenoms) and chain-routing (`routing${Date.now()}`).
  // SKU names are unique-per-provider on chain; suffixing with a timestamp
  // makes the test re-runnable against accumulated state without collisions.
  // The provider itself is keyed by address and can't be timestamp-suffixed —
  // see the file preamble for the standing fresh-chain-state convention.
  const SKU_NAME = `bsl-cpu-${Date.now()}`;

  let testAddress: string;
  let providerUuid: string;
  let skuUuid: string;
  let activeLeaseUuid: string;
  let rejectableLeaseUuid: string;
  let cancellableLeaseUuid: string;

  // Track whether each flow's setup succeeded so dependent tests can skip
  // gracefully if (e.g.) self-acknowledgement turns out not to be allowed.
  let selfAckOk = true;

  beforeAll(async () => {
    await client.connect({ serverEntry: 'packages/node/dist/chain.js' });
    const acct = await client.callTool<{ address: string }>('get_account_info');
    testAddress = acct.address;
  });

  afterAll(async () => {
    await client.close();
  });

  // ==========================================================================
  // 1. SKU side — provider + SKU registration
  // ==========================================================================
  it('tx: sku create-provider self-registers the test wallet', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'create-provider',
      // [address, payout-address, api-url]
      args: [testAddress, testAddress, 'https://test-wallet-provider.invalid'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const lookup = await client.callTool<{
      result: { providers: Array<{ uuid: string; address: string }> };
    }>('cosmos_query', {
      module: 'sku',
      subcommand: 'provider-by-address',
      args: [testAddress],
    });
    const found = lookup.result.providers.find((p) => p.address === testAddress);
    expect(found).toBeDefined();
    providerUuid = found!.uuid;
  });

  it('tx: sku update-provider changes the api-url', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'update-provider',
      args: [
        providerUuid,
        testAddress,
        testAddress,
        'https://test-wallet-provider-v2.invalid',
      ],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { provider: { apiUrl: string } };
    }>('cosmos_query', {
      module: 'sku',
      subcommand: 'provider',
      args: [providerUuid],
    });
    expect(info.result.provider.apiUrl).toBe(
      'https://test-wallet-provider-v2.invalid',
    );
  });

  it('tx: sku create-sku creates a per-hour SKU under the new provider', async () => {
    // Price 3,600 upwr per hour = 1 upwr/sec, divisible by 3600 (per-second
    // rate must be a non-zero integer per init_billing.sh:67 conventions).
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'create-sku',
      // [provider-uuid, name, unit, base-price]
      args: [providerUuid, SKU_NAME, 'per-hour', `3600${PWR_DENOM}`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const lookup = await client.callTool<{
      result: { skus: Array<{ uuid: string; name: string; providerUuid: string }> };
    }>('cosmos_query', {
      module: 'sku',
      subcommand: 'skus-by-provider',
      args: [providerUuid],
    });
    const found = lookup.result.skus.find((s) => s.name === SKU_NAME);
    expect(found).toBeDefined();
    skuUuid = found!.uuid;
  });

  it('tx: sku update-sku doubles the base price', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'update-sku',
      // [sku-uuid, provider-uuid, name, unit, base-price]
      args: [skuUuid, providerUuid, SKU_NAME, 'per-hour', `7200${PWR_DENOM}`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const info = await client.callTool<{
      result: { sku: { basePrice: { amount: string } } };
    }>('cosmos_query', {
      module: 'sku',
      subcommand: 'sku',
      args: [skuUuid],
    });
    expect(info.result.sku.basePrice.amount).toBe('7200');
  });

  // ==========================================================================
  // 2. Fund credits so leases have something to drain
  // ==========================================================================
  it('tx: billing fund-credit seeds the tenant credit account', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'fund-credit',
      args: [testAddress, `100000000${PWR_DENOM}`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ==========================================================================
  // 3. Billing flow A — create → acknowledge → withdraw → close
  // ==========================================================================
  it('tx: billing create-lease (flow A) — tenant creates against own provider/sku', async () => {
    const beforeRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const beforeIds = new Set(beforeRes.result.leases.map((l) => l.uuid));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease',
      // sku-uuid:quantity
      args: [`${skuUuid}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const newLease = afterRes.result.leases.find((l) => !beforeIds.has(l.uuid));
    expect(newLease).toBeDefined();
    activeLeaseUuid = newLease!.uuid;
  });

  it('query: billing lease (singular) returns the just-created lease by UUID', async () => {
    const result = await client.callTool<{
      result: { lease: { uuid: string; tenant: string } };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'lease',
      args: [activeLeaseUuid],
    });
    expect(result.result.lease.uuid).toBe(activeLeaseUuid);
    expect(result.result.lease.tenant).toBe(testAddress);
  });

  it('query: billing withdrawable-amount for the active lease', async () => {
    // Empty amount list is fine for a freshly-created lease — we only
    // need the routing path to succeed.
    const result = await client.callTool<{
      result: { amounts: Array<{ denom: string; amount: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'withdrawable-amount',
      args: [activeLeaseUuid],
    });
    expect(Array.isArray(result.result.amounts)).toBe(true);
  });

  it('tx: billing acknowledge-lease (flow A) — provider self-acknowledges (probe)', async () => {
    try {
      const result = await client.callTool<{ code: number }>('cosmos_tx', {
        module: 'billing',
        subcommand: 'acknowledge-lease',
        args: [activeLeaseUuid],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);
    } catch (err) {
      // Only swallow chain-side rejection (TX_FAILED). Routing-layer
      // regressions (UNSUPPORTED_TX, UNKNOWN_MODULE, INVALID_ADDRESS,
      // transport failures) must surface — they are not "self-ack
      // disallowed", they are bugs.
      const code = parseToolErrorCode(err);
      if (code !== 'TX_FAILED') {
        throw err;
      }
      selfAckOk = false;
      console.warn(
        `[billing-sku-lifecycle] self-acknowledgement rejected by chain — close/withdraw paths will be skipped: ${err}`,
      );
    }
  });

  it('tx: billing withdraw (flow A) — provider claims accrued earnings', async () => {
    if (!selfAckOk) {
      console.warn('[billing-sku-lifecycle] skipping withdraw — self-ack failed');
      return;
    }
    // Wait a couple of seconds to accrue earnings (1 upwr/sec at this rate).
    await sleep(2_000);

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'withdraw',
      args: [activeLeaseUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  it('tx: billing close-lease (flow A) — closes the active lease', async () => {
    if (!selfAckOk) {
      console.warn('[billing-sku-lifecycle] skipping close-lease — self-ack failed');
      return;
    }
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'close-lease',
      args: [activeLeaseUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ==========================================================================
  // 4. Billing flow B — create → reject (provider rejects a fresh lease)
  // ==========================================================================
  it('tx: billing create-lease (flow B) for the rejection path', async () => {
    const beforeRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const beforeIds = new Set(beforeRes.result.leases.map((l) => l.uuid));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease',
      args: [`${skuUuid}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const newLease = afterRes.result.leases.find((l) => !beforeIds.has(l.uuid));
    expect(newLease).toBeDefined();
    rejectableLeaseUuid = newLease!.uuid;
  });

  it('tx: billing reject-lease (flow B)', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'reject-lease',
      args: [rejectableLeaseUuid, '--reason', 'not-provisioning-during-e2e'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ==========================================================================
  // 5. Billing flow C — create → cancel (tenant cancels a fresh lease)
  // ==========================================================================
  it('tx: billing create-lease (flow C) for the cancellation path', async () => {
    const beforeRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const beforeIds = new Set(beforeRes.result.leases.map((l) => l.uuid));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease',
      args: [`${skuUuid}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const newLease = afterRes.result.leases.find((l) => !beforeIds.has(l.uuid));
    expect(newLease).toBeDefined();
    cancellableLeaseUuid = newLease!.uuid;
  });

  it('tx: billing cancel-lease (flow C)', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'cancel-lease',
      args: [cancellableLeaseUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ==========================================================================
  // 6. SKU cleanup — deactivate-sku, deactivate-provider
  //
  // Both must run after all leases on the SKU are settled, otherwise the
  // chain typically rejects with "still in use".
  // ==========================================================================

  // If self-ack was rejected upstream, flow A's lease was created but never
  // acknowledged/closed — it's still bound to the SKU. Cancel it before
  // deactivation. cancel-lease is tenant-only and works on any non-terminal
  // lease, so it's a safe terminal action regardless of state. No-op when
  // selfAckOk is true (close-lease already terminated the lease).
  it('cleanup: cancel flow A lease if self-ack was rejected', async () => {
    if (selfAckOk) {
      return;
    }
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'cancel-lease',
      args: [activeLeaseUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // create-lease-for-tenant routes through the MsgCreateLeaseForTenant
  // handler with `authority: senderAddress`. The chain validates the
  // authority against `billing.params.allowed_list`; init_chain.sh seeds
  // the test wallet into that list (so the create-provider test can
  // self-register), which means this call is *authorized* on the devnet
  // and the expected outcome is success.
  //
  // Must run before `deactivate-sku` below: with an inactive SKU, the
  // chain rejects with "sku not active" before this code path can prove
  // the routing.
  //
  // Cleanup: the call creates a real lease, so we cancel it immediately
  // after to avoid state leak (the lease is bound to the SKU and would
  // block deactivation).
  let tenantLeaseUuid: string | undefined;
  it('tx: billing create-lease-for-tenant succeeds when authority is allow-listed', async () => {
    const beforeRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const beforeIds = new Set(beforeRes.result.leases.map((l) => l.uuid));

    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease-for-tenant',
      args: [testAddress, `${skuUuid}:1`],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);

    const afterRes = await client.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const newLease = afterRes.result.leases.find((l) => !beforeIds.has(l.uuid));
    expect(newLease).toBeDefined();
    tenantLeaseUuid = newLease!.uuid;
  });

  it('cleanup: cancel the create-lease-for-tenant probe lease', async () => {
    if (!tenantLeaseUuid) return;
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'cancel-lease',
      args: [tenantLeaseUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  it('tx: sku deactivate-sku', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'deactivate-sku',
      args: [skuUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  it('tx: sku deactivate-provider', async () => {
    const result = await client.callTool<{ code: number }>('cosmos_tx', {
      module: 'sku',
      subcommand: 'deactivate-provider',
      args: [providerUuid],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });
});
