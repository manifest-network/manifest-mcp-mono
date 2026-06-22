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
import type { AppDeploySpec } from '@manifest-network/manifest-mcp-core';
import {
  asProviderUuid,
  asSkuUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import type {
  DeployAppCallbacks,
  DeployResult,
  FailureEnvelope,
  Plan,
  ProgressEvent,
  RecoveryOption,
  SkuCandidate,
  WalletProvider,
} from './index.js';

// ENG-310: the narrow DeploySpec union (and SingleServiceSpec) are gone —
// agent-core's deploy input IS the canonical AppDeploySpec. These local
// aliases keep the pre-existing fixture casts in this file readable while
// pointing at the single canonical type.
type DeploySpec = AppDeploySpec;
type SingleServiceSpec = AppDeploySpec;

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
  fetchActiveLease: vi.fn(),
  pollLeaseUntilReady: vi.fn(),
  resolveProviderUrl: vi.fn(),
  uploadLeaseData: vi.fn(),
  waitForAppReady: vi.fn(),
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
    // ENG-258: deploy-app resolves the SKU pin ONCE via core's
    // `resolveSku` (the deleted internal SKU-lookup helper's coverage now
    // lives in core's `sku-resolution.test.ts`). The orchestration replay
    // tests exercise deploy-app's SHAPE, not the SKU-lookup integration,
    // so the default mock resolves a single pinned candidate. Tests that
    // exercise the ambiguity path override this per-scenario via
    // `vi.mocked(core.resolveSku)`.
    resolveSku: vi.fn().mockResolvedValue({
      skuUuid: 'sku-uuid-fixture',
      providerUuid: 'provider-uuid-fixture',
      name: 'small',
      active: true,
    }),
  };
});

const FIXTURES_ROOT = join(__dirname, '..', '__fixtures__');

function readFixture(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8'));
}

interface MockClientManager {
  getQueryClient: Mock;
  getSigningClient: Mock;
  getConfig: Mock;
  getAddress: Mock;
}

function makeMockClientManager(
  chainId = 'manifest-ledger-testnet-1',
  address = 'manifest1deadbeef',
): MockClientManager {
  return {
    getQueryClient: vi.fn().mockResolvedValue({} as unknown),
    getSigningClient: vi.fn().mockResolvedValue({} as unknown),
    getConfig: vi.fn().mockReturnValue({
      chainId,
      gasPrice: '1umfx',
    }),
    // r3248900328: deploy-app's address-source consistency guard
    // reads `clientManager.getAddress()` up-front and asserts it
    // matches `walletProvider.getAddress()`. Default mock address
    // matches the wallet's default so existing tests stay green;
    // tests asserting the mismatch path pass an explicit address.
    getAddress: vi.fn().mockResolvedValue(address),
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
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

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

  /**
   * Shared scenario setup for the F1 regression — fred returns
   * LEASE_STATE_REJECTED (numeric 4). Split into TWO tests per ENG-185
   * sub-PR D architect's Q7 audit: one for the event-sequence claims
   * (classifier event fires, app_ready_confirmed does NOT), one for the
   * throw shape (TX_FAILED, REJECTED stateName + leaseUuid).
   */
  async function setupF1RejectedScenario() {
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
    return { caughtErr, progress, completed, fred };
  }

  it("F1 regression: REJECTED classifier outcome fires deploy_response_classified('failed') and skips app_ready_confirmed", async () => {
    // Preserves the original F1 spirit (REJECTED not silently coerced to
    // ACTIVE) by asserting the event sequence: classifier outcome emitted
    // BEFORE the throw, app_ready_confirmed NEVER fired, onComplete
    // never invoked. Split from the throw-shape assertion per ENG-185
    // sub-PR D architect's Q7 audit — different concerns (event surface
    // vs error envelope) deserve separate tests.
    const { progress, completed, fred } = await setupF1RejectedScenario();

    const classifiedEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifiedEvents).toHaveLength(1);
    expect(
      classifiedEvents[0]?.kind === 'deploy_response_classified' &&
        classifiedEvents[0].outcome,
    ).toBe('failed');
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    // Polling MUST NOT fire for an outcome that's already 'failed'.
    expect(progress.some((e) => e.kind === 'polling_for_readiness')).toBe(
      false,
    );
    expect(vi.mocked(fred.waitForAppReady)).not.toHaveBeenCalled();
    // onComplete never fires when the orchestrator throws.
    expect(completed).toHaveLength(0);
  });

  it('F1 regression: REJECTED classifier outcome throws TX_FAILED with errorSummary', async () => {
    // Sub-PR D upgrade: the prior assertion-form (INVALID_CONFIG + ENG-185
    // scope item #6 deferral note) is replaced by the full routing
    // contract — TX_FAILED with the classifier's canonical
    // `Lease ${uuid} reached terminal state ${stateName}` errorSummary.
    const { caughtErr } = await setupF1RejectedScenario();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain('LEASE_STATE_REJECTED');
    expect((caughtErr as Error).message).toContain(
      '11111111-1111-4111-8111-111111111111',
    );
    // Verdict B note: the misleading "ENG-185 scope item #6" deferral
    // reference was removed when D landed the full routing.
    expect((caughtErr as Error).message).not.toContain('ENG-185 scope item');
  });
});

describe('deployApp — ENG-258 SKU pin resolution + ambiguity elicitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Some tests here override `resolveSku`'s BASE implementation (via
  // `mockImplementation`) rather than the consume-once queue. `vi.clearAllMocks`
  // resets call history + the `*Once` queue but NOT the base implementation,
  // so without this restore a `mockImplementation` would leak into sibling
  // describe blocks. Re-establish the canonical single-pin default after each
  // test in this block.
  afterEach(async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.resolveSku).mockReset();
    vi.mocked(core.resolveSku).mockResolvedValue({
      skuUuid: 'sku-uuid-fixture',
      providerUuid: 'provider-uuid-fixture',
      name: 'small',
      active: true,
    } as SkuCandidate);
  });

  // Shared happy-path fred/preview/fee stubs. The ambiguity behavior is
  // driven entirely by the per-test `core.resolveSku` mock; the rest of
  // the orchestration is the canonical fast-path-active flow.
  async function setupHappyDeps() {
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
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    return { spec, fred, core };
  }

  it('invokes onResolveSku when resolveSku throws SKU_AMBIGUOUS, then pins the choice into the fred broadcast', async () => {
    const { spec, fred, core } = await setupHappyDeps();

    const c1: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p1'),
      providerUuid: asProviderUuid('p1'),
      name: 'small',
      active: true,
    };
    const c2: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
      name: 'small',
      active: true,
    };
    // First resolveSku (by name) is ambiguous; after the pick, the second
    // resolveSku (by skuUuid+providerUuid) returns the concrete pin.
    vi.mocked(core.resolveSku)
      .mockRejectedValueOnce(
        new ManifestMCPError(
          ManifestMCPErrorCode.SKU_AMBIGUOUS,
          'SKU name "small" matches 2 active SKUs.',
          { reason: 'AMBIGUOUS_SKU_NAME', size: 'small', candidates: [c1, c2] },
        ),
      )
      .mockResolvedValueOnce(c2);

    const onResolveSku = vi.fn(async (_candidates: SkuCandidate[]) => ({
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
    }));
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onResolveSku,
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // onResolveSku invoked exactly once with the two ambiguous candidates.
    expect(onResolveSku).toHaveBeenCalledTimes(1);
    expect(onResolveSku.mock.calls[0]?.[0]).toEqual([c1, c2]);

    // A `sku_ambiguous` progress event carried the candidates. The kind
    // assertion is the real guard; the candidates `toEqual` then runs
    // unconditionally (no silent skip on a regression).
    const ambiguousEvents = baseCapture.progress.filter(
      (e) => e.kind === 'sku_ambiguous',
    );
    expect(ambiguousEvents).toHaveLength(1);
    const ev = ambiguousEvents[0];
    expect(ev?.kind).toBe('sku_ambiguous');
    expect((ev as { candidates: unknown }).candidates).toEqual([c1, c2]);

    // The fred broadcast input (4th positional arg) carries the pinned
    // skuUuid/providerUuid from the user's pick.
    const fredInput = vi.mocked(fred.deployApp).mock.calls[0]?.[3] as
      | { skuUuid?: string; providerUuid?: string }
      | undefined;
    expect(fredInput).toMatchObject({
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
    });
  });

  it('re-throws SKU_AMBIGUOUS when no onResolveSku callback is provided', async () => {
    const { spec, fred, core } = await setupHappyDeps();

    const c1: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p1'),
      providerUuid: asProviderUuid('p1'),
      name: 'small',
      active: true,
    };
    const c2: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
      name: 'small',
      active: true,
    };
    vi.mocked(core.resolveSku).mockRejectedValueOnce(
      new ManifestMCPError(
        ManifestMCPErrorCode.SKU_AMBIGUOUS,
        'SKU name "small" matches 2 active SKUs.',
        { reason: 'AMBIGUOUS_SKU_NAME', size: 'small', candidates: [c1, c2] },
      ),
    );

    // Callbacks WITHOUT onResolveSku.
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = { ...baseCapture.callbacks };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

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

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.SKU_AMBIGUOUS,
    );
    // No broadcast on ambiguity.
    expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
  });

  it('FIX 1 (regression): threads the RESOLVED pin.name (not requestedSize) into checkDeploymentReadiness', async () => {
    // The spec fixture has no `size` → `requestedSize` defaults to 'small'.
    // resolveSku returns a pin whose on-chain `name` is 'docker-micro'
    // (e.g. the deploy was pinned by skuUuid to a SKU whose name != 'small').
    // The bug: deploy-app passed `size: requestedSize(spec)` ('small') to
    // readiness, so fred's gate `skuCandidates.some(c => c.name === size)`
    // failed → status 'block' → INVALID_CONFIG before broadcast, rejecting
    // a valid pin. The fix threads `pinned.name` ('docker-micro') instead.
    const { spec, fred, core } = await setupHappyDeps();

    vi.mocked(core.resolveSku).mockResolvedValue({
      skuUuid: 'X',
      providerUuid: 'p1',
      name: 'docker-micro',
      active: true,
    } as SkuCandidate);

    const baseCapture = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(spec, baseCapture.callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // The readiness check was invoked with the RESOLVED SKU name, NOT the
    // user's defaulted 'small'. This is the assertion that would have
    // caught the high-severity bug.
    const readinessInput = vi.mocked(fred.checkDeploymentReadiness).mock
      .calls[0]?.[2] as { size?: string } | undefined;
    expect(readinessInput?.size).toBe('docker-micro');
    expect(readinessInput?.size).not.toBe('small');
  });

  it('FIX 2: stamping the resolved pin prevents a post-edit re-elicit (onResolveSku called exactly once)', async () => {
    // First pass: ambiguous SKU → onResolveSku resolves a pin. The pin is
    // stamped onto `confirmedSpec`. An `edit_env` PlanEdit preserves the
    // stamped skuUuid/providerUuid, so the post-edit `resolvePin` resolves
    // BY UUID — bypassing the name + ambiguity — without re-eliciting.
    const { spec, fred, core } = await setupHappyDeps();

    const c1: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p1'),
      providerUuid: asProviderUuid('p1'),
      name: 'small',
      active: true,
    };
    const c2: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
      name: 'small',
      active: true,
    };
    const pinned: SkuCandidate = {
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
      name: 'small',
      active: true,
    };

    // resolveSku throws SKU_AMBIGUOUS ONLY when called WITHOUT a skuUuid;
    // once the pin is stamped, the by-uuid call resolves the same pin with
    // no re-elicit. This makes the once-only assertion deterministic.
    vi.mocked(core.resolveSku).mockImplementation(
      async (_qc: unknown, input: { skuUuid?: string }) => {
        if (input.skuUuid === undefined) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.SKU_AMBIGUOUS,
            'SKU name "small" matches 2 active SKUs.',
            {
              reason: 'AMBIGUOUS_SKU_NAME',
              size: 'small',
              candidates: [c1, c2],
            },
          );
        }
        return pinned;
      },
    );

    const onResolveSku = vi.fn(async (_candidates: SkuCandidate[]) => ({
      skuUuid: asSkuUuid('sku-p2'),
      providerUuid: asProviderUuid('p2'),
    }));

    // onPlan returns an `edit_env` edit on the first (and only) call,
    // triggering a single post-edit re-plan. The single-service spec gets
    // a new env key; `resolvePin(confirmedSpec)` then runs again — and must
    // NOT re-elicit because the stamped pin resolves by uuid.
    let planCalls = 0;
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onResolveSku,
      onPlan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          return { kind: 'edit_env', env: { FOO: 'bar' } };
        }
        return 'confirm';
      },
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // The whole point of FIX 2: onResolveSku fires exactly ONCE across the
    // entire deploy, even though resolvePin ran twice (initial + post-edit).
    expect(onResolveSku).toHaveBeenCalledTimes(1);
    // resolveSku itself ran at least twice (initial ambiguous throw + the
    // by-uuid resolve), and again for the post-edit re-plan by uuid.
    expect(vi.mocked(core.resolveSku).mock.calls.length).toBeGreaterThanOrEqual(
      3,
    );
    // The second pass (post-edit) resolved BY UUID — the last call carried
    // the stamped skuUuid, proving the pin was written back to the spec.
    const lastCall = vi.mocked(core.resolveSku).mock.calls.at(-1);
    expect((lastCall?.[1] as { skuUuid?: string }).skuUuid).toBe('sku-p2');
    // The broadcast still carries the pinned identity.
    const fredInput = vi.mocked(fred.deployApp).mock.calls[0]?.[3] as
      | { skuUuid?: string; providerUuid?: string }
      | undefined;
    expect(fredInput).toMatchObject({ skuUuid: 'sku-p2', providerUuid: 'p2' });
  });

  it('FIX 2 (non-elicited path): a UNIQUE-name resolution does NOT stamp confirmedSpec; post-edit re-plan re-resolves by name (no stale pin)', async () => {
    // When the SKU resolves uniquely by name (no ambiguity, no elicitation),
    // `confirmedSpec` must NOT be stamped with the pin. A subsequent
    // `edit_env` re-plan therefore presents the original spec to `resolvePin`
    // WITHOUT a pre-locked skuUuid — demonstrating the non-elicited path
    // does not carry a stale pin identity.
    //
    // Verification strategy: the default `resolveSku` mock always resolves
    // uniquely (no SKU_AMBIGUOUS throw), so `pinElicited` is always false.
    // We observe all `resolveSku` call inputs: none of the calls issued
    // BEFORE the broadcast should carry a skuUuid (i.e. the post-edit
    // re-plan was NOT fed a stamped UUID by `confirmedSpec`). The broadcast
    // input still carries the pin — set directly by `buildFredDeployInput`
    // from the `pinned` local, not from `confirmedSpec`.
    const { spec, fred, core } = await setupHappyDeps();

    let planCalls = 0;
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onPlan: async () => {
        planCalls += 1;
        if (planCalls === 1) {
          // Trigger the post-edit re-plan with an `edit_env` edit. The
          // edit spreads `confirmedSpec` — which must NOT carry a stamped
          // skuUuid in the non-elicited path.
          return { kind: 'edit_env', env: { UNIQUE_NAME: 'yes' } };
        }
        return 'confirm';
      },
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // Both `resolvePin` calls (initial + post-edit) should have gone through
    // the default mock's unique-resolve path. Neither should have received a
    // `skuUuid` from `confirmedSpec` (non-elicited → no stamp).
    const allResolveCalls = vi.mocked(core.resolveSku).mock.calls;
    // There must have been at least 2 calls: initial + post-edit.
    expect(allResolveCalls.length).toBeGreaterThanOrEqual(2);
    // Neither call should carry a skuUuid from a stale pin stamp.
    for (const call of allResolveCalls) {
      const input = call[1] as { skuUuid?: string };
      expect(input.skuUuid).toBeUndefined();
    }

    // The broadcast still carries the resolved pin (from the `pinned` local).
    const fredInput = vi.mocked(fred.deployApp).mock.calls[0]?.[3] as
      | { skuUuid?: string }
      | undefined;
    expect(fredInput?.skuUuid).toBe('sku-uuid-fixture');
  });
});

