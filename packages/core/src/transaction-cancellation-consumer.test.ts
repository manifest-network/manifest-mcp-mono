import { SigningStargateClient } from '@cosmjs/stargate';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  expectExactDetails,
  makeInclusionTimeoutFixture,
} from './__test-utils__/mocks.js';
import { asLeaseUuid } from './brands.js';
import { CosmosClientManager } from './client.js';
import { createManifestClient } from './client-full.js';
import { LeaseState } from './manifest-types.js';
import { isRetryableError } from './retry.js';
import {
  MAX_TOOL_ERROR_RESPONSE_CHARS,
  withErrorHandling,
} from './server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

const { queryLease } = vi.hoisted(() => ({ queryLease: vi.fn() }));

vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn(async () => ({
    liftedinit: { billing: { v1: { lease: queryLease } } },
  })),
}));

const LEASE = asLeaseUuid('550e8400-e29b-41d4-a716-446655440000');

/** Real factory, manager, stopApp and native broadcast; only signing and remote reads are mocked. */
async function cancelAcceptedStop(initialState: LeaseState, reason: unknown) {
  const wire = await makeInclusionTimeoutFixture();
  const lookup = deferred<Awaited<ReturnType<typeof wire.comet.txSearchAll>>>();
  wire.comet.txSearchAll.mockReturnValue(lookup.promise);
  queryLease
    .mockResolvedValueOnce({ lease: { uuid: LEASE, state: initialState } })
    .mockResolvedValue({
      lease: { uuid: LEASE, state: LeaseState.LEASE_STATE_CLOSED },
    });
  const connect = vi
    .spyOn(SigningStargateClient, 'connectWithSigner')
    .mockResolvedValue(wire.client);
  const client = await createManifestClient({
    config: {
      chainId: wire.chainId,
      rpcUrl: 'https://rpc.example.invalid',
      restUrl: 'https://rest.example.invalid',
      gasPrice: '1umfx',
      retry: { maxRetries: 0 },
    },
    walletProvider: {
      getAddress: async () => wire.sender,
      getSigner: async () => wire.signer,
    },
    chainIdentityFetch: vi.fn(async () =>
      Response.json({ default_node_info: { network: wire.chainId } }),
    ),
  });
  const controller = new AbortController();
  const pending = client
    .stopApp({ leaseUuid: LEASE }, { signal: controller.signal, fee: wire.fee })
    .catch((error: unknown) => error);

  try {
    await vi.advanceTimersByTimeAsync(2);
    expect(connect).toHaveBeenCalledOnce();
    expect(wire.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(wire.comet.txSearchAll).toHaveBeenCalledOnce();
    controller.abort(reason);
    // The native lookup is still unresolved: caller cancellation must settle independently.
    const error = await pending;
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError)) throw error;
    expect(error.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expectExactDetails(error, {
      reason,
      sent: true,
      transactionHash: wire.hash,
    });
    expect(error.details?.reason).toBe(reason);
    expect(isRetryableError(error)).toBe(false);
    expect(queryLease).toHaveBeenCalledOnce();

    // Let the abandoned native poll reject, then drain the lock. It must neither
    // re-query the terminal lease nor mutate the already returned cancellation.
    lookup.resolve({ txs: [], totalCount: 0 });
    await client.chain.withBroadcastLock(wire.sender, async () => undefined);
    expect(queryLease).toHaveBeenCalledOnce();
    expect(wire.sign).toHaveBeenCalledOnce();
    expect(wire.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expectExactDetails(error, {
      reason,
      sent: true,
      transactionHash: wire.hash,
    });
    return { error, hash: wire.hash };
  } finally {
    lookup.resolve({ txs: [], totalCount: 0 });
    client.dispose();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  queryLease.mockReset();
});

afterEach(() => {
  CosmosClientManager.clearInstances();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('accepted caller cancellation at consumer boundaries', () => {
  it.each([
    ['ACTIVE close', LeaseState.LEASE_STATE_ACTIVE],
    ['PENDING cancel', LeaseState.LEASE_STATE_PENDING],
  ] as const)(
    '%s retains the known hash through bound stopApp without terminal reconciliation',
    async (_label, initialState) => {
      await cancelAcceptedStop(
        initialState,
        new Error('caller stopped waiting for teardown'),
      );
    },
  );

  it('keeps sparse submission evidence in bounded real MCP output under a large abort reason', async () => {
    const reason = new Error(`caller cancelled: ${'x'.repeat(200_000)}`);
    const { error, hash } = await cancelAcceptedStop(
      LeaseState.LEASE_STATE_ACTIVE,
      reason,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling(
      'close_lease',
      async (): Promise<CallToolResult> => {
        throw error;
      },
    );
    const result = await handler();
    expect(result.isError).toBe(true);
    const content = result.content[0];
    expect(content?.type).toBe('text');
    if (content?.type !== 'text') throw new Error('Expected MCP error text');
    expect(content.text.length).toBeLessThanOrEqual(
      MAX_TOOL_ERROR_RESPONSE_CHARS,
    );
    const projected = JSON.parse(content.text);
    expect(projected.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expect(projected.truncated).toBe(true);
    expect(projected.details).toMatchObject({
      sent: true,
      transactionHash: hash,
    });
    expect(Object.keys(projected.details).sort()).toEqual([
      'reason',
      'sent',
      'transactionHash',
    ]);
    expectExactDetails(error, {
      reason,
      sent: true,
      transactionHash: hash,
    });
    expect(error.details?.reason).toBe(reason);
  });
});
