import { readFileSync } from 'node:fs';
import { cosmosTx } from '@manifest-network/manifest-mcp-core';
import {
  buildManifestPreview,
  type FredCompatibilityConfig,
  deployApp as fredDeployApp,
  resolveProviderUrl,
} from '@manifest-network/manifest-mcp-fred';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deployApp } from './deploy-app.js';
import type {
  DeployAppCallbacks,
  DeployAppOptions,
  Plan,
  ProgressEvent,
} from './types.js';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@manifest-network/manifest-mcp-core')
  >()),
  resolveSku: vi.fn(
    async (_ctx: unknown, input: { providerUuid?: string }) => ({
      skuUuid: 'sku-fixture',
      providerUuid: input.providerUuid ?? 'provider-fixture',
      name: 'small',
      active: true,
      price: { amount: '1000', denom: 'umfx' },
      billingUnit: 'hour',
    }),
  ),
  cosmosEstimateFee: vi.fn(async () => ({
    module: 'billing',
    subcommand: 'create-lease',
    gasEstimate: '142000',
    fee: { amount: [{ denom: 'umfx', amount: '2300' }], gas: '142000' },
  })),
  cosmosTx: vi.fn(async () => {
    throw new Error('test broadcast boundary');
  }),
}));

vi.mock('@manifest-network/manifest-mcp-fred', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-fred')
    >();
  return {
    ...actual,
    buildManifestPreview: vi.fn(actual.buildManifestPreview),
    deployApp: vi.fn(actual.deployApp),
    resolveProviderUrl: vi.fn(actual.resolveProviderUrl),
    checkDeploymentReadiness: vi.fn(async () =>
      JSON.parse(
        readFileSync(
          new URL(
            '../__fixtures__/skills/deploy-app/01-fast-path-active/input/readiness-response.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    ),
  };
});

const PROVIDER_URL = 'https://provider.example.com';
const spec = {
  image: 'nginx',
  port: 80,
  size: 'small',
  labels: { 'com.docker.compose.project': 'tenant' },
  user: 'a:b:c',
};

function options(
  fredCompatibility?: FredCompatibilityConfig,
  providerUrls: Record<string, string> = {},
): DeployAppOptions {
  return {
    fredCompatibility,
    clientManager: {
      getAddress: vi.fn(async () => 'manifest1deadbeef'),
      acquireRateLimit: vi.fn(async () => {}),
      getConfig: vi.fn(() => ({
        chainId: 'manifest-ledger-testnet-1',
        gasPrice: '1umfx',
      })),
      getQueryClient: vi.fn(async () => ({
        liftedinit: {
          sku: {
            v1: {
              provider: vi.fn(async ({ uuid }: { uuid: string }) => ({
                provider: { apiUrl: providerUrls[uuid] ?? PROVIDER_URL },
              })),
            },
          },
        },
      })),
    } as unknown as DeployAppOptions['clientManager'],
    walletProvider: {
      getAddress: vi.fn(async () => 'manifest1deadbeef'),
      getSigner: vi.fn(async () => ({}) as never),
      signArbitrary: vi.fn(async () => ({
        pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'base64==' },
        signature: 'sig==',
      })),
    },
  };
}

describe('orchestrated Fred compatibility at the real deployment boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    undefined,
    { 'https://other.example.com': 'pr240' } satisfies FredCompatibilityConfig,
  ])(
    'keeps legacy manifest admission by default or for unlisted providers: %j',
    async (config) => {
      await expect(
        deployApp(spec, { onConfirm: async () => 'yes' }, options(config)),
      ).rejects.toThrow('test broadcast boundary');
      expect(cosmosTx).toHaveBeenCalledTimes(1);
      expect(buildManifestPreview).toHaveBeenCalledWith(spec, 'v0.13');
    },
  );

  it.each([
    'pr240',
    { [PROVIDER_URL]: 'pr240' },
  ] satisfies FredCompatibilityConfig[])(
    'rejects PR240-invalid data before the credit-reserving create-lease: %j',
    async (config) => {
      await expect(
        deployApp(spec, { onConfirm: async () => 'yes' }, options(config)),
      ).rejects.toThrow(/Invalid manifest/);
      expect(cosmosTx).not.toHaveBeenCalled();
      expect(fredDeployApp).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(fredDeployApp).mock.calls[0][0].fredCompatibility,
      ).toEqual(config);
    },
  );

  it('snapshots caller maps before confirmation callbacks can mutate them', async () => {
    const config: Record<string, 'v0.13' | 'pr240'> = {
      [PROVIDER_URL]: 'pr240',
    };
    const callbacks: DeployAppCallbacks = {
      onConfirm: async () => {
        config[PROVIDER_URL] = 'v0.13';
        return 'yes';
      },
    };
    await expect(deployApp(spec, callbacks, options(config))).rejects.toThrow(
      /Invalid manifest/,
    );
    const selected =
      vi.mocked(fredDeployApp).mock.calls[0][0].fredCompatibility;
    expect(selected).toEqual({ [PROVIDER_URL]: 'pr240' });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(cosmosTx).not.toHaveBeenCalled();
  });

  it('uses the selected global policy for every edited preview', async () => {
    let edits = 0;
    await expect(
      deployApp(
        spec,
        {
          onConfirm: async () => 'yes',
          onPlan: async () =>
            edits++ === 0
              ? {
                  kind: 'replace_spec',
                  spec: { ...spec, env: { CHANGED: 'true' } },
                }
              : 'confirm',
        },
        options('pr240'),
      ),
    ).rejects.toThrow(/Invalid manifest/);
    expect(
      vi.mocked(buildManifestPreview).mock.calls.map((call) => call[1]),
    ).toEqual(['pr240', 'pr240']);
    expect(cosmosTx).not.toHaveBeenCalled();
  });

  it('shows the mapped provider policy and invalid result before any confirmation or deployment', async () => {
    const events: ProgressEvent[] = [];
    const onConfirm = vi.fn(async () => 'yes' as const);
    const onPlan = vi.fn(async (plan: Plan) => {
      expect(plan.manifestValidation).toMatchObject({
        fred_compatibility: 'pr240',
        valid: false,
      });
      expect(plan.manifestValidation?.errors.join(' ')).toContain(
        'com.docker.compose.',
      );
      return 'cancel' as const;
    });
    await expect(
      deployApp(
        spec,
        { onPlan, onConfirm, onProgress: (event) => events.push(event) },
        options({ [PROVIDER_URL]: 'pr240' }),
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(fredDeployApp).not.toHaveBeenCalled();
    expect(cosmosTx).not.toHaveBeenCalled();
    const rendered = events.find(
      (event) => event.kind === 'deployment_plan_rendered',
    );
    expect(rendered?.kind).toBe('deployment_plan_rendered');
    if (rendered?.kind === 'deployment_plan_rendered') {
      expect(rendered.block.text).toContain('pr240');
      expect(rendered.block.text).toMatch(/invalid/i);
      expect(rendered.block.text).toContain('com.docker.compose.');
    }
  });

  it('resolves provider-specific policy again after a provider edit and exposes both plans', async () => {
    const legacyUrl = 'https://legacy.example.com';
    const plans: Plan[] = [];
    const renderedPlans: string[] = [];
    await expect(
      deployApp(
        { ...spec, providerUuid: 'provider-legacy' },
        {
          onPlan: async (plan) => {
            plans.push(plan);
            return plans.length === 1
              ? {
                  kind: 'replace_spec',
                  spec: { ...spec, providerUuid: 'provider-modern' },
                }
              : 'cancel';
          },
          onProgress: (event) => {
            if (event.kind === 'deployment_plan_rendered')
              renderedPlans.push(event.block.text);
          },
        },
        options(
          { [legacyUrl]: 'v0.13', [PROVIDER_URL]: 'pr240' },
          { 'provider-legacy': legacyUrl },
        ),
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(
      plans.map((plan) => ({
        mode: plan.manifestValidation?.fred_compatibility,
        valid: plan.manifestValidation?.valid,
      })),
    ).toEqual([
      { mode: 'v0.13', valid: true },
      { mode: 'pr240', valid: false },
    ]);
    expect(
      vi.mocked(resolveProviderUrl).mock.calls.map((call) => call[1]),
    ).toEqual(['provider-legacy', 'provider-modern']);
    expect(
      vi.mocked(buildManifestPreview).mock.calls.map((call) => call[1]),
    ).toEqual(['v0.13', 'pr240']);
    expect(renderedPlans[0]).toContain('v0.13');
    expect(renderedPlans[1]).toContain('pr240');
    expect(renderedPlans[1]).toMatch(/invalid/i);
    expect(fredDeployApp).not.toHaveBeenCalled();
    expect(cosmosTx).not.toHaveBeenCalled();
  });

  it('rejects invalid configuration before wallet or chain reads', async () => {
    const opts = options('latest' as FredCompatibilityConfig);
    await expect(deployApp(spec, {}, opts)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(opts.walletProvider.getAddress).not.toHaveBeenCalled();
    expect(opts.clientManager.getQueryClient).not.toHaveBeenCalled();
  });
});