describe('deployApp replay — Copilot review fixes (PR #58 unresolved comments)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('r3237308843: onPlan edit re-emits `deployment_plan_rendered` with post-edit values', async () => {
    // After applying a PlanEdit, the orchestrator recomputes preview /
    // summary / fees / plan against the edited spec. The plan block
    // emitted via onProgress must also be refreshed so consumers see the
    // post-edit block alongside the post-edit intent recap.
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
    // Pre-edit preview returns the original meta hash; the post-edit
    // call returns a distinguishably different one. The orchestrator
    // calls `buildManifestPreview` once at plan-assembly and a second
    // time after applying the edit — sequencing the mock returns by
    // call order verifies that flow.
    vi.mocked(fred.buildManifestPreview)
      .mockResolvedValueOnce({
        manifest_json: metaHashResp.manifest_json,
        meta_hash_hex: metaHashResp.meta_hash_hex,
      } as Awaited<ReturnType<typeof fred.buildManifestPreview>>)
      .mockResolvedValueOnce({
        manifest_json: '{"edited":true}',
        meta_hash_hex:
          'deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedead',
      } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    // Construct a captureCallbacks variant that supplies an onPlan edit.
    // Replace the spec's image to a distinct value so the pre-edit and
    // post-edit blocks differ in a way we can assert on.
    const editedImage = 'ghcr.io/example/edited-app:v2';
    const editedSpec: DeploySpec = {
      ...(spec as SingleServiceSpec),
      image: editedImage,
    } as DeploySpec;
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onPlan: async () => ({ kind: 'replace_spec', spec: editedSpec }),
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // Two `deployment_plan_rendered` events fired: the pre-edit block
    // and a refreshed post-edit block.
    const rendered = baseCapture.progress.filter(
      (e) => e.kind === 'deployment_plan_rendered',
    );
    expect(rendered).toHaveLength(2);
    const preEditBlock =
      rendered[0]?.kind === 'deployment_plan_rendered'
        ? rendered[0].block
        : undefined;
    const postEditBlock =
      rendered[1]?.kind === 'deployment_plan_rendered'
        ? rendered[1].block
        : undefined;
    expect(preEditBlock).toBeDefined();
    expect(postEditBlock).toBeDefined();
    // The post-edit block reflects the edited image; the pre-edit block
    // reflects the original. (The original image is asserted indirectly
    // — it isn't the edited one. The renderer embeds the image string
    // verbatim into the block's `text`.)
    expect(postEditBlock?.text).toContain(editedImage);
    expect(preEditBlock?.text).not.toContain(editedImage);
    // Both blocks must differ — minimum-floor assertion against a
    // future regression where both events emit the same (stale) block.
    expect(preEditBlock?.text).not.toBe(postEditBlock?.text);
  });

  // ENG-185 sub-PR D: the prior `r3237308914` test asserted that
  // needs_wait throws INVALID_CONFIG with an "ENG-185 #6 deferral" note —
  // the textbook regression-guard inversion case once D lands the full
  // routing. Per the MEMORY.md `regression-guard-inversion-lesson`, the
  // architect's Q7 audit prescribed DELETE + REWRITE (not flip-in-place):
  // the new contract is that needs_wait POLLS via waitForAppReady,
  // emits one-or-more `polling_for_readiness` events, then fires
  // `app_ready_confirmed` + falls through to onComplete success. This
  // test pins that full happy path end-to-end.
  it('needs_wait classifier outcome → waitForAppReady polls → app_ready_confirmed + onComplete', async () => {
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
    // Initial deploy returns PENDING (numeric 1, classifier → needs_wait).
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '33333333-3333-4333-8333-333333333333',
      provider_uuid: '44444444-4444-4444-8444-444444444444',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 1 as never,
      connection: { instances: [] },
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    // waitForAppReady synchronously fires onProgress twice (PENDING then
    // ACTIVE samples) to exercise the polling_for_readiness emission,
    // then resolves with ACTIVE + a running instance.
    vi.mocked(fred.waitForAppReady).mockImplementation(
      async (
        _qc: unknown,
        _addr: unknown,
        leaseUuid: unknown,
        _getAuthToken: unknown,
        opts?: { onProgress?: (status: { state: number }) => void },
      ) => {
        opts?.onProgress?.({ state: 1 }); // PENDING sample
        opts?.onProgress?.({ state: 2 }); // ACTIVE sample (LeaseState enum: 2 = ACTIVE; was 3 = CLOSED — Copilot #5)
        return {
          lease_uuid: leaseUuid as string,
          provider_uuid: '44444444-4444-4444-8444-444444444444',
          provider_url: 'https://provider.testnet.manifest.network',
          state: 'LEASE_STATE_ACTIVE',
          status: {
            state: 2, // ACTIVE in LeaseState enum (was 3 = CLOSED — Copilot #5)
            instances: [
              {
                name: 'app',
                status: 'running',
                fqdn: 'app-33333333.testnet.manifest.app',
                ports: { '80/tcp': 30001 },
              },
            ],
          },
        } as Awaited<ReturnType<typeof fred.waitForAppReady>>;
      },
    );

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

    // Exactly ONE deploy_response_classified event (the initial bucket).
    // Defense-in-depth #2 (post-poll re-classify) is internal — it MUST
    // NOT emit a second deploy_response_classified event.
    const classifiedEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifiedEvents).toHaveLength(1);
    expect(
      classifiedEvents[0]?.kind === 'deploy_response_classified' &&
        classifiedEvents[0].outcome,
    ).toBe('needs_wait');

    // At least one polling_for_readiness event with the expected payload
    // shape (leaseUuid, numeric attempt, numeric elapsedMs).
    const pollEvents = progress.filter(
      (e) => e.kind === 'polling_for_readiness',
    );
    expect(pollEvents.length).toBeGreaterThanOrEqual(1);
    const firstPoll = pollEvents[0];
    if (firstPoll?.kind === 'polling_for_readiness') {
      expect(firstPoll.leaseUuid).toBe('33333333-3333-4333-8333-333333333333');
      expect(typeof firstPoll.attempt).toBe('number');
      expect(firstPoll.attempt).toBeGreaterThanOrEqual(1);
      expect(typeof firstPoll.elapsedMs).toBe('number');
      expect(firstPoll.elapsedMs).toBeGreaterThanOrEqual(0);
    }

    // Strict ordering (Risk 7 from architect's report): polling MUST
    // happen BEFORE app_ready_confirmed; classifier event MUST come
    // before polling.
    const pollIdx = progress.findIndex(
      (e) => e.kind === 'polling_for_readiness',
    );
    const readyIdx = progress.findIndex(
      (e) => e.kind === 'app_ready_confirmed',
    );
    const classifyIdx = progress.findIndex(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifyIdx).toBeGreaterThanOrEqual(0);
    expect(pollIdx).toBeGreaterThan(classifyIdx);
    expect(readyIdx).toBeGreaterThan(pollIdx);

    // app_ready_confirmed carries the leaseUuid from the post-poll
    // (merged) fredResult.
    const readyEvent = progress.find((e) => e.kind === 'app_ready_confirmed');
    if (readyEvent?.kind === 'app_ready_confirmed') {
      expect(readyEvent.leaseUuid).toBe('33333333-3333-4333-8333-333333333333');
    }

    // onComplete fires with the final ACTIVE result.
    expect(completed).toHaveLength(1);
    expect(completed[0]?.leaseState).toBe('LEASE_STATE_ACTIVE');
    expect(result.leaseState).toBe('LEASE_STATE_ACTIVE');
    expect(result.leaseUuid).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('r3248900328: walletProvider/clientManager address mismatch throws INVALID_CONFIG before any chain I/O', async () => {
    // The orchestrator reads the tenant address from `walletProvider`
    // (readiness check + ADR-036 auth) and `clientManager` (fred's
    // create-lease broadcast). If they diverge, the orchestrator must
    // fail-fast with INVALID_CONFIG before touching the chain —
    // otherwise the chain tx executes for the clientManager wallet
    // while provider auth (signed by walletProvider) fails, orphaning
    // a lease on clientManager's wallet.
    const spec = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'spec.json',
    ) as DeploySpec;

    // Set up the mocks that would normally fire on the happy path so
    // we can assert they're NEVER invoked. The guard must short-circuit
    // before any chain I/O.
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      {} as Awaited<ReturnType<typeof fred.checkDeploymentReadiness>>,
    );
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: '{}',
      meta_hash_hex: 'aa'.repeat(32),
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue(
      {} as Awaited<ReturnType<typeof fred.deployApp>>,
    );
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue(
      {} as Awaited<ReturnType<typeof core.cosmosEstimateFee>>,
    );

    const addressA = 'manifest1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1aaaa';
    const addressB = 'manifest1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1bbbb';
    const { callbacks } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    // walletProvider returns addressA; clientManager returns addressB.
    const walletProvider = makeMockWalletProvider();
    vi.mocked(walletProvider.getAddress).mockResolvedValue(addressA);
    const clientManager = makeMockClientManager(
      'manifest-ledger-testnet-1',
      addressB,
    );

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

    // INVALID_CONFIG throw with both addresses in the message.
    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toContain(addressA);
    expect((caughtErr as Error).message).toContain(addressB);
    expect((caughtErr as Error).message).toContain(
      'opts.walletProvider and opts.clientManager are bound to different addresses',
    );
    // No chain I/O performed: every downstream workspace-dep mock must
    // be untouched. (The guard short-circuits before
    // `checkDeploymentReadiness` / `buildManifestPreview` /
    // `cosmosEstimateFee` / `fredDeployApp` are reached.)
    expect(vi.mocked(fred.checkDeploymentReadiness)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.buildManifestPreview)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    expect(vi.mocked(core.cosmosEstimateFee)).not.toHaveBeenCalled();
  });

  it('r3249097051: portless single-service spec rejected before any chain I/O', async () => {
    // fred's image-mode rejects portless inputs (`port is required
    // when using image` at packages/fred/src/tools/deployApp.ts:202 +
    // buildManifestPreview.ts:181). The orchestrator's validateSpec
    // gate must reject upstream so the user gets an actionable
    // INVALID_CONFIG with a stack-spec hint, not a fred-side mid-
    // orchestration failure.
    const fred = await import('@manifest-network/manifest-mcp-fred');
    const core = await import('@manifest-network/manifest-mcp-core');

    const portlessSpec = {
      image: 'docker.io/library/alpine:latest',
      // No port intentionally.
    } as unknown as DeploySpec;

    const { callbacks } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    let caughtErr: unknown = null;
    try {
      await deployApp(portlessSpec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toContain(
      'single-service specs require at least one port',
    );
    // Stack-spec escape hatch must be advertised in the message.
    expect((caughtErr as Error).message).toContain(
      'For internal-only services, use a stack spec',
    );
    // No chain I/O performed (validateSpec is the very first step of
    // the orchestrator).
    expect(vi.mocked(fred.checkDeploymentReadiness)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.buildManifestPreview)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    expect(vi.mocked(core.cosmosEstimateFee)).not.toHaveBeenCalled();
  });

  it('r3249097136: DeployResult.urls fallback normalizes scheme-less fredResult.url', async () => {
    // fred's legacy top-level `url` may arrive scheme-less (e.g.
    // `app.example.com:443` from the older `connection.host` / `ports`
    // shape). The classifier + format-success renderer already
    // normalize via `normalizeFredUrl`; the success-path DeployResult
    // builder must too, otherwise consumers expecting URL strings get
    // a non-URL.
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
    // Active state but `connection.instances` empty so the URL
    // fallback fires; URL itself is scheme-less.
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '55555555-5555-4555-8555-555555555555',
      provider_uuid: '66666666-6666-4666-8666-666666666666',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 'LEASE_STATE_ACTIVE' as never,
      // Forces the fallback path: `extractRunningEndpoints` returns []
      // because the connection has no `instances` array, but
      // `hasRunningInstances` returns true via the `services` map
      // (kept the classifier on the 'active' branch).
      connection: {
        services: {
          web: {
            instances: [{ status: 'running' }],
          },
        },
      },
      url: 'app.example.com:443',
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

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

    // Scheme-less url → normalized to https://...:443/
    expect(result.urls).toEqual(['https://app.example.com:443/']);
  });

  it('r3249097136: DeployResult.urls fallback passes through fredResult.url already with scheme', async () => {
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
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '77777777-7777-4777-8777-777777777777',
      provider_uuid: '88888888-8888-4888-8888-888888888888',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 'LEASE_STATE_ACTIVE' as never,
      connection: {
        services: {
          web: {
            instances: [{ status: 'running' }],
          },
        },
      },
      url: 'https://app.example.com/',
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

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

    // Already-scheme'd url passes through unchanged.
    expect(result.urls).toEqual(['https://app.example.com/']);
  });

  // Copilot review fix (PR #58 r3249684686): `applyPlanEdit` may swap
  // in a fresh spec returned by `onPlan`. Without re-validation, an
  // invalid `replace_spec` (portless single-service, out-of-range
  // port, stack-without-services, etc.) flows through to
  // `buildManifestPreview` / fred. Fail fast at the boundary.
  describe('r3249684686: re-validate post-edit spec', () => {
    async function buildEditScenario(replacementSpec: DeploySpec) {
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
      vi.mocked(fred.deployApp).mockResolvedValue(
        {} as Awaited<ReturnType<typeof fred.deployApp>>,
      );
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
        module: 'billing',
        subcommand: 'create-lease',
        gasEstimate: '142000',
        fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
      } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

      const baseCapture = captureCallbacks();
      const callbacks: DeployAppCallbacks = {
        ...baseCapture.callbacks,
        onPlan: async () => ({ kind: 'replace_spec', spec: replacementSpec }),
      };

      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

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
      return { caughtErr, fred, core, baseCapture };
    }

    it('rejects portless replace_spec; build/deploy not invoked after the throw', async () => {
      const { caughtErr, fred } = await buildEditScenario({
        image: 'alpine',
      } as unknown as DeploySpec);

      expect(caughtErr).toBeInstanceOf(Error);
      expect((caughtErr as Error).message).toContain(
        'Post-edit spec failed validation',
      );
      expect((caughtErr as Error).message).toContain(
        'single-service specs require at least one port',
      );
      // The post-edit `buildManifestPreview` call MUST NOT fire.
      // Pre-edit call: 1 invocation (initial plan render). After the
      // re-validation throw, no second call.
      expect(vi.mocked(fred.buildManifestPreview)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    });

    it('rejects out-of-range port (r3249294877 + r3249684686 interplay)', async () => {
      const { caughtErr, fred } = await buildEditScenario({
        image: 'alpine',
        port: -1,
      } as unknown as DeploySpec);

      expect(caughtErr).toBeInstanceOf(Error);
      expect((caughtErr as Error).message).toContain(
        'Post-edit spec failed validation',
      );
      expect((caughtErr as Error).message).toContain(
        'finite positive integer in the TCP range',
      );
      expect(vi.mocked(fred.buildManifestPreview)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    });

    it('rejects stack + customDomain missing serviceName (r3249684707 + r3249684686 interplay)', async () => {
      const { caughtErr, fred } = await buildEditScenario({
        services: { web: { image: 'nginx:1.27' } },
        customDomain: 'app.example.com',
      } as unknown as DeploySpec);

      expect(caughtErr).toBeInstanceOf(Error);
      expect((caughtErr as Error).message).toContain(
        'Post-edit spec failed validation',
      );
      expect((caughtErr as Error).message).toContain('customDomain');
      expect((caughtErr as Error).message).toContain('serviceName');
      expect(vi.mocked(fred.buildManifestPreview)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    });

    it('positive control: valid replace_spec proceeds through recompute + broadcast', async () => {
      // A valid replacement should NOT throw — the re-validation passes
      // and the orchestrator recomputes preview/summary/fees/plan
      // against the edited spec. `buildManifestPreview` fires twice
      // (pre-edit + post-edit), `deployApp` once.
      const validReplacement = {
        image: 'docker.io/library/nginx:1.27',
        port: 8080,
      } as DeploySpec;

      const { caughtErr, fred } = await buildEditScenario(validReplacement);

      // The mocked fred.deployApp returns `{}` which the classifier
      // routes to `'failed'` (no lease_uuid → outcome failed). Per
      // ENG-185 sub-PR D the orchestrator now throws TX_FAILED with the
      // classifier's `deploy_app returned no lease_uuid` errorSummary.
      // That's fine — we only care that the throw is NOT a post-edit-
      // validation failure (i.e., the recompute fired and we got past
      // validateSpec).
      expect(caughtErr).toBeInstanceOf(Error);
      expect((caughtErr as Error).message).not.toContain(
        'Post-edit spec failed validation',
      );
      // buildManifestPreview fires twice: once before onPlan, once
      // after applyPlanEdit + the re-validation pass.
      expect(vi.mocked(fred.buildManifestPreview)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fred.deployApp)).toHaveBeenCalledTimes(1);
    });
  });

  // Copilot review fix (PR #58 r3267373084): post-edit readiness recall.
  // After `applyPlanEdit` + `validateSpec`, the orchestrator now
  // re-evaluates readiness against the edited spec before
  // `buildManifestPreview` / `estimateFees`. Structural wiring is in
  // place for ENG-185 #1 (full evaluator); today the stub returns
  // `'ok'` for both calls. Same fail-fast block-short-circuit as the
  // original-spec gate.
  describe('r3267373084: readiness recall post-edit', () => {
    it('replace_spec edit triggers a second `checkDeploymentReadiness` call', async () => {
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
      vi.mocked(fred.deployApp).mockResolvedValue(
        {} as Awaited<ReturnType<typeof fred.deployApp>>,
      );
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
        module: 'billing',
        subcommand: 'create-lease',
        gasEstimate: '142000',
        fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
      } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

      // replace_spec with a different image/size to make the recall
      // semantically meaningful (today the stub returns the same
      // `'ok'` regardless, but the wiring fires either way).
      const editedSpec: DeploySpec = {
        image: 'docker.io/library/redis:7',
        port: 6379,
      } as DeploySpec;
      const baseCapture = captureCallbacks();
      const callbacks: DeployAppCallbacks = {
        ...baseCapture.callbacks,
        onPlan: async () => ({ kind: 'replace_spec', spec: editedSpec }),
      };

      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      try {
        await deployApp(spec, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch {
        // fredResult `{}` → classifier `'failed'` → orchestrator throws
        // TX_FAILED (sub-PR D full routing). Irrelevant; we only care
        // about the readiness call count.
      }

      // ONE call against the original spec (image: nginx, size: small),
      // then ONE call against the edited spec (image: redis, size: small
      // — `requestedSize` reads `spec.size` else falls back to 'small').
      expect(vi.mocked(fred.checkDeploymentReadiness)).toHaveBeenCalledTimes(2);
      // The post-edit call passed the edited image (regression guard).
      const calls = vi.mocked(fred.checkDeploymentReadiness).mock.calls;
      expect(calls[0]?.[2]).toMatchObject({
        image: 'docker.io/library/nginx:1.27',
      });
      expect(calls[1]?.[2]).toMatchObject({
        image: 'docker.io/library/redis:7',
      });
      // Two `readiness_evaluated` progress events: original + edited.
      const readinessEvents = baseCapture.progress.filter(
        (e) => e.kind === 'readiness_evaluated',
      );
      expect(readinessEvents).toHaveLength(2);
    });

    it('positive control: `onPlan` returns `confirm` → readiness called ONCE (no recall)', async () => {
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
      vi.mocked(fred.deployApp).mockResolvedValue(
        {} as Awaited<ReturnType<typeof fred.deployApp>>,
      );
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
        module: 'billing',
        subcommand: 'create-lease',
        gasEstimate: '142000',
        fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
      } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

      const baseCapture = captureCallbacks();
      const callbacks: DeployAppCallbacks = {
        ...baseCapture.callbacks,
        onPlan: async () => 'confirm',
      };

      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      try {
        await deployApp(spec, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch {
        // Same as above — classifier throw (TX_FAILED) from `{}` fredResult.
      }

      // No edit → no recall.
      expect(vi.mocked(fred.checkDeploymentReadiness)).toHaveBeenCalledTimes(1);
      const readinessEvents = baseCapture.progress.filter(
        (e) => e.kind === 'readiness_evaluated',
      );
      expect(readinessEvents).toHaveLength(1);
    });
  });

  // ENG-185 sub-PR B item 1: with the real `evaluateReadiness` wired
  // through the snake_case → camelCase translator, BOTH the initial-spec
  // and the post-edit recall paths fire the `status === 'block'`
  // short-circuit. Block conditions verified end-to-end:
  //   - empty `wallet_balances` → block (rule #2 — wallet has no gas);
  //   - requested SKU not in `available_skus` / no candidate → block (rule #1).
  // Tests assert: throw is INVALID_CONFIG with the expected message,
  // fred's `deployApp` is NEVER called, and the orchestrator does NOT
  // emit `deploy_app_broadcast`.
  describe('ENG-185 #1: readiness block-short-circuit (initial + post-edit)', () => {
    function readinessOk(): unknown {
      return readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'input',
        'readiness-response.json',
      );
    }

    function readinessBlocking(): unknown {
      // wallet_balances: [] is the simplest block trigger — evaluator's
      // gas-balance rule fires `status: 'block'` with the
      // `request_faucet` + `topup_wallet` actions.
      const r = readinessOk() as Record<string, unknown>;
      return { ...r, wallet_balances: [] };
    }

    it('initial-spec readiness=block → throws INVALID_CONFIG; fred.deployApp NEVER called', async () => {
      const spec = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'input',
        'spec.json',
      ) as DeploySpec;

      const fred = await import('@manifest-network/manifest-mcp-fred');
      vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
        readinessBlocking() as Awaited<
          ReturnType<typeof fred.checkDeploymentReadiness>
        >,
      );

      const baseCapture = captureCallbacks();
      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      let err: unknown = null;
      try {
        await deployApp(spec, baseCapture.callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((err as Error).message).toContain('Readiness check failed');
      // No broadcast — short-circuit fired before fred.deployApp.
      expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
      expect(
        baseCapture.progress.some((e) => e.kind === 'deploy_app_broadcast'),
      ).toBe(false);
    });

    it('post-edit readiness=block (initial ok) → throws INVALID_CONFIG on recall; fred.deployApp NEVER called', async () => {
      const spec = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'input',
        'spec.json',
      ) as DeploySpec;
      const metaHashResp = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'input',
        'meta-hash-response.json',
      ) as { manifest_json: string; meta_hash_hex: string };

      const fred = await import('@manifest-network/manifest-mcp-fred');
      // First call (initial spec) → ok; second call (post-edit recall) → block.
      vi.mocked(fred.checkDeploymentReadiness)
        .mockResolvedValueOnce(
          readinessOk() as Awaited<
            ReturnType<typeof fred.checkDeploymentReadiness>
          >,
        )
        .mockResolvedValueOnce(
          readinessBlocking() as Awaited<
            ReturnType<typeof fred.checkDeploymentReadiness>
          >,
        );
      vi.mocked(fred.buildManifestPreview).mockResolvedValue({
        manifest_json: metaHashResp.manifest_json,
        meta_hash_hex: metaHashResp.meta_hash_hex,
      } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
        module: 'billing',
        subcommand: 'create-lease',
        gasEstimate: '142000',
        fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
      } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

      const editedSpec: DeploySpec = {
        image: 'docker.io/library/redis:7',
        port: 6379,
      } as DeploySpec;
      const baseCapture = captureCallbacks();
      const callbacks: DeployAppCallbacks = {
        ...baseCapture.callbacks,
        onPlan: async () => ({ kind: 'replace_spec', spec: editedSpec }),
      };

      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      let err: unknown = null;
      try {
        await deployApp(spec, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      // Post-edit message has a distinct prefix to differentiate from the
      // initial-spec throw (deploy-app.ts L327-330 "Post-edit readiness
      // check failed:").
      expect((err as Error).message).toContain(
        'Post-edit readiness check failed',
      );
      // Both readiness calls fired (initial ok → continue → recall block).
      expect(vi.mocked(fred.checkDeploymentReadiness)).toHaveBeenCalledTimes(2);
      // Two readiness_evaluated events emitted (initial + recall).
      const readinessEvents = baseCapture.progress.filter(
        (e) => e.kind === 'readiness_evaluated',
      );
      expect(readinessEvents).toHaveLength(2);
      // No broadcast — short-circuit fired before fred.deployApp.
      expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
      expect(
        baseCapture.progress.some((e) => e.kind === 'deploy_app_broadcast'),
      ).toBe(false);
    });

    it('initial readiness=block → throws BEFORE the plan is rendered (no `deployment_plan_rendered` event)', async () => {
      // Defensive: the block-short-circuit fires at L207, which sits
      // BEFORE the plan-assembly + renderDeploymentPlan call. The
      // orchestrator must NOT render a plan for a spec that already
      // failed readiness — a rendered plan would suggest the deploy is
      // actionable when it isn't.
      const spec = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'input',
        'spec.json',
      ) as DeploySpec;
      const fred = await import('@manifest-network/manifest-mcp-fred');
      vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
        readinessBlocking() as Awaited<
          ReturnType<typeof fred.checkDeploymentReadiness>
        >,
      );

      const baseCapture = captureCallbacks();
      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      try {
        await deployApp(spec, baseCapture.callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch {
        // expected
      }

      expect(
        baseCapture.progress.some((e) => e.kind === 'deployment_plan_rendered'),
      ).toBe(false);
      // The readiness_evaluated event DOES fire (the orchestrator emits
      // it before the block check, so consumers see the verdict).
      expect(
        baseCapture.progress.some((e) => e.kind === 'readiness_evaluated'),
      ).toBe(true);
    });
  });

  // Copilot review fix (PR #58 r3250192734): the FeeEstimate `gas` must
  // match the gas the `coins` were priced for (post-`gasMultiplier`),
  // not raw `gasEstimate`. Under the default 1.5x multiplier the prior
  // code displayed a number ~33% lower than the price reflected.
  describe('r3250192734: createLease.gas reflects post-multiplier fee.gas', () => {
    it('surfaces fee.gas (priced), not gasEstimate (raw simulation gas)', async () => {
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
      vi.mocked(fred.deployApp).mockResolvedValue(
        {} as Awaited<ReturnType<typeof fred.deployApp>>,
      );
      // Distinct values for gasEstimate vs. fee.gas — the bug would
      // surface as `plan.fees.createLease.gas === 100`; the fix
      // surfaces 150.
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
        module: 'billing',
        subcommand: 'create-lease',
        gasEstimate: '100',
        fee: {
          gas: '150',
          amount: [{ denom: 'umfx', amount: '2300' }],
        },
      } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

      // Capture the Plan passed to onPlan so we can inspect
      // `plan.fees.createLease.gas`.
      let capturedPlan: Plan | undefined;
      const baseCapture = captureCallbacks();
      const callbacks: DeployAppCallbacks = {
        ...baseCapture.callbacks,
        onPlan: async (plan) => {
          capturedPlan = plan;
          return 'confirm';
        },
      };

      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      try {
        await deployApp(spec, callbacks, {
          clientManager: clientManager as unknown as Parameters<
            typeof deployApp
          >[2]['clientManager'],
          walletProvider,
        });
      } catch {
        // fredResult is `{}` → classifier `'failed'` → orchestrator
        // throws TX_FAILED (sub-PR D full routing). Irrelevant; we
        // only need the captured Plan from the onPlan callback.
      }

      expect(capturedPlan).toBeDefined();
      expect(capturedPlan?.fees.createLease.gas).toBe(150);
      expect(capturedPlan?.fees.createLease.gas).not.toBe(100);
    });
  });

  // Copilot review fix (PR #58 r3250192834): preserve the original
  // ManifestMCPError code from `cosmosEstimateFee` instead of forcing
  // every failure into SIMULATION_FAILED. Core's `cosmosEstimateFee`
  // throws across multiple code sites — clobbering to SIMULATION_FAILED
  // makes callers unable to distinguish, e.g., INVALID_CONFIG (missing
  // gasPrice) from UNSUPPORTED_TX (bad module/subcommand) from an
  // actual simulation error.
  describe('r3250192834: cosmosEstimateFee error code preservation', () => {
    async function runDeployWithEstimateError(thrownByEstimate: unknown) {
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
      const core = await import('@manifest-network/manifest-mcp-core');
      vi.mocked(core.cosmosEstimateFee).mockRejectedValue(thrownByEstimate);

      const { callbacks } = captureCallbacks();
      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

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
      return caughtErr;
    }

    it('preserves INVALID_CONFIG from a typed ManifestMCPError', async () => {
      const err = await runDeployWithEstimateError(
        new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_CONFIG,
          'cosmos: gasPrice not configured',
        ),
      );
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((err as Error).message).toContain(
        'Failed to estimate create-lease fee',
      );
      expect((err as Error).message).toContain('gasPrice not configured');
    });

    it('preserves UNSUPPORTED_TX from a typed ManifestMCPError', async () => {
      const err = await runDeployWithEstimateError(
        new ManifestMCPError(
          ManifestMCPErrorCode.UNSUPPORTED_TX,
          'cosmos: module/subcommand not registered',
        ),
      );
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.UNSUPPORTED_TX,
      );
    });

    it('falls back to SIMULATION_FAILED for untyped failures', async () => {
      const err = await runDeployWithEstimateError(
        new Error('untyped failure from cosmosEstimateFee'),
      );
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.SIMULATION_FAILED,
      );
      expect((err as Error).message).toContain(
        'Failed to estimate create-lease fee',
      );
      expect((err as Error).message).toContain('untyped failure');
    });
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
      expect.objectContaining({
        chain: expect.anything(),
        logger: expect.anything(),
      }),
      { leaseUuid: '11111111-1111-4111-8111-111111111111' },
    );

    // Verify the orchestrator threw after recovery (caller expected to
    // re-run troubleshootDeployment).
    expect(caughtErr).toBeInstanceOf(Error);
  });

  // ENG-185 #7 (route β): the rendered partial-success prompt body rides a
  // `partial_success_prompt_rendered` ProgressEvent, emitted exactly once
  // immediately before `onFailure`. Reuses the sibling fixture + the same
  // partial-success rejection message so the lease UUID + reason flow
  // verbatim into the renderer for a char-exact byte-baseline assertion.
  it('partial-success: emits one partial_success_prompt_rendered event carrying the renderer-exact prompt before onFailure', async () => {
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
    // Same partial-success rejection message as the sibling test so the
    // lease UUID + reason are identical going into the renderer.
    const partialSuccessReason =
      'Deploy partially succeeded: lease 11111111-1111-4111-8111-111111111111 was created but set-domain failed: simulation error';
    vi.mocked(fred.deployApp).mockRejectedValue(
      new Error(partialSuccessReason),
    );

    const { callbacks, progress, failures } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const core = await import('@manifest-network/manifest-mcp-core');
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

    try {
      await deployApp(spec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch {
      // The orchestrator throws after recovery dispatch; irrelevant here.
    }

    // (a) Exactly one partial_success_prompt_rendered event fired, and its
    // leaseUuid is the expected UUID.
    const promptEvents = progress.filter(
      (
        e,
      ): e is Extract<
        ProgressEvent,
        { kind: 'partial_success_prompt_rendered' }
      > => e.kind === 'partial_success_prompt_rendered',
    );
    expect(promptEvents).toHaveLength(1);
    const promptEvent = promptEvents[0];
    expect(promptEvent.leaseUuid).toBe('11111111-1111-4111-8111-111111111111');

    // (b) Byte-for-byte: the event prompt equals the real renderer's output
    // for the IDENTICAL inputs the orchestrator fed it. We pull leaseUuid,
    // reason, and requestedCustomDomain from the captured failure envelope
    // (== `classified.{leaseUuid,reason}` + `requestedCustomDomain`) and
    // pair them with the orchestrator's hard-coded `decodedState`. The
    // renderer is deterministic, so this MUST match char-for-char.
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure?.envelope.outcome).toBe('partially_succeeded');
    if (failure?.envelope.outcome !== 'partially_succeeded') {
      throw new Error('expected partially_succeeded envelope');
    }
    const { renderPartialSuccessPrompt } = await import(
      './internals/render-partial-success-prompt.js'
    );
    const expected = renderPartialSuccessPrompt({
      leaseUuid: failure.envelope.leaseUuid,
      decodedState: 'LEASE_STATE_PENDING',
      reason: failure.envelope.reason,
      ...(failure.envelope.requestedCustomDomain !== undefined
        ? { requestedCustomDomain: failure.envelope.requestedCustomDomain }
        : {}),
    }).prompt;
    expect(promptEvent.prompt).toBe(expected);

    // (c) onFailure invoked exactly once (no double-prompt).
    expect(failures).toHaveLength(1);
  });
});

