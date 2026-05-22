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
  ManifestMCPError,
  ManifestMCPErrorCode,
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
    expect(core.stopApp).toHaveBeenCalledWith(
      clientManager,
      '11111111-1111-4111-8111-111111111111',
    );
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
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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
      lease_uuid: '99999999-9999-4999-8999-999999999999',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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

  it('user declines at confirm → throws INVALID_CONFIG; broadcast NOT fired', async () => {
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
    ).rejects.toThrow(/User declined to proceed/);

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
    vi.mocked(core.stopApp).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.stopApp>>);

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
