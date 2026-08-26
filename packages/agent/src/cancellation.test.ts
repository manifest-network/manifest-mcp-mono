/// <reference lib="es2024.promise" />

/**
 * Transport-to-agent-core post-broadcast cancellation test for ENG-745.
 *
 * The handler tests prove that every tool receives the live request signal;
 * agent-core's own suites prove the final pre-broadcast guards. This test spans
 * both layers for the partial-success path where a lease already exists and
 * the cancelled tool response can no longer carry its UUID back to the host.
 */

import { deployApp } from '@manifest-network/manifest-agent-core';
import {
  connectClientWithElicitation,
  type ElicitationScript,
} from '@manifest-network/manifest-mcp-core/__test-utils__/callToolWithElicitation.js';
import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import type { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type ElicitRequestFormParams,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMCPServer, type AgentOrchestrators } from './index.js';

vi.mock('@manifest-network/manifest-mcp-core', async () => {
  const actual = await vi.importActual<
    typeof import('@manifest-network/manifest-mcp-core')
  >('@manifest-network/manifest-mcp-core');
  const clientManager = {
    disconnect: vi.fn(),
    getQueryClient: vi.fn().mockResolvedValue({}),
    getSigningClient: vi.fn().mockResolvedValue({}),
    getAddress: vi.fn().mockResolvedValue('manifest1abc'),
    getConfig: vi.fn().mockReturnValue({
      chainId: 'manifest-ledger-testnet-1',
      gasPrice: '1umfx',
    }),
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue(clientManager),
    },
    cosmosEstimateFee: vi.fn().mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: {
        amount: [{ denom: 'umfx', amount: '2300' }],
        gas: '142000',
      },
    }),
    resolveSku: vi.fn().mockResolvedValue({
      skuUuid: 'sku-small',
      providerUuid: 'provider-one',
      name: 'small',
      active: true,
    }),
  };
});

vi.mock('@manifest-network/manifest-mcp-fred', async () => {
  const actual = await vi.importActual<
    typeof import('@manifest-network/manifest-mcp-fred')
  >('@manifest-network/manifest-mcp-fred');
  return {
    ...actual,
    buildManifestPreview: vi.fn().mockResolvedValue({
      manifest_json: '{"image":"nginx"}',
      meta_hash_hex: 'ab'.repeat(32),
    }),
    checkDeploymentReadiness: vi.fn().mockResolvedValue({
      tenant: 'manifest1abc',
      image: 'nginx',
      size: 'small',
      wallet_balances: [{ denom: 'umfx', amount: '10000000' }],
      credits: {
        active_leases: '0',
        pending_leases: '0',
        reserved_amounts: [],
        balances: [{ denom: 'umfx', amount: '50000000000' }],
        available_balances: [{ denom: 'umfx', amount: '50000000000' }],
      },
      sku: {
        name: 'small',
        uuid: 'sku-small',
        provider_uuid: 'provider-one',
        price: { denom: 'umfx', amount: '1000' },
        active: true,
      },
      sku_candidates: [
        {
          name: 'small',
          uuid: 'sku-small',
          provider_uuid: 'provider-one',
          price: { denom: 'umfx', amount: '1000' },
          active: true,
        },
      ],
      available_skus: [
        {
          name: 'small',
          uuid: 'sku-small',
          provider_uuid: 'provider-one',
        },
      ],
      ready: true,
      missing_steps: [],
    }),
    deployApp: vi.fn().mockResolvedValue({
      lease_uuid: '55555555-5555-4555-8555-555555555555',
      provider_uuid: '66666666-6666-4666-8666-666666666666',
      provider_url: 'https://provider.example.com',
      state: 2,
      connection: {
        instances: [
          {
            name: 'app',
            status: 'running',
            fqdn: 'app.example.com',
            ports: {},
          },
        ],
      },
    }),
    waitForAppReady: vi.fn(),
  };
});

const leaseUuid = '550e8400-e29b-41d4-a716-446655440000';
let activeTransports: InMemoryTransport[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  activeTransports = [];
});

afterEach(async () => {
  for (const transport of activeTransports) {
    await transport.close();
  }
  activeTransports = [];
});

function makeServer(
  orchestrators: Partial<AgentOrchestrators>,
): AgentMCPServer {
  return new AgentMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet({ signArbitrary: true }),
    orchestrators,
  });
}

const confirmScript: ElicitationScript = {
  respond: (request) => {
    const params = request.params as ElicitRequestFormParams;
    const schema = params.requestedSchema as unknown as {
      properties?: { verdict?: { enum?: string[] } };
    };
    const verdicts = schema.properties?.verdict?.enum ?? [];
    return verdicts.includes('edit_env')
      ? { action: 'accept' as const, content: { verdict: 'confirm' } }
      : { action: 'accept' as const, content: { verdict: 'yes' } };
  },
};

describe('AgentMCPServer real-orchestrator cancellation (ENG-745)', () => {
  it('readiness cancel exits the real deploy flow and logs the live lease out of band', async () => {
    const pollStarted = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const logReceived = Promise.withResolvers<Record<string, unknown>>();
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.deployApp).mockResolvedValueOnce({
      lease_uuid: leaseUuid,
      provider_uuid: '66666666-6666-4666-8666-666666666666',
      provider_url: 'https://provider.example.com',
      state: 1,
      connection: { instances: [] },
    } as never);
    let pollSignal: AbortSignal | undefined;
    vi.mocked(fred.waitForAppReady).mockImplementationOnce(
      async (_ctx, _args, options) => {
        const signal = options?.signal;
        pollSignal = signal;
        pollStarted.resolve();
        if (signal === undefined) {
          throw new Error('readiness poll received no signal');
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          } else {
            signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }
        });
        signal.throwIfAborted();
        throw new Error('unreachable');
      },
    );
    const wrappedDeploy: AgentOrchestrators['deployApp'] = async (...args) => {
      try {
        return await deployApp(...args);
      } finally {
        settled.resolve();
      }
    };
    const server = makeServer({ deployApp: wrappedDeploy });
    const connection = await connectClientWithElicitation(
      server.getServer(),
      confirmScript,
      activeTransports,
    );
    connection.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        const data = notification.params.data as Record<string, unknown>;
        if (data.kind === 'deploy_cancelled_after_broadcast') {
          logReceived.resolve(data);
        }
      },
    );
    const controller = new AbortController();
    const request = connection.client
      .callTool(
        {
          name: 'deploy_app_orchestrated',
          arguments: { spec: { image: 'nginx', port: 80, size: 'small' } },
        },
        undefined,
        { signal: controller.signal },
      )
      .catch(() => undefined);

    try {
      await pollStarted.promise;
      controller.abort();
      await settled.promise;
      const log = await logReceived.promise;
      expect(pollSignal?.aborted).toBe(true);
      expect(fred.waitForAppReady).toHaveBeenCalledOnce();
      expect(log).toMatchObject({
        kind: 'deploy_cancelled_after_broadcast',
        code: 'OPERATION_CANCELLED',
        lease_uuid: leaseUuid,
        readiness_unconfirmed: true,
      });
    } finally {
      await request;
      await connection.close();
    }
  });
});
