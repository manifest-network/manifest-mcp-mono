/**
 * Tests for the `troubleshootDeployment` orchestrator (PR 4 / ENG-129).
 *
 * PR 4 ships the chain-only variant (per blueprint §3.3 #3 option b):
 * a single `billing.lease(leaseUuid)` query feeds the inline markdown
 * renderer. No fred / provider HTTP calls, no ADR-036 auth tokens, no
 * `appStatus` / `getAppLogs` round-trips. Fixture scenarios therefore
 * stub only the chain query response.
 *
 * Coverage:
 *
 *   - Unit tests: argument validation, query-failure path, missing-lease
 *     path (chain returns `null`), state-decoding edge cases.
 *   - Fixture-replay: each `__fixtures__/skills/troubleshoot/NN-…/`
 *     scenario asserts byte-for-byte equality of the rendered markdown
 *     report against a committed snapshot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type {
  TroubleshootArgs,
  TroubleshootCallbacks,
  TroubleshootReport,
} from './index.js';

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
}

function makeMockClientManager(
  queryClient: MockQueryClient,
): MockClientManager {
  return {
    getQueryClient: vi.fn().mockResolvedValue(queryClient),
  };
}

interface Buckets {
  callbacks: TroubleshootCallbacks;
  progress: { kind: string }[];
  completed: TroubleshootReport[];
  failures: { reason: string }[];
}

function captureCallbacks(): Buckets {
  const progress: { kind: string }[] = [];
  const completed: TroubleshootReport[] = [];
  const failures: { reason: string }[] = [];
  return {
    callbacks: {
      onProgress: (e) => progress.push(e),
      onComplete: (r) => completed.push(r),
      onFailure: async (f) => {
        failures.push(f);
      },
    },
    progress,
    completed,
    failures,
  };
}

// =============================================================================
// Fixture replay — happy + degraded chain-state paths
// =============================================================================

describe('troubleshootDeployment replay — 01-active-healthy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the ACTIVE-state markdown report byte-for-byte', async () => {
    const args = readFixture(
      'skills',
      'troubleshoot',
      '01-active-healthy',
      'input',
      'args.json',
    ) as TroubleshootArgs;
    const leaseResp = readFixture(
      'skills',
      'troubleshoot',
      '01-active-healthy',
      'input',
      'lease-response.json',
    );
    const expectedMarkdown = readFixtureText(
      'skills',
      'troubleshoot',
      '01-active-healthy',
      'expected-report.md',
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leaseResp);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks();

    const { troubleshootDeployment } = await import('./troubleshoot.js');
    const result = await troubleshootDeployment(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof troubleshootDeployment
      >[2]['clientManager'],
    });

    expect(result.markdown).toBe(expectedMarkdown);
    expect(completed).toEqual([result]);
    expect(queryClient.liftedinit.billing.v1.lease).toHaveBeenCalledWith({
      leaseUuid: '11111111-1111-4111-8111-111111111111',
    });
  });
});

describe('troubleshootDeployment replay — 02-pending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the PENDING-state report with "_No items found_" line + provisioning guidance', async () => {
    const args = readFixture(
      'skills',
      'troubleshoot',
      '02-pending',
      'input',
      'args.json',
    ) as TroubleshootArgs;
    const leaseResp = readFixture(
      'skills',
      'troubleshoot',
      '02-pending',
      'input',
      'lease-response.json',
    );
    const expectedMarkdown = readFixtureText(
      'skills',
      'troubleshoot',
      '02-pending',
      'expected-report.md',
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leaseResp);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks();

    const { troubleshootDeployment } = await import('./troubleshoot.js');
    const result = await troubleshootDeployment(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof troubleshootDeployment
      >[2]['clientManager'],
    });

    expect(result.markdown).toBe(expectedMarkdown);
    expect(completed).toEqual([result]);
  });
});

describe('troubleshootDeployment replay — 03-closed-terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders terminal-state report with Closed timestamp + terminal guidance', async () => {
    const args = readFixture(
      'skills',
      'troubleshoot',
      '03-closed-terminal',
      'input',
      'args.json',
    ) as TroubleshootArgs;
    const leaseResp = readFixture(
      'skills',
      'troubleshoot',
      '03-closed-terminal',
      'input',
      'lease-response.json',
    );
    const expectedMarkdown = readFixtureText(
      'skills',
      'troubleshoot',
      '03-closed-terminal',
      'expected-report.md',
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leaseResp);
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks();

    const { troubleshootDeployment } = await import('./troubleshoot.js');
    const result = await troubleshootDeployment(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof troubleshootDeployment
      >[2]['clientManager'],
    });

    expect(result.markdown).toBe(expectedMarkdown);
    expect(completed).toEqual([result]);
  });
});

describe('troubleshootDeployment replay — 04-lease-not-found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chain returns null lease → onFailure invoked with "not found on chain" reason → throws QUERY_FAILED', async () => {
    const args = readFixture(
      'skills',
      'troubleshoot',
      '04-lease-not-found',
      'input',
      'args.json',
    ) as TroubleshootArgs;
    const expectedFailure = readFixture(
      'skills',
      'troubleshoot',
      '04-lease-not-found',
      'expected-failure.json',
    ) as { reason: string };

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({ lease: null });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, failures } = captureCallbacks();

    const { troubleshootDeployment } = await import('./troubleshoot.js');
    await expect(
      troubleshootDeployment(args, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof troubleshootDeployment
        >[2]['clientManager'],
      }),
    ).rejects.toThrowError(ManifestMCPError);

    expect(completed).toEqual([]);
    expect(failures).toEqual([expectedFailure]);
  });
});

// =============================================================================
// Unit tests — validation + transport failures
// =============================================================================

describe('troubleshootDeployment — args validation', () => {
  it('invalid UUID throws INVALID_CONFIG before any chain call', async () => {
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    await expect(
      troubleshootDeployment({ leaseUuid: 'not-a-uuid' }, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof troubleshootDeployment
        >[2]['clientManager'],
      }),
    ).rejects.toThrow(/leaseUuid must be a UUID/);

    expect(queryClient.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
  });
});

describe('troubleshootDeployment — chain-query failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chain query rejects → onFailure with wrapped reason → throws QUERY_FAILED', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new Error('transport: ECONNREFUSED 127.0.0.1:9090'),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    await expect(
      troubleshootDeployment(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof troubleshootDeployment
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrowError(ManifestMCPError);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatch(
      /Failed to query lease 11111111-1111-4111-8111-111111111111: transport: ECONNREFUSED/,
    );
  });

  it('chain query rejects with structured ManifestMCPError → preserves original code (does not re-wrap as QUERY_FAILED)', async () => {
    // Copilot review PR #60 (comment 3276172289): the previous catch
    // wrapped EVERY rejection as QUERY_FAILED, erasing structured
    // upstream codes. Mirrors the round-1 fix for `lookupDomain` in
    // manage-domain.ts.
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'fixture-injected upstream INVALID_CONFIG',
      ),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    await expect(
      troubleshootDeployment(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof troubleshootDeployment
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
    expect(failures[0]?.reason).toContain(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('getQueryClient() rejects → onFailure invoked + throws QUERY_FAILED (init-time failure)', async () => {
    // Copilot review PR #60 (comment 3276719462): `getQueryClient()`
    // can throw `INVALID_CONFIG` (no rpc/rest url) or
    // `RPC_CONNECTION_FAILED` (connect failure). Pre-fix, that
    // rejection happened OUTSIDE the try/catch and bypassed onFailure
    // + the QUERY_FAILED normalization. Post-fix, init-time failures
    // route through the same disambiguation as chain-query failures.
    const queryClient = makeMockQueryClient();
    const clientManager: MockClientManager = {
      getQueryClient: vi
        .fn()
        .mockRejectedValue(new Error('transport: ECONNREFUSED 127.0.0.1:9090')),
      getAddress: vi.fn().mockResolvedValue('manifest1deadbeef'),
    };
    void queryClient;
    const { callbacks, failures } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    await expect(
      troubleshootDeployment(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof troubleshootDeployment
          >[2]['clientManager'],
        },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('11111111-1111-4111-8111-111111111111'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('ECONNREFUSED');
  });

  it('getQueryClient() rejects with structured ManifestMCPError → preserves original code', async () => {
    const clientManager: MockClientManager = {
      getQueryClient: vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'no rpcUrl or restUrl configured',
          ),
        ),
      getAddress: vi.fn().mockResolvedValue('manifest1deadbeef'),
    };
    const { callbacks, failures } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    await expect(
      troubleshootDeployment(
        { leaseUuid: '11111111-1111-4111-8111-111111111111' },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof troubleshootDeployment
          >[2]['clientManager'],
        },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: 'no rpcUrl or restUrl configured',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('no rpcUrl or restUrl configured');
  });

  it('chain returns lease with unknown state int → renders UNKNOWN(<raw>) placeholder', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        state: 42, // Out-of-range int
        providerUuid: '22222222-2222-4222-8222-222222222222',
        items: [],
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    const result = await troubleshootDeployment(
      { leaseUuid: '11111111-1111-4111-8111-111111111111' },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof troubleshootDeployment
        >[2]['clientManager'],
      },
    );

    expect(result.markdown).toContain('- **State:** UNKNOWN(42)');
    expect(result.markdown).toContain(
      'Lease state could not be decoded. Re-query in a moment',
    );
    expect(completed).toEqual([result]);
  });

  it('chain returns lease with missing providerUuid → renders (unknown) placeholder', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        state: 2,
        items: [],
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    const result = await troubleshootDeployment(
      { leaseUuid: '11111111-1111-4111-8111-111111111111' },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof troubleshootDeployment
        >[2]['clientManager'],
      },
    );

    expect(result.markdown).toContain('- **Provider:** (unknown)');
  });

  it('chain returns lease with snake_case provider_uuid / created_at → renderer normalizes via lease-items conventions', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        state: 2,
        provider_uuid: '22222222-2222-4222-8222-222222222222',
        created_at: '2026-05-19T15:00:00.000Z',
        items: [{ service_name: 'web', custom_domain: 'app.example.com' }],
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { troubleshootDeployment } = await import('./troubleshoot.js');

    const result = await troubleshootDeployment(
      { leaseUuid: '11111111-1111-4111-8111-111111111111' },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof troubleshootDeployment
        >[2]['clientManager'],
      },
    );

    expect(result.markdown).toContain(
      '- **Provider:** 22222222-2222-4222-8222-222222222222',
    );
    expect(result.markdown).toContain(
      '- **Created:** 2026-05-19T15:00:00.000Z',
    );
    expect(result.markdown).toContain('- **web** → app.example.com');
  });
});

// Confirm the import surface — `ManifestMCPErrorCode` reference proves
// the test file actually consumes the value when expectations run.
void ManifestMCPErrorCode.QUERY_FAILED;
