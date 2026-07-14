import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import {
  makeMockClientManager,
  makeMockQueryClient,
  makeTxCtx,
} from './__test-utils__/mocks.js';
import { asAddress, asFqdn, asLeaseUuid } from './brands.js';
import { cosmosTx } from './cosmos.js';
import { fundCredits } from './tools/fundCredits.js';
import { setItemCustomDomain } from './tools/setItemCustomDomain.js';
import { stopApp } from './tools/stopApp.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// §9 CROSS-FACE EQUIVALENCE — the 3 txs are §9 PASSTHROUGH: each is 1:1 over a single `cosmos_tx`
// subcommand (`fundCredits`→`fund-credit`, `setItemCustomDomain`→`set-item-custom-domain`,
// `stopApp`→`close-lease`). The typed face is byte-equivalent to the stringly `cosmos_tx` face when
// both bottom out in the SAME `cosmosTx(chain, module, subcommand, args)` invocation. We spy on
// `cosmosTx` and assert the typed fn passes the SAME (module, subcommand, args) tuple a direct
// stringly `cosmosTx(chain, 'billing', subcommand, args)` caller would pass, and returns the same
// brand-erased result + `ManifestMCPErrorCode`.
//
// OBSERVATION-LAYER LIMIT: a `cosmosTx`-spy can ONLY observe the §9 passthrough (module, subcommand,
// args) tuple. The §5.8 byte care-points (memo, trim, clear) are produced INSIDE
// `routeBillingTransaction`/`buildBillingMessages`, BELOW `cosmosTx`, so the spy cannot see them.
// They are pinned at that lower layer and referenced per care-point below:
//   (a) memo on BOTH simulate + broadcast legs → transactions/billing.test.ts
//       ('routeBillingTransaction — fee/memo channel': memo is the memo seen by BOTH legs).
//   (b) trim convergence (both faces trim) → transactions/billing.test.ts
//       ('trims surrounding whitespace on the positional <custom-domain> ...').
//   (c) clear arm ships `--clear`/`''` form → transactions/billing.test.ts
//       (buildBillingMessages set-item-custom-domain --clear → customDomain '').

const mockCosmosTx = vi.mocked(cosmosTx);

const SENDER = 'manifest1sender';
const TENANT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const LEASE_UUID = '11111111-2222-3333-4444-555555555555';

// Care-point (b): PIN the FQDN to ALREADY-CANONICAL (lowercase, trimmed) form. `parseFqdn`
// (brands.ts:96 `value.toLowerCase()`) LOWERCASES on the typed boundary while the stringly billing
// path only `.trim()`s (billing.ts:489) — so a mixed-case input (`'App.Example.Com'`) would ship
// `'app.example.com'` typed vs `'App.Example.Com'` stringly, and the (module, subcommand, args)
// tuple would DIVERGE. §9 equivalence is brand-erasure + VALUE-equality, NOT case-equality: the
// case-folding is a DELIBERATE typed-face enrichment (spec §5.0) the stringly adapter intentionally
// lacks. Pinning canonical input keeps the comparison honest. The *trim* convergence still holds.
const FQDN = 'app.example.com';

/** A passthrough tx result the chain leg would return; brands erase at runtime so it doubles as the
 * stringly result the byte-equivalent direct `cosmosTx` caller would observe. */