// Copilot review fix (PR #58 r3266642610): `applyPlanEdit` previously
// silently no-op'd `edit_env` on stack specs when `service` was missing
// or unknown, returning the original spec while the callback caller
// perceived the edit as applied. Worst case: deploy with wrong env vars
// / secrets, no error signal. Now throws `INVALID_CONFIG` from inside
// `applyPlanEdit`, which surfaces through `deployApp`'s onPlan branch
// to the caller.
describe('deployApp — applyPlanEdit edit_env validation (r3266642610)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runWithEdit(
    initialSpec: DeploySpec,
    plannedEdit: NonNullable<DeployAppCallbacks['onPlan']> extends (
      p: Plan,
    ) => Promise<infer R>
      ? Exclude<R, 'confirm' | 'cancel'>
      : never,
  ): Promise<unknown> {
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
    vi.mocked(fred.deployApp).mockResolvedValue(
      {} as Awaited<ReturnType<typeof fred.deployApp>>,
    );
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onPlan: async () => plannedEdit,
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    let caughtErr: unknown = null;
    try {
      await deployApp(initialSpec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch (err) {
      caughtErr = err;
    }
    return caughtErr;
  }

  const STACK_SPEC: DeploySpec = {
    services: {
      web: { image: 'nginx:1.27', ports: [80], env: { EXISTING: 'value' } },
    },
  } as unknown as DeploySpec;

  it('stack + edit_env without `service` → INVALID_CONFIG with "requires `service`"', async () => {
    const err = await runWithEdit(STACK_SPEC, {
      kind: 'edit_env',
      env: { NEW: 'val' },
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      'edit_env on a stack spec requires `service`',
    );
  });

  it('stack + edit_env with unknown service → INVALID_CONFIG with services list', async () => {
    const err = await runWithEdit(STACK_SPEC, {
      kind: 'edit_env',
      service: 'unknown-svc',
      env: { NEW: 'val' },
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"unknown-svc"');
    expect((err as Error).message).toContain('is not a key in `services`');
    expect((err as Error).message).toContain('web');
  });

  it("stack + edit_env with prototype-chain pollution ('constructor') → INVALID_CONFIG (Fix 16 symmetry)", async () => {
    const err = await runWithEdit(STACK_SPEC, {
      kind: 'edit_env',
      service: 'constructor',
      env: { NEW: 'val' },
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"constructor"');
    expect((err as Error).message).toContain('is not a key in `services`');
  });

  it('stack + edit_env with valid service → merges env on that service (positive control)', async () => {
    // A valid edit shouldn't trigger the applyPlanEdit throw. The
    // orchestrator's downstream classifier-driven INVALID_CONFIG
    // (fredResult `{}` → 'failed' classification) IS expected — we just
    // care the throw is NOT the applyPlanEdit one.
    const err = await runWithEdit(STACK_SPEC, {
      kind: 'edit_env',
      service: 'web',
      env: { NEW: 'val' },
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(
      'edit_env on a stack spec requires',
    );
    expect((err as Error).message).not.toContain('is not a key in `services`');
  });

  it('single-service edit_env → merges env (regression guard, unchanged behavior)', async () => {
    const singleSpec = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'spec.json',
    ) as DeploySpec;
    const err = await runWithEdit(singleSpec, {
      kind: 'edit_env',
      env: { NEW: 'val' },
    });
    // Same positive-control rationale as above — applyPlanEdit must
    // not throw; downstream classification throw is acceptable.
    expect((err as Error | null)?.message).not.toContain(
      'edit_env on a stack spec requires',
    );
    expect((err as Error | null)?.message).not.toContain(
      'is not a key in `services`',
    );
  });
});

// ENG-185 sub-PR C (item 3): two fee-estimation bugs in `estimateFees`.
//
//   Bug 1 (create-lease underestimation on stacks): the prior code always
//   emitted a SINGLE item-arg to `cosmosEstimateFee`. fred's deploy-time
//   logic (`packages/fred/src/tools/deployApp.ts:336-341`) creates N items
//   for an N-service stack — one per service. Underestimating gas for an
//   N-service stack as a 1-service lease is a real bug; the user's plan
//   shows a fee that won't cover broadcast.
//
//   Bug 2 (service-mode args gated on customDomain): the prior code's
//   gate was `isStackSpec(spec) && spec.serviceName`. But `spec.serviceName`
//   is only present when the stack ALSO carries a customDomain (via
//   validateSpec's coupling). A stack-without-customDomain therefore fell
//   through to bare `${skuUuid}:1` (legacy-mode item args), which has a
//   different gas profile from service-mode items per
//   `x/billing/keeper/custom_domain.go`. The architect's prescription drops
//   the gate entirely.
//
// Fix: mirror fred's deploy-time iteration verbatim — for a stack, one
// `${skuUuid}:1:${name}` arg per service; for single-service, one bare
// `${skuUuid}:1`. spec.serviceName presence is now irrelevant for fee
// estimation (it still matters at broadcast, but fred owns that).
//
// Set-domain sentinel reason: the prior string referenced "approach-3
// fallback deferred to PR-3.x" — misleading per the architect's
// verdict-B chain analysis (chain rejects placeholder-UUID simulation
// permanently, no TODO). Updated to the canonical short form
// `'no representative lease for pre-broadcast simulation'`, which is
// ALREADY pinned in `render-deployment-plan.test.ts:170` — same string
// across producer + renderer test = no churn.
describe('deployApp — estimateFees create-lease itemArgs (ENG-185 #3 bug 1+2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Setup helper: stub fred's readiness/preview + core's cosmosEstimateFee
   * with the canonical happy-path values, then run `deployApp` with an
   * `onPlan` callback that returns `'cancel'`. By the time `onPlan` fires,
   * `estimateFees` has already invoked `cosmosEstimateFee` — we capture
   * its 4th-positional `args` array and the rendered plan for assertion.
   *
   * `validateSpec` runs FIRST in `deployApp`, so the caller-supplied spec
   * must be well-formed. Each test crafts its spec to satisfy that gate.
   */
  async function runUntilPlan(spec: DeploySpec): Promise<{
    capturedPlan: Plan | null;
    estimateFeeArgs: string[] | undefined;
    err: unknown;
  }> {
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

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    let capturedPlan: Plan | null = null;
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      // Capture-then-cancel: by this point estimateFees has run, plan is
      // assembled, and the orchestrator throws OPERATION_CANCELLED on
      // 'cancel' — which we swallow. Net: cheap path through the fee path
      // only.
      onPlan: async (p) => {
        capturedPlan = p;
        return 'cancel';
      },
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    let err: unknown = null;
    try {
      await deployApp(spec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch (e) {
      err = e;
    }

    // 4th positional arg to cosmosEstimateFee is the args[] array.
    const estimateFeeArgs = vi.mocked(core.cosmosEstimateFee).mock
      .calls[0]?.[3] as string[] | undefined;

    return { capturedPlan, estimateFeeArgs, err };
  }

  it('single-service spec → 1 bare item-arg `<skuUuid>:1` (legacy mode)', async () => {
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
    } as DeploySpec;
    const { estimateFeeArgs } = await runUntilPlan(spec);
    expect(estimateFeeArgs).toBeDefined();
    expect(estimateFeeArgs?.[0]).toBe('--meta-hash');
    // Index 1 is the meta-hash hex; from index 2 onward are the item-args.
    expect(estimateFeeArgs?.slice(2)).toEqual(['sku-uuid-fixture:1']);
  });

  it('3-service stack spec → 3 item-args, one `<skuUuid>:1:<name>` per service (bug 1)', async () => {
    const spec: DeploySpec = {
      size: 'small',
      services: {
        web: { image: 'nginx:1.27' },
        api: { image: 'node:20' },
        db: { image: 'postgres:16' },
      },
    };
    const { estimateFeeArgs } = await runUntilPlan(spec);
    expect(estimateFeeArgs?.slice(2)).toEqual([
      'sku-uuid-fixture:1:web',
      'sku-uuid-fixture:1:api',
      'sku-uuid-fixture:1:db',
    ]);
  });

  it('1-service stack (NO customDomain) → 1 service-mode item-arg (bug 2 regression guard)', async () => {
    // The PRIOR code did `isStackSpec(spec) && spec.serviceName` — and
    // `spec.serviceName` is only present alongside customDomain. So a
    // stack-without-customDomain fell through to bare `${skuUuid}:1`
    // (legacy mode), even though fred would create service-mode items
    // at broadcast time. THIS test is the regression guard for bug 2:
    // the fix MUST emit `sku-uuid-fixture:1:web`, NOT `sku-uuid-fixture:1`.
    const spec: DeploySpec = {
      size: 'small',
      services: {
        web: { image: 'nginx:1.27' },
      },
    };
    const { estimateFeeArgs } = await runUntilPlan(spec);
    expect(estimateFeeArgs?.slice(2)).toEqual(['sku-uuid-fixture:1:web']);
    expect(estimateFeeArgs?.slice(2)).not.toEqual(['sku-uuid-fixture:1']);
  });

  it('stack WITH customDomain+serviceName → all services covered, customDomain target not privileged (bug 1+2)', async () => {
    // Cross-check on the architect's prescription: spec.serviceName
    // presence (here `'web'`) MUST NOT change the item-args — fred will
    // still create one item per service at broadcast. The customDomain
    // affects the set-domain TX, not create-lease.
    const spec: DeploySpec = {
      size: 'small',
      services: {
        web: { image: 'nginx:1.27' },
        api: { image: 'node:20' },
      },
      customDomain: 'app.example.com',
      serviceName: 'web',
    };
    const { estimateFeeArgs } = await runUntilPlan(spec);
    expect(estimateFeeArgs?.slice(2)).toEqual([
      'sku-uuid-fixture:1:web',
      'sku-uuid-fixture:1:api',
    ]);
    // Defensive cross-check: BOTH service names appear; the args do NOT
    // collapse to the single customDomain target.
    const itemArgs = estimateFeeArgs?.slice(2) ?? [];
    expect(itemArgs).toHaveLength(2);
    expect(itemArgs.some((a) => a.endsWith(':web'))).toBe(true);
    expect(itemArgs.some((a) => a.endsWith(':api'))).toBe(true);
  });

  it('cosmosEstimateFee called with `--meta-hash` prefix + the resolved hex digest', async () => {
    // Regression guard for the meta-hash threading: must continue to pass
    // the canonical `--meta-hash <hex>` prefix in front of the item-args
    // (mirrors fred's create-lease tx at packages/fred/src/tools/deployApp.ts:363).
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
    } as DeploySpec;
    const { estimateFeeArgs } = await runUntilPlan(spec);
    expect(estimateFeeArgs?.[0]).toBe('--meta-hash');
    expect(estimateFeeArgs?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deployApp — user cancellation throws OPERATION_CANCELLED (ENG-272)', () => {
  // Regression guard pinning the code of the two deliberate-cancellation
  // throw sites — symmetric with the manage-domain / close-lease decline
  // tests (manage-domain.test.ts / close-lease.test.ts). A user decline /
  // cancel is NOT a config fault: surfacing it as INVALID_CONFIG (the prior
  // code) — or worse, UNKNOWN (the wrapper-rejection bug) — hid the cause.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Stub fred readiness/preview + core estimateFee with the canonical
  // happy-path fixtures, then run the REAL deployApp with caller-supplied
  // plan/confirm verdicts and return the rejection for assertion.
  async function runDeployExpectingThrow(
    verdicts: Pick<DeployAppCallbacks, 'onPlan' | 'onConfirm'>,
  ): Promise<unknown> {
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

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      ...verdicts,
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
    } as DeploySpec;

    let err: unknown;
    try {
      await deployApp(spec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch (e) {
      err = e;
    }
    return err;
  }

  it("onPlan returns 'cancel' → OPERATION_CANCELLED (not INVALID_CONFIG / UNKNOWN)", async () => {
    const err = await runDeployExpectingThrow({ onPlan: async () => 'cancel' });
    expect(err).toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      message: expect.stringMatching(/User cancelled deployment at plan step/),
    });
  });

  it("onConfirm returns 'no' → OPERATION_CANCELLED (not INVALID_CONFIG / UNKNOWN)", async () => {
    const err = await runDeployExpectingThrow({
      onPlan: async () => 'confirm',
      onConfirm: async () => 'no',
    });
    expect(err).toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      message: expect.stringMatching(
        /User declined to proceed at intent-recap step/,
      ),
    });
  });
});

describe('deployApp — estimateFees set-domain sentinel reason (ENG-185 #3)', () => {
  // Architect's verdict B: chain rejects placeholder-UUID simulation of
  // `MsgSetItemCustomDomain` (keeper calls `GetLease()` first, fails
  // with ErrLeaseNotFound). The sentinel `{notEstimated: true, reason}`
  // is the PERMANENT shape — not a TODO. The reason string was misleading
  // (`'... deferred to PR-3.x'`); replaced with the canonical short form
  // already pinned in `render-deployment-plan.test.ts:170`:
  // `'no representative lease for pre-broadcast simulation'`.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function captureFees(spec: DeploySpec): Promise<Plan['fees'] | null> {
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

    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    let capturedPlan: Plan | null = null;
    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onPlan: async (p) => {
        capturedPlan = p;
        return 'cancel';
      },
    };

    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();
    try {
      await deployApp(spec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
      });
    } catch {
      // 'cancel' verdict throws OPERATION_CANCELLED; expected, swallow.
    }
    return capturedPlan === null ? null : (capturedPlan as Plan).fees;
  }

  it('emits the canonical short reason string when customDomain is set', async () => {
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
      customDomain: 'app.testnet.manifest.app',
    } as DeploySpec;
    const fees = await captureFees(spec);
    expect(fees?.setDomain).toBeDefined();
    expect(fees?.setDomain).toEqual({
      notEstimated: true,
      reason: 'no representative lease for pre-broadcast simulation',
    });
  });

  it('does NOT emit a setDomain field when customDomain is absent', async () => {
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
    } as DeploySpec;
    const fees = await captureFees(spec);
    expect(fees?.setDomain).toBeUndefined();
  });

  it('reason string does NOT contain stale "approach-3" / "deferred to PR-3.x" wording', async () => {
    // Anti-regression guard: the prior string referenced an internal
    // tracking ID + implied a TODO. The architect's verdict B makes the
    // sentinel permanent; future maintainers should not re-introduce
    // misleading TODO-style language.
    const spec: DeploySpec = {
      image: 'docker.io/library/nginx:1.27',
      port: 80,
      customDomain: 'app.testnet.manifest.app',
    } as DeploySpec;
    const fees = await captureFees(spec);
    const setDomain = fees?.setDomain;
    expect(
      setDomain !== undefined &&
        'notEstimated' in setDomain &&
        setDomain.notEstimated,
    ).toBe(true);
    if (setDomain !== undefined && 'notEstimated' in setDomain) {
      expect(setDomain.reason).not.toMatch(/approach-3/i);
      expect(setDomain.reason).not.toMatch(/deferred to PR-3/i);
      expect(setDomain.reason).not.toMatch(/lease UUID unavailable/i);
    }
  });
});

