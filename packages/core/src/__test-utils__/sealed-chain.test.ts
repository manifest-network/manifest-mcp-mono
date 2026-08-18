// The executable half of ENG-713.
//
// `makeSealedClientManager` claims that sealing `ctx.chain` contains every core broadcast. That is a
// claim about a MECHANISM, so it is proved by running the real broadcasters against a sealed chain
// rather than by maintaining a list of which core exports broadcast — a list rots the moment core
// grows a helper, and the core barrel has 85 runtime exports, so classifying all of them (ENG-715's
// approach for the small `provider.ts` module) would be noise.
//
// This file lives in CORE on purpose. Core has no barrel mock, so the imports below ARE the real
// modules, including the module-local `import { cosmosTx } from '../cosmos.js'` that no `vi.mock` of
// the core barrel can reach — the exact edge ENG-713 is about. A fred-side test can only prove the
// seal is INSTALLED in that file (see `restoreApp.test.ts`); it cannot reach these modules at all,
// because core exposes no wildcard subpath export.

import { describe, expect, it, vi } from 'vitest';
import { asFqdn, asLeaseUuid } from '../brands.js';
import { executeTx } from '../tools/executeTx.js';
import { fundCredits } from '../tools/fundCredits.js';
import { setItemCustomDomain } from '../tools/setItemCustomDomain.js';
import { stopApp } from '../tools/stopApp.js';
import {
  makeSealedClientManager,
  makeTxCtx,
  SEALED_CHAIN_METHODS,
  sealedChainMessage,
} from './mocks.js';

const LEASE = asLeaseUuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

/** Drive a broadcaster against a fully sealed chain and return whatever it threw. */
async function runSealed(fn: () => Promise<unknown>): Promise<Error> {
  return await fn().then(
    () => new Error('NO THROW — the sealed chain was never reached'),
    (e: unknown) => e as Error,
  );
}

describe('makeSealedClientManager (ENG-713)', () => {
  it('seals every public CosmosClientManager method, each throwing by name', () => {
    const chain = makeSealedClientManager() as unknown as Record<
      string,
      () => unknown
    >;
    for (const method of SEALED_CHAIN_METHODS) {
      expect(vi.isMockFunction(chain[method]), `${method} is not sealed`).toBe(
        true,
      );
      expect(() => chain[method]?.()).toThrow(sealedChainMessage(method));
    }
  });

  it('lets `allow` opt a method back in, and leaves the rest sealed', async () => {
    const acquireRateLimit = vi.fn().mockResolvedValue(undefined);
    const chain = makeSealedClientManager({ acquireRateLimit });

    await expect(chain.acquireRateLimit()).resolves.toBeUndefined();
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
    expect(() => chain.getConfig()).toThrow(sealedChainMessage('getConfig'));
  });

  // The `vi.fn(impl)` CONSTRUCTOR form matters: `clearAllMocks` is common in a `beforeEach`, and
  // `mockImplementation` would be wiped by it, silently un-sealing the chain mid-suite.
  it('survives vi.clearAllMocks(), which a beforeEach commonly calls', () => {
    const chain = makeSealedClientManager();
    vi.clearAllMocks();
    expect(() => chain.getConfig()).toThrow(sealedChainMessage('getConfig'));
  });
});

describe('the seal contains real core broadcasters (ENG-713)', () => {
  // The three helpers below reach `cosmosTx` through their own module-local '../cosmos.js' import.
  // Measured before the fix: with only `cosmosTx` stubbed at the barrel, the spy recorded 0 calls
  // while the REAL cosmosTx threw `TypeError: clientManager.getConfig is not a function` from
  // inside. These assert that the same escape now fails by name instead.
  it.each([
    [
      'setItemCustomDomain',
      () =>
        setItemCustomDomain(makeTxCtx({ chain: makeSealedClientManager() }), {
          leaseUuid: LEASE,
          customDomain: asFqdn('app.example.com'),
        }),
    ],
    [
      'stopApp',
      () =>
        stopApp(makeTxCtx({ chain: makeSealedClientManager() }), {
          leaseUuid: LEASE,
        }),
    ],
    [
      'fundCredits',
      () =>
        fundCredits(makeTxCtx({ chain: makeSealedClientManager() }), {
          amount: '1000umfx',
        }),
    ],
  ])('%s — the internal ../cosmos.js edge', async (_name, call) => {
    const err = await runSealed(call);
    // Some helpers re-wrap (enrichTxError interpolates, stopApp's queryLease wraps as QUERY_FAILED),
    // so match on the marker surviving inside the message rather than on the error identity.
    expect(err.message).toContain('is sealed in this test (ENG-713)');
  });

  // executeTx is the reason the seam beats enumerating `cosmosTx` callers: it never imports
  // cosmosTx at all, and broadcasts straight off ctx.chain.getBroadcastClient().
  it('executeTx — the parallel direct-broadcast path, which imports no cosmosTx', async () => {
    const err = await runSealed(() =>
      executeTx(makeTxCtx({ chain: makeSealedClientManager() }), [
        { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: new Uint8Array() },
      ]),
    );
    expect(err.message).toContain('is sealed in this test (ENG-713)');
  });
});
