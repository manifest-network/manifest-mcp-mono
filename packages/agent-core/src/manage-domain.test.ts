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
 * fixture responses for `lease({ leaseUuid })` and `leaseByCustomDomain`.
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
        lease: Mock;
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
          lease: vi.fn(),
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
    // Symmetric `onComplete` fires on the lookup happy path
    // (Copilot review PR #60, comment 3288656598). Pre-fix this
    // asserted `completed === []` — that asymmetry was retracted.
    expect(completed).toEqual([result]);
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
    const { callbacks, completed } = captureCallbacks();

    const { manageDomain } = await import('./manage-domain.js');
    const result = await manageDomain(args, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof manageDomain
      >[2]['clientManager'],
    });

    expect(result).toEqual(expected);
    // Symmetric `onComplete` also fires on the lookup-not-found
    // path (Copilot review PR #60, comment 3288656598).
    expect(completed).toEqual([result]);
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

  it('lookup: getQueryClient() rejects → onFailure invoked + throws QUERY_FAILED (init-time failure)', async () => {
    // Copilot review PR #60 (comment 3276719558): `getQueryClient()`
    // was outside the try/catch in `lookupDomain`. Init-time failures
    // bypassed onFailure + the QUERY_FAILED normalization. Post-fix,
    // they route through the same disambiguation as chain-query
    // failures.
    const clientManager: MockClientManager = {
      getQueryClient: vi
        .fn()
        .mockRejectedValue(new Error('transport: ECONNREFUSED 127.0.0.1:9090')),
      getAddress: vi.fn().mockResolvedValue('manifest1deadbeef'),
    };
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
    expect(failures[0]?.reason).toContain('ECONNREFUSED');
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
      'lease-response.json',
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
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
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
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        customDomain: 'app.testnet.manifest.app',
        serviceName: undefined, // no serviceName on legacy single-item lease
      },
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
      'lease-response.json',
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
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
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
      'lease-response.json',
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
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
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
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        customDomain: 'api.testnet.manifest.app',
        serviceName: 'web',
      },
    );
  });

  it('user declines at confirm → throws OPERATION_CANCELLED; broadcast NOT fired', async () => {
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
    ).rejects.toMatchObject({
      // ENG-272: a user decline is a deliberate cancellation, not a
      // config fault. Pin the dedicated code so a regression to
      // INVALID_CONFIG (or worse, UNKNOWN) is caught.
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      message: expect.stringMatching(/User declined to proceed/),
    });

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
          // Interior spaces (not surrounding) survive the silent
          // trim and fail the anchored FQDN regex.
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

  it('set silently trims surrounding whitespace; broadcast + confirm-block use the trimmed FQDN', async () => {
    // Copilot review PR #60 (comment 3276519081): align with
    // setItemCustomDomain's silent-trim semantics + lookupDomain's
    // already-trimmed input. Whitespace at the edges no longer
    // triggers INVALID_CONFIG.
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        items: [{ serviceName: '', customDomain: 'app.example.com' }],
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, confirms } = captureCallbacks('yes');
    const { manageDomain } = await import('./manage-domain.js');

    const result = await manageDomain(
      {
        action: 'set',
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        fqdn: '  app.example.com  ',
      },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      },
    );

    // Broadcast received the trimmed form.
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        customDomain: 'app.example.com',
        serviceName: undefined,
      },
    );
    // Confirm block displays the trimmed form (no leading/trailing
    // whitespace in the FQDN line).
    expect(confirms[0]?.text).toContain('FQDN:         app.example.com\n');
    expect(confirms[0]?.text).not.toContain('  app.example.com  ');
    // Result carries the verified domain.
    expect(result).toEqual({
      action: 'set',
      leaseUuid: '11111111-1111-4111-8111-111111111111',
      verified: true,
      finalCustomDomain: 'app.example.com',
    });
  });

  it('set lowercases a mixed-case FQDN so broadcast and verify use the same normalized value', async () => {
    // Regression (code-review PR #102): `parseFqdn` lowercases the
    // broadcast value (RFC 4343), so the post-broadcast verification must
    // compare against the SAME lowercased value. Previously `expected`
    // used the un-lowercased input, so a mixed-case FQDN produced a false
    // `mismatch` (spurious TX_FAILED) after a successful on-chain set.
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    // The chain stores what was broadcast — the lowercased domain.
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        items: [{ serviceName: '', customDomain: 'app.example.com' }],
      },
    });
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
    const { manageDomain } = await import('./manage-domain.js');

    const result = await manageDomain(
      {
        action: 'set',
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        fqdn: 'App.Example.COM',
      },
      callbacks,
      {
        clientManager: clientManager as unknown as Parameters<
          typeof manageDomain
        >[2]['clientManager'],
      },
    );

    // Broadcast received the lowercased form.
    expect(core.setItemCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        customDomain: 'app.example.com',
        serviceName: undefined,
      },
    );
    // Verification matched the lowercased chain value → success, not a
    // spurious mismatch.
    expect(failures).toEqual([]);
    expect(result).toEqual({
      action: 'set',
      leaseUuid: '11111111-1111-4111-8111-111111111111',
      verified: true,
      finalCustomDomain: 'app.example.com',
    });
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
    // Chain returns `{ lease: null }` for an unknown UUID — verifier
    // routes to `not_found` outcome.
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: null,
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
    expect(failures[0]?.reason).toMatch(
      /lease UUID not found in verification payload/,
    );
  });

  it('verifier chain-query rejects → onFailure invoked + throws QUERY_FAILED (not propagated raw)', async () => {
    // Copilot review PR #60 (comment 3276419210): the verifier closure
    // previously called `billing.v1.lease()` without try/catch. A chain
    // rejection would propagate out of `verifyAndRecover` and bypass
    // the post-verify `onFailure` callback. Mirror the disambiguation
    // pattern from `lookupDomain` (round 1) + `troubleshoot` (round 3).
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new Error('transport: ECONNREFUSED 127.0.0.1:9090'),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
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
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('11111111-1111-4111-8111-111111111111'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain('ECONNREFUSED');
    expect(failures[0]?.reason).toContain('set-verify');
  });

  it('verifier chain-query rejects with structured ManifestMCPError → preserves original code', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.setItemCustomDomain).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'DEADBEEF',
      code: 0,
    } as Awaited<ReturnType<typeof core.setItemCustomDomain>>);

    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.lease.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'fixture-injected upstream INVALID_CONFIG',
      ),
    );
    const clientManager = makeMockClientManager(queryClient);
    const { callbacks, failures } = captureCallbacks('yes');
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
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: 'fixture-injected upstream INVALID_CONFIG',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toContain(
      'fixture-injected upstream INVALID_CONFIG',
    );
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

    expect(queryClient.liftedinit.billing.v1.lease).not.toHaveBeenCalled();
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
      'lease-response.json',
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
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue(leasesPayload);
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
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        clear: true,
        serviceName: undefined,
      },
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
    queryClient.liftedinit.billing.v1.lease.mockResolvedValue({
      lease: {
        uuid: '11111111-1111-4111-8111-111111111111',
        items: [
          { serviceName: 'web', customDomain: '' },
          { serviceName: 'db', customDomain: '' },
        ],
      },
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
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      {
        leaseUuid: '11111111-1111-4111-8111-111111111111',
        clear: true,
        serviceName: 'web',
      },
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

describe('cancellation (ENG-374)', () => {
  const CANCEL_LEASE_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('set: a pre-aborted signal throws OPERATION_CANCELLED and never broadcasts', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { manageDomain } = await import('./manage-domain.js');
    const ac = new AbortController();
    ac.abort(new Error('user aborted'));
    const onConfirm = vi.fn(async () => 'yes' as const);
    const clientManager = makeMockClientManager(makeMockQueryClient());
    await expect(
      manageDomain(
        {
          action: 'set',
          leaseUuid: CANCEL_LEASE_UUID,
          fqdn: 'app.example.com',
          serviceName: 'web',
        },
        { onConfirm },
        { clientManager: clientManager as never, signal: ac.signal },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expect(core.setItemCustomDomain).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('lookup positive control: with no signal the query IS invoked and the result returns', async () => {
    const { manageDomain } = await import('./manage-domain.js');
    const queryClient = makeMockQueryClient();
    queryClient.liftedinit.billing.v1.leaseByCustomDomain.mockResolvedValue({
      lease: null,
    });
    const clientManager = makeMockClientManager(queryClient);
    const res = await manageDomain(
      { action: 'lookup', fqdn: 'app.example.com' },
      {},
      { clientManager: clientManager as never },
    );
    expect(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain,
    ).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ action: 'lookup', lease: null });
  });

  it('lookup: a pre-aborted signal throws OPERATION_CANCELLED and the query is NOT called', async () => {
    const { manageDomain } = await import('./manage-domain.js');
    const ac = new AbortController();
    ac.abort(new Error('user aborted'));
    const queryClient = makeMockQueryClient();
    const onFailure = vi.fn(async () => {});
    const clientManager = makeMockClientManager(queryClient);
    await expect(
      manageDomain(
        { action: 'lookup', fqdn: 'app.example.com' },
        { onFailure },
        { clientManager: clientManager as never, signal: ac.signal },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expect(
      queryClient.liftedinit.billing.v1.leaseByCustomDomain,
    ).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled(); // cancellation is NOT a query failure
  });
});
