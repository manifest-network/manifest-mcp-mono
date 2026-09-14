import type { EncodeObject } from '@cosmjs/proto-signing';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeSealedClientManager,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { deployApp as fredDeployApp } from '@manifest-network/manifest-mcp-fred';
import { describe, expect, it, vi } from 'vitest';
import { deployApp } from './deploy-app.js';
import type {
  AppDeploySpec,
  Coin,
  DeployAppCallbacks,
  Plan,
  ProgressEvent,
  WalletProvider,
} from './types.js';

const TENANT = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const PROVIDER = '11111111-1111-4111-8111-111111111111';
const COMPUTE = '22222222-2222-4222-8222-222222222222';
const STORAGE = '33333333-3333-4333-8333-333333333333';

interface CatalogSku {
  uuid: string;
  providerUuid: string;
  name: string;
  active: boolean;
  unit?: number;
  basePrice?: { amount: string; denom: string };
}

function catalog(): CatalogSku[] {
  return [
    {
      uuid: COMPUTE,
      providerUuid: PROVIDER,
      name: 'small',
      active: true,
      unit: 1,
      basePrice: { amount: '2', denom: 'umfx' },
    },
    {
      uuid: STORAGE,
      providerUuid: PROVIDER,
      name: 'disk-small',
      active: true,
      unit: 1,
      basePrice: { amount: '99', denom: 'umfx' },
    },
  ];
}

// Exercise real resolution, preview, fee/message construction, and rendering.
// Only the injected chain transport is fake; every broadcast/signing path is sealed.
function harness(
  skus = catalog(),
  credits: Coin[] = [{ amount: '50000000000', denom: 'umfx' }],
) {
  const query = makeMockQueryClient({
    billing: {
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountBalances: credits,
      creditAccountAvailableBalances: credits,
    },
    sku: {
      skus: skus.filter((sku) => sku.active),
      providerLookup: {
        [PROVIDER]: { provider: { apiUrl: 'https://provider.example.com' } },
      },
    },
  });
  const simulate = vi.fn(
    async (
      _sender: string,
      _messages: readonly EncodeObject[],
      _memo?: string,
    ) => 100000,
  );
  const chain = makeSealedClientManager({
    getQueryClient: vi.fn(async () => query as never),
    getAddress: vi.fn(async () => TENANT),
    getConfig: vi.fn(() => makeMockConfig()),
    acquireRateLimit: vi.fn(async () => {}),
    getSigningClient: vi.fn(async () => ({ simulate }) as never),
  });
  const wallet: WalletProvider = {
    getAddress: vi.fn(async () => TENANT),
    getSigner: vi.fn(async () => {
      throw new Error('wallet signing is sealed');
    }),
    signArbitrary: vi.fn(async () => {
      throw new Error('ADR-036 signing is sealed');
    }),
  };
  const events: ProgressEvent[] = [];
  const plans: Plan[] = [];
  const callbacks: DeployAppCallbacks = {
    onProgress: (event) => events.push(event),
    onPlan: vi.fn(async (plan) => {
      plans.push(plan);
      return 'cancel' as const;
    }),
    onConfirm: vi.fn(async () => 'no' as const),
    onResolveSku: vi.fn(async () => {
      throw new Error('storage cannot be pinned by the compute picker');
    }),
  };
  return {
    query,
    chain,
    wallet,
    simulate,
    callbacks,
    plans,
    events,
    blocks: () =>
      events.flatMap((event) =>
        event.kind === 'deployment_plan_rendered' ? [event.block.text] : [],
      ),
    run: (spec: AppDeploySpec, signal?: AbortSignal) =>
      deployApp(spec, callbacks, {
        clientManager: chain,
        walletProvider: wallet,
        signal,
      }),
  };
}

const shapes: { label: string; spec: AppDeploySpec; services: string[] }[] = [
  {
    label: 'flat single service',
    spec: { size: 'small', image: 'nginx:1.27', port: 80 },
    services: [''],
  },
  {
    label: 'authored single service',
    spec: { size: 'small', services: { web: { image: 'nginx:1.27' } } },
    services: ['web'],
  },
  {
    label: 'multiple services',
    spec: {
      size: 'small',
      services: {
        web: { image: 'nginx:1.27' },
        api: { image: 'node:22' },
        db: { image: 'postgres:16' },
      },
    },
    services: ['web', 'api', 'db'],
  },
  {
    label: 'multiple services with a custom domain',
    spec: {
      size: 'small',
      services: {
        web: { image: 'nginx:1.27' },
        db: { image: 'postgres:16' },
      },
      customDomain: 'app.example.com',
      serviceName: 'web',
    },
    services: ['web', 'db'],
  },
];

