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

  it('F1 regression: terminal-state surfaces via classifier throw, not silent coercion to ACTIVE', async () => {
    // QA F1: prior `leaseStateAsName` helper silently returned
    // 'LEASE_STATE_ACTIVE' for any non-LEASE_STATE_-prefixed input
    // (including unknown numeric ints). This regression test verifies
    // the canonical `decode()` from lease-state.ts handles known numeric
    // inputs and terminal-state passthrough correctly.
    //
    // Updated for Copilot review fix r3237308914 (assertion form per
    // ENG-185 scope item #6): the orchestrator now routes the success-
    // return path through `classifyDeployResponse`, which buckets
    // terminal states (e.g. REJECTED) as outcome `'failed'`. PR-3
    // throws `INVALID_CONFIG` with the classifier's `errorSummary` and
    // an ENG-185 #6 reference (full FailureEnvelope routing deferred).
    // Asserting on the THROWN error preserves the F1 spirit (REJECTED
    // not silently coerced to ACTIVE) while honoring the new contract.
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

    // F1 verdict: REJECTED surfaced via INVALID_CONFIG throw with the
    // classifier's canonical `Lease ${uuid} reached terminal state
    // ${name}` summary plus an ENG-185 #6 follow-up reference — not
    // silently coerced to ACTIVE and not returned as a "successful"
    // DeployResult.
    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toContain('LEASE_STATE_REJECTED');
    expect((caughtErr as Error).message).toContain(
      '11111111-1111-4111-8111-111111111111',
    );
    expect((caughtErr as Error).message).toContain('ENG-185 scope item #6');
    // Orchestrator emitted `deploy_response_classified: 'failed'` and did
    // NOT emit `app_ready_confirmed` (the misleading event the prior
    // hardcoded-`'active'` path always fired).
    const classifiedEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifiedEvents).toHaveLength(1);
    expect(
      classifiedEvents[0]?.kind === 'deploy_response_classified' &&
        classifiedEvents[0].outcome,
    ).toBe('failed');
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    // onComplete never fires when the orchestrator throws.
    expect(completed).toHaveLength(0);
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

  it('r3237308914: classifier-returns-`needs_wait` throws INVALID_CONFIG with ENG-185 #6 deferral note', async () => {
    // fred returns a PENDING lease with no running instances:
    // classifyDeployResponse → `'needs_wait'`. PR-3 assertion form
    // (ENG-185 scope item #6) throws INVALID_CONFIG with the
    // classifier's `stateName` plus the deferral reference. Full
    // routing — polling `wait_for_app_ready`, emitting
    // `polling_for_readiness` events — is the ENG-185 #6 follow-up.
    // The classification event itself MUST fire before the throw so
    // consumers see the intermediate state.
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
    // state 1 = PENDING (not terminal); empty connection. Classifier:
    // not active, not terminal → `'needs_wait'`.
    vi.mocked(fred.deployApp).mockResolvedValue({
      lease_uuid: '33333333-3333-4333-8333-333333333333',
      provider_uuid: '44444444-4444-4444-8444-444444444444',
      provider_url: 'https://provider.testnet.manifest.network',
      state: 1 as never,
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

    // Classifier outcome surfaced as `'needs_wait'` BEFORE the throw.
    const classifiedEvents = progress.filter(
      (e) => e.kind === 'deploy_response_classified',
    );
    expect(classifiedEvents).toHaveLength(1);
    expect(
      classifiedEvents[0]?.kind === 'deploy_response_classified' &&
        classifiedEvents[0].outcome,
    ).toBe('needs_wait');
    // PR-3 assertion form: throw INVALID_CONFIG with the classifier's
    // stateName + ENG-185 #6 deferral reference. Full routing (poll
    // wait_for_app_ready, emit polling_for_readiness) lives in #6.
    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toContain('LEASE_STATE_PENDING');
    expect((caughtErr as Error).message).toContain('ENG-185 scope item #6');
    // `app_ready_confirmed` MUST NOT fire — the prior hardcoded-`'active'`
    // path would have lied here.
    expect(progress.some((e) => e.kind === 'app_ready_confirmed')).toBe(false);
    // onComplete never fires when the orchestrator throws.
    expect(completed).toHaveLength(0);
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