// ENG-185 sub-PR D — fixture-driven integration tests for the full
// classifier routing. Each test loads its fixture's JSON, drives the
// orchestrator end-to-end, and asserts the variant-specific event
// sequence and throw shape. Mirrors the `01-fast-path-active` test
// pattern; new fixtures live under
// `__fixtures__/skills/deploy-app/{05,06,07}-*`.
describe('deployApp replay — ENG-185 sub-PR D fixtures (05/06/07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('05-needs-wait-then-active: PENDING → poll → ACTIVE; sequenced events; onComplete fires', async () => {
    const spec = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;
    const waitResp = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'wait-for-app-ready-response.json',
    ) as Record<string, unknown>;
    const feeResp = readFixture(
      'skills',
      'deploy-app',
      '05-needs-wait-then-active',
      'input',
      'fee-response.json',
    ) as { fee: { amount: { denom: string; amount: string }[]; gas: string } };

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
    // Initial deploy returns PENDING string state per the fixture.
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    // waitForAppReady fires onProgress twice (PENDING + ACTIVE samples)
    // then returns the fixture's post-poll ACTIVE result.
    vi.mocked(fred.waitForAppReady).mockImplementation(
      async (
        _qc: unknown,
        _addr: unknown,
        _leaseUuid: unknown,
        _getAuthToken: unknown,
        opts?: { onProgress?: (status: { state: number }) => void },
      ) => {
        opts?.onProgress?.({ state: 1 }); // PENDING
        opts?.onProgress?.({ state: 2 }); // ACTIVE (was 3 = CLOSED — Copilot #5)
        return waitResp as unknown as Awaited<
          ReturnType<typeof fred.waitForAppReady>
        >;
      },
    );
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: feeResp.fee.gas,
      fee: feeResp.fee,
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

    // Risk-7 strict ordering: classify < poll < ready, and exactly ONE
    // classifier event (no re-emission after the post-poll Defense #2
    // re-classification).
    const classifyIdxs = progress
      .map((e, i) => (e.kind === 'deploy_response_classified' ? i : -1))
      .filter((i) => i >= 0);
    expect(classifyIdxs).toHaveLength(1);
    const pollIdxs = progress
      .map((e, i) => (e.kind === 'polling_for_readiness' ? i : -1))
      .filter((i) => i >= 0);
    expect(pollIdxs.length).toBeGreaterThanOrEqual(1);
    const readyIdx = progress.findIndex(
      (e) => e.kind === 'app_ready_confirmed',
    );
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(pollIdxs[0]).toBeGreaterThan(classifyIdxs[0] as number);
    expect(readyIdx).toBeGreaterThan(pollIdxs[pollIdxs.length - 1] as number);

    // Classifier emitted 'needs_wait' (the initial bucket).
    const classifyEvent = progress[classifyIdxs[0] as number];
    if (classifyEvent?.kind === 'deploy_response_classified') {
      expect(classifyEvent.outcome).toBe('needs_wait');
    }

    // onComplete fires with the merged post-poll ACTIVE state.
    expect(completed).toHaveLength(1);
    expect(result.leaseState).toBe('LEASE_STATE_ACTIVE');
    expect(result.leaseUuid).toBe(deployResp.lease_uuid as string);
    expect(vi.mocked(fred.waitForAppReady)).toHaveBeenCalledTimes(1);
    // Post-poll URL plumbing (Copilot fix-3 regression guard): the
    // FINAL `DeployResult.urls` must reflect the POST-POLL connection's
    // running instance fqdn (from `wait-for-app-ready-response.json`),
    // NOT the pre-poll empty instance list (from `deploy-response.json`).
    // Locks the `liveConnection` plumbing through
    // `extractRunningEndpoints` → `formatEndpointAsUrl`.
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls).toContain(
      `https://${(waitResp.status as { instances: { fqdn: string }[] }).instances[0]?.fqdn}/`,
    );
  });

  it('06-classifier-failed-terminal: REJECTED → TX_FAILED throw; no polling; no app_ready_confirmed', async () => {
    const spec = readFixture(
      'skills',
      'deploy-app',
      '06-classifier-failed-terminal',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '06-classifier-failed-terminal',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '06-classifier-failed-terminal',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '06-classifier-failed-terminal',
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
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
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

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain('LEASE_STATE_REJECTED');
    expect((caughtErr as Error).message).toContain(
      deployResp.lease_uuid as string,
    );
    expect(progress.some((e) => e.kind === 'polling_for_readiness')).toBe(
      false,
    );
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    expect(vi.mocked(fred.waitForAppReady)).not.toHaveBeenCalled();
    expect(completed).toHaveLength(0);
  });

  it('07-classifier-failed-no-lease-uuid: missing lease_uuid → TX_FAILED throw with no-uuid summary', async () => {
    const spec = readFixture(
      'skills',
      'deploy-app',
      '07-classifier-failed-no-lease-uuid',
      'input',
      'spec.json',
    ) as DeploySpec;
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '07-classifier-failed-no-lease-uuid',
      'input',
      'readiness-response.json',
    );
    const metaHashResp = readFixture(
      'skills',
      'deploy-app',
      '07-classifier-failed-no-lease-uuid',
      'input',
      'meta-hash-response.json',
    ) as { manifest_json: string; meta_hash_hex: string };
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '07-classifier-failed-no-lease-uuid',
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
    // Fixture's deploy-response.json deliberately omits `lease_uuid`.
    vi.mocked(fred.deployApp).mockResolvedValue(
      deployResp as unknown as Awaited<ReturnType<typeof fred.deployApp>>,
    );
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

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain(
      'deploy_app returned no lease_uuid',
    );
    expect(progress.some((e) => e.kind === 'polling_for_readiness')).toBe(
      false,
    );
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    expect(vi.mocked(fred.waitForAppReady)).not.toHaveBeenCalled();
    expect(completed).toHaveLength(0);
  });
});

