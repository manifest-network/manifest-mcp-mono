/**
 * Tests for the `manageDomain` orchestrator (PR 4 / ENG-129).
 *
 * Two test surfaces are covered here:
 *
 *   - Unit tests: dispatch on `args.action`, validation errors, branch
 *     selection (set/clear happy path, mismatch + not_found via the
 *     verifyAndRecover driver, user-declined-confirm path, etc.).
 *   - Fixture-replay: each `__fixtures__/skills/manage-domain/NN-…/`
 *     scenario authored as a committed byte-baseline. Inputs (args +
 *     mocked chain responses) drive the orchestrator; outputs
 *     (confirm-block text, typed result, failure reason) are asserted
 *     against the committed `expected-*` files.
 *
 * Mocking strategy: vi.mock the core package's `setItemCustomDomain`
 * (the only chain broadcast in manage-domain) and stub
 * `opts.clientManager` with a query client that returns canonical
 * fixture responses for `leasesByTenant` and `leaseByCustomDomain`.
 * No real chain I/O.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type {
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainResult,
} from './index.js';

vi.mock('@manifest-network/manifest-mcp-core', async () => {
  const actual = await vi.importActual<
    typeof import('@manifest-network/manifest-mcp-core')
  >('@manifest-network/manifest-mcp-core');
  return {
    ...actual,
    setItemCustomDomain: vi.fn(),
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
        leasesByTenant: Mock;
        leaseByCustomDomain: Mock;
      };
    };
  };
}

function makeMockQueryClient(): MockQueryClient {
  return {
    liftedinit: {
      billing: {
        v1: {
          leasesByTenant: vi.fn(),
          leaseByCustomDomain: vi.fn(),
        },
      },
    },
  };
}

interface MockClientManager {
  getQueryClient: Mock;
  getAddress: Mock;
  // Cast-only — the real CosmosClientManager has more methods but
  // manage-domain.ts only reads these two on the broadcast path.
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

interface CallbackBuckets {
  callbacks: ManageDomainCallbacks;
  progress: { kind: string }[];
  completed: ManageDomainResult[];
  failures: { reason: string }[];
  confirms: { text: string }[];
}

function captureCallbacks(
  confirmAnswer: 'yes' | 'no' = 'yes',
): CallbackBuckets {
  const progress: { kind: string }[] = [];
  const completed: ManageDomainResult[] = [];
  const failures: { reason: string }[] = [];
  const confirms: { text: string }[] = [];
  return {
    callbacks: {
      onConfirm: vi.fn(async (block) => {
        confirms.push(block);
        return confirmAnswer;
      }),
      onProgress: (event) => progress.push(event),
      onComplete: (result) => completed.push(result),
      onFailure: async (failure) => {
        failures.push(failure);
      },
    },
    progress,
    completed,
    failures,
    confirms,
  };
}

// =============================================================================
// Lookup path — fixture replay 04-lookup-found + 05-lookup-not-found
// =============================================================================

describe('manageDomain — lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('04-lookup-found: returns typed lease object when chain has a match', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '04-lookup-found',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const lookupResp = readFixture(
      'skills',
      'manage-domain',
      '04-lookup-found',
      'input',
      'lease-by-custom-domain-response.json',
    );
    const expected = readFixture(
      'skills',
      'manage-domain',
      '04-lookup-found',
      'expected-result.json',
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockResolvedValue(
      lookupResp,
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks();

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    // Lookup path returns the result directly WITHOUT firing
    // `onComplete` (per the current `lookupDomain` impl, which
    // short-circuits before reaching the broadcast-path's onComplete).
    // Asserted explicitly here so any future change in either
    // direction (consistent fire / consistent skip) is reviewable.
    expect(completed).toEqual([]);
    expect(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain,
    ).toHaveBeenCalledWith({
      customDomain: 'app.testnet.manifest.app',
    });
  });

  it('05-lookup-not-found: returns `lease: null` when chain throws (FQDN unclaimed)', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '05-lookup-not-found',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const expected = readFixture(
      'skills',
      'manage-domain',
      '05-lookup-not-found',
      'expected-result.json',
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
      new Error('NotFound: domain not claimed'),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
  });

  it('lookup with empty fqdn throws INVALID_CONFIG before any chain call', async () => {
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { manageDomain } = await import('./manage-domain.js');

    await expect(
      manageDomain(
        { action: 'lookup', fqdn: '   ' } as ManageDomainArgs,
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/fqdn must be a non-empty string/);
    expect(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain,
    ).not.toHaveBeenCalled();
  });

  it('lookup trims surrounding whitespace before chain query', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockResolvedValue({
      lease: null,
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { manageDomain } = await import('./manage-domain.js');

    const result = await manageDomain(
      { action: 'lookup', fqdn: '  app.example.com  ' },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      },
    );

    expect(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain,
    ).toHaveBeenCalledWith({ customDomain: 'app.example.com' });
    expect(result).toEqual({
      action: 'lookup',
      fqdn: 'app.example.com',
      lease: null,
    });
  });

  it('lookup surfaces non-NotFound chain errors as QUERY_FAILED with onFailure', async () => {
    // Copilot review PR #60: the bare `catch` previously masked any
    // failure as `{ lease: null }`. Narrowed-catch now distinguishes the
    // keeper's NotFound (unclaimed FQDN → returns null) from real
    // failures (RPC transport, decoding, internal error → throws
    // QUERY_FAILED and invokes onFailure first so callers can react).
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
      new Error('ECONNRESET: socket hang up'),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks();
    const { manageDomain } = await import('./manage-domain.js');

    await expect(
      manageDomain({ action: 'lookup', fqdn: 'app.example.com' }, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('app.example.com'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('ECONNRESET');
    expect(failures[0]?.reason).toContain('app.example.com');
  });

  it('lookup preserves structured ManifestMCPError code (does not re-wrap as QUERY_FAILED)', async () => {
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'fixture-injected upstream error',
      ),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks();
    const { manageDomain } = await import('./manage-domain.js');

    await expect(
      manageDomain({ action: 'lookup', fqdn: 'app.example.com' }, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: 'fixture-injected upstream error',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('fixture-injected upstream error');
  });
});

// =============================================================================
// Set path — fixture replay 01-set-success + 02-set-mismatch + 06-stack-set-success
// =============================================================================

describe('manageDomain — set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('01-set-success: happy path orchestrates confirm → broadcast → verify → onComplete', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '01-set-success',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const leasesPayload = readFixture(
      'skills',
      'manage-domain',
      '01-set-success',
      'input',
      'leases-by-tenant-response.json',
    );
    const txResp = readFixture(
      'skills',
      'manage-domain',
      '01-set-success',
      'input',
      'set-domain-tx-response.json',
    );
    const expected = readFixture(
      'skills',
      'manage-domain',
      '01-set-success',
      'expected-result.json',
    );
    const expectedBlock = readFixtureText(
      'skills',
      'manage-domain',
      '01-set-success',
      'expected-confirm-block.txt',
    );

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue(
      txResp as Awaited<ReturnType<typeof core.setItemCustomDomain>>,
    );

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue(
      leasesPayload,
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, progress, completed, failures, confirms } =
      captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    expect(completed).toEqual([expected]);
    expect(failures).toEqual([]);
    expect(progress.map((p) => p.kind)).toEqual(['user_confirmed']);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.text).toBe(expectedBlock);
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      clientManager,
      '11111111-1111-4111-8111-111111111111',
      'app.testnet.manifest.app',
      undefined, // no serviceName on legacy single-item lease
    );
  });

  it('02-set-mismatch: verifier returns mismatch → onFailure invoked with exact reason → throws TX_FAILED', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '02-set-mismatch',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const leasesPayload = readFixture(
      'skills',
      'manage-domain',
      '02-set-mismatch',
      'input',
      'leases-by-tenant-response.json',
    );
    const expectedFailure = readFixture(
      'skills',
      'manage-domain',
      '02-set-mismatch',
      'expected-failure.json',
    ) as { reason: string };

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: 'app.testnet.manifest.app',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue(
      leasesPayload,
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, failures } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(args, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      }),
    ).rejects.toThrowError(ManifestMCPError);

    expect(completed).toEqual([]);
    expect(failures).toEqual([expectedFailure]);
  });

  it('06-stack-set-success: stack lease threads serviceName through broadcast + confirm block', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '06-stack-set-success',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const leasesPayload = readFixture(
      'skills',
      'manage-domain',
      '06-stack-set-success',
      'input',
      'leases-by-tenant-response.json',
    );
    const expected = readFixture(
      'skills',
      'manage-domain',
      '06-stack-set-success',
      'expected-result.json',
    );
    const expectedBlock = readFixtureText(
      'skills',
      'manage-domain',
      '06-stack-set-success',
      'expected-confirm-block.txt',
    );

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: 'web',
      custom_domain: 'api.testnet.manifest.app',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue(
      leasesPayload,
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, confirms } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    expect(completed).toEqual([expected]);
    expect(confirms[0]?.text).toBe(expectedBlock);
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      clientManager,
      '11111111-1111-4111-8111-111111111111',
      'api.testnet.manifest.app',
      { serviceName: 'web' },
    );
  });

  it('user declines at confirm → throws INVALID_CONFIG; broadcast NOT fired', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks('no');

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: '11111111-1111-4111-8111-111111111111',
          fqdn: 'app.testnet.manifest.app',
        },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/User declined to proceed/);

    expect(core.setItemCustomDomain).not.toHaveBeenCalled();
  });

  it('invalid UUID throws INVALID_CONFIG before any chain call', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: 'not-a-uuid',
          fqdn: 'app.example.com',
        },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/leaseUuid must be a UUID/);
    expect(core.setItemCustomDomain).not.toHaveBeenCalled();
  });

  it('empty fqdn on set throws INVALID_CONFIG before any chain call', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: '11111111-1111-4111-8111-111111111111',
          fqdn: '   ',
        },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/fqdn must be a non-empty string/);
    expect(core.setItemCustomDomain).not.toHaveBeenCalled();
  });

  // FQDN-shape validation gates added by engineer's #13 batch — the
  // anchored RFC 1123 regex (`FQDN_RE` in manage-domain.ts) is a
  // client-side typo gate so we don't waste a tx on obviously-malformed
  // input. Each `it` here targets one rejection path; all must throw
  // INVALID_CONFIG before `setItemCustomDomain` is invoked.
  describe('FQDN-shape validation (set action)', () => {
    const cases: Array<{ label: string; fqdn: string; expectedMatch: RegExp }> =
      [
        {
          label: 'leading whitespace rejected with the surrounding-ws message',
          fqdn: '  app.example.com',
          expectedMatch: /must not have surrounding whitespace/,
        },
        {
          label: 'trailing whitespace rejected with the surrounding-ws message',
          fqdn: 'app.example.com  ',
          expectedMatch: /must not have surrounding whitespace/,
        },
        {
          label:
            'http:// scheme prefix rejected with the bare-hostname message',
          fqdn: 'http://app.example.com',
          expectedMatch: /must be a bare hostname \(no scheme\)/,
        },
        {
          label:
            'https:// scheme prefix rejected with the bare-hostname message',
          fqdn: 'https://app.example.com',
          expectedMatch: /must be a bare hostname \(no scheme\)/,
        },
        {
          label:
            "free-text 'not a domain' rejected with the FQDN-shape message",
          fqdn: 'not a domain',
          // The surrounding-whitespace check fires first since trim() does
          // not equal the raw input only when there IS surrounding ws; this
          // input has interior space, so the FQDN regex catches it.
          expectedMatch: /is not a valid RFC 1123 hostname/,
        },
        {
          label: 'leading-hyphen label rejected with the FQDN-shape message',
          fqdn: '-leading-hyphen.com',
          expectedMatch: /is not a valid RFC 1123 hostname/,
        },
        {
          label: 'trailing-hyphen label rejected with the FQDN-shape message',
          fqdn: 'trailing-hyphen-.com',
          expectedMatch: /is not a valid RFC 1123 hostname/,
        },
        {
          label: 'single-label hostname rejected with the FQDN-shape message',
          fqdn: 'localhost',
          expectedMatch: /is not a valid RFC 1123 hostname/,
        },
        {
          label: '>253-char hostname rejected with the FQDN-shape message',
          // 254 chars: 251 'a' + '.com'
          fqdn: `${'a'.repeat(251)}.com`,
          expectedMatch: /is not a valid RFC 1123 hostname/,
        },
      ];

    for (const { label, fqdn, expectedMatch } of cases) {
      it(label, async () => {
        const core = await import('@manifest-network/manifest-mcp-core');
        const queryClient = makeMockQueryClient();
        const clientManager = makeMockClientManager(queryClient);
        const { callbacks } = captureCallbacks();
        const { manageDomain } = await import('./manage-domain.js');

        await expect(
          manageDomain(
            {
              action: 'set',
              leaseUuid: '11111111-1111-4111-8111-111111111111',
              fqdn,
            },
            callbacks,
            {
              clientManager: clientManager as unknown as Parameters<
                typeof manageDomain
              >[2]['clientManager'],
            },
          ),
        ).rejects.toThrow(expectedMatch);
        expect(core.setItemCustomDomain).not.toHaveBeenCalled();
      });
    }
  });

  it('verifier sees lease not_found → onFailure invoked with reason → throws TX_FAILED', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '99999999-9999-4999-8999-999999999999',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    // empty leases payload — verifier's findLease returns null
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue({
      leases: [],
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: '99999999-9999-4999-8999-999999999999',
          fqdn: 'app.example.com',
        },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrowError(ManifestMCPError);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatch(/lease UUID not in tenant leases/);
  });

  it('broadcast failure surfaces as ManifestMCPError; verify NOT called', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'set-item-custom-domain rejected by chain',
      ),
    );

    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: '11111111-1111-4111-8111-111111111111',
          fqdn: 'app.example.com',
        },
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/set-item-custom-domain rejected by chain/);

    expect(
      queryClient.liftedinit.billing.v1.leasesByTenant,
    ).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Clear path — fixture replay 03-clear-success + a stack/service-missing case
// =============================================================================

describe('manageDomain — clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('03-clear-success: happy path on single-item lease (no serviceName)', async () => {
    const args = readFixture(
      'skills',
      'manage-domain',
      '03-clear-success',
      'input',
      'args.json',
    ) as ManageDomainArgs;
    const leasesPayload = readFixture(
      'skills',
      'manage-domain',
      '03-clear-success',
      'input',
      'leases-by-tenant-response.json',
    );
    const expected = readFixture(
      'skills',
      'manage-domain',
      '03-clear-success',
      'expected-result.json',
    );
    const expectedBlock = readFixtureText(
      'skills',
      'manage-domain',
      '03-clear-success',
      'expected-confirm-block.txt',
    );

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: '',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue(
      leasesPayload,
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed, confirms } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    expect(completed).toEqual([expected]);
    expect(confirms[0]?.text).toBe(expectedBlock);
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      clientManager,
      '11111111-1111-4111-8111-111111111111',
      '',
      { clear: true },
    );
  });

  it('clear on stack lease threads serviceName + clear:true through broadcast', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: 'web',
      custom_domain: '',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leasesByTenant.mockResolvedValue({
      leases: [
        {
          uuid: '11111111-1111-4111-8111-111111111111',
          items: [
            { serviceName: 'web', customDomain: '' },
            { serviceName: 'db', customDomain: '' },
          ],
        },
      ],
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, completed } = captureCallbacks('yes');

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(
      {
        action: 'clear',
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        serviceName: 'web',
      },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      },
    );

    // Narrow the discriminated union via assertion. `action === 'clear'`
    // tells TS this is the broadcasting-path variant carrying verified +
    // finalCustomDomain (lookup-variant lacks both).
    expect(result.action).toBe('clear');
    if (result.action !== 'clear') throw new Error('unreachable');
    expect(result.verified).toBe(true);
    expect(result.finalCustomDomain).toBeNull();
    expect(completed).toHaveLength(1);
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      clientManager,
      '11111111-1111-4111-8111-111111111111',
      '',
      { clear: true, serviceName: 'web' },
    );
  });
});

// =============================================================================
// Action-dispatch validation
// =============================================================================

describe('manageDomain — args validation', () => {
  it('rejects unknown action with INVALID_CONFIG', async () => {
    const queryClient = makeMockQueryClient();
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks } = captureCallbacks();
    const { manageDomain } = await import('./manage-domain.js');

    await expect(
      manageDomain(
        { action: 'whoops' } as unknown as ManageDomainArgs,
        callbacks,
        {
          clientManager: clientManager as unknown as Parameters<
            typeof manageDomain
          >[2]['clientManager'],
        },
      ),
    ).rejects.toThrow(/unknown action "whoops"/);
  });
});
