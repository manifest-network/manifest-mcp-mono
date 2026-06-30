import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseState } from '@manifest-network/manifest-mcp-core';
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
 *   The lease is created via `deploy_app` against the provider registered
 *   by `init_billing.sh` (ADDR1) so providerd actually acknowledges it
 *   and the lease ends up in `LEASE_STATE_ACTIVE` — the chain only allows
 *   `MsgSetItemCustomDomain` against PENDING or ACTIVE leases. A bare
 *   `cosmos_tx billing create-lease` against the same provider is
 *   auto-rejected by providerd within sub-second (no payload), which
 *   would race the set-domain call.
 *
 *   `init_chain.sh` adds the test wallet (ADDR2) to
 *   `billing.params.allowed_list`, so the wallet is independently a valid
 *   signer for `MsgSetItemCustomDomain` even outside the tenant role.
 *
 *   FQDN format is validated by `IsValidFQDN` on chain (lowercase, ≥1 dot,
 *   each label is RFC 1123, TLD label has ≥1 non-digit). The unique
 *   timestamp suffix here keeps re-runs against persistent state from
 *   colliding on the reverse-index entry.
 *
 *   Cleanup: close-lease at the end so providerd tears down the container
 *   and chain state doesn't leak into the lifecycle suite that runs later.
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
  const fredClient = new MCPTestClient();

  let testAddress: string;
  let skuUuid: string;
  let leaseUuid: string;

  // Distinct FQDNs per phase keep the chain's reverse-index clean and let
  // the assertions below be exact rather than "any non-empty string".
  const FQDN_VIA_TOOL = `tool-${RUN_TAG}.e2e.test`;
  const FQDN_VIA_CHAIN = `chain-${RUN_TAG}.e2e.test`;

  // Custom-domain support landed in manifest-ledger v2.1.0 (proto changes
  // for `MsgSetItemCustomDomain` and `Query/LeaseByCustomDomain`). Older
  // devnets reject the message type as "unable to resolve type URL" and
  // the query path as "unknown query path". Probe once in beforeAll so
  // each test can early-return with a console.warn instead of failing.
  let chainSupportsCustomDomain = false;

  beforeAll(async () => {
    await Promise.all([
      leaseClient.connect({ serverEntry: 'packages/node/dist/lease.js' }),
      chainClient.connect({ serverEntry: 'packages/node/dist/chain.js' }),
      fredClient.connect({ serverEntry: 'packages/node/dist/fred.js' }),
    ]);
    const acct = await chainClient.callTool<{ address: string }>(
      'get_account_info',
    );
    testAddress = acct.address;

    // Feature-detect by hitting the new query with a sentinel FQDN.
    // - Chain v2.1+ supports the path; for an unclaimed FQDN the keeper
    //   returns a structured `NotFound` ("no lease with custom_domain X"),
    //   which the MCP layer wraps as QUERY_FAILED. Both signal the feature
    //   is registered.
    // - Pre-v2.1 chains return "unknown query path" (registry miss) or
    //   "unable to resolve type URL" (proto mismatch); those mean the
    //   feature is genuinely absent and dependent tests are skipped.
    // Any other error (network, transport, routing regression) re-throws
    // so genuine bugs still surface.
    try {
      await chainClient.callTool('cosmos_query', {
        module: 'billing',
        subcommand: 'lease-by-custom-domain',
        args: [`probe-${RUN_TAG}.invalid`],
      });
      chainSupportsCustomDomain = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unknown query path|unable to resolve type URL/i.test(message)) {
        console.warn(
          '[billing-custom-domain] chain does not expose v2.1 custom-domain ' +
            'queries — skipping. Bump the chain image to manifest-ledger ' +
            'v2.1.0+ (or rebuild dist after a manifestjs/MCP server upgrade) ' +
            'to enable.',
        );
      } else if (/NotFound|no lease with custom_domain|key not found/i.test(message)) {
        // Probe FQDN isn't claimed by anyone — expected. The query path
        // is registered, so the feature is available.
        chainSupportsCustomDomain = true;
      } else {
        throw err;
      }
    }
  });

  afterAll(async () => {
    await Promise.all([
      leaseClient.close(),
      chainClient.close(),
      fredClient.close(),
    ]);
  });

  // ------------------------------------------------------------------
  // 1. Setup — fund credits and deploy_app to get an ACTIVE lease
  //
  // Why deploy_app rather than `cosmos_tx billing create-lease`: the
  // chain-side custom-domain edits require PENDING or ACTIVE state, and
  // a bare create-lease against the init_billing.sh provider is
  // auto-rejected by providerd within sub-second (no payload), which
  // would race against the set-domain call. deploy_app produces a real
  // acknowledged lease in ACTIVE state.
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

  it('setup: deploy_app provisions an ACTIVE lease via providerd', async () => {
    const result = await fredClient.callTool<{
      lease_uuid: string;
      state: LeaseState;
    }>('deploy_app', {
      image: 'nginxinc/nginx-unprivileged:alpine',
      port: 8080,
      size: 'docker-micro',
    });
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.lease_uuid).toBeTruthy();
    leaseUuid = result.lease_uuid;
  });

  // ------------------------------------------------------------------
  // 2. High-level lease MCP tools — set, look up, clear
  //
  // Each test that touches the chain-side custom-domain surface returns
  // early when the probe in `beforeAll` decided the chain is too old.
  // Client-side rejection tests in section 4 don't need the feature on
  // chain and run unconditionally.
  // ------------------------------------------------------------------
  it('set_item_custom_domain assigns an FQDN to the lease (legacy 1-item — no service_name)', async () => {
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
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

  it('lease_by_custom_domain after clearing rejects the lookup with NotFound (no lease claims the FQDN)', async () => {
    if (!chainSupportsCustomDomain) return;
    // The keeper returns `status.Errorf(codes.NotFound, "no lease with
    // custom_domain X")` when the reverse index has no entry for the
    // given domain. The MCP layer wraps this as QUERY_FAILED with the
    // chain message preserved.
    const err = await leaseClient.callToolExpectError(
      'lease_by_custom_domain',
      { custom_domain: FQDN_VIA_TOOL },
    );
    expect(err.code).toBe('QUERY_FAILED');
    expect(err.message).toMatch(/no lease with custom_domain|NotFound/i);
  });

  // ------------------------------------------------------------------
  // 3. Generic chain layer — set / clear via cosmos_tx
  // ------------------------------------------------------------------
  it('cosmos_tx billing set-item-custom-domain (low-level) assigns a different FQDN', async () => {
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
    const result = await leaseClient.callTool<{
      lease: { uuid: string };
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_CHAIN });
    expect(result.lease.uuid).toBe(leaseUuid);
  });

  it('cosmos_tx billing set-item-custom-domain --clear (low-level) clears the FQDN', async () => {
    if (!chainSupportsCustomDomain) return;
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
    if (!chainSupportsCustomDomain) return;
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
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toMatch(/custom_domain|cannot be empty|clear/i);
  });

  it('cosmos_query billing lease-by-custom-domain rejects empty <custom-domain> before hitting the chain', async () => {
    const err = await chainClient.callToolExpectError('cosmos_query', {
      module: 'billing',
      subcommand: 'lease-by-custom-domain',
      args: [''],
    });
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toMatch(/cannot be empty/);
  });

  // ------------------------------------------------------------------
  // 5. Cleanup — close the lease so providerd tears down the container
  //    and chain state doesn't leak into subsequent test files.
  // ------------------------------------------------------------------
  it('cleanup: close_lease terminates the test lease', async () => {
    try {
      const result = await leaseClient.callTool<{
        lease_uuid: string;
        status: string;
      }>('close_lease', { lease_uuid: leaseUuid });
      expect(result.lease_uuid).toBe(leaseUuid);
      expect(result.status).toBe('stopped');
    } catch (err) {
      // If the lease somehow already terminated, swallow the chain rejection.
      // Routing-layer regressions still surface (UNSUPPORTED_TX, etc.).
      const code = parseToolErrorCode(err);
      if (code !== 'TX_FAILED') {
        throw err;
      }
      console.warn(
        `[billing-custom-domain] close_lease rejected (already terminal?): ${err}`,
      );
    }
  });

  // ------------------------------------------------------------------
  // 6. Combined flow — deploy_app with `custom_domain` in one call
  //
  // Verifies the orchestration in `deployApp` slots the
  // MsgSetItemCustomDomain tx between create-lease and the manifest
  // upload, and that the resulting lease shows up in the reverse-index
  // immediately on return. Independent setup/teardown so it doesn't
  // entangle with the staged tests above.
  // ------------------------------------------------------------------
  describe('deploy_app + custom_domain (single-call orchestration)', () => {
    const FQDN_VIA_DEPLOY = `deploy-${RUN_TAG}.e2e.test`;
    let combinedLeaseUuid: string;

    it('deploy_app accepts custom_domain and surfaces it on the result', async () => {
      if (!chainSupportsCustomDomain) return;
      const result = await fredClient.callTool<{
        lease_uuid: string;
        state: LeaseState;
        custom_domain?: string;
        service_name?: string;
      }>('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: FQDN_VIA_DEPLOY,
      });
      expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
      expect(result.custom_domain).toBe(FQDN_VIA_DEPLOY);
      // 1-item legacy lease (image+port) — service_name not echoed.
      expect(result.service_name).toBeUndefined();
      combinedLeaseUuid = result.lease_uuid;
      // Settle one block for the index update to surface through the LCD.
      await sleep(1_000);
    });

    it('lease_by_custom_domain finds the lease set by the combined call', async () => {
      if (!chainSupportsCustomDomain) return;
      const result = await leaseClient.callTool<{
        lease: { uuid: string };
      }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_DEPLOY });
      expect(result.lease.uuid).toBe(combinedLeaseUuid);
    });

    it('cleanup: close_lease terminates the combined-flow lease', async () => {
      if (!combinedLeaseUuid) return;
      try {
        const result = await leaseClient.callTool<{
          lease_uuid: string;
          status: string;
        }>('close_lease', { lease_uuid: combinedLeaseUuid });
        expect(result.lease_uuid).toBe(combinedLeaseUuid);
        expect(result.status).toBe('stopped');
      } catch (err) {
        const code = parseToolErrorCode(err);
        if (code !== 'TX_FAILED') throw err;
        console.warn(
          `[billing-custom-domain] combined close_lease rejected (already terminal?): ${err}`,
        );
      }
    });

    it('rejects an empty custom_domain client-side without creating a lease (INVALID_CONFIG)', async () => {
      // The eager-validation block in deployApp.ts fires before any
      // chain tx. A regression that drops the check would be caught
      // by the unit test, but only this e2e test verifies the real
      // fred MCP server's argument plumbing keeps the rejection
      // structured. Skip-if-feature-absent because we need the chain
      // index to be queryable for the lease-count baseline.
      if (!chainSupportsCustomDomain) return;

      // Snapshot lease count before — must not change after the rejected
      // call, since the validation runs before create-lease.
      const before = await leaseClient.callTool<{
        leases: Array<{ uuid: string }>;
      }>('leases_by_tenant', {});
      const beforeCount = before.leases.length;

      const err = await fredClient.callToolExpectError('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: '   ',
      });
      expect(err.code).toBe('INVALID_CONFIG');
      expect(err.message).toMatch(/cannot be empty/);

      const after = await leaseClient.callTool<{
        leases: Array<{ uuid: string }>;
      }>('leases_by_tenant', {});
      expect(after.leases.length).toBe(beforeCount);
    });

    it('rejects an invalid FQDN through the orchestrated path with a partial-success error', async () => {
      if (!chainSupportsCustomDomain) return;
      // Sanity check: "INVALID" (uppercase + no dot separator) is an invalid
      // FQDN. Since the branded-Fqdn / parse-don't-validate work, parseFqdn
      // rejects it CLIENT-SIDE with INVALID_ARGUMENT at the set-domain step —
      // which runs *after* create-lease succeeds and *before* its broadcast
      // (deployManifest.ts) — so deployApp still wraps it as a partial-success
      // error (the lease is already created) and the caller can identify the
      // orphaned lease from the error details to clean up.
      const err = await fredClient.callToolExpectError('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: 'INVALID',
      });

      // The client-side INVALID_ARGUMENT (from parseFqdn) bubbles through as
      // part of the partial-success wrap (the wrap reuses the inner code).
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(err.message).toMatch(/Deploy partially succeeded/);
      expect(err.message).toMatch(/close_lease if needed/);

      // Best-effort cleanup of the orphaned lease so the suite leaves clean
      // state. The error details include `lease_uuid` per the deployApp
      // partial-success branch.
      const orphanedUuid = (err.details as { lease_uuid?: string } | undefined)
        ?.lease_uuid;
      if (orphanedUuid) {
        try {
          await leaseClient.callTool<{
            lease_uuid: string;
            status: string;
          }>('close_lease', { lease_uuid: orphanedUuid });
        } catch (cleanupErr) {
          console.warn(
            `[billing-custom-domain] orphaned-lease cleanup failed: ${cleanupErr}`,
          );
        }
      }
    });
  });
});