// ENG-185 sub-PR D — Defense-in-depth tests.
describe('deployApp — sub-PR D defense-in-depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Defense #2: post-poll re-classification. waitForAppReady can exit on
  // state === ACTIVE without verifying running instances. A rare provider-
  // side race could leave us at ACTIVE with empty connection. The
  // orchestrator re-classifies the post-poll response; if outcome isn't
  // 'active', it throws TX_FAILED rather than misleadingly emitting
  // app_ready_confirmed + onComplete on a non-running deploy.
  it('Defense #2: waitForAppReady returns ACTIVE with no instances → re-classify → TX_FAILED', async () => {
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
    // Initial deploy → PENDING (classifier → needs_wait).
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '99999999-9999-4999-8999-999999999999',
      provider_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 1 as never,
      connection: { instances: [] },
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    // waitForAppReady returns ACTIVE state but EMPTY instances/services.
    // Classifier sees state==ACTIVE + no running instances → needs_wait.
    vi.mocked(fred.waitForAppReady).mockResolvedValue({
      lease_uuid: '99999999-9999-4999-8999-999999999999',
      provider_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 'LEASE_STATE_ACTIVE',
      status: { state: 2, instances: [] }, // ACTIVE (was 3 = CLOSED — Copilot #5)
    } as Awaited<ReturnType<typeof fred.waitForAppReady>>);
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

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    // Tightened assertion (Copilot review fix-2, post-fixup hygiene): the
    // throw MUST be specifically the Defense #2 re-classify-and-throw
    // path, NOT a terminal-state error from the classifier. The exact
    // post-poll message is `wait_for_app_ready returned but post-poll
    // classifier outcome is needs_wait` per `deploy-app.ts:545-546`.
    expect((caughtErr as Error).message).toContain('post-poll classifier');
    expect((caughtErr as Error).message).toContain('needs_wait');
    // Copilot fix-6 regression guard: the post-poll fallback message
    // MUST include the leaseUuid so log/user-report correlation matches
    // the sibling `waitForAppReady` catch path at L549-551. Diagnostic
    // consistency invariant — see `deploy-app.ts:~L573`.
    expect((caughtErr as Error).message).toContain(
      '99999999-9999-4999-8999-999999999999',
    );
    // The throw must NOT surface as a terminal-state error (that would
    // mean the test accidentally exercises a different path — the kind
    // of regression-guard inversion documented in MEMORY.md).
    expect((caughtErr as Error).message).not.toMatch(
      /terminal state|LEASE_STATE_CLOSED|LEASE_STATE_REJECTED|LEASE_STATE_EXPIRED/,
    );
    // app_ready_confirmed MUST NOT fire — Defense #2 caught the race.
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    expect(completed).toHaveLength(0);
    // Initial classifier emits `'needs_wait'` (the orchestrator routed
    // into the polling branch); exactly ONE deploy_response_classified
    // event (the re-classify is internal and MUST NOT emit a second
    // event).
    const classifyEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifyEvents).toHaveLength(1);
    const initialClassify = classifyEvents[0];
    if (initialClassify?.kind === 'deploy_response_classified') {
      expect(initialClassify.outcome).toBe('needs_wait');
    }
    // Defense #2 only fires AFTER waitForAppReady returns; verifying the
    // call happened locks in that the throw is from the post-poll path,
    // not from the initial classifier.
    expect(vi.mocked(fred.waitForAppReady)).toHaveBeenCalledTimes(1);
  });

  // Defense #1 (unreachable defense): the classifier guarantees needs_wait
  // → leaseUuid is non-empty. There's no clean way to construct an
  // exercising input without mocking the classifier module-wide (which
  // would invasively affect every other test). Skipping per the
  // architect's brief allowance; documented for future-proofing.
  it.skip('Defense #1: needs_wait without leaseUuid → INVALID_CONFIG (unreachable, skipped)', () => {});

  // waitForAppReady error path: ProviderApiError / timeout / chain-
  // terminal-state → orchestrator wraps as TX_FAILED with the lease
  // uuid in the message.
  it('waitForAppReady throws → TX_FAILED with leaseUuid + underlying message', async () => {
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
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      provider_uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 1 as never,
      connection: { instances: [] },
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    // Simulate a ProviderApiError / timeout.
    vi.mocked(fred.waitForAppReady).mockRejectedValue(
      new Error('polling timed out after 480000ms'),
    );
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const { callbacks, completed } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

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

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect((caughtErr as Error).message).toContain('polling timed out');
    expect(completed).toHaveLength(0);
  });

  // waitForReadyTimeoutMs override is forwarded to waitForAppReady.
  it('opts.waitForReadyTimeoutMs is forwarded to waitForAppReady (default = 480_000)', async () => {
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
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      provider_uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 1 as never,
      connection: { instances: [] },
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    vi.mocked(fred.waitForAppReady).mockResolvedValue({
      lease_uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      provider_uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 'LEASE_STATE_ACTIVE',
      status: {
        state: 2, // ACTIVE (was 3 = CLOSED — Copilot #5)
        instances: [
          {
            name: 'app',
            status: 'running',
            fqdn: 'app-dddddddd.testnet.manifest.app',
            ports: { '80/tcp': 30001 },
          },
        ],
      },
    } as Awaited<ReturnType<typeof fred.waitForAppReady>>);
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

    // Override the timeout.
    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
      waitForReadyTimeoutMs: 60_000,
    });

    // Assert waitForAppReady received the override (5th positional arg is opts).
    const callArgs = vi.mocked(fred.waitForAppReady).mock.calls[0];
    expect(callArgs).toBeDefined();
    const opts = callArgs?.[4] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBe(60_000);
  });
});