describe('deployApp storage pricing and simulated messages (ENG-944)', () => {
  it.each([
    {
      label: 'all compute services plus storage',
      spec: { ...shapes[2].spec, storage: 'disk-small' },
      daily: false,
      storageDenom: 'umfx',
      status: 'warn',
      reason: /105 umfx per hour/,
    },
    {
      label: 'storage paid in another denomination',
      spec: { ...shapes[0].spec, storage: 'disk-small' },
      daily: false,
      storageDenom: 'upwr',
      status: 'warn',
      reason: /Fund upwr credits/,
    },
    {
      label: 'daily compute billing',
      spec: shapes[0].spec,
      daily: true,
      storageDenom: 'umfx',
      status: 'ok',
      reason: undefined,
    },
  ])(
    'uses the displayed prices for readiness: $label',
    async ({ spec, daily, storageDenom, status, reason }) => {
      const skus = catalog();
      if (daily) {
        skus[0].unit = 2;
        skus[0].basePrice = { amount: '48', denom: 'umfx' };
      }
      skus[1].basePrice = { amount: '99', denom: storageDenom };
      const h = harness(skus, [{ amount: '100', denom: 'umfx' }]);
      await expect(h.run(spec)).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expect(h.plans[0].readiness.status).toBe(status);
      if (reason)
        expect(h.plans[0].readiness.reasons.join('\n')).toMatch(reason);
      else expect(h.plans[0].readiness.reasons).toEqual([]);
    },
  );

  it.each(['confirm', 'cancel'] as const)(
    'presents the edited price to onPlan before accepting %s',
    async (verdict) => {
      const h = harness();
      const shown: string[] = [];
      h.callbacks.onPlan = vi.fn(async () => {
        shown.push(h.blocks().at(-1)!);
        return shown.length === 1
          ? {
              kind: 'replace_spec' as const,
              spec: { ...shapes[0].spec, storage: 'disk-small' },
            }
          : verdict;
      });
      await expect(h.run(shapes[0].spec)).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expect(shown).toHaveLength(2);
      expect(shown[0]).toContain('Recurring total:           2 umfx / hour');
      expect(shown[1]).toContain('Recurring total:           101 umfx / hour');
      expect(h.callbacks.onConfirm).toHaveBeenCalledTimes(
        verdict === 'confirm' ? 1 : 0,
      );
      expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
    },
  );

  it.each([5, { size: 'disk-small' }, null, false, '', '  ', '\t\n'])(
    'rejects malformed storage %j at the input boundary',
    async (storage) => {
      const h = harness();
      await expect(
        h.run({ ...shapes[0].spec, storage } as unknown as AppDeploySpec),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('`storage`'),
      });
      expect(h.query.liftedinit.sku.v1.sKUs).not.toHaveBeenCalled();
      expect(h.callbacks.onPlan).not.toHaveBeenCalled();
      expect(h.simulate).not.toHaveBeenCalled();
    },
  );

  it('rechecks readiness and confirmation across multiple edits', async () => {
    const h = harness(catalog(), [{ amount: '100', denom: 'umfx' }]);
    const plans: Plan[] = [];
    h.callbacks.onPlan = async (plan) => {
      plans.push(plan);
      if (plans.length === 1)
        return {
          kind: 'replace_spec',
          spec: { ...shapes[0].spec, storage: 'disk-small' },
        };
      if (plans.length === 2)
        return { kind: 'replace_spec', spec: shapes[0].spec };
      return 'cancel';
    };
    await expect(h.run(shapes[0].spec)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expect(plans.map((plan) => plan.readiness.status)).toEqual([
      'ok',
      'warn',
      'ok',
    ]);
    expect(plans.map((plan) => plan.leaseItems.length)).toEqual([1, 2, 1]);
    expect(h.simulate).toHaveBeenCalledTimes(3);
    expect(h.blocks()).toHaveLength(3);
    expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
    expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
  });

  it('cancels while waiting for confirmation of the edited price', async () => {
    const h = harness();
    const controller = new AbortController();
    h.callbacks.onPlan = vi
      .fn<NonNullable<DeployAppCallbacks['onPlan']>>()
      .mockResolvedValueOnce({
        kind: 'replace_spec',
        spec: { ...shapes[0].spec, storage: 'disk-small' },
      })
      .mockImplementationOnce(() => {
        controller.abort();
        return new Promise(() => {});
      });
    await expect(
      h.run(shapes[0].spec, controller.signal),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    expect(h.callbacks.onPlan).toHaveBeenCalledTimes(2);
    expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
    expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
  });

  it.each([5, '  '])(
    'rejects malformed post-edit storage %j before replanning',
    async (storage) => {
      const h = harness();
      h.callbacks.onPlan = async () => ({
        kind: 'replace_spec',
        spec: { ...shapes[0].spec, storage } as unknown as AppDeploySpec,
      });
      await expect(h.run(shapes[0].spec)).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining(
          'Post-edit spec failed validation: validateSpec: `storage`',
        ),
      });
      expect(h.simulate).toHaveBeenCalledTimes(1);
      expect(h.blocks()).toHaveLength(1);
      expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
    },
  );

  for (const { label, spec, services } of shapes) {
    for (const storage of [false, true]) {
      it(`${label}, ${storage ? 'with' : 'without'} storage`, async () => {
        const h = harness();
        const input = {
          ...spec,
          ...(storage ? { storage: 'disk-small' } : {}),
        };
        await expect(h.run(input)).rejects.toMatchObject({
          code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        });
        expect(h.simulate).toHaveBeenCalledTimes(1);
        const [sender, messages] = h.simulate.mock.calls[0];
        expect(sender).toBe(TENANT);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          typeUrl: '/liftedinit.billing.v1.MsgCreateLease',
          value: {
            tenant: TENANT,
            metaHash: expect.any(Uint8Array),
            items: [
              ...services.map((serviceName) => ({
                skuUuid: COMPUTE,
                quantity: 1n,
                serviceName,
              })),
              ...(storage
                ? [{ skuUuid: STORAGE, quantity: 1n, serviceName: '' }]
                : []),
            ],
          },
        });
        const [block] = h.blocks();
        expect(h.plans[0].leaseItems).toHaveLength(
          services.length + Number(storage),
        );
        expect(block).toContain('2 umfx / hour');
        if (storage) {
          expect(block).toContain('Storage item:');
          expect(block).toContain('disk-small');
          expect(block).toContain(STORAGE);
          expect(block).toContain(PROVIDER);
          expect(block).toContain('quantity=1');
          expect(block).toContain('99 umfx / hour');
          expect(block).toContain(
            `Recurring total:           ${99 + 2 * services.length} umfx / hour`,
          );
        } else {
          expect(block).not.toContain('Storage item:');
          expect(block).not.toContain(STORAGE);
        }
        expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
        expect(h.wallet.getSigner).not.toHaveBeenCalled();
        expect(h.wallet.signArbitrary).not.toHaveBeenCalled();

        // Compare with Fred's real deployment path at the injected broadcast
        // boundary. The probe captures messages and throws without signing.
        const signAndBroadcast = vi.fn(async () => {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'offline broadcast probe',
          );
        });
        const chain = makeSealedClientManager({
          getAddress: h.chain.getAddress,
          getConfig: h.chain.getConfig,
          acquireRateLimit: h.chain.acquireRateLimit,
          getBroadcastClient: vi.fn(
            async () =>
              ({
                simulate: h.simulate,
                signAndBroadcast,
              }) as never,
          ),
          withBroadcastLock: async (_address, fn) => fn(),
        });
        const denyProvider = vi.fn(async () => {
          throw new Error('provider requests and signing are sealed');
        });
        await expect(
          fredDeployApp(
            {
              query: h.query,
              chain,
              logger: noopLogger,
              fetch: denyProvider,
              providerAuth: {
                providerToken: denyProvider,
                leaseDataToken: denyProvider,
              },
            },
            { ...input, skuUuid: COMPUTE, providerUuid: PROVIDER },
          ),
        ).rejects.toThrow('offline broadcast probe');
        expect(signAndBroadcast).toHaveBeenCalledTimes(1);
        expect(signAndBroadcast).toHaveBeenCalledWith(
          TENANT,
          messages,
          expect.any(Object),
          '',
        );
        expect(denyProvider).not.toHaveBeenCalled();
      });
    }
  }

  it('selects storage on the compute provider despite a duplicate name elsewhere', async () => {
    const skus = catalog();
    skus.unshift({
      ...skus[1],
      uuid: '44444444-4444-4444-8444-444444444444',
      providerUuid: 'other-provider',
    });
    const h = harness(skus);
    await expect(
      h.run({ ...shapes[0].spec, skuUuid: COMPUTE, storage: ' disk-small ' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    expect(h.simulate.mock.calls[0][1][0].value.items.at(-1)).toEqual({
      skuUuid: STORAGE,
      quantity: 1n,
      serviceName: '',
    });
    expect(h.callbacks.onResolveSku).not.toHaveBeenCalled();
  });

  for (const failure of [
    'missing',
    'other-provider',
    'inactive',
    'ambiguous',
  ] as const) {
    it(`fails before simulation or confirmation for ${failure} storage`, async () => {
      const skus = catalog();
      if (failure === 'missing') skus.pop();
      if (failure === 'other-provider') skus[1].providerUuid = 'other-provider';
      if (failure === 'inactive') skus[1].active = false;
      if (failure === 'ambiguous')
        skus.push({ ...skus[1], uuid: '44444444-4444-4444-8444-444444444444' });
      const h = harness(skus);
      await expect(
        h.run({ ...shapes[0].spec, storage: 'disk-small' }),
      ).rejects.toMatchObject({
        code:
          failure === 'ambiguous'
            ? ManifestMCPErrorCode.SKU_AMBIGUOUS
            : ManifestMCPErrorCode.QUERY_FAILED,
        message: expect.stringMatching(
          failure === 'ambiguous'
            ? /Ambiguous storage SKU.*Choose another compute provider/
            : /Could not resolve storage SKU/,
        ),
        details: expect.objectContaining({
          selection: 'storage',
          phase: 'initial',
          providerUuid: PROVIDER,
          storage: 'disk-small',
        }),
      });
      expect(h.simulate).not.toHaveBeenCalled();
      expect(h.blocks()).toEqual([]);
      expect(h.callbacks.onPlan).not.toHaveBeenCalled();
      expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
      expect(h.callbacks.onResolveSku).not.toHaveBeenCalled();
      expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
      expect(h.wallet.signArbitrary).not.toHaveBeenCalled();
    });
  }

  it.each([
    {
      computeUnit: 2,
      storageUnit: 2,
      denom: 'umfx',
      amount: '99',
      total: '101 umfx / day',
    },
    {
      computeUnit: 1,
      storageUnit: 2,
      denom: 'umfx',
      amount: '99',
      total: '147 umfx / day',
    },
    {
      computeUnit: 2,
      storageUnit: 1,
      denom: 'umfx',
      amount: '99',
      total: '2378 umfx / day',
    },
    {
      computeUnit: 1,
      storageUnit: 1,
      denom: 'upwr',
      amount: '99',
      total: '2 umfx / hour + 99 upwr / hour',
    },
    {
      computeUnit: 1,
      storageUnit: 1,
      denom: 'umfx',
      amount: '9007199254740993',
      total: '9007199254740995 umfx / hour',
    },
  ])(
    'renders exact recurring costs: $total',
    async ({ computeUnit, storageUnit, denom, amount, total }) => {
      const skus = catalog();
      skus[0].unit = computeUnit;
      skus[1].unit = storageUnit;
      skus[1].basePrice = { amount, denom };
      const h = harness(skus);
      await expect(
        h.run({ ...shapes[0].spec, storage: 'disk-small' }),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expect(h.blocks()[0]).toContain(`Recurring total:           ${total}`);
      expect(h.blocks()[0]).toContain(
        `${amount} ${denom} / ${storageUnit === 1 ? 'hour' : 'day'}`,
      );
    },
  );

  it.each(['price', 'unit', 'unsupported-unit', 'malformed-price'] as const)(
    'marks recurring pricing incomplete for missing or invalid storage %s',
    async (field) => {
      const skus = catalog();
      if (field === 'price') delete skus[1].basePrice;
      if (field === 'unit') delete skus[1].unit;
      if (field === 'unsupported-unit') skus[1].unit = 123;
      if (field === 'malformed-price')
        skus[1].basePrice = { amount: 'not-a-number', denom: 'umfx' };
      const h = harness(skus);
      await expect(
        h.run({ ...shapes[0].spec, storage: 'disk-small' }),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expect(h.blocks()[0]).toContain(
        'Recurring total:           2 umfx / hour + 1 unpriced item (incomplete)',
      );
      expect(h.plans[0].readiness.status).toBe('warn');
      expect(h.plans[0].readiness.reasons.join(' ')).toContain(
        'Cannot fully estimate deployment runtime',
      );
      expect(h.simulate.mock.calls[0][1][0].value.items).toHaveLength(2);
      expect(h.blocks()[0]).toContain(STORAGE);
    },
  );

  it.each([true, false])(
    'rebuilds both estimate and rendered plan when storage becomes %s',
    async (withStorage) => {
      const h = harness();
      h.callbacks.onPlan = vi
        .fn<NonNullable<DeployAppCallbacks['onPlan']>>()
        .mockResolvedValueOnce({
          kind: 'replace_spec' as const,
          spec: {
            ...shapes[0].spec,
            ...(withStorage ? { storage: 'disk-small' } : {}),
          },
        })
        .mockResolvedValue('confirm');
      await expect(
        h.run({
          ...shapes[0].spec,
          ...(!withStorage ? { storage: 'disk-small' } : {}),
        }),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expect(
        h.simulate.mock.calls.map(
          ([, messages]) => messages[0].value.items.length,
        ),
      ).toEqual(withStorage ? [1, 2] : [2, 1]);
      expect(h.blocks().map((block) => block.includes(STORAGE))).toEqual([
        !withStorage,
        withStorage,
      ]);
      expect(h.blocks()[1]).toContain(
        `Recurring total:           ${withStorage ? 101 : 2} umfx / hour`,
      );
      expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
    },
  );

  it('re-resolves storage after changing compute provider and service count', async () => {
    const skus = catalog();
    const nextProvider = '44444444-4444-4444-8444-444444444444';
    const nextCompute = '55555555-5555-4555-8555-555555555555';
    const nextStorage = '66666666-6666-4666-8666-666666666666';
    skus.push(
      {
        ...skus[0],
        uuid: nextCompute,
        providerUuid: nextProvider,
        basePrice: { amount: '3', denom: 'umfx' },
      },
      {
        ...skus[1],
        uuid: nextStorage,
        providerUuid: nextProvider,
        basePrice: { amount: '7', denom: 'umfx' },
      },
    );
    const h = harness(skus);
    h.callbacks.onPlan = vi
      .fn<NonNullable<DeployAppCallbacks['onPlan']>>()
      .mockResolvedValueOnce({
        kind: 'replace_spec' as const,
        spec: {
          ...shapes[2].spec,
          skuUuid: nextCompute,
          storage: 'disk-small',
        },
      })
      .mockResolvedValue('confirm');
    await expect(
      h.run({ ...shapes[0].spec, skuUuid: COMPUTE, storage: 'disk-small' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.OPERATION_CANCELLED });
    expect(h.simulate.mock.calls[1][1][0].value.items).toEqual([
      ...['web', 'api', 'db'].map((serviceName) => ({
        skuUuid: nextCompute,
        quantity: 1n,
        serviceName,
      })),
      { skuUuid: nextStorage, quantity: 1n, serviceName: '' },
    ]);
    expect(h.blocks()[1]).toContain(nextProvider);
    expect(h.blocks()[1]).toContain(nextStorage);
    expect(h.blocks()[1]).not.toContain(STORAGE);
    expect(h.blocks()[1]).toContain(
      'Recurring total:           16 umfx / hour',
    );
  });

  it('fails closed when an edited spec requests unresolved storage', async () => {
    const h = harness();
    h.callbacks.onPlan = vi
      .fn<NonNullable<DeployAppCallbacks['onPlan']>>()
      .mockResolvedValueOnce({
        kind: 'replace_spec' as const,
        spec: { ...shapes[0].spec, storage: 'missing-disk' },
      })
      .mockResolvedValue('confirm');
    await expect(h.run(shapes[0].spec)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining(
        'Post-edit: Could not resolve storage SKU',
      ),
      details: expect.objectContaining({
        selection: 'storage',
        phase: 'post_edit',
      }),
    });
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(h.blocks()).toHaveLength(1);
    expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
    expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
  });
});
