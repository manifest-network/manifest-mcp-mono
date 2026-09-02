import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCPTestClient, parseToolErrorCode } from './helpers/mcp-client.js';

/**
 * Live coverage for the agent CLI and its two read-only orchestrated tools.
 * The default MCPTestClient advertises no elicitation capability, so success
 * also proves these handlers stay usable by headless hosts.
 *
 * The diagnostic fixture is created directly on-chain and intentionally has
 * no deployment payload. With providerd running it may pass through active
 * before being rejected; without providerd it remains pending. All are valid,
 * queryable states for the chain-only troubleshooter, and none provisions a
 * container.
 */

const UNCLAIMED_FQDN = `agent-unclaimed-${Date.now()}.e2e.test`;
const CUSTOM_DOMAIN_SKIP_REASON =
  'chain does not expose the manifest-ledger v2.1+ custom-domain API';
const TERMINAL_STATES = [
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
];

describe('Agent read-only tools (live MCP transport)', () => {
  const agentClient = new MCPTestClient();
  const chainClient = new MCPTestClient();

  let testAddress: string;
  let leaseUuid: string | undefined;

  beforeAll(async () => {
    await Promise.all([
      agentClient.connect({ serverEntry: 'packages/node/dist/agent.js' }),
      chainClient.connect({ serverEntry: 'packages/node/dist/chain.js' }),
    ]);
  });

  afterAll(async () => {
    try {
      if (leaseUuid !== undefined) {
        await settleDiagnosticLease(leaseUuid);
      }
    } finally {
      await Promise.all([agentClient.close(), chainClient.close()]);
    }
  });

  async function queryLeaseState(uuid: string): Promise<LeaseState> {
    const result = await chainClient.callTool<{
      result: { lease: { state: LeaseState } };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'lease',
      args: [uuid],
    });
    return result.result.lease.state;
  }

  async function settleDiagnosticLease(uuid: string): Promise<void> {
    const state = await queryLeaseState(uuid);
    if (!TERMINAL_STATES.includes(state)) {
      const subcommand =
        state === LeaseState.LEASE_STATE_ACTIVE
          ? 'close-lease'
          : 'cancel-lease';
      try {
        const result = await chainClient.callTool<{ code: number }>(
          'cosmos_tx',
          {
            module: 'billing',
            subcommand,
            args: [uuid],
            wait_for_confirmation: true,
          },
        );
        expect(result.code).toBe(0);
      } catch (err) {
        // providerd may win the race and reject a PENDING lease between the
        // state query and cancel broadcast. Accept only that terminal race.
        expect(parseToolErrorCode(err)).toBe('TX_FAILED');
        expect(TERMINAL_STATES).toContain(await queryLeaseState(uuid));
      }
    }
  }

  it('lookup_custom_domain_orchestrated returns null for an unclaimed FQDN without elicitation', async ({
    skip,
  }) => {
    const result = await agentClient
      .callTool<{
        action: 'lookup';
        fqdn: string;
        lease: { leaseUuid: string } | null;
      }>('lookup_custom_domain_orchestrated', { fqdn: UNCLAIMED_FQDN })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.match(/unknown query path|unable to resolve type URL/i)) {
          skip(CUSTOM_DOMAIN_SKIP_REASON);
        }
        throw err;
      });

    expect(result).toEqual({
      action: 'lookup',
      fqdn: UNCLAIMED_FQDN,
      lease: null,
    });
  });

  it('setup: creates a queryable lease without provisioning a container', async () => {
    const account = await chainClient.callTool<{ address: string }>(
      'get_account_info',
    );
    testAddress = account.address;
    expect(testAddress).toMatch(/^manifest1/);

    const skus = await chainClient.callTool<{
      result: {
        skus: Array<{
          uuid: string;
          name: string;
          basePrice: { denom: string };
        }>;
      };
    }>('cosmos_query', { module: 'sku', subcommand: 'skus' });
    const micro = skus.result.skus.find((sku) => sku.name === 'docker-micro');
    expect(micro).toBeDefined();

    const before = await chainClient.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const previousLeaseIds = new Set(
      before.result.leases.map((lease) => lease.uuid),
    );

    const funding = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'fund-credit',
      args: [testAddress, `5000000${micro!.basePrice.denom}`],
      wait_for_confirmation: true,
    });
    expect(funding.code).toBe(0);

    const creation = await chainClient.callTool<{ code: number }>('cosmos_tx', {
      module: 'billing',
      subcommand: 'create-lease',
      args: [`${micro!.uuid}:1`],
      wait_for_confirmation: true,
    });
    expect(creation.code).toBe(0);

    const after = await chainClient.callTool<{
      result: { leases: Array<{ uuid: string }> };
    }>('cosmos_query', {
      module: 'billing',
      subcommand: 'leases-by-tenant',
      args: [testAddress],
    });
    const created = after.result.leases.find(
      (lease) => !previousLeaseIds.has(lease.uuid),
    );
    expect(created).toBeDefined();
    leaseUuid = created!.uuid;
  });

  it('troubleshoot_deployment_orchestrated renders the live lease without elicitation', async () => {
    if (leaseUuid === undefined) {
      throw new Error(
        'setup did not create the lease required for diagnostics',
      );
    }

    const result = await agentClient.callTool<{ markdown: string }>(
      'troubleshoot_deployment_orchestrated',
      { lease_uuid: leaseUuid },
    );

    expect(result.markdown).toContain(`# Lease diagnostic — ${leaseUuid}`);
    expect(result.markdown).toMatch(
      /\*\*State:\*\* LEASE_STATE_(PENDING|ACTIVE|REJECTED)/,
    );
    expect(result.markdown).toContain('## Items');
    expect(result.markdown).toContain('## Guidance');
  });
});