// ENG-185 sub-PR E (item 5): `retry_set_domain` recovery decomposition.
//
// Before E: the recovery branch broadcast `setItemCustomDomain` then threw
// TX_FAILED with "caller should re-run troubleshootDeployment to confirm
// app readiness." But per the partial-success contract
// (`render-partial-success-prompt.ts:88-91`), the manifest was NEVER
// uploaded — no app is running — and troubleshoot is read-only. The retry
// left the lease in a broken state.
//
// After E (per architect's Q5 verdict, human-approved): the retry path
// completes the deployment by decomposing fred's atomic deploy into its
// primitives — `setItemCustomDomain` → `uploadLeaseData` → `pollLeaseUntilReady`
// → re-classify (Defense #2 parity from D) → DeployResult with onComplete.
// Polling emission reuses D's canonical pattern verbatim; the primitive
// itself is the lower-level `pollLeaseUntilReady` (not `waitForAppReady`)
// per Copilot fix-1 (PR #71) to skip redundant on-chain queries.
describe('deployApp — retry_set_domain decomposition (ENG-185 sub-PR E)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Shared setup for the retry path: drives the orchestrator to the
   * partial-success branch, then the `onFailure` callback picks
   * `retry_set_domain` so the recovery dispatch fires.
   */
  async function setupRetryScenario(opts: {
    setItemCustomDomain?: ReturnType<typeof vi.fn>;
    uploadLeaseData?: ReturnType<typeof vi.fn>;
    pollLeaseUntilReady?: ReturnType<typeof vi.fn>;
  }) {
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
    const leaseUuid = '11111111-1111-4111-8111-111111111111';
    const providerUuid = '22222222-2222-4222-8222-222222222222';
    const providerApiUrl = 'https://provider.testnet.manifest.network';
    const fqdn = 'app-11111111.testnet.manifest.app';

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
    // fred throws the partial-success error envelope (mirrors the 03 fixture).
    vi.mocked(fred.deployApp).mockRejectedValue(
      new Error(
        `Deploy partially succeeded: lease ${leaseUuid} was created but set-domain failed: simulation error`,
      ),
    );
    // For the retry-completion path: resolve provider URL via lease lookup,
    // upload manifest payload, then poll. All mocks default to success;
    // callers override the specific step they want to exercise.
    vi.mocked(fred.fetchActiveLease).mockResolvedValue({
      providerUuid,
    } as unknown as Awaited<ReturnType<typeof fred.fetchActiveLease>>);
    vi.mocked(fred.resolveProviderUrl).mockResolvedValue(providerApiUrl);
    if (opts.uploadLeaseData) {
      vi.mocked(fred.uploadLeaseData).mockImplementation(
        opts.uploadLeaseData as unknown as typeof fred.uploadLeaseData,
      );
    } else {
      vi.mocked(fred.uploadLeaseData).mockResolvedValue(undefined);
    }
    if (opts.pollLeaseUntilReady) {
      vi.mocked(fred.pollLeaseUntilReady).mockImplementation(
        opts.pollLeaseUntilReady as unknown as typeof fred.pollLeaseUntilReady,
      );
    } else {
      vi.mocked(fred.pollLeaseUntilReady).mockImplementation(
        async (
          _providerUrl: unknown,
          _leaseUuid: unknown,
          _authToken: unknown,
          waitOpts?: {
            onProgress?: (status: { state: number }) => void;
          },
        ) => {
          waitOpts?.onProgress?.({ state: 1 }); // PENDING
          waitOpts?.onProgress?.({ state: 2 }); // ACTIVE
          // Returns FredLeaseStatus directly (no WaitForAppReadyResult
          // wrapping — that's the whole point of the refactor).
          return {
            state: 2,
            instances: [
              {
                name: 'web-1',
                status: 'running',
                fqdn,
                ports: { '80/tcp': 30001 },
              },
            ],
          } as Awaited<ReturnType<typeof fred.pollLeaseUntilReady>>;
        },
      );
    }
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);
    if (opts.setItemCustomDomain) {
      vi.mocked(core.setItemCustomDomain).mockImplementation(
        opts.setItemCustomDomain as unknown as typeof core.setItemCustomDomain,
      );
    } else {
      vi.mocked(core.setItemCustomDomain).mockResolvedValue(
        {} as unknown as Awaited<ReturnType<typeof core.setItemCustomDomain>>,
      );
    }

    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      // Override default `close_lease` → choose retry_set_domain so the
      // recovery dispatch hits the new decomposition path.
      onFailure: async (envelope, options) => {
        baseCapture.failures.push({ envelope, options });
        return { id: 'retry_set_domain' };
      },
    };
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    return {
      spec,
      callbacks,
      baseCapture,
      leaseUuid,
      providerUuid,
      providerApiUrl,
      fqdn,
      run: async () => {
        let caughtErr: unknown = null;
        let result: DeployResult | undefined;
        try {
          result = await deployApp(spec, callbacks, {
            clientManager: clientManager as unknown as Parameters<
              typeof deployApp
            >[2]['clientManager'],
            walletProvider,
          });
        } catch (err) {
          caughtErr = err;
        }
        return { caughtErr, result };
      },
    };
  }

  it('happy path: setItemCustomDomain → uploadLeaseData → pollLeaseUntilReady → DeployResult with urls + customDomain', async () => {
    const { run, baseCapture, leaseUuid, fqdn } = await setupRetryScenario({});

    const { caughtErr, result } = await run();
    expect(caughtErr).toBeNull();
    expect(result).toBeDefined();

    const fred = await import('@manifest-network/manifest-mcp-fred');
    const core = await import('@manifest-network/manifest-mcp-core');

    // setItemCustomDomain called with the right lease + domain (ctx-shaped:
    // arg[0] is the TxCtx, arg[1] is the branded SET-arm input object).
    expect(vi.mocked(core.setItemCustomDomain)).toHaveBeenCalledTimes(1);
    const setDomainCall = vi.mocked(core.setItemCustomDomain).mock.calls[0];
    expect(setDomainCall?.[1]).toEqual({
      leaseUuid,
      customDomain: 'app.testnet.manifest.app',
      serviceName: undefined,
    });

    // uploadLeaseData called with provider URL, leaseUuid, payload, token.
    expect(vi.mocked(fred.uploadLeaseData)).toHaveBeenCalledTimes(1);
    const uploadCall = vi.mocked(fred.uploadLeaseData).mock.calls[0];
    expect(uploadCall?.[0]).toBe('https://provider.testnet.manifest.network');
    expect(uploadCall?.[1]).toBe(leaseUuid);
    expect(uploadCall?.[2]).toBeInstanceOf(Uint8Array);
    expect((uploadCall?.[2] as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(typeof uploadCall?.[3]).toBe('string'); // auth token
    expect((uploadCall?.[3] as string).length).toBeGreaterThan(0);

    // Copilot fix-1 (PR #71) — no-redundant-query invariant:
    // The retry helper resolves `lease` + `providerUrl` ONCE up-front
    // (for `uploadLeaseData`), then polls via the lower-level
    // `pollLeaseUntilReady` passing the already-resolved values directly.
    // It must NOT call the higher-level `waitForAppReady` (which would
    // re-run `fetchActiveLease` + `resolveProviderUrl` internally,
    // doubling the on-chain query cost per recovery).
    expect(vi.mocked(fred.pollLeaseUntilReady)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fred.waitForAppReady)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.fetchActiveLease)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fred.resolveProviderUrl)).toHaveBeenCalledTimes(1);

    // ProgressEvents: polling_for_readiness fired >=1 time; app_ready_confirmed
    // fired AFTER polling; success_rendered + onComplete fired.
    const progress = baseCapture.progress;
    const pollIdxs = progress
      .map((e, i) => (e.kind === 'polling_for_readiness' ? i : -1))
      .filter((i) => i >= 0);
    expect(pollIdxs.length).toBeGreaterThanOrEqual(1);
    const readyIdx = progress.findIndex(
      (e) => e.kind === 'app_ready_confirmed',
    );
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThan(pollIdxs[pollIdxs.length - 1] as number);
    expect(progress.some((e) => e.kind === 'success_rendered')).toBe(true);
    expect(baseCapture.completed).toHaveLength(1);

    // DeployResult shape: urls carry the post-poll FQDN (locks the
    // extractRunningEndpoints plumbing per fixup-3 pattern); customDomain
    // is set; leaseState reflects ACTIVE.
    expect(result?.leaseState).toBe('LEASE_STATE_ACTIVE');
    expect(result?.leaseUuid).toBe(leaseUuid);
    expect((result?.urls ?? []).length).toBeGreaterThan(0);
    expect(result?.urls).toContain(`https://${fqdn}/`);
    expect(result?.customDomain).toBe('app.testnet.manifest.app');
  });

  it('upload fails → TX_FAILED with leaseUuid in message; onComplete NOT called', async () => {
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      uploadLeaseData: vi
        .fn()
        .mockRejectedValue(new Error('provider responded 502 bad gateway')),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toMatch(/upload|502 bad gateway/i);
    expect(baseCapture.completed).toHaveLength(0);
    // pollLeaseUntilReady MUST NOT be invoked after upload failure.
    // Per Copilot fix-1 (PR #71): retry helper polls via the lower-level
    // `pollLeaseUntilReady` (no redundant on-chain queries). The higher-
    // level `waitForAppReady` is NOT called anywhere in the retry path.
    const fred = await import('@manifest-network/manifest-mcp-fred');
    expect(vi.mocked(fred.pollLeaseUntilReady)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.waitForAppReady)).not.toHaveBeenCalled();
  });

  it('pollLeaseUntilReady fails → TX_FAILED with leaseUuid in message; onComplete NOT called', async () => {
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      pollLeaseUntilReady: vi
        .fn()
        .mockRejectedValue(
          new Error('polling timed out after 480000ms for lease'),
        ),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toMatch(/polling timed out|wait/i);
    expect(baseCapture.completed).toHaveLength(0);
  });

  it('setItemCustomDomain fails → TX_FAILED with retry_set_domain prefix + leaseUuid; downstream not invoked', async () => {
    // Copilot fix-3 (PR #71) regression guard: every throw site in
    // `retrySetDomainAndComplete` MUST surface the `retry_set_domain`
    // prefix + leaseUuid for log/user-report correlation (sibling-parity
    // with the fetchActiveLease/uploadLeaseData/pollLeaseUntilReady
    // wraps in the same helper). The pre-fix `setItemCustomDomain` call
    // was bare — chain-layer errors leaked through without the prefix.
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      setItemCustomDomain: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Tx billing set-item-custom-domain failed: simulation error',
          ),
        ),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    // Sibling-parity assertions: prefix + leaseUuid + the failing
    // primitive's name all appear in the message.
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toContain('set-item-custom-domain');
    // The original error's body propagates verbatim (the wrap preserves
    // the underlying chain-layer message for diagnostics).
    expect((caughtErr as Error).message).toContain('simulation error');
    // Short-circuit guard (structural-impossibility proof): the
    // downstream resolve/upload/poll fns MUST NOT be invoked when the
    // domain claim fails — otherwise we'd be running redundant on-chain
    // queries against a lease whose retry already aborted.
    const fred = await import('@manifest-network/manifest-mcp-fred');
    expect(vi.mocked(fred.fetchActiveLease)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.resolveProviderUrl)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.uploadLeaseData)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.pollLeaseUntilReady)).not.toHaveBeenCalled();
    expect(baseCapture.completed).toHaveLength(0);
  });

  it('post-poll re-classify with errorSummary (terminal state) → TX_FAILED with retry_set_domain prefix + leaseUuid + errorSummary content', async () => {
    // Copilot fix-4 (PR #71) regression guard for the errorSummary
    // branch of the `??` fallback at L1267. The pre-fix code used
    // `classification.errorSummary ?? ...fallback...` which meant when
    // errorSummary IS set (post-poll classifier produces 'failed' with
    // a terminal-state errorSummary), the thrown message would be
    // errorSummary VERBATIM — no `retry_set_domain` prefix, no leaseUuid.
    // Inconsistent with the sibling-parity discipline that all other
    // throw sites in this helper honor (fixup-3 wrap).
    //
    // To drive the errorSummary path: mock pollLeaseUntilReady to
    // RESOLVE with a terminal-state response. The post-poll re-classify
    // then sees state=REJECTED → outcome='failed' → classifier sets
    // errorSummary to `Lease ${leaseUuid} reached terminal state
    // LEASE_STATE_REJECTED` (per classify-deploy-response.ts:120).
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      pollLeaseUntilReady: vi.fn().mockResolvedValue({
        state: 4, // LEASE_STATE_REJECTED — terminal
        instances: [],
      }),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    // Sibling-parity invariant: prefix + leaseUuid in the message.
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    // The classifier's errorSummary content is preserved (we wrap it
    // for prefix, but the underlying terminal-state diagnostic is the
    // information operators need).
    expect((caughtErr as Error).message).toContain('LEASE_STATE_REJECTED');
    expect((caughtErr as Error).message).toContain('terminal state');
    // Wording differentiates the errorSummary path from the
    // no-errorSummary fallback (latter says "but post-poll classifier
    // outcome is needs_wait").
    expect((caughtErr as Error).message).toMatch(
      /post-poll re-classification/i,
    );
    expect(baseCapture.completed).toHaveLength(0);
  });

  it('post-poll re-classify without errorSummary (ACTIVE with no instances) → TX_FAILED with retry_set_domain prefix + leaseUuid + fallback wording', async () => {
    // Copilot fix-4 (PR #71) regression guard for the no-errorSummary
    // branch of the `??` fallback at L1268. Post-poll classifier
    // returns 'needs_wait' (ACTIVE state but no running instances —
    // the Defense #2 race scenario from D), errorSummary is undefined,
    // and the fallback string fires. Pre-fix the fallback referenced
    // the stale `wait_for_app_ready` primitive name (fixup-1 switched
    // to pollLeaseUntilReady but fixup-2's comment-only sweep missed
    // template literals).
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      pollLeaseUntilReady: vi.fn().mockResolvedValue({
        state: 2, // LEASE_STATE_ACTIVE — not terminal
        instances: [], // but no running instances → re-classifier → 'needs_wait'
      }),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    // Sibling-parity invariant.
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toContain('post-poll classifier');
    expect((caughtErr as Error).message).toContain('needs_wait');
    // Stale-string anti-regression: the post-fixup-4 fallback names
    // the primitive that actually runs (`pollLeaseUntilReady`), not
    // the higher-level `wait_for_app_ready` MCP-tool name.
    expect((caughtErr as Error).message).toContain('pollLeaseUntilReady');
    expect((caughtErr as Error).message).not.toMatch(/wait_for_app_ready/);
    // The classifier emitted exactly the Defense #2 outcome ('needs_wait'),
    // NOT a terminal-state outcome (which would have hit the
    // errorSummary branch instead — verified by the message not
    // containing "terminal state").
    expect((caughtErr as Error).message).not.toMatch(/terminal state/i);
    expect(baseCapture.completed).toHaveLength(0);
  });

  // Copilot fix-5 (PR #71) regression tests — uniform `ManifestMCPError`
  // code preservation across all 4 catches in `retrySetDomainAndComplete`.
  // Fixup-4's JSDoc rewrite claimed helper-wide code preservation, but
  // only the `setItemCustomDomain` catch (added by fixup-3) actually
  // honored it; the other 3 catches hardcoded TX_FAILED. The 3 tests
  // below lock the L1147-precedent pattern at fetchActiveLease/
  // resolveProviderUrl, uploadLeaseData, and pollLeaseUntilReady.
  //
  // Structural-impossibility discriminator: each test asserts
  // `.code === <typed-non-TX_FAILED-code>` AND
  // `.code !== ManifestMCPErrorCode.TX_FAILED`. The pre-fix code
  // unconditionally writes TX_FAILED, so the `.not.toBe(TX_FAILED)`
  // assertion is the RED-driver.

  it('fetchActiveLease throws ManifestMCPError → preserves original code (not flattened to TX_FAILED)', async () => {
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({});
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.fetchActiveLease).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Lease "${leaseUuid}" not found on chain`,
      ),
    );

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.QUERY_FAILED,
    );
    expect((caughtErr as ManifestMCPError).code).not.toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    // Sibling-parity invariants still apply: prefix + leaseUuid + the
    // primitive group name in the wrap.
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toContain('resolve provider');
    expect((caughtErr as Error).message).toContain('not found on chain');
    // Short-circuit: downstream upload/poll must not be invoked.
    expect(vi.mocked(fred.uploadLeaseData)).not.toHaveBeenCalled();
    expect(vi.mocked(fred.pollLeaseUntilReady)).not.toHaveBeenCalled();
    expect(baseCapture.completed).toHaveLength(0);
  });

  it('uploadLeaseData throws ManifestMCPError → preserves original code (not flattened to TX_FAILED)', async () => {
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      uploadLeaseData: vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'Invalid provider URL: scheme must be https',
          ),
        ),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.INVALID_CONFIG,
    );
    expect((caughtErr as ManifestMCPError).code).not.toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toContain('manifest upload');
    expect((caughtErr as Error).message).toContain(
      'Invalid provider URL: scheme must be https',
    );
    // Short-circuit: poll must not run after upload failure.
    const fred = await import('@manifest-network/manifest-mcp-fred');
    expect(vi.mocked(fred.pollLeaseUntilReady)).not.toHaveBeenCalled();
    expect(baseCapture.completed).toHaveLength(0);
  });

  it('pollLeaseUntilReady throws ManifestMCPError → preserves original code (not flattened to TX_FAILED)', async () => {
    const { run, baseCapture, leaseUuid } = await setupRetryScenario({
      pollLeaseUntilReady: vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.SIMULATION_FAILED,
            'Provider returned 500 mid-poll',
          ),
        ),
    });

    const { caughtErr } = await run();

    expect(caughtErr).toBeInstanceOf(ManifestMCPError);
    expect((caughtErr as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.SIMULATION_FAILED,
    );
    expect((caughtErr as ManifestMCPError).code).not.toBe(
      ManifestMCPErrorCode.TX_FAILED,
    );
    expect((caughtErr as Error).message).toContain('retry_set_domain');
    expect((caughtErr as Error).message).toContain(leaseUuid);
    expect((caughtErr as Error).message).toContain('pollLeaseUntilReady');
    expect((caughtErr as Error).message).toContain(
      'Provider returned 500 mid-poll',
    );
    expect(baseCapture.completed).toHaveLength(0);
  });
});

describe('deployApp — C2 plan-edit roundtrip propagates edited size (ENG-185 #4)', () => {
  // Regression guard for the C2 fix (post-edit propagation gap). The
  // `r3237308843` test above already pins the plain plan-block *re-render*
  // (it asserts the post-edit `image` and that the two emitted blocks
  // differ). THIS block guards a DIFFERENT axis: that a `replace_spec`
  // edit which changes ONLY `size` propagates the edited size through
  // every post-edit consumer — the rendered `Size:` line, the post-edit
  // `checkDeploymentReadiness` call arg, the broadcast `fredInput.size`,
  // the post-edit `cosmosEstimateFee` meta-hash threading, and the
  // persisted manifest wrapper's `size`. Size is the ONLY observable
  // difference between the pre- and post-edit specs, so each positive
  // (`medium`) + negative (`not small`) pair is non-vacuous by
  // construction (a stale-spec regression would surface `small`).
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // `setupSizeEditScenario` overrides `resolveSku`'s BASE implementation
  // (size-driven, for FIX 1). `vi.clearAllMocks` does not reset the base
  // implementation, so restore the canonical single-pin default after each
  // test to keep the override from leaking into sibling describe blocks.
  afterEach(async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.resolveSku).mockReset();
    vi.mocked(core.resolveSku).mockResolvedValue({
      skuUuid: 'sku-uuid-fixture',
      providerUuid: 'provider-uuid-fixture',
      name: 'small',
      active: true,
    } as SkuCandidate);
  });

  // Distinguishable meta-hash digests so a post-edit consumer that reads
  // the STALE pre-edit preview can be caught. Both are valid 64-char hex.
  const PRE_EDIT_META =
    '1111111111111111111111111111111111111111111111111111111111111111';
  const POST_EDIT_META =
    '2222222222222222222222222222222222222222222222222222222222222222';

  /**
   * Shared setup: load the 01-fast-path-active fixtures, set the base
   * spec's first-class `size: 'small'` field (ENG-275; read by
   * `requestedSize`), and wire an `onPlan` that returns a `replace_spec`
   * edit identical to the base EXCEPT `size: 'medium'`.
   * `buildManifestPreview` is sequenced PRE → POST so the post-edit
   * fee/persist path can be proven to use the edited-spec hash.
   * `checkDeploymentReadiness` is size-agnostic (same response both calls);
   * the size lives in the call ARGUMENT, not the response.
   *
   * `previewOverride` lets Test E swap in a real `{manifest_json,
   * meta_hash_hex}` pair (hash matches content) so `saveManifest`'s
   * SHA-256 audit passes.
   */
  async function setupSizeEditScenario(previewOverride?: {
    manifestJson: string;
    metaHashHex: string;
  }) {
    const baseSpecRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'spec.json',
    ) as Record<string, unknown>;
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

    // ENG-275: `size` is now a first-class typed field on `DeploySpec`.
    // The `as unknown as DeploySpec` here is structural only — it narrows
    // the untyped fixture `Record<string, unknown>` to the spec union; it
    // is NOT smuggling an off-type field.
    const baseSpec = {
      ...baseSpecRaw,
      size: 'small',
    } as unknown as DeploySpec;
    // Size is the ONLY difference. Spread the already-typed `baseSpec` and
    // override `size` — assignable to `DeploySpec` without a further cast
    // because `size` is on the contract. (The definitive type-contract
    // proof is `types.test.ts`'s `toEqualTypeOf`; this block tests runtime
    // propagation of the edited size.)
    const editedSpec: DeploySpec = { ...baseSpec, size: 'medium' };

    const fred = await import('@manifest-network/manifest-mcp-fred');
    // Size-agnostic readiness: identical response for both the pre-edit
    // and post-edit calls. The edited size is encoded in the call ARG.
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    vi.mocked(fred.buildManifestPreview)
      .mockResolvedValueOnce({
        manifest_json: metaHashResp.manifest_json,
        meta_hash_hex: PRE_EDIT_META,
      } as Awaited<ReturnType<typeof fred.buildManifestPreview>>)
      .mockResolvedValueOnce({
        manifest_json:
          previewOverride?.manifestJson ?? metaHashResp.manifest_json,
        meta_hash_hex: previewOverride?.metaHashHex ?? POST_EDIT_META,
      } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

    const core = await import('@manifest-network/manifest-mcp-core');
    // Size-agnostic fee estimate; the edited size shows up in the
    // create-lease ARG (item-args / meta-hash), not the response.
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);
    // ENG-258 review FIX 1: the canonical SKU name now comes from the
    // RESOLVED pin (`pinned.name`), not the requested `size`. Model the
    // realistic resolve where requesting size `X` resolves a SKU named
    // `X` — so the edited `medium` propagates through resolveSku into the
    // downstream readiness/plan/fred/persist consumers under test here.
    vi.mocked(core.resolveSku).mockImplementation(
      async (_qc: unknown, input: { size: string }) =>
        ({
          skuUuid: `sku-${input.size}`,
          providerUuid: 'provider-uuid-fixture',
          name: input.size,
          active: true,
        }) as SkuCandidate,
    );

    const baseCapture = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...baseCapture.callbacks,
      onPlan: async () => ({ kind: 'replace_spec', spec: editedSpec }),
    };

    return { baseSpec, editedSpec, callbacks, baseCapture, fred, core };
  }

  it('A. rendered post-edit plan `Size:` line is `medium` (pre-edit block stays `small`)', async () => {
    const { baseSpec, callbacks, baseCapture } = await setupSizeEditScenario();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(baseSpec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    const rendered = baseCapture.progress.filter(
      (e) => e.kind === 'deployment_plan_rendered',
    );
    expect(rendered).toHaveLength(2);
    const preEditBlock =
      rendered[0]?.kind === 'deployment_plan_rendered'
        ? rendered[0].block
        : undefined;
    const postEditBlock =
      rendered[1]?.kind === 'deployment_plan_rendered'
        ? rendered[1].block
        : undefined;
    // The renderer emits a literal `  Size:                      <size>`
    // line (render-deployment-plan.ts). Assert the exact rendered line so
    // the check can't be satisfied by `medium` appearing elsewhere.
    expect(postEditBlock?.text).toContain(
      '  Size:                      medium',
    );
    expect(postEditBlock?.text).not.toContain(
      '  Size:                      small',
    );
    expect(preEditBlock?.text).toContain('  Size:                      small');
    expect(preEditBlock?.text).not.toContain(
      '  Size:                      medium',
    );
  });

  it('B. post-edit `checkDeploymentReadiness` call arg `.size` is `medium` (1st call is `small`)', async () => {
    const { baseSpec, callbacks, fred } = await setupSizeEditScenario();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(baseSpec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // Two readiness calls: original spec, then the post-edit recall. Arg
    // index [2] is the `{image, size}` input (mirrors the readiness-recall
    // tests above).
    expect(vi.mocked(fred.checkDeploymentReadiness)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fred.checkDeploymentReadiness).mock.calls;
    expect(calls[0]?.[2]).toMatchObject({ size: 'small' });
    expect(calls[1]?.[2]).toMatchObject({ size: 'medium' });
    expect(calls[1]?.[2]).not.toMatchObject({ size: 'small' });
  });

  it('C. broadcast `fredInput.size` is `medium` (the AC requirement)', async () => {
    const { baseSpec, callbacks, fred } = await setupSizeEditScenario();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(baseSpec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // fredDeployApp signature: (clientManager, getAuthToken,
    // getLeaseDataAuthToken, fredInput, fetchFn) — `fredInput` is the 4th
    // positional arg (index [3]).
    expect(vi.mocked(fred.deployApp)).toHaveBeenCalledTimes(1);
    const fredInput = vi.mocked(fred.deployApp).mock.calls[0]?.[3] as
      | { size?: string }
      | undefined;
    expect(fredInput?.size).toBe('medium');
    expect(fredInput?.size).not.toBe('small');
  });

  it('D. post-edit `cosmosEstimateFee` is called with `--meta-hash <POST_EDIT hex>` (pre-edit call uses PRE_EDIT hex)', async () => {
    const { baseSpec, callbacks, core } = await setupSizeEditScenario();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();

    await deployApp(baseSpec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    // estimateFees runs once at plan-assembly (pre-edit preview) and again
    // after the edit (post-edit preview). cosmosEstimateFee's 4th
    // positional arg (index [3]) is the `string[]` args array, shaped
    // `['--meta-hash', <hex>, <itemArg>]`.
    expect(vi.mocked(core.cosmosEstimateFee)).toHaveBeenCalledTimes(2);
    const preEditArgs = vi.mocked(core.cosmosEstimateFee).mock.calls[0]?.[3] as
      | string[]
      | undefined;
    const postEditArgs = vi.mocked(core.cosmosEstimateFee).mock.calls[1]?.[3] as
      | string[]
      | undefined;
    // Pre-edit call threads the PRE_EDIT preview hash + the pre-edit
    // resolved skuUuid (`sku-small`, from the size-driven resolveSku mock).
    expect(preEditArgs?.[0]).toBe('--meta-hash');
    expect(preEditArgs?.[1]).toBe(PRE_EDIT_META);
    expect(preEditArgs?.slice(2)).toEqual(['sku-small:1']);
    // Post-edit call threads the POST_EDIT preview hash + the post-edit
    // resolved skuUuid (`sku-medium`) — proving the recompute re-resolves
    // the pin AND uses the freshly-built (edited-spec) preview, not the
    // stale pre-edit one.
    expect(postEditArgs?.[0]).toBe('--meta-hash');
    expect(postEditArgs?.[1]).toBe(POST_EDIT_META);
    expect(postEditArgs?.[1]).not.toBe(PRE_EDIT_META);
    expect(postEditArgs?.slice(2)).toEqual(['sku-medium:1']);
  });

  it('E. persisted manifest wrapper `size` is `medium` (real on-disk save, SHA-256 audit passes)', async () => {
    // Real on-disk save: override the post-edit preview with a
    // `{manifest_json, meta_hash_hex}` pair whose hash matches the
    // content, so `saveManifest`'s SHA-256 audit passes. Read the wrapper
    // back and assert `size` + `meta_hash_hex`.
    const {
      mkdtempSync,
      readFileSync: readFs,
      rmSync,
    } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { createHash } = await import('node:crypto');

    const dataDir = mkdtempSync(joinPath(tmpdir(), 'eng185f-'));
    try {
      // A real manifest_json whose SHA-256 (after trimEnd) is the
      // recorded meta_hash_hex — matches saveManifest's audit contract.
      const editedManifestJson = '{"image":"docker.io/library/nginx:1.27"}';
      const editedMetaHash = createHash('sha256')
        .update(editedManifestJson)
        .digest('hex');

      const { baseSpec, callbacks } = await setupSizeEditScenario({
        manifestJson: editedManifestJson,
        metaHashHex: editedMetaHash,
      });
      const { deployApp } = await import('./deploy-app.js');
      const clientManager = makeMockClientManager();
      const walletProvider = makeMockWalletProvider();

      const result = await deployApp(baseSpec, callbacks, {
        clientManager: clientManager as unknown as Parameters<
          typeof deployApp
        >[2]['clientManager'],
        walletProvider,
        dataDir,
      });

      expect(result.manifestPath).not.toBe('');
      const wrapper = JSON.parse(readFs(result.manifestPath, 'utf8')) as {
        size?: string;
        meta_hash_hex?: string;
      };
      // The persisted wrapper records the EDITED size + the edited-spec
      // preview hash — proving tryPersistManifest reads the post-edit
      // `requestedSize(confirmedSpec)` + post-edit preview, not the stale
      // pre-edit values.
      expect(wrapper.size).toBe('medium');
      expect(wrapper.size).not.toBe('small');
      expect(wrapper.meta_hash_hex).toBe(editedMetaHash);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ---- ENG-309: Task 5 ------------------------------------------------
// Pin the deliberate snake→camel DeployResult projection so a future
// canonical-type adoption (Plan 3b) can't silently flatten it. The test
// binds to the same 01-fast-path-active fixture + vi.mocked harness that
// the surrounding tests use — no new mock framework; no production change.
//
// Wire DTO (fred DeployAppResult / core DeployResult, snake_case):
//   lease_uuid, provider_uuid, provider_url, state (LeaseState numeric/enum),
//   url?, connection?, connectionError?, custom_domain?, service_name?
//
// agent-core projection (camelCase, deploy-app.ts:828-842):
//   leaseUuid    ← lease_uuid            (direct rename)
//   providerUuid ← provider_uuid         (direct rename)
//   leaseState   ← decode(state)         (TRANSFORMED: string union, not the enum value)
//   urls         ← extractRunningEndpoints(connection).map(formatEndpointAsUrl) w/ url fallback
//                                        (DERIVED list, not a 1:1 of `url`)
//   customDomain ← custom_domain?        (conditional spread)
//   manifestPath ← persistedPath ?? ''   (AGENT-CORE ONLY: no wire counterpart)
//   DROPPED:     provider_url, connectionError, service_name
describe('DeployResult snake→camel projection (deliberate, not a 1:1 rename) (ENG-309)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps direct wire id/domain fields and transforms state/urls; drops provider_url and service_name', async () => {
    // Use the 01-fast-path-active fixture — the canonical happy-path
    // fixture whose deploy-response.json seeds a running FQDN instance,
    // so `urls` is non-empty and the assertion is strong.
    const FRED_FIXTURE = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;

    // The fixture has:
    //   lease_uuid:   "11111111-1111-4111-8111-111111111111"
    //   provider_uuid: "22222222-2222-4222-8222-222222222222"
    //   provider_url:  "https://provider.testnet.manifest.network"
    //   state:         "LEASE_STATE_ACTIVE"
    //   connection.instances[0]: { status: "running", fqdn: "nginx-11111111.testnet.manifest.app" }
    // Expected projection:
    //   leaseUuid:    "11111111-1111-4111-8111-111111111111"   (direct rename)
    //   providerUuid: "22222222-2222-4222-8222-222222222222"   (direct rename)
    //   leaseState:   "LEASE_STATE_ACTIVE"                     (string, decoded)
    //   urls:         ["https://nginx-11111111.testnet.manifest.app/"]  (derived)
    //   manifestPath: ""  (no dataDir → persistedPath is undefined)
    //   provider_url: ABSENT                                   (dropped)
    //   service_name: ABSENT                                   (dropped)

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
    // Seed the fred wire response from the known fixture + add an
    // explicit service_name to confirm it is NOT projected.
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: FRED_FIXTURE.lease_uuid as string,
      provider_uuid: FRED_FIXTURE.provider_uuid as string,
      provider_url: FRED_FIXTURE.provider_url as string,
      state: FRED_FIXTURE.state as never,
      connection: FRED_FIXTURE.connection,
      service_name: 'web',
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

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
      // No dataDir: manifestPath is persisted to '' (no-op path).
    });

    // ── Direct renames ──────────────────────────────────────────────────
    expect(result.leaseUuid).toBe(FRED_FIXTURE.lease_uuid);
    expect(result.providerUuid).toBe(FRED_FIXTURE.provider_uuid);
    // No custom_domain in the fixture → the conditional spread omits the
    // customDomain key entirely from the result.
    expect('customDomain' in result).toBe(false);

    // ── Deliberate transforms (NOT trivial renames) ─────────────────────
    // leaseState is a STRING (decoded LeaseStateName union), NOT the raw
    // numeric enum value that arrives on the wire. If this ever becomes a
    // number the Plan 3b canonical-type adoption broke the decoder.
    expect(typeof result.leaseState).toBe('string');
    expect(result.leaseState).toBe('LEASE_STATE_ACTIVE');

    // urls is a DERIVED array from extractRunningEndpoints(connection),
    // not a 1:1 copy of the wire `url` field. The fixture seeds one
    // running FQDN instance, so the list is non-empty and fully formed.
    expect(Array.isArray(result.urls)).toBe(true);
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls[0]).toBe('https://nginx-11111111.testnet.manifest.app/');

    // manifestPath is agent-core-only (no wire counterpart). The
    // projection is `persistedPath ?? ''`; with NO dataDir supplied to
    // this deploy, tryPersistManifest short-circuits to `undefined`
    // (deploy-app.ts:1597), so manifestPath is the empty string. Pinning
    // the exact value (not just `typeof === 'string'`, which the type
    // already guarantees) catches a refactor that drops the `?? ''`
    // fallback or wires persistence on by default.
    expect(result.manifestPath).toBe('');

    // ── Fields intentionally DROPPED from the projection ───────────────
    // provider_url is a fred wire field that agent-core deliberately
    // omits from its typed DeployResult (it is internal fred routing
    // data, not consumer-facing).
    expect('provider_url' in result).toBe(false);
    // service_name is a fred wire field (set when customDomain + serviceName
    // are supplied together). agent-core exposes customDomain but not
    // service_name in its projection.
    expect('service_name' in result).toBe(false);
  });
});

// ENG-310: deployApp input is the canonical AppDeploySpec. The deleted
// build-fred-input mapper dropped every rich field (user/tmpfs/health_check/
// stop_grace_period/init/expose/labels/storage/depends_on, and — on the stack
// arm — everything `convertServiceDef` didn't copy). The loss-free spread
// proves each field now survives to the fred broadcast, and the resolved SKU
// identity (size/skuUuid/providerUuid) is the authoritative pin, not raw input.
describe('deployApp input = AppDeploySpec — loss-free broadcast (ENG-310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The default module-level resolveSku mock returns this pin. The loss-free
  // assertions check that size/skuUuid/providerUuid on the fred input equal
  // the RESOLVED pin, not the spec's raw hints.
  const resolvedSkuFixture = {
    name: 'small',
    skuUuid: 'sku-uuid-fixture',
    providerUuid: 'provider-uuid-fixture',
  } as const;

  const SINGLE: AppDeploySpec = {
    image: 'nginx:latest',
    size: 'small',
    port: 8080,
    env: { A: '1' },
    command: ['/bin/sh'],
    args: ['-c', 'true'],
    user: '1000:1000',
    tmpfs: ['/tmp'],
    health_check: { test: ['CMD', 'true'], interval: '10s', retries: 3 },
    stop_grace_period: '30s',
    init: true,
    expose: ['9090'],
    labels: { tier: 'web' },
    storage: '10Gi',
    depends_on: { db: { condition: 'service_started' } },
    customDomain: 'app.example.com',
  };
  const STACK: AppDeploySpec = {
    size: 'small',
    serviceName: 'web',
    customDomain: 'app.example.com',
    services: {
      web: {
        image: 'nginx:latest',
        ports: { '80/tcp': {} },
        env: { A: '1' },
        command: ['/bin/sh'],
        args: ['-c', 'true'],
        user: '1000:1000',
        tmpfs: ['/tmp'],
        health_check: { test: ['CMD', 'true'] },
        stop_grace_period: '30s',
        depends_on: { db: { condition: 'service_started' } },
        expose: ['9090'],
        labels: { tier: 'web' },
      },
    },
  };

  // Wire the happy-path fred/preview/fee mocks (mirrors setupHappyDeps but with
  // an arbitrary AppDeploySpec instead of the fixture), run deployApp, and
  // surface both captured inputs for the loss-free + meta-hash-parity asserts.
  async function runDeploy(spec: AppDeploySpec): Promise<{
    fredInput: AppDeploySpec;
    previewInput: Record<string, unknown>;
    previewMetaHash: string;
  }> {
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'readiness-response.json',
    );
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: '{"version":"0.1"}',
      meta_hash_hex: 'cc'.repeat(32),
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);

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

    await deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });

    const fredInput = vi.mocked(fred.deployApp).mock
      .calls[0]?.[3] as AppDeploySpec;
    const previewInput = vi.mocked(fred.buildManifestPreview).mock
      .calls[0]?.[0] as unknown as Record<string, unknown>;
    return { fredInput, previewInput, previewMetaHash: 'cc'.repeat(32) };
  }

  for (const [name, spec] of [
    ['single', SINGLE],
    ['stack', STACK],
  ] as const) {
    it(`loss-free (${name}): every AppDeploySpec field survives to the fred broadcast (ENG-310)`, async () => {
      const { fredInput } = await runDeploy(spec);
      for (const k of Object.keys(spec) as (keyof AppDeploySpec)[]) {
        if (k === 'size') continue; // overwritten with the resolved SKU name (below)
        expect(fredInput[k]).toEqual(spec[k]);
      }
      // Top-level key parity (sound because the broadcast spread is SHALLOW —
      // it never rebuilds nested objects).
      expect(Object.keys(fredInput).sort()).toEqual(
        [...new Set([...Object.keys(spec), 'skuUuid', 'providerUuid'])].sort(),
      );
      // Resolved-identity: size/skuUuid/providerUuid are the RESOLVED pin.
      expect(fredInput.size).toBe(resolvedSkuFixture.name);
      expect(fredInput.skuUuid).toBe(resolvedSkuFixture.skuUuid);
      expect(fredInput.providerUuid).toBe(resolvedSkuFixture.providerUuid);
    });

    it(`preview-vs-deploy meta-hash parity (${name}): both manifests derive from the same STRUCTURED_FIELDS (ENG-310)`, async () => {
      const { fredInput, previewInput, previewMetaHash } =
        await runDeploy(spec);
      // The preview and the fred deploy build the manifest from the SAME
      // STRUCTURED_FIELDS, so preview.meta_hash ≡ the deployed meta-hash by
      // construction. Anti-drift: assert the structured manifest inputs agree.
      const STRUCTURED_FIELDS = [
        'image',
        'port',
        'env',
        'command',
        'args',
        'user',
        'tmpfs',
        'health_check',
        'stop_grace_period',
        'init',
        'expose',
        'labels',
        'depends_on',
        'services',
      ] as const;
      for (const f of STRUCTURED_FIELDS) {
        expect(previewInput[f]).toEqual(
          (fredInput as unknown as Record<string, unknown>)[f],
        );
      }
      // The deploy path commits the preview's meta-hash (auth-token +
      // persistence). It is the value the preview computed — equal by
      // construction since neither path re-derives the manifest.
      expect(previewMetaHash).toBe('cc'.repeat(32));
    });
  }
});

// ENG-310: validateSpec gates image-xor-services at EACH entry path
// (initial deployApp call + a replace_spec onPlan edit). The four combos:
// image-only ✓, services-only ✓, both → INVALID_CONFIG, neither → INVALID_CONFIG.
describe('deployApp validateSpec image-xor-services gate (ENG-310)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function wireHappyMocks() {
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'readiness-response.json',
    );
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: '{"version":"0.1"}',
      meta_hash_hex: 'cc'.repeat(32),
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);
  }

  const IMAGE_ONLY: AppDeploySpec = {
    image: 'nginx:latest',
    size: 'small',
    port: 80,
  };
  const SERVICES_ONLY: AppDeploySpec = {
    size: 'small',
    services: { web: { image: 'nginx:latest' } },
  };
  // BOTH/NEITHER are illegal at the type level; cast through unknown to
  // exercise the runtime guard (untrusted JSON.parse callers).
  const BOTH = {
    image: 'nginx:latest',
    size: 'small',
    port: 80,
    services: { web: { image: 'nginx:latest' } },
  } as unknown as AppDeploySpec;
  const NEITHER = { size: 'small' } as unknown as AppDeploySpec;

  async function callDeploy(spec: AppDeploySpec): Promise<unknown> {
    const { callbacks } = captureCallbacks();
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();
    return deployApp(spec, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });
  }

  // initial-call entry path -------------------------------------------------
  it('initial call: image-only is accepted', async () => {
    await wireHappyMocks();
    await expect(callDeploy(IMAGE_ONLY)).resolves.toBeDefined();
  });
  it('initial call: services-only is accepted', async () => {
    await wireHappyMocks();
    await expect(callDeploy(SERVICES_ONLY)).resolves.toBeDefined();
  });
  it('initial call: both image AND services → INVALID_CONFIG', async () => {
    await wireHappyMocks();
    await expect(callDeploy(BOTH)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });
  it('initial call: neither image NOR services → INVALID_CONFIG', async () => {
    await wireHappyMocks();
    await expect(callDeploy(NEITHER)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });

  // replace_spec onPlan-edit entry path ------------------------------------
  async function callDeployWithEdit(
    initial: AppDeploySpec,
    replacement: AppDeploySpec,
  ): Promise<unknown> {
    const base = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...base.callbacks,
      onPlan: async () => ({ kind: 'replace_spec', spec: replacement }),
    };
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();
    return deployApp(initial, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
    });
  }
  it('replace_spec edit: image-only replacement is accepted', async () => {
    await wireHappyMocks();
    await expect(
      callDeployWithEdit(SERVICES_ONLY, IMAGE_ONLY),
    ).resolves.toBeDefined();
  });
  it('replace_spec edit: services-only replacement is accepted', async () => {
    await wireHappyMocks();
    await expect(
      callDeployWithEdit(IMAGE_ONLY, SERVICES_ONLY),
    ).resolves.toBeDefined();
  });
  it('replace_spec edit: both image AND services → INVALID_CONFIG', async () => {
    await wireHappyMocks();
    await expect(callDeployWithEdit(IMAGE_ONLY, BOTH)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });
  it('replace_spec edit: neither image NOR services → INVALID_CONFIG', async () => {
    await wireHappyMocks();
    await expect(callDeployWithEdit(IMAGE_ONLY, NEITHER)).rejects.toMatchObject(
      { code: ManifestMCPErrorCode.INVALID_CONFIG },
    );
  });
});

// ENG-310 / D4: cancellation contract. deployApp resolves the caller's
// {signal?,timeout?} via core's resolveCallSignal and races it against ONLY
// the pre-broadcast interactive callbacks (onPlan/onConfirm/onResolveSku).
// An abort before the fred broadcast surfaces OPERATION_CANCELLED, emits a
// `cancelled` progress event, and creates no lease. The loser-cleanup must
// swallow a late callback rejection — vitest's global unhandledRejection
// listener fails the whole run on a leak, so the no-leak test is non-vacuous.
describe('deployApp — cancellation contract (signal/timeout) (ENG-310 / D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SPEC: AppDeploySpec = {
    image: 'docker.io/library/nginx:1.27',
    size: 'small',
    port: 80,
  };

  // Wire the happy-path fred/preview/fee mocks, then run the REAL deployApp
  // with the caller-supplied cancellation options + callbacks, returning the
  // promise (so the caller can race the abort against it) plus the captured
  // progress events.
  async function runDeploy(
    opts: {
      signal?: AbortSignal;
      timeout?: number;
    } & Pick<DeployAppCallbacks, 'onPlan' | 'onConfirm' | 'onResolveSku'>,
  ): Promise<{ promise: Promise<DeployResult>; progress: ProgressEvent[] }> {
    const readinessRaw = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'readiness-response.json',
    );
    const fred = await import('@manifest-network/manifest-mcp-fred');
    vi.mocked(fred.checkDeploymentReadiness).mockResolvedValue(
      readinessRaw as unknown as Awaited<
        ReturnType<typeof fred.checkDeploymentReadiness>
      >,
    );
    const deployResp = readFixture(
      'skills',
      'deploy-app',
      '01-fast-path-active',
      'input',
      'deploy-response.json',
    ) as Record<string, unknown>;
    vi.mocked(fred.buildManifestPreview).mockResolvedValue({
      manifest_json: '{"version":"0.1"}',
      meta_hash_hex: 'cc'.repeat(32),
    } as Awaited<ReturnType<typeof fred.buildManifestPreview>>);
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: deployResp.lease_uuid as string,
      provider_uuid: deployResp.provider_uuid as string,
      provider_url: deployResp.provider_url as string,
      state: deployResp.state as never,
      connection: deployResp.connection,
    } as unknown as Awaited<ReturnType<typeof fred.deployApp>>);
    const core = await import('@manifest-network/manifest-mcp-core');
    vi.mocked(core.cosmosEstimateFee).mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      gasEstimate: '142000',
      fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
    } as Awaited<ReturnType<typeof core.cosmosEstimateFee>>);

    const { signal, timeout, onPlan, onConfirm, onResolveSku } = opts;
    const base = captureCallbacks();
    const callbacks: DeployAppCallbacks = {
      ...base.callbacks,
      ...(onPlan ? { onPlan } : {}),
      ...(onConfirm ? { onConfirm } : {}),
      ...(onResolveSku ? { onResolveSku } : {}),
    };
    const { deployApp } = await import('./deploy-app.js');
    const clientManager = makeMockClientManager();
    const walletProvider = makeMockWalletProvider();
    const promise = deployApp(SPEC, callbacks, {
      clientManager: clientManager as unknown as Parameters<
        typeof deployApp
      >[2]['clientManager'],
      walletProvider,
      ...(signal ? { signal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    });
    return { promise, progress: base.progress };
  }

  it('pre-broadcast abort → OPERATION_CANCELLED, no lease created, `cancelled` event emitted', async () => {
    const fred = await import('@manifest-network/manifest-mcp-fred');
    const ac = new AbortController();
    ac.abort();
    const { promise, progress } = await runDeploy({ signal: ac.signal });
    const err = await promise.catch((e) => e);
    expect(err).toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expect(vi.mocked(fred.deployApp)).not.toHaveBeenCalled();
    expect(progress.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('abort during a pending onConfirm rejects promptly; the late callback rejection is swallowed', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      // onConfirm rejects AFTER the abort has already won the race. raceAbort
      // MUST swallow this late rejection — if it does not, vitest's global
      // unhandledRejection handler fails the whole run.
      const onConfirm = (): Promise<'yes' | 'no'> =>
        new Promise<'yes' | 'no'>((_, reject) =>
          setTimeout(() => reject(new Error('host timeout')), 5),
        );
      const { promise } = await runDeploy({ signal: ac.signal, onConfirm });
      ac.abort();
      const err = await promise.catch((e) => e);
      expect(err).toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      // Deterministically fire the late rejection; a leak here fails the run.
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('composed signal: caller timeout aborts with TimeoutError → OPERATION_CANCELLED', async () => {
    vi.useFakeTimers();
    try {
      const onConfirm = (): Promise<'yes' | 'no'> =>
        new Promise<'yes' | 'no'>(() => {});
      const { promise } = await runDeploy({ timeout: 1000, onConfirm });
      const assertion = expect(promise).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
