import { LeaseState } from '@manifest-network/manifest-mcp-core';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from 'vitest';
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

const CUSTOM_DOMAIN_SKIP_REASON =
  'chain does not expose the manifest-ledger v2.1+ custom-domain API';

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
  // each dependent test is reported as skipped instead of passing without
  // running an assertion.
  let chainSupportsCustomDomain = false;

  function skipUnlessCustomDomainSupported(skip: TestContext['skip']): void {
    skip(!chainSupportsCustomDomain, CUSTOM_DOMAIN_SKIP_REASON);
  }

  function leaseUuidFromErrorDetails(details: unknown): string | undefined {
    if (details === null || typeof details !== 'object') return undefined;
    const value = Reflect.get(details, 'lease_uuid');
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  async function cleanupLeaseFromErrorDetails(
    details: unknown,
    label: string,
  ): Promise<string | undefined> {
    const orphanedLeaseUuid = leaseUuidFromErrorDetails(details);
    if (orphanedLeaseUuid === undefined) return undefined;

    try {
      await leaseClient.callTool('close_lease', {
        lease_uuid: orphanedLeaseUuid,
      });
    } catch (cleanupErr) {
      const code = parseToolErrorCode(cleanupErr);
      if (code !== 'TX_FAILED') throw cleanupErr;
      console.warn(
        `[billing-custom-domain] ${label} orphaned-lease cleanup rejected (already terminal?): ${cleanupErr}`,
      );
    }

    return orphanedLeaseUuid;
  }

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
      } else if (
        /NotFound|no lease with custom_domain|key not found/i.test(message)
      ) {
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
  // Each test that touches the chain-side custom-domain surface records a
  // runtime skip when the probe in `beforeAll` decided the chain is too old.
  // Client-side rejection tests in section 4 don't need the feature on
  // chain and run unconditionally.
  // ------------------------------------------------------------------
  it('set_item_custom_domain assigns an FQDN to the lease (legacy 1-item — no service_name)', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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

  it('lease_by_custom_domain (high-level) returns the lease that claimed the FQDN', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
    const result = await leaseClient.callTool<{
      lease: { uuid: string; tenant: string };
      service_name: string;
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_TOOL });

    expect(result.lease.uuid).toBe(leaseUuid);
    expect(result.lease.tenant).toBe(testAddress);
    // 1-item legacy lease — service_name is empty.
    expect(result.service_name).toBe('');
  });

  it('cosmos_query billing lease-by-custom-domain (low-level) returns the same shape', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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

  it('leases_by_tenant per-item output now surfaces customDomain / serviceName', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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

  it('set_item_custom_domain clears the FQDN with clear:true', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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

  it('lease_by_custom_domain after clearing rejects the lookup with NotFound (no lease claims the FQDN)', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
    // The keeper returns `status.Errorf(codes.NotFound, "no lease with
    // custom_domain X")` when the reverse index has no entry for the
    // given domain. The MCP layer now raises NOT_FOUND, with the
    // chain message preserved.
    const err = await leaseClient.callToolExpectError(
      'lease_by_custom_domain',
      { custom_domain: FQDN_VIA_TOOL },
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toMatch(/no lease with custom_domain|NotFound/i);
  });

  // ------------------------------------------------------------------
  // 3. Generic chain layer — set / clear via cosmos_tx
  // ------------------------------------------------------------------
  it('cosmos_tx billing set-item-custom-domain (low-level) assigns a different FQDN', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
    const result = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'set-item-custom-domain',
      args: [leaseUuid, FQDN_VIA_CHAIN],
      wait_for_confirmation: true,
    });
    expect(result.code).toBe(0);
    await sleep(1_000);
  });

  it('lease_by_custom_domain finds the FQDN set via the chain layer', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
    const result = await leaseClient.callTool<{
      lease: { uuid: string };
    }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_CHAIN });
    expect(result.lease.uuid).toBe(leaseUuid);
  });

  it('cosmos_tx billing set-item-custom-domain --clear (low-level) clears the FQDN', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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
  it('cosmos_tx rejects an invalid FQDN on chain (TX_FAILED with chain error)', async ({
    skip,
  }) => {
    skipUnlessCustomDomainSupported(skip);
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
    const err = await leaseClient.callToolExpectError(
      'set_item_custom_domain',
      {
        lease_uuid: leaseUuid,
        custom_domain: '',
      },
    );
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
        outcome: string;
        lease_state: string;
      }>('close_lease', { lease_uuid: leaseUuid });
      expect(result.lease_uuid).toBe(leaseUuid);
      // Best-effort cleanup: assert the outcome<->lease_state correlation, not
      // independent sets. The lease is ACTIVE here (deploy_app waits for it), so
      // close-lease yields (stopped, CLOSED); stopApp is idempotent (ENG-487A), so
      // an already-terminal lease returns (already_inactive, CLOSED) or, on credit
      // runout, (already_inactive, EXPIRED) WITHOUT throwing. It is never PENDING,
      // so cancelled/REJECTED cannot occur, and (stopped, EXPIRED) is impossible.
      expect([
        'stopped/LEASE_STATE_CLOSED',
        'already_inactive/LEASE_STATE_CLOSED',
        'already_inactive/LEASE_STATE_EXPIRED',
      ]).toContain(`${result.outcome}/${result.lease_state}`);
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
    const MIXED_CASE_FQDN_VIA_DEPLOY = `Deploy-${RUN_TAG}.E2E.test`;
    let combinedLeaseUuid: string;

    it('deploy_app canonicalizes custom_domain and surfaces it on the result', async ({
      skip,
    }) => {
      skipUnlessCustomDomainSupported(skip);
      const result = await fredClient.callTool<{
        lease_uuid: string;
        state: LeaseState;
        custom_domain?: string;
        service_name?: string;
      }>('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: MIXED_CASE_FQDN_VIA_DEPLOY,
      });
      expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
      expect(result.custom_domain).toBe(FQDN_VIA_DEPLOY);
      // 1-item legacy lease (image+port) — service_name not echoed.
      expect(result.service_name).toBeUndefined();
      combinedLeaseUuid = result.lease_uuid;
      // Settle one block for the index update to surface through the LCD.
      await sleep(1_000);
    });

    it('lease_by_custom_domain finds the lease set by the combined call', async ({
      skip,
    }) => {
      skipUnlessCustomDomainSupported(skip);
      const result = await leaseClient.callTool<{
        lease: { uuid: string };
      }>('lease_by_custom_domain', { custom_domain: FQDN_VIA_DEPLOY });
      expect(result.lease.uuid).toBe(combinedLeaseUuid);
    });

    it('reports partial success when custom_domain is already claimed', async ({
      skip,
    }) => {
      skipUnlessCustomDomainSupported(skip);

      // The first combined-flow lease still owns FQDN_VIA_DEPLOY. A second
      // deploy therefore creates its lease, then fails at the chain-authoritative
      // set-domain step. Keep a live wire-level pin for the partial-success
      // prefix/details contract while cleaning up the intentionally orphaned
      // lease before making assertions.
      const err = await fredClient.callToolExpectError('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: FQDN_VIA_DEPLOY,
      });
      const orphanedLeaseUuid = await cleanupLeaseFromErrorDetails(
        err.details,
        'duplicate-domain',
      );

      expect(err.code).toBe('TX_FAILED');
      expect(err.message).toMatch(/^Deploy partially succeeded:/);
      expect(err.message).toMatch(
        /Close this lease with close_lease if needed/,
      );
      expect(err.details).toMatchObject({
        partial: true,
        failedStep: 'set_domain',
        lease_uuid: expect.any(String),
      });
      expect(orphanedLeaseUuid).toBeDefined();
      expect(orphanedLeaseUuid).not.toBe(combinedLeaseUuid);
    });

    it('cleanup: close_lease terminates the combined-flow lease', async ({
      skip,
    }) => {
      if (!combinedLeaseUuid) {
        skip('combined-flow lease was not created');
      }
      try {
        const result = await leaseClient.callTool<{
          lease_uuid: string;
          outcome: string;
          lease_state: string;
        }>('close_lease', { lease_uuid: combinedLeaseUuid });
        expect(result.lease_uuid).toBe(combinedLeaseUuid);
        // Best-effort cleanup — assert the outcome<->lease_state correlation, see
        // the earlier block. This ACTIVE-created lease's only reachable pairs are
        // (stopped, CLOSED), (already_inactive, CLOSED), (already_inactive, EXPIRED).
        expect([
          'stopped/LEASE_STATE_CLOSED',
          'already_inactive/LEASE_STATE_CLOSED',
          'already_inactive/LEASE_STATE_EXPIRED',
        ]).toContain(`${result.outcome}/${result.lease_state}`);
      } catch (err) {
        const code = parseToolErrorCode(err);
        if (code !== 'TX_FAILED') throw err;
        console.warn(
          `[billing-custom-domain] combined close_lease rejected (already terminal?): ${err}`,
        );
      }
    });

    it('rejects an empty custom_domain client-side without creating a lease (INVALID_CONFIG)', async () => {
      // deployManifest's eager validation fires before any chain tx. Only
      // this e2e test verifies that the real fred MCP argument plumbing keeps
      // the rejection structured. If a regression does create a lease, clean
      // it up before failing the no-lease assertion so later files stay clean.
      const err = await fredClient.callToolExpectError('deploy_app', {
        image: 'nginxinc/nginx-unprivileged:alpine',
        port: 8080,
        size: 'docker-micro',
        custom_domain: '   ',
      });
      const orphanedLeaseUuid = await cleanupLeaseFromErrorDetails(
        err.details,
        'empty-domain regression',
      );

      expect(err.code).toBe('INVALID_CONFIG');
      expect(err.message).toMatch(/cannot be empty/);
      expect(err.details ?? {}).not.toHaveProperty('lease_uuid');
      expect(orphanedLeaseUuid).toBeUndefined();
    });

    it.each([
      {
        label: 'scheme-prefixed domain',
        customDomain: 'https://app.example.com',
        message:
          'customDomain "https://app.example.com" must not include a scheme — pass a bare FQDN',
      },
      {
        label: 'invalid FQDN',
        customDomain: 'INVALID',
        message: 'customDomain "INVALID" is not a valid FQDN',
      },
    ])(
      'rejects a $label before creating a lease',
      async ({ customDomain, message }) => {
        // ENG-749 moved parseFqdn to deployManifest's preflight boundary. Pin
        // both parser branches before the credit-reserving create-lease tx.
        const err = await fredClient.callToolExpectError('deploy_app', {
          image: 'nginxinc/nginx-unprivileged:alpine',
          port: 8080,
          size: 'docker-micro',
          custom_domain: customDomain,
        });
        const orphanedLeaseUuid = await cleanupLeaseFromErrorDetails(
          err.details,
          `${customDomain} regression`,
        );

        expect(err.code).toBe('INVALID_ARGUMENT');
        expect(err.message).toBe(message);
        expect(err.details ?? {}).not.toHaveProperty('lease_uuid');
        expect(orphanedLeaseUuid).toBeUndefined();
      },
    );
  });
});
