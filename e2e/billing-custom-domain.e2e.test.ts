import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * End-to-end coverage for the lease custom-domain feature added by manifestjs
 * 2.4.1 / manifest-ledger v2.1.0. Drives both the lease-MCP layer
 * (`set_item_custom_domain`, `lease_by_custom_domain`, `leases_by_tenant`)
 * and the generic chain layer (`cosmos_tx billing set-item-custom-domain`,
 * `cosmos_query billing lease-by-custom-domain`) against a real chain so
 * the wire-level message encoding and chain-side validation are exercised.
 *
 * Setup:
 *   `init_billing.sh` registers the provider/SKU, and `init_chain.sh` adds
 *   the test wallet (ADDR2) to `billing.params.allowed_list`. The test
 *   wallet is therefore both the lease tenant and (independently) an
 *   `allowed_list` signer — both authorisation paths the chain accepts for
 *   `MsgSetItemCustomDomain`.
 *
 *   The lease is created against the existing provider/SKU registered by
 *   `init_billing.sh`. Per `MsgSetItemCustomDomain.ValidateBasic`, the
 *   lease must be in PENDING or ACTIVE state to be addressable; we set/
 *   clear domains while the lease is PENDING (no provider acknowledgement
 *   required).
 *
 *   FQDN format is validated by `IsValidFQDN` on chain (lowercase, ≥1 dot,
 *   each label is RFC 1123, TLD label has ≥1 non-digit). The unique
 *   timestamp suffix here keeps re-runs against persistent state from
 *   colliding on the reverse-index entry.
 *
 *   Cleanup: cancel-lease at the end so the lease doesn't block follow-up
 *   tests (and doesn't leak chain state). cancel-lease is tenant-only and
 *   works on any non-terminal lease.
 *
 * Re-runnability: the test wallet's allowed-list seat persists across runs.
 * The unique FQDN suffix avoids reverse-index conflicts. As with the rest
 * of the e2e suite, a fresh chain (`docker compose down -v`) between runs
 * is the clean baseline.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RUN_TAG = `${Date.now()}`;

describe('Billing custom-domain', () => {
  const leaseClient = new MCPTestClient();
  const chainClient = new MCPTestClient();

  let testAddress: string;
  let skuUuid: string;
  let leaseUuid: string;

  // Distinct FQDNs per phase keep the chain's reverse-index clean and let
  // the assertions below be exact rather than "any non-empty string".
  const FQDN_VIA_TOOL = `tool-${RUN_TAG}.e2e.test`;
  const FQDN_VIA_CHAIN = `chain-${RUN_TAG}.e2e.test`;

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      chainClient.connect({ serverEntry: 'packages/node/dist/chain.js' }),
    ]);
    const acct = await chainClient.callTool<{ address: string }>(
      'get_account_info',
    );
    testAddress = acct.address;
  });

  afterAll(async () => {
    await Promise.all([leaseClient.close(), chainClient.close()]);
  });

  // ------------------------------------------------------------------
  // 1. Setup — discover the docker-micro SKU and fund credits
  // ------------------------------------------------------------------
  it('setup: get_skus discovers the docker-micro SKU', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{
        uuid: string;
        name: string;
        basePrice: { denom: string };
      }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    expect(micro).toBeDefined();
    skuUuid = micro!.uuid;
  });

  it('setup: fund_credit seeds the tenant credit account', async () => {
    const skus = await leaseClient.callTool<{
      skus: Array<{ name: string; basePrice: { denom: string } }>;
    }>('get_skus');
    const micro = skus.skus.find((s) => s.name === 'docker-micro');
    const denom = micro!.basePrice.denom;

    const result = await leaseClient.callTool<{ code: number }>('fund_credit', {
      amount: `10000000${denom}`,
    });
    expect(result.code).toBe(0);
  });

  it('setup: cosmos_tx billing create-lease creates a PENDING lease for the test wallet', async () => {
    const beforeRes = await chainClient.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const beforeIds = new Set(beforeRes.result.leases.map((l) => l.uuid));

    const tx = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease',
      args: [`${skuUuid}:1`],
      wait_for_confirmation: true,
    });
    expect(tx.code).toBe(0);

    const afterRes = await chainClient.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const newLease = afterRes.result.leases.find((l) => !beforeIds.has(l.uuid));
    expect(newLease).toBeDefined();
    leaseUuid = newLease!.uuid;
  });

  // ------------------------------------------------------------------
  // 2. High-level lease MCP tools — set, look up, clear
  // ------------------------------------------------------------------
  it('set_item_custom_domain assigns an FQDN to the lease (legacy 1-item — no service_name)', async () => {
    const result = await leaseClient.callTool<{
      lease_uuid: string;
      service_name: string;
      custom_domain: string;
      code: number;
    }>('set_item_custom_domain', {
      lease_uuid: leaseUuid,
      custom_domain: FQDN_VIA_TOOL,
    });
    expect(result.code).toBe(0);
    expect(result.lease_uuid).toBe(leaseUuid);
    expect(result.custom_domain).toBe(FQDN_VIA_TOOL);
    expect(result.service_name).toBe('');

    // The chain index updates inside the same block, but give the node a
    // moment to surface it through the LCD/RPC adapter the next query uses.
    await sleep(1_000);
  });

  it('lease_by_custom_domain (high-level) returns the lease that claimed the FQDN', async () => {
    const result = await leaseClient.callTool<{
      lease: { uuid: string; tenant: string };
      service_name: string;
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_TOOL });

    expect(result.lease.uuid).toBe(leaseUuid);
    expect(result.lease.tenant).toBe(testAddress);
    // 1-item legacy lease — service_name is empty.
    expect(result.service_name).toBe('');
  });

  it('cosmos_query billing lease-by-custom-domain (low-level) returns the same shape', async () => {
    const result = await chainClient.callTool<{
      result: {
        lease: { uuid: string; tenant: string };
        serviceName: string;
      };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'lease-by-custom-domain',
      args: [FQDN_VIA_TOOL],
    });

    expect(result.result.lease.uuid).toBe(leaseUuid);
    expect(result.result.lease.tenant).toBe(testAddress);
    // Generic-chain shape uses camelCase — the lease MCP tool maps it to
    // service_name; here we assert the underlying shape directly.
    expect(result.result.serviceName).toBe('');
  });

  it('leases_by_tenant per-item output now surfaces customDomain / serviceName', async () => {
    const result = await leaseClient.callTool<{
      leases: Array<{
        uuid: string;
        items?: Array<{
          skuUuid: string;
          serviceName?: string;
          customDomain?: string;
        }>;
      }>;
    }>('leases_by_tenant', {});
    const ours = result.leases.find((l) => l.uuid === leaseUuid);
    expect(ours).toBeDefined();
    expect(ours!.items).toBeDefined();
    const item = ours!.items![0];
    expect(item.skuUuid).toBe(skuUuid);
    expect(item.customDomain).toBe(FQDN_VIA_TOOL);
    expect(item.serviceName ?? '').toBe('');
  });

  it('set_item_custom_domain clears the FQDN with clear:true', async () => {
    const result = await leaseClient.callTool<{
      custom_domain: string;
      code: number;
    }>('set_item_custom_domain', {
      lease_uuid: leaseUuid,
      clear: true,
    });
    expect(result.code).toBe(0);
    expect(result.custom_domain).toBe('');
    await sleep(1_000);
  });

  it('lease_by_custom_domain after clearing returns an empty lease (not-found)', async () => {
    const result = await leaseClient.callTool<{
      lease: { uuid?: string } | undefined;
      service_name: string;
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_TOOL });

    // After clearing, the reverse-index entry is freed. The chain returns
    // an empty Lease (default-initialised) rather than an absent field, so
    // assert the lease has no uuid rather than checking for undefined.
    expect(result.lease?.uuid ?? '').toBe('');
    expect(result.service_name).toBe('');
  });

  // ------------------------------------------------------------------
  // 3. Generic chain layer — set / clear via cosmos_tx
  // ------------------------------------------------------------------
  it('cosmos_tx billing set-item-custom-domain (low-level) assigns a different FQDN', async () => {
    const result = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'set-item-custom-domain',
      args: [leaseUuid, FQDN_VIA_CHAIN],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
    await sleep(1_000);
  });

  it('lease_by_custom_domain finds the FQDN set via the chain layer', async () => {
    const result = await leaseClient.callTool<{
      lease: { uuid: string };
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_CHAIN });
    expect(result.lease.uuid).toBe(leaseUuid);
  });

  it('cosmos_tx billing set-item-custom-domain --clear (low-level) clears the FQDN', async () => {
    const result = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'set-item-custom-domain',
      args: [leaseUuid, '--clear'],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
  });

  // ------------------------------------------------------------------
  // 4. Negative cases — chain-side and client-side rejections
  // ------------------------------------------------------------------
  it('cosmos_tx rejects an invalid FQDN on chain (TX_FAILED with chain error)', async () => {
    // The chain's IsValidFQDN requires lowercase, ≥1 dot separator, RFC
    // 1123 labels, and a non-numeric TLD. "INVALID" violates all three —
    // the broadcast itself succeeds (passes ValidateBasic for lease_uuid /
    // sender) but the keeper rejects with a non-zero code, which surfaces
    // through the MCP layer as TX_FAILED.
    const err = await chainClient.callToolExpectError('cosmos_tx', {
      module: 'billing',
      subcommand: 'set-item-custom-domain',
      args: [leaseUuid, 'INVALID'],
      wait_for_confirmation: true,
    });
    expect(err.code).toBe('TX_FAILED');
  });

  it('set_item_custom_domain rejects an empty custom_domain client-side (does not broadcast)', async () => {
    const err = await leaseClient.callToolExpectError('set_item_custom_domain', {
      lease_uuid: leaseUuid,
      custom_domain: '',
    });
    expect(err.code).toBe('TX_FAILED');
    expect(err.message).toMatch(/custom_domain|cannot be empty|clear/i);
  });

  it('cosmos_query billing lease-by-custom-domain rejects empty <custom-domain> before hitting the chain', async () => {
    const err = await chainClient.callToolExpectError('cosmos_query', {
      module: 'billing',
      subcommand: 'lease-by-custom-domain',
      args: [''],
    });
    expect(err.code).toBe('QUERY_FAILED');
    expect(err.message).toMatch(/cannot be empty/);
  });

  // ------------------------------------------------------------------
  // 5. Cleanup — cancel the lease so it doesn't leak state into other tests
  // ------------------------------------------------------------------
  it('cleanup: cancel-lease terminates the test lease', async () => {
    try {
      const result = await chainClient.callTool<{ code: number }>('cosmos_tx', {
        module: 'billing',
        subcommand: 'cancel-lease',
        args: [leaseUuid],
        wait_for_confirmation: true,
      });
      expect(result.code).toBe(0);
    } catch (err) {
      // If the lease somehow already terminated, swallow the chain rejection.
      // Routing-layer regressions still surface (UNSUPPORTED_TX, etc.).
      const code = parseToolErrorCode(err);
      if (code !== 'TX_FAILED') {
        throw err;
      }
      console.warn(
        `[billing-custom-domain] cancel-lease rejected (already terminal?): ${err}`,
      );
    }
  });
});