function txResult(subcommand: string) {
  return {
    module: 'billing',
    subcommand,
    transactionHash: 'HASH',
    code: 0,
    height: '100',
    confirmed: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('§9 cross-face equivalence (typed tx vs cosmos_tx stringly face)', () => {
  it('fundCredits passes the SAME (module, subcommand, args) tuple as stringly billing fund-credit', async () => {
    const cm = makeMockClientManager({ address: SENDER });
    mockCosmosTx.mockResolvedValue(txResult('fund-credit'));

    const typed = await fundCredits(makeTxCtx({ chain: cm }), {
      amount: '10000000umfx',
      tenant: asAddress(TENANT),
    });

    // The stringly face for the same intent: cosmosTx(chain, 'billing', 'fund-credit',
    // [tenant, amount]). Assert the typed fn invoked cosmosTx with the SAME tuple.
    const [, module, subcommand, args] = mockCosmosTx.mock.calls[0];
    expect([module, subcommand, args]).toEqual([
      'billing',
      'fund-credit',
      [TENANT, '10000000umfx'],
    ]);

    // Brand-erased result equivalence: the typed fn echoes the branded sender/tenant/amount over the
    // SAME chain result a direct `cosmosTx` caller would receive (brands erase at runtime).
    expect({ ...typed }).toEqual({
      ...txResult('fund-credit'),
      sender: SENDER,
      tenant: TENANT,
      amount: '10000000umfx',
    });
  });

  it('setItemCustomDomain (SET arm) passes the SAME tuple as stringly billing set-item-custom-domain', async () => {
    const cm = makeMockClientManager({ address: SENDER });
    mockCosmosTx.mockResolvedValue(txResult('set-item-custom-domain'));

    const typed = await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      customDomain: asFqdn(FQDN), // already-canonical (see FQDN comment)
    });

    const [, module, subcommand, args] = mockCosmosTx.mock.calls[0];
    expect([module, subcommand, args]).toEqual([
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, FQDN],
    ]);

    expect({ ...typed }).toEqual({
      lease_uuid: LEASE_UUID,
      service_name: '',
      custom_domain: FQDN,
      transactionHash: 'HASH',
      code: 0,
      confirmed: true,
    });
  });

  it('setItemCustomDomain (CLEAR arm) ships the same --clear/empty form as the stringly face', async () => {
    const cm = makeMockClientManager({ address: SENDER });
    mockCosmosTx.mockResolvedValue(txResult('set-item-custom-domain'));

    // Care-point (c): the clear arm ships `--clear` (the tuple) on both faces and echoes `asFqdn('')`
    // (the empty canonical clear form). The `--clear` → `customDomain: ''` translation itself is
    // pinned BELOW cosmosTx in buildBillingMessages (see header note).
    const typed = await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      clear: true,
    });

    const [, module, subcommand, args] = mockCosmosTx.mock.calls[0];
    expect([module, subcommand, args]).toEqual([
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, '--clear'],
    ]);

    expect(typed.custom_domain).toBe('');
    expect(typed.lease_uuid).toBe(LEASE_UUID);
  });

  it('stopApp passes the SAME (module, subcommand, args) tuple as stringly billing close-lease', async () => {
    const cm = makeMockClientManager({
      address: SENDER,
      queryClient: makeMockQueryClient({
        billing: {
          lease: {
            uuid: LEASE_UUID,
            state: LeaseState.LEASE_STATE_ACTIVE,
            providerUuid: 'p1',
          },
        },
      }),
    });
    mockCosmosTx.mockResolvedValue(txResult('close-lease'));

    const typed = await stopApp(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
    });

    const [, module, subcommand, args] = mockCosmosTx.mock.calls[0];
    expect([module, subcommand, args]).toEqual([
      'billing',
      'close-lease',
      [LEASE_UUID],
    ]);

    expect({ ...typed }).toEqual({
      lease_uuid: LEASE_UUID,
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'HASH',
      code: 0,
      confirmed: true,
    });
  });

  it('the typed face surfaces the SAME ManifestMCPErrorCode the stringly face would (TX_FAILED)', async () => {
    const cm = makeMockClientManager({
      address: SENDER,
      queryClient: makeMockQueryClient({
        billing: {
          lease: {
            uuid: LEASE_UUID,
            state: LeaseState.LEASE_STATE_ACTIVE,
            providerUuid: 'p1',
          },
        },
      }),
    });
    // The single `cosmosTx` chokepoint is shared by both faces; a chain-leg TX_FAILED propagates
    // identically through the typed fn and a direct stringly `cosmosTx` call.
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Transaction billing close-lease failed with code 5: lease not found',
      ),
    );

    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: asLeaseUuid(LEASE_UUID) }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
    await expect(
      cosmosTx(cm as never, 'billing', 'close-lease', [LEASE_UUID], true),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
  });
});
