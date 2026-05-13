/**
 * Replay tests for the deploy-app orchestration. Per PR-3 sub-plan + the
 * architect's α-locked composition, these tests verify the orchestration
 * SHAPE (call sequence, callback invocation, recovery dispatch) rather
 * than the byte-baseline of individual renderer outputs — byte-baseline
 * parity is already covered by commit A's `render-*.test.ts` suite
 * against the same fixture `expected-*.txt` files.
 *
 * Scenarios:
 *   - 01-fast-path-active: happy-path single-service deploy without
 *     custom domain; mocks fred's deployApp + checkDeploymentReadiness +
 *     buildManifestPreview to return canonical fixture responses;
 *     asserts onProgress sequence + onComplete called with the typed
 *     DeployResult.
 *   - 03-partial-success-set-domain-failed: fred's deployApp throws the
 *     "Deploy partially succeeded:" error envelope; asserts onFailure
 *     fires with the recovery options (3 options per Option-C mapping)
 *     and the orchestrator routes through the inline-closure dispatch.
 *
 * Mocking strategy: `vi.mock('@manifest-network/manifest-mcp-fred')` +
 * `vi.mock('@manifest-network/manifest-mcp-core')` at the module level;
 * each test sets the workspace-dep behaviors via `vi.mocked(...)` per
 * scenario. Tests do NOT make real chain calls.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type {
  DeployAppCallbacks,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
  ProgressEvent,
  RecoveryOption,
  WalletProvider,
} from './index.js';

// Mock the workspace deps at the module level. Individual tests inject
// per-scenario behaviors via vi.mocked.
vi.mock('@manifest-network/manifest-mcp-fred', () => ({
  AuthTimestampTracker: class {
    private last = 0;
    async next(): Promise<number> {
      const now = Math.max(this.last + 1, Math.floor(Date.now() / 1000));
      this.last = now;
      return now;
    }
  },
  buildManifestPreview: vi.fn(),
  checkDeploymentReadiness: vi.fn(),
  createAuthToken: vi.fn(() => 'mock-token'),
  createLeaseDataSignMessage: vi.fn(() => 'lease-data-msg'),
  createSignMessage: vi.fn(() => 'sign-msg'),
  deployApp: vi.fn(),
}));

vi.mock('@manifest-network/manifest-mcp-core', async () => {
  const actual = await vi.importActual<
    typeof import('@manifest-network/manifest-mcp-core')
  >('@manifest-network/manifest-mcp-core');
  return {
    ...actual,
    cosmosEstimateFee: vi.fn(),
    setItemCustomDomain: vi.fn(),
    stopApp: vi.fn(),
  };
});

// Mock the internal find-sku-uuid helper. The orchestration replay tests
// exercise deploy-app's shape, not the SKU-lookup integration (which has
// its own unit tests in find-sku-uuid.test.ts). Mocking the module-level
// import keeps test setup compact + isolates orchestration concerns.
vi.mock('./internals/find-sku-uuid.js', () => ({
  findSkuUuid: vi.fn().mockResolvedValue({
    skuUuid: 'sku-uuid-fixture',
    providerUuid: 'provider-uuid-fixture',
  }),
}));

const FIXTURES_ROOT = join(__dirname, '..', '__fixtures__');

function readFixture(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8'));
}

interface MockClientManager {
  getQueryClient: Mock;
  getSigningClient: Mock;
  getConfig: Mock;
}

function makeMockClientManager(
  chainId = 'manifest-ledger-testnet-1',
): MockClientManager {
  return {
    getQueryClient: vi.fn().mockResolvedValue({} as unknown),
    getSigningClient: vi.fn().mockResolvedValue({} as unknown),
    getConfig: vi.fn().mockReturnValue({
      chainId,
      gasPrice: '1umfx',
    }),
  };
}

function makeMockWalletProvider(): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('manifest1deadbeef'),
    getSigner: vi.fn().mockResolvedValue({} as never),
    signArbitrary: vi.fn().mockResolvedValue({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'base64==' },
      signature: 'sig==',
    }),
  };
}

function captureCallbacks(): {
  callbacks: DeployAppCallbacks;
  progress: ProgressEvent[];
  completed: DeployResult[];
  failures: { envelope: FailureEnvelope; options: RecoveryOption[] }[];
} {
  const progress: ProgressEvent[] = [];
  const completed: DeployResult[] = [];
  const failures: { envelope: FailureEnvelope; options: RecoveryOption[] }[] =
    [];
  return {
    callbacks: {
      onProgress: (e) => progress.push(e),
      onComplete: (r) => completed.push(r),
      onFailure: async (envelope, options) => {
        failures.push({ envelope, options });
        // Default: pick close_lease for partial-success recovery so the
        // test's flow can verify the dispatch path. Specific tests can
        // override this via a wrapper.
        return { id: 'close_lease' };
      },
      onConfirm: async () => 'yes',
    },
    progress,
    completed,
    failures,
  };
}

describe('deployApp replay — 01-fast-path-active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: orchestrates checkReadiness → buildManifest → fredDeployApp → onComplete', async () => {
    const spec = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;

    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: metaHashResp.manifest_json,
      meta_hash_hex: metaHashResp.meta_hash_hex,
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as Awaited<ReturnType<typeof fred.deployApp>>);

    // fix-3: real cosmosEstimateFee is now invoked. Mock returns the
    // canonical fixture-aligned FeeEstimateResult (per scenario
    // 01-fast-path-active's fee-response.json: 2300 umfx @ 142000 gas).
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const { callbacks, progress, completed } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    const result = await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // Verify happy-path orchestration emits the canonical progress sequence.
    const progressKinds = progress.map((p) => p.kind);
    expect(progressKinds).toContain('readiness_evaluated');
    expect(progressKinds).toContain('deployment_plan_rendered');
    expect(progressKinds).toContain('user_confirmed');
    expect(progressKinds).toContain('deploy_app_broadcast');
    expect(progressKinds).toContain('app_ready_confirmed');
    expect(progressKinds).toContain('success_rendered');

    // Verify onComplete fired with typed DeployResult.
    expect(completed).toHaveLength(1);
    const completedResult = completed[0];
    expect(completedResult).toBeDefined();
    expect(completedResult?.leaseUuid).toBe(deployResp.lease_uuid);
    expect(completedResult?.providerUuid).toBe(deployResp.provider_uuid);

    // Verify result matches.
    expect(result.leaseUuid).toBe(deployResp.lease_uuid);
    // F1 regression: leaseState from fred's response correctly decoded.
    // Fixture has `state: 'LEASE_STATE_ACTIVE'`; decoded form is the
    // canonical LeaseStateName (passthrough for valid LEASE_STATE_*
    // strings via lease-state.decode()).
    expect(result.leaseState).toBe('LEASE_STATE_ACTIVE');
  });

  it('F1 regression: terminal-state preserved, not silently coerced to ACTIVE', async () => {
    // QA F1: prior `leaseStateAsName` helper silently returned
    // 'LEASE_STATE_ACTIVE' for any non-LEASE_STATE_-prefixed input
    // (including unknown numeric ints). This regression test verifies
    // the canonical `decode()` from lease-state.ts now handles known
    // numeric inputs and terminal-state passthrough correctly.
    const spec = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };

    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: metaHashResp.manifest_json,
      meta_hash_hex: metaHashResp.meta_hash_hex,
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    // fred returns numeric integer state 4 (LEASE_STATE_REJECTED per
    // PR-1's option-1 chain-aligned mapping). The deploy-app
    // orchestrator must decode this as REJECTED, NOT silently coerce
    // to ACTIVE.
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '11111111-1111-4111-8111-111111111111',
      provider_uuid: '22222222-2222-4222-8222-222222222222',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 4 as never, // raw chain int — REJECTED per option-1 mapping
      connection: { instances: [] },
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

    // fix-3: cosmosEstimateFee mock for the F1 regression flow.
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const { callbacks } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    const result = await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // F1 verdict: REJECTED preserved, not ACTIVE.
    expect(result.leaseState).toBe('LEASE_STATE_REJECTED');
  });
});

describe('deployApp replay — 03-partial-success-set-domain-failed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('partial-success: fred throws → onFailure fires with recovery options → close_lease dispatched', async () => {
    const spec = readFixture(
      'skills',
      'deploy-app',
      '03-partial-success-set-domain-failed',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '03-partial-success-set-domain-failed',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '03-partial-success-set-domain-failed',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };

    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: metaHashResp.manifest_json,
      meta_hash_hex: metaHashResp.meta_hash_hex,
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    // fred throws the partial-success error envelope.
    const partialSuccessReason =
      'Deploy partially succeeded: lease 11111111-1111-4111-8111-111111111111 was created but set-domain failed: simulation error';
    vi.mocked(fred.deployApp).mockRejectedValue(
      new Error(partialSuccessReason),
    );

    const { callbacks, failures } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const core = await import('@manifest-network/manifest-mcp-core');
    // fix-3: cosmosEstimateFee mock — set-domain emits sentinel
    // (per architect-ratified "as designed" framing), so only
    // create-lease estimate is invoked.
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);
    vi.mocked(core.stopApp).mockResolvedValue(
      {} as Awaited<ReturnType<typeof core.stopApp>>,
    );

    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    // The orchestrator throws after recovery dispatch (the inline closure
    // signals "lease closed" via ManifestMCPError + the recovery branch
    // path; caller is expected to re-run troubleshootDeployment).
    let caughtErr: unknown = null;
    try {
      await deployApp(spec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch (err) {
      caughtErr = err;
    }

    // Verify onFailure fired with the partial-success envelope.
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure).toBeDefined();
    expect(failure?.envelope.outcome).toBe('partially_succeeded');
    if (failure?.envelope.outcome === 'partially_succeeded') {
      expect(failure.envelope.leaseUuid).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
      expect(failure.envelope.requestedCustomDomain).toBe(
        'app.testnet.manifest.app',
      );
    }

    // Verify recovery options offered (with-domain case: 3 options).
    const optionIds = failure?.options.map((o) => o.id) ?? [];
    expect(optionIds).toContain('retry_set_domain');
    expect(optionIds).toContain('salvage_without_domain');
    expect(optionIds).toContain('close_lease');

    // Verify the close_lease dispatch (captureCallbacks default choice)
    // invoked core's stopApp.
    expect(vi.mocked(core.stopApp)).toHaveBeenCalledWith(
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
    );

    // Verify the orchestrator threw after recovery (caller expected to
    // re-run troubleshootDeployment).
    expect(caughtErr).toBeInstanceOf(Error);
  });
});
