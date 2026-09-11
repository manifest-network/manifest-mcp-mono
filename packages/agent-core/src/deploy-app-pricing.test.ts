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
function harness(skus = catalog()) {
  const query = makeMockQueryClient({
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
    run: (spec: AppDeploySpec) =>
      deployApp(spec, callbacks, {
        clientManager: chain,
        walletProvider: wallet,
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
      expect(h.blocks()[0]).toContain('Recurring total:           (incomplete');
      expect(h.simulate.mock.calls[0][1][0].value.items).toHaveLength(2);
      expect(h.blocks()[0]).toContain(STORAGE);
    },
  );

  it.each([true, false])(
    'rebuilds both estimate and rendered plan when storage becomes %s',
    async (withStorage) => {
      const h = harness();
      h.callbacks.onPlan = vi.fn(async () => ({
        kind: 'replace_spec' as const,
        spec: {
          ...shapes[0].spec,
          ...(withStorage ? { storage: 'disk-small' } : {}),
        },
      }));
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
    h.callbacks.onPlan = vi.fn(async () => ({
      kind: 'replace_spec' as const,
      spec: { ...shapes[2].spec, skuUuid: nextCompute, storage: 'disk-small' },
    }));
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
    h.callbacks.onPlan = vi.fn(async () => ({
      kind: 'replace_spec' as const,
      spec: { ...shapes[0].spec, storage: 'missing-disk' },
    }));
    await expect(h.run(shapes[0].spec)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(h.blocks()).toHaveLength(1);
    expect(h.callbacks.onConfirm).not.toHaveBeenCalled();
    expect(h.chain.getBroadcastClient).not.toHaveBeenCalled();
  });
});
