/**
 * Tests for the `closeLease` orchestrator (PR 4 / ENG-129).
 *
 * Coverage:
 *
 *   - Unit tests: validation, confirm dispatch, broadcast invocation,
 *     verifier branch selection (terminal / pending / not_found), and
 *     callback firing.
 *   - Fixture-replay: each `__fixtures__/skills/close-lease/NN-…/`
 *     scenario is a committed snapshot of inputs + expected outputs;
 *     replay asserts byte-baseline equality on the confirm-block text
 *     and the typed `CloseLeaseResult` (success path) or the
 *     `failure.reason` string (verify-fail paths).
 *
 * Mocking: vi.mock the core package's `stopApp` (the only chain
 * broadcast). The clientManager stub's `getQueryClient` returns a
 * `liftedinit.billing.v1.lease({ leaseUuid })`-shaped object so the verifier
 * can read the single-lease payload directly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asLeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type StopAppResult,
  withRetry,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type {
  CloseLeaseArgs,
  CloseLeaseCallbacks,
  CloseLeaseResult,
} from './index.js';

vi.mock('@manifest-network/manifest-mcp-core', async () => {
  const actual = await vi.importActual<
    typeof import('@manifest-network/manifest-mcp-core')
  >('@manifest-network/manifest-mcp-core');
  return {
    ...actual,
    stopApp: vi.fn(),
  };
});

const FIXTURES_ROOT = join(__dirname, '..', '__fixtures__');

function readFixture(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8'));
}

function readFixtureText(...parts: string[]): string {
  return readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8');
}

interface MockQueryClient {
  liftedinit: {
    billing: {
      v1: {
        lease: Mock;
      };
    };
  };
}

function makeMockQueryClient(): MockQueryClient {
  return {
    liftedinit: {
      billing: {
        v1: {
          lease: vi.fn(),
        },
      },
    },
  };
}

interface MockClientManager {
  getQueryClient: Mock;
  getAddress: Mock;
}

function makeMockClientManager(
  queryClient: MockQueryClient,
  address = 'manifest1deadbeef',
): MockClientManager {
  return {
    getQueryClient: vi.fn().mockResolvedValue(queryClient),
    getAddress: vi.fn().mockResolvedValue(address),
  };
}

interface Buckets {
  callbacks: CloseLeaseCallbacks;
  progress: { kind: string }[];
  completed: CloseLeaseResult[];
  failures: { reason: string }[];
  confirms: { text: string }[];
}

function captureCallbacks(confirmAnswer: 'yes' | 'no' = 'yes'): Buckets {
  const progress: { kind: string }[] = [];
  const completed: CloseLeaseResult[] = [];
  const failures: { reason: string }[] = [];
  const confirms: { text: string }[] = [];
  return {
    callbacks: {
      onConfirm: vi.fn(async (block) => {
        confirms.push(block);
        return confirmAnswer;
      }),
      onProgress: (e) => progress.push(e),
      onComplete: (r) => completed.push(r),
      onFailure: async (f) => {
        failures.push(f);
      },
    },
    progress,
    completed,
    failures,
    confirms,
  };
}

// =============================================================================
// 01-close-success: terminal CLOSED state
// =============================================================================

describe('closeLease replay — 01-close-success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: confirm → broadcast → verify CLOSED → onComplete', async () => {
    const args = readFixture(
      'skills',
      'close-lease',
      '01-close-success',
      'input',
      'args.json',
    ) as CloseLeaseArgs;
    const stopResp = readFixture(
      'skills',
      'close-lease',
      '01-close-success',
      'input',
      'stop-app-response.json',
    );
    const leasesPayload = readFixture(
      'skills',
      'close-lease',
      '01-close-success',
      'input',
      'lease-response.json',
    );
    const expected = readFixture(
      'skills',
      'close-lease',
      '01-close-success',
      'expected-result.json',
    );
    const expectedBlock = readFixtureText(
      'skills',
      'close-lease',
      '01-close-success',
      'expected-confirm-block.txt',
    );

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockResolvedValue(
      stopResp as Awaited<ReturnType<typeof core.stopApp>>,
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, progress, completed, failures, confirms } =
      captureCallbacks('yes');

    const { closeLease } = await import('./close-lease.js');
    const result = await closeLease(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof closeLease
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    expect(completed).toEqual([expected]);
    expect(failures).toEqual([]);
    expect(progress.map((p) => p.kind)).toEqual(['user_confirmed']);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.text).toBe(expectedBlock);
    // Read off the recorded call rather than pinning the whole argument list with
    // toHaveBeenCalledWith: that matcher is exact-arity, and core's `stopApp` already
    // declares a trailing `opts?: TxCallOptions` that agent-core will thread once this
    // broadcast becomes cancellable. Slots count from the START (ENG-706).
    const [stopCtx, stopInput] = vi.mocked(core.stopApp).mock.calls[0]!;
    expect(stopCtx).toEqual(
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
    );
    expect(stopInput).toEqual({
      leaseUuid: '11111111-1111-4111-8111-111111111111',
    });
  });
});

// =============================================================================
// 02-close-pending-verify-fail: broadcast OK but state still PENDING
// =============================================================================

describe('closeLease replay — 02-close-pending-verify-fail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verify shows PENDING → onFailure invoked with exact reason → throws TX_FAILED', async () => {
    const args = readFixture(
      'skills',
      'close-lease',
      '02-close-pending-verify-fail',
      'input',
      'args.json',
    ) as CloseLeaseArgs;
    const leasesPayload = readFixture(
      'skills',
      'close-lease',
      '02-close-pending-verify-fail',
      'input',
      'lease-response.json',
    );
    const expectedFailure = readFixture(
      'skills',
      'close-lease',
      '02-close-pending-verify-fail',
      'expected-failure.json',
    ) as { reason: string };

    const core = await import('@manifest-network/manifest-mcp-core');
    // A PENDING lease teardown yields `cancelled` (never `stopped`); the
    // verifier query (mocked to still-PENDING below) still fires pending_drift.
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
      outcome: 'cancelled',
      lease_state: 'LEASE_STATE_REJECTED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, failures } = captureCallbacks('yes');

    const { closeLease } = await import('./close-lease.js');
    await expect(
      closeLease(args, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof closeLease
        >[2]['clientManager'],
      }),
    ).rejects.toThrowError(ManifestMCPError);

    expect(completed).toEqual([]);
    expect(failures).toEqual([expectedFailure]);
  });
});

// =============================================================================
// 03-close-not-found: lease not visible in tenant payload after broadcast
// =============================================================================

describe('closeLease replay — 03-close-not-found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chain returns `{ lease: null }` → onFailure invoked with "not visible on chain" reason → throws TX_FAILED', async () => {
    const args = readFixture(
      'skills',
      'close-lease',
      '03-close-not-found',
      'input',
      'args.json',
    ) as CloseLeaseArgs;
    const leasesPayload = readFixture(
      'skills',
      'close-lease',
      '03-close-not-found',
      'input',
      'lease-response.json',
    );
    const expectedFailure = readFixture(
      'skills',
      'close-lease',
      '03-close-not-found',
      'expected-failure.json',
    ) as { reason: string };

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('99999999-9999-4999-8999-999999999999'),
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');

    const { closeLease } = await import('./close-lease.js');
    await expect(
      closeLease(args, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof closeLease
        >[2]['clientManager'],
      }),
    ).rejects.toThrowError(ManifestMCPError);

    expect(failures).toEqual([expectedFailure]);
  });
});

// =============================================================================
// Unit tests — validation + control-flow guards
// =============================================================================

describe('closeLease — args validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalid UUID throws INVALID_CONFIG before any chain call', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease({ leaseUuid: 'not-a-uuid' }, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof closeLease
        >[2]['clientManager'],
      }),
    ).rejects.toThrow(/leaseUuid must be a UUID/);

    expect(core.stopApp).not.toHaveBeenCalled();
  });

  it('user declines at confirm → throws OPERATION_CANCELLED; broadcast NOT fired', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks('no');
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        },
      ),
    ).rejects.toMatchObject({
      // ENG-272: a user decline is a deliberate cancellation, not a
      // config fault. Pin the dedicated code so a regression to
      // INVALID_CONFIG (or worse, UNKNOWN) is caught.
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      message: expect.stringMatching(/User declined to proceed/),
    });

    expect(core.stopApp).not.toHaveBeenCalled();
  });

  it('broadcast failure surfaces as ManifestMCPError; verify NOT called', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'close-lease rejected by chain',
      ),
    );

    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks('yes');
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/close-lease rejected by chain/);

    expect(queryClient.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
  });

  it('verifier returns terminal REJECTED → counts as success', async () => {
    // Coverage: any terminal state (CLOSED / REJECTED / EXPIRED /
    // INSUFFICIENT_FUNDS per lease-state.TERMINAL_STATES) maps to the
    // `terminal` outcome which is in successValues.
    const core = await import('@manifest-network/manifest-mcp-core');
    // A REJECTED terminal state is reached via cancel (PENDING teardown),
    // so the coherent stopApp outcome here is `cancelled`.
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
      outcome: 'cancelled',
      lease_state: 'LEASE_STATE_REJECTED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        state: 4, // LEASE_STATE_REJECTED
        providerUuid: '22222222-2222-4222-8222-222222222222',
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, failures } = captureCallbacks('yes');
    const { closeLease } = await import('./close-lease.js');

    const result = await closeLease(
      { leaseUuid: '11111111-1111-4111-8111-111111111111' },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof closeLease
        >[2]['clientManager'],
      },
    );

    expect(result.finalState).toBe('LEASE_STATE_REJECTED');
    expect(completed).toEqual([result]);
    expect(failures).toEqual([]);
  });

  it('verifier returns ACTIVE → non-terminal → pending_drift inform-only failure', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        state: 2, // LEASE_STATE_ACTIVE
        providerUuid: '22222222-2222-4222-8222-222222222222',
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrowError(ManifestMCPError);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe(
      'close_lease tx accepted but state is still LEASE_STATE_ACTIVE.',
    );
  });

  it('verifier chain-query rejects → onFailure invoked + throws QUERY_FAILED (not propagated raw)', async () => {
    // Copilot review PR #60 (comment 3276419264): the verifier closure
    // previously called `billing.v1.lease()` without try/catch. A chain
    // rejection would propagate out of `verifyAndRecover` and bypass
    // the post-verify `onFailure` callback. Mirror the disambiguation
    // pattern from `lookupDomain` (round 1) + `troubleshoot` (round 3).
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new Error('transport: ECONNREFUSED 127.0.0.1:9090'),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('11111111-1111-4111-8111-111111111111'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('ECONNREFUSED');
    expect(failures[0]?.reason).toContain('close-verify');
  });

  it('verifier chain-query rejects with structured ManifestMCPError → preserves original code', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: asLeaseUuid('11111111-1111-4111-8111-111111111111'),
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'DEADBEEF',
      code: 0,
      confirmed: true,
    });

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'fixture-injected upstream INVALID_CONFIG',
      ),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
    const { closeLease } = await import('./close-lease.js');

    await expect(
      closeLease(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: 'fixture-injected upstream INVALID_CONFIG',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain(
      'fixture-injected upstream INVALID_CONFIG',
    );
  });
});

// =============================================================================
// Post-mutation verification (ENG-805)
// =============================================================================

describe('closeLease post-mutation verification (ENG-805)', () => {
  const leaseUuid = asLeaseUuid('11111111-1111-4111-8111-111111111111');
  const retryConfig = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const receipts = [
    {
      lease_uuid: leaseUuid,
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'CLOSE_CONFIRMED_HASH',
      confirmed: true,
      code: 0,
    },
    {
      lease_uuid: leaseUuid,
      outcome: 'cancelled',
      lease_state: 'LEASE_STATE_REJECTED',
      transactionHash: 'CANCEL_SENT_HASH',
      confirmed: false,
    },
  ] satisfies StopAppResult[];

  const readFailures = [
    {
      label: 'HTTP 408',
      makeError: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'close verification request failed',
          { httpStatus: 408 },
        ),
    },
    {
      label: 'HTTP 503',
      makeError: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'close verification request failed',
          { httpStatus: 503 },
        ),
    },
    {
      label: 'raw ECONNRESET',
      makeError: () => new Error('verification transport ECONNRESET'),
    },
  ];

  for (const receipt of receipts) {
    it.each(readFailures)(
      `${receipt.outcome} receipt prevents another mutation after $label`,
      async ({ makeError }) => {
        const core = await import('@manifest-network/manifest-mcp-core');
        const { closeLease } = await import('./close-lease.js');
        const original = makeError();
        const originalDetails =
          original instanceof ManifestMCPError ? original.details : undefined;
        if (originalDetails) {
          // Read-error metadata must not overwrite the actual stop receipt.
          Object.assign(originalDetails, {
            sent: false,
            transaction_hash: 'UPSTREAM_QUERY_HASH',
            transaction_confirmed: !receipt.confirmed,
            transaction_code: 23,
            lease_uuid: 'upstream-query-lease',
            stop_outcome: 'upstream-query-outcome',
            lease_state: 'LEASE_STATE_ACTIVE',
          });
          Object.freeze(originalDetails);
        }
        Object.freeze(original);
        vi.mocked(core.stopApp).mockResolvedValue(Object.freeze(receipt));
        const queryClient = makeMockQueryClient();
        queryClient.liftedinit.billing.v1.lease.mockRejectedValue(original);
        const clientManager = makeMockClientManager(queryClient);
        const { callbacks, confirms, failures, completed } = captureCallbacks();
        const retry = vi.fn();

        const error: unknown = await withRetry(
          () =>
            closeLease({ leaseUuid }, callbacks, {
              clientManager: clientManager as unknown as Parameters<
                typeof closeLease
              >[2]['clientManager'],
            }),
          { config: retryConfig, onRetry: retry },
        ).catch((error: unknown) => error);

        expect(core.stopApp).toHaveBeenCalledTimes(1);
        expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(
          1,
        );
        expect(retry).not.toHaveBeenCalled();
        expect(error).toBeInstanceOf(ManifestMCPError);
        expect(error).not.toBe(original);
        expect(error).toMatchObject({
          code: ManifestMCPErrorCode.QUERY_FAILED,
          details: {
            sent: true,
            lease_uuid: receipt.lease_uuid,
            transaction_hash: receipt.transactionHash,
            transaction_confirmed: receipt.confirmed,
            ...(receipt.confirmed ? { transaction_code: receipt.code } : {}),
            stop_outcome: receipt.outcome,
            lease_state: receipt.lease_state,
            ...(originalDetails
              ? { httpStatus: originalDetails.httpStatus }
              : {}),
          },
        });
        if (!(error instanceof ManifestMCPError)) {
          throw new Error('expected a structured verification failure');
        }
        const cause: unknown = Reflect.get(error, 'cause');
        if (original instanceof ManifestMCPError) {
          expect(cause).toBe(original);
          expect(error.message).toBe(original.message);
          expect(original.details).toBe(originalDetails);
          expect(original.details).toMatchObject({
            sent: false,
            transaction_hash: 'UPSTREAM_QUERY_HASH',
            transaction_confirmed: !receipt.confirmed,
            transaction_code: 23,
          });
        } else {
          // A raw read failure may first gain its established QUERY_FAILED
          // wrapper before the post-mutation boundary adds receipt context.
          expect(
            cause === original ||
              (cause instanceof Error &&
                Reflect.get(cause, 'cause') === original),
          ).toBe(true);
        }
        expect(
          Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable,
        ).toBe(false);
        if (!receipt.confirmed) {
          expect(error.details).not.toHaveProperty('transaction_code');
        }
        expect(original).not.toHaveProperty('cause');
        expect(confirms).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(completed).toEqual([]);
      },
    );
  }

  it('does not evaluate verification diagnostic getters or replay a confirmed stop', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { closeLease } = await import('./close-lease.js');
    const receipt = Object.freeze({
      lease_uuid: leaseUuid,
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'A'.repeat(64),
      confirmed: true,
      code: 0,
    } satisfies StopAppResult);
    vi.mocked(core.stopApp).mockResolvedValue(receipt);
    const diagnosticGetter = vi.fn(() => {
      throw new Error('fetch failed');
    });
    const originalDetails = Object.freeze(
      Object.defineProperty({ httpStatus: 503 }, 'diagnostic', {
        enumerable: true,
        get: diagnosticGetter,
      }),
    );
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'verification query unavailable',
        originalDetails,
      ),
    );
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(original);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, confirms, failures, completed } = captureCallbacks();
    const retry = vi.fn();

    const error: unknown = await withRetry(
      () =>
        closeLease({ leaseUuid }, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        }),
      { config: retryConfig, onRetry: retry },
    ).catch((error: unknown) => error);

    expect(core.stopApp).toHaveBeenCalledTimes(1);
    expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(diagnosticGetter).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError)) {
      throw new Error('expected a structured verification failure');
    }
    expect(error.code).toBe(original.code);
    expect(error.message).toBe(original.message);
    expect(Reflect.get(error, 'cause')).toBe(original);
    expect(error.details).toEqual({
      lease_uuid: leaseUuid,
      sent: true,
      transaction_hash: receipt.transactionHash,
      transaction_confirmed: true,
      transaction_code: 0,
      stop_outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      httpStatus: 503,
    });
    expect(original.details).toBe(originalDetails);
    expect(
      Object.getOwnPropertyDescriptor(originalDetails, 'diagnostic')?.get,
    ).toBe(diagnosticGetter);
    expect(confirms).toHaveLength(1);
    expect(failures).toEqual([
      {
        reason: `Failed to query lease ${leaseUuid} during close-verify: ${original.message}`,
      },
    ]);
    expect(completed).toEqual([]);
  });

  it.each([
    {
      label: 'SDK message',
      field: 'message',
      createError: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          'verification query failed',
        ),
      expectedCode: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      expectedMessage: 'Verification error message unavailable',
    },
    {
      label: 'SDK code',
      field: 'code',
      createError: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'verification query failed',
        ),
      expectedCode: ManifestMCPErrorCode.QUERY_FAILED,
      expectedMessage: 'verification query failed',
    },
    {
      label: 'raw Error message',
      field: 'message',
      createError: () => new Error('verification query failed'),
      expectedCode: ManifestMCPErrorCode.QUERY_FAILED,
      expectedMessage: `Failed to query lease ${leaseUuid} during close-verify: Verification error message unavailable`,
    },
  ])(
    'preserves the stop receipt and original cause when $label access throws',
    async ({ createError, field, expectedCode, expectedMessage }) => {
      const core = await import('@manifest-network/manifest-mcp-core');
      const { closeLease } = await import('./close-lease.js');
      const receipt = Object.freeze({
        lease_uuid: leaseUuid,
        outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
        transactionHash: 'B'.repeat(64),
        confirmed: true,
        code: 0,
      } satisfies StopAppResult);
      vi.mocked(core.stopApp).mockResolvedValue(receipt);
      const original = createError();
      const metadataGetter = vi.fn(() => {
        throw new Error(
          'fetch failed while reading verification error metadata',
        );
      });
      Object.defineProperty(original, field, {
        configurable: true,
        get: metadataGetter,
      });
      const queryClient = makeMockQueryClient();
      queryClient.liftedinit.billing.v1.lease.mockRejectedValue(original);
      const clientManager = makeMockClientManager(queryClient);
      const { callbacks, confirms, failures, completed } = captureCallbacks();
      const retry = vi.fn();

      const error: unknown = await withRetry(
        () =>
          closeLease({ leaseUuid }, callbacks, {
            clientManager: clientManager as unknown as Parameters<
              typeof closeLease
            >[2]['clientManager'],
          }),
        { config: retryConfig, onRetry: retry },
      ).catch((error: unknown) => error);

      expect(core.stopApp).toHaveBeenCalledTimes(1);
      expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(ManifestMCPError);
      if (!(error instanceof ManifestMCPError)) {
        throw new Error('expected a structured verification failure');
      }
      expect(error.code).toBe(expectedCode);
      expect(error.message).toBe(expectedMessage);
      expect(error.details).toEqual({
        lease_uuid: leaseUuid,
        sent: true,
        transaction_hash: receipt.transactionHash,
        transaction_confirmed: true,
        transaction_code: 0,
        stop_outcome: 'stopped',
        lease_state: 'LEASE_STATE_CLOSED',
      });
      const cause: unknown = Reflect.get(error, 'cause');
      expect(
        cause === original ||
          (cause instanceof Error && Reflect.get(cause, 'cause') === original),
      ).toBe(true);
      expect(Object.getOwnPropertyDescriptor(original, field)?.get).toBe(
        metadataGetter,
      );
      expect(confirms).toHaveLength(1);
      expect(failures).toEqual([
        {
          reason: `Failed to query lease ${leaseUuid} during close-verify: ${
            field === 'code'
              ? 'verification query failed'
              : 'Verification error message unavailable'
          }`,
        },
      ]);
      expect(completed).toEqual([]);
    },
  );

  const inactiveResults = [
    {
      lease_uuid: leaseUuid,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
    },
    {
      lease_uuid: leaseUuid,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_EXPIRED',
    },
    {
      lease_uuid: leaseUuid,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: 'provider rejected the lease',
    },
  ] satisfies StopAppResult[];

  for (const receipt of receipts) {
    it.each([
      {
        label: 'non-terminal state',
        payload: { lease: { uuid: leaseUuid, state: 2 } },
        reason:
          'close_lease tx accepted but state is still LEASE_STATE_ACTIVE.',
      },
      {
        label: 'missing lease',
        payload: {},
        reason: `lease ${leaseUuid} not visible on chain after close`,
      },
      {
        label: 'invalid state',
        payload: { lease: { uuid: leaseUuid, state: 999 } },
        reason: `lease ${leaseUuid} state could not be decoded (raw=999)`,
      },
    ])(
      `${receipt.outcome} receipt remains available after $label verification failure`,
      async ({ payload, reason }) => {
        const core = await import('@manifest-network/manifest-mcp-core');
        const { closeLease } = await import('./close-lease.js');
        vi.mocked(core.stopApp).mockResolvedValue(receipt);
        const queryClient = makeMockQueryClient();
        queryClient.liftedinit.billing.v1.lease.mockResolvedValue(payload);
        const clientManager = makeMockClientManager(queryClient);
        const { callbacks, confirms, failures, completed } = captureCallbacks();
        const retry = vi.fn();

        await expect(
          withRetry(
            () =>
              closeLease({ leaseUuid }, callbacks, {
                clientManager: clientManager as unknown as Parameters<
                  typeof closeLease
                >[2]['clientManager'],
              }),
            { config: retryConfig, onRetry: retry },
          ),
        ).rejects.toMatchObject({
          code: ManifestMCPErrorCode.TX_FAILED,
          message: reason,
          details: {
            sent: true,
            lease_uuid: receipt.lease_uuid,
            transaction_hash: receipt.transactionHash,
            transaction_confirmed: receipt.confirmed,
            ...(receipt.confirmed ? { transaction_code: receipt.code } : {}),
            stop_outcome: receipt.outcome,
            lease_state: receipt.lease_state,
          },
        });

        expect(core.stopApp).toHaveBeenCalledTimes(1);
        expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(
          1,
        );
        expect(retry).not.toHaveBeenCalled();
        expect(confirms).toHaveLength(1);
        expect(failures).toEqual([{ reason }]);
        expect(completed).toEqual([]);
      },
    );

    it(`${receipt.outcome} receipt survives a verifier invariant failure`, async () => {
      const core = await import('@manifest-network/manifest-mcp-core');
      const { closeLease } = await import('./close-lease.js');
      const verifier = await import('./internals/verify-recover.js');
      const verify = vi.spyOn(verifier, 'verifyAndRecover').mockResolvedValue({
        result: 'success',
        verifierOutcome: 'terminal',
        branchId: null,
        journalActionTags: [],
        diagnostic: {},
      });
      try {
        vi.mocked(core.stopApp).mockResolvedValue(receipt);
        const queryClient = makeMockQueryClient();
        const clientManager = makeMockClientManager(queryClient);
        const { callbacks, confirms, failures, completed } = captureCallbacks();

        await expect(
          closeLease({ leaseUuid }, callbacks, {
            clientManager: clientManager as unknown as Parameters<
              typeof closeLease
            >[2]['clientManager'],
          }),
        ).rejects.toMatchObject({
          code: ManifestMCPErrorCode.TX_FAILED,
          message: expect.stringContaining(
            'close-lease verifier invariant violated',
          ),
          details: {
            sent: true,
            lease_uuid: receipt.lease_uuid,
            transaction_hash: receipt.transactionHash,
            transaction_confirmed: receipt.confirmed,
            ...(receipt.confirmed ? { transaction_code: receipt.code } : {}),
            stop_outcome: receipt.outcome,
            lease_state: receipt.lease_state,
          },
        });

        expect(core.stopApp).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(confirms).toHaveLength(1);
        // Existing invariant handling throws directly without a failure callback.
        expect(failures).toEqual([]);
        expect(completed).toEqual([]);
      } finally {
        verify.mockRestore();
      }
    });
  }

  it.each(inactiveResults)(
    '$lease_state without a receipt preserves the upstream diagnostics and invents no broadcast evidence',
    async (stopResult) => {
      // stopApp can also return already_inactive after a failed broadcast was
      // reconciled on chain. Absence of a receipt cannot establish sent:false.
      const core = await import('@manifest-network/manifest-mcp-core');
      const { closeLease } = await import('./close-lease.js');
      vi.mocked(core.stopApp).mockResolvedValue(Object.freeze(stopResult));
      const original = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'close verification request failed',
          Object.freeze({ httpStatus: 503 }),
        ),
      );
      const queryClient = makeMockQueryClient();
      queryClient.liftedinit.billing.v1.lease.mockRejectedValue(original);
      const clientManager = makeMockClientManager(queryClient);
      const { callbacks, failures, completed } = captureCallbacks();

      const error: unknown = await closeLease({ leaseUuid }, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof closeLease
        >[2]['clientManager'],
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ManifestMCPError);
      if (!(error instanceof ManifestMCPError)) {
        throw new Error('expected a structured verification failure');
      }
      expect(error).toMatchObject({
        code: original.code,
        message: original.message,
        details: {
          httpStatus: 503,
          lease_uuid: leaseUuid,
          stop_outcome: 'already_inactive',
          lease_state: stopResult.lease_state,
        },
      });
      expect(Reflect.get(error, 'cause')).toBe(original);
      expect(original.details).toEqual({ httpStatus: 503 });
      expect(error.details).not.toHaveProperty('sent');
      expect(error.details).not.toHaveProperty('transaction_hash');
      expect(error.details).not.toHaveProperty('transaction_confirmed');
      expect(error.details).not.toHaveProperty('transaction_code');
      expect(core.stopApp).toHaveBeenCalledTimes(1);
      expect(failures).toHaveLength(1);
      expect(completed).toEqual([]);
    },
  );

  it('already_inactive preserves a raw permanent cause that vetoes retry without inventing a receipt', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { closeLease } = await import('./close-lease.js');
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: leaseUuid,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
    } satisfies StopAppResult);
    const permanentCause = Object.freeze(
      new Error('getaddrinfo ENOTFOUND rpc.invalid'),
    );
    const original = Object.freeze(
      Object.assign(new Error('fetch failed'), { cause: permanentCause }),
    );
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(original);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures, completed } = captureCallbacks();
    const retry = vi.fn();

    const error: unknown = await withRetry(
      () =>
        closeLease({ leaseUuid }, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof closeLease
          >[2]['clientManager'],
        }),
      { config: retryConfig, onRetry: retry },
    ).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError)) {
      throw new Error('expected a structured verification failure');
    }
    expect(error).toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: {
        lease_uuid: leaseUuid,
        stop_outcome: 'already_inactive',
        lease_state: 'LEASE_STATE_CLOSED',
      },
    });
    const cause: unknown = Reflect.get(error, 'cause');
    expect(
      cause === original ||
        (cause instanceof Error && Reflect.get(cause, 'cause') === original),
    ).toBe(true);
    expect(original.cause).toBe(permanentCause);
    expect(error.details).not.toHaveProperty('sent');
    expect(error.details).not.toHaveProperty('transaction_hash');
    expect(error.details).not.toHaveProperty('transaction_confirmed');
    expect(error.details).not.toHaveProperty('transaction_code');
    expect(core.stopApp).toHaveBeenCalledTimes(1);
    expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    expect(completed).toEqual([]);
  });

  it.each(readFailures)(
    'already_inactive retains retryable verification behavior after $label',
    async ({ makeError }) => {
      const core = await import('@manifest-network/manifest-mcp-core');
      const { closeLease } = await import('./close-lease.js');
      vi.mocked(core.stopApp).mockResolvedValue({
        lease_uuid: leaseUuid,
        outcome: 'already_inactive',
        lease_state: 'LEASE_STATE_CLOSED',
      } satisfies StopAppResult);
      const original = makeError();
      const queryClient = makeMockQueryClient();
      queryClient.liftedinit.billing.v1.lease
        .mockRejectedValueOnce(original)
        .mockResolvedValue({ lease: { uuid: leaseUuid, state: 3 } });
      const clientManager = makeMockClientManager(queryClient);
      const { callbacks, confirms, failures, completed } = captureCallbacks();
      const retry = vi.fn();

      const result = await withRetry(
        () =>
          closeLease({ leaseUuid }, callbacks, {
            clientManager: clientManager as unknown as Parameters<
              typeof closeLease
            >[2]['clientManager'],
          }),
        { config: retryConfig, onRetry: retry },
      );

      expect(result).toEqual({ leaseUuid, finalState: 'LEASE_STATE_CLOSED' });
      expect(core.stopApp).toHaveBeenCalledTimes(2);
      expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledTimes(2);
      expect(retry).toHaveBeenCalledTimes(1);
      const retryError: unknown = retry.mock.calls[0]?.[0];
      expect(retryError).toBeInstanceOf(ManifestMCPError);
      if (!(retryError instanceof ManifestMCPError)) {
        throw new Error('expected a structured verification failure');
      }
      expect(retryError.details ?? {}).not.toHaveProperty('sent');
      expect(retryError.details ?? {}).not.toHaveProperty('transaction_hash');
      expect(retryError.details ?? {}).not.toHaveProperty(
        'transaction_confirmed',
      );
      expect(retryError.details ?? {}).not.toHaveProperty('transaction_code');
      if (original instanceof ManifestMCPError)
        expect(Reflect.get(retryError, 'cause')).toBe(original);
      expect(confirms).toHaveLength(2);
      expect(failures).toHaveLength(1);
      expect(completed).toEqual([result]);
    },
  );
});

// =============================================================================
// Cancellation (ENG-374)
// =============================================================================

describe('cancellation (ENG-374)', () => {
  const CANCEL_LEASE_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a pre-aborted signal throws OPERATION_CANCELLED and never broadcasts', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { closeLease } = await import('./close-lease.js');
    const ac = new AbortController();
    ac.abort(new Error('user aborted'));
    const events: Array<{ kind: string }> = [];
    const onConfirm = vi.fn(async () => 'yes' as const);
    const clientManager = makeMockClientManager(makeMockQueryClient());
    await expect(
      closeLease(
        { leaseUuid: CANCEL_LEASE_UUID },
        { onConfirm, onProgress: (e) => events.push(e) },
        { clientManager: clientManager as never, signal: ac.signal },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    expect(core.stopApp).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1);
  });

  it('abort after confirmation is caught by the final guard before broadcast', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { closeLease } = await import('./close-lease.js');
    const ac = new AbortController();
    const events: Array<{ kind: string }> = [];
    const clientManager = makeMockClientManager(makeMockQueryClient());

    await expect(
      closeLease(
        { leaseUuid: CANCEL_LEASE_UUID },
        {
          onConfirm: async () => 'yes',
          onProgress: (event) => {
            events.push(event);
            if (event.kind === 'user_confirmed') ac.abort('host cancelled');
          },
        },
        { clientManager: clientManager as never, signal: ac.signal },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expect(core.stopApp).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'cancelled')).toHaveLength(
      1,
    );
  });

  it('aborting while onConfirm is pending rejects with OPERATION_CANCELLED and never broadcasts', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { closeLease } = await import('./close-lease.js');
    const ac = new AbortController();
    let rejectConfirm: (e: unknown) => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<'yes' | 'no'>((_res, rej) => {
          rejectConfirm = rej;
        }),
    );
    const clientManager = makeMockClientManager(makeMockQueryClient());
    const p = closeLease(
      { leaseUuid: CANCEL_LEASE_UUID },
      { onConfirm },
      { clientManager: clientManager as never, signal: ac.signal },
    );
    ac.abort(new Error('mid-confirm'));
    await expect(p).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    rejectConfirm(new Error('late-decline')); // swallowed, no unhandled rejection
    expect(core.stopApp).not.toHaveBeenCalled();
  });
});
