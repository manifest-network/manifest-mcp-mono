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
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type {
  DeployAppCallbacks,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
  Plan,
  ProgressEvent,
  RecoveryOption,
  SingleServiceSpec,
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
    } as Awaited<ReturnType<typeof fred.deployApp>>);

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
        opts?.onProgress?.({ state: 3 }); // ACTIVE sample
        return {
          lease_uuid: leaseUuid as string,
          provider_uuid: '44444444-4444-4444-8444-444444444444',
          provider_url: 'https://provider.testnet.manifest.network',
          state: 'LEASE_STATE_ACTIVE',
          status: {
            state: 3,
            instances: [
              {
                status: 'running',
                fqdn: 'app-33333333.testnet.manifest.app',
                host_port: 30001,
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
  //   - requested SKU not in `available_sku_names` → block (rule #1).
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
      expect.anything(),
      '11111111-1111-4111-8111-111111111111',
    );

    // Verify the orchestrator threw after recovery (caller expected to
    // re-run troubleshootDeployment).
    expect(caughtErr).toBeInstanceOf(Error);
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
      // assembled, and the orchestrator throws INVALID_CONFIG on 'cancel'
      // — which we swallow. Net: cheap path through the fee path only.
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
      services: {
        web: { image: 'nginx:1.27', ports: [80] },
        api: { image: 'node:20', ports: [3000] },
        db: { image: 'postgres:16', ports: [5432] },
      },
    } as DeploySpec;
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
      services: {
        web: { image: 'nginx:1.27', ports: [80] },
      },
    } as DeploySpec;
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
      services: {
        web: { image: 'nginx:1.27', ports: [80] },
        api: { image: 'node:20', ports: [3000] },
      },
      customDomain: 'app.example.com',
      serviceName: 'web',
    } as DeploySpec;
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
      // 'cancel' verdict throws INVALID_CONFIG; expected, swallow.
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
        opts?.onProgress?.({ state: 1 });
        opts?.onProgress?.({ state: 3 });
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
      status: { state: 3, instances: [] },
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
    // The re-classification emits 'needs_wait' on the post-poll response.
    // The orchestrator throws with a message that surfaces the post-poll
    // outcome.
    expect((caughtErr as Error).message).toMatch(
      /post-poll|needs_wait|wait_for_app_ready/i,
    );
    // app_ready_confirmed MUST NOT fire — Defense #2 caught the race.
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    expect(completed).toHaveLength(0);
    // Polling did happen (at least one classifier event + waitForAppReady
    // was called); we expect exactly ONE deploy_response_classified
    // event (the initial; the re-classify is internal and MUST NOT emit
    // a second event).
    const classifyEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifyEvents).toHaveLength(1);
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
        state: 3,
        instances: [
          {
            status: 'running',
            fqdn: 'app-dddddddd.testnet.manifest.app',
            host_port: 30001,
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
