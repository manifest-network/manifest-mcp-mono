import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getSupportedModules, getTxHandler } from '../modules.js';
import { ManifestMCPErrorCode } from '../types.js';
import { routeBankTransaction } from './bank.js';
import { routeStakingTransaction } from './staking.js';
import {
  assertExplicitFeeWithinCeiling,
  resolveTxFeeAndMemo,
} from './utils.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const RECIPIENT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const VALOPER = 'manifestvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0apzj780';

const EXPLICIT_FEE = {
  amount: [{ denom: 'umfx', amount: '4242' }],
  gas: '123456',
};

function makeMockSigningClient() {
  return {
    signAndBroadcast: vi.fn().mockResolvedValue({
      code: 0,
      transactionHash: 'ABCD1234',
      height: 100,
      gasUsed: 50000n,
      gasWanted: 100000n,
    }),
    // Fails loudly: an explicit fee must never reach the simulate leg.
    simulate: vi
      .fn()
      .mockRejectedValue(new Error('simulate must not be called')),
  } as never;
}

/** Drop `//` and conventional block-comment lines before source matching. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*')
      );
    })
    .join('\n');
}

/**
 * ENG-665. `cosmosTx` accepts `txExtras` and passes it as the 8th argument to the
 * registered handler, but 13 of the 14 route functions declared only six
 * parameters. A JS call with more arguments than the callee declares is legal
 * and `TxHandler` marks the trailing params optional, so an explicit fee or memo
 * was dropped in total silence — and because `cosmos.ts` skips building
 * `TxOptions` whenever a fee is supplied, the handler then called `buildGasFee`
 * with no options, which returns `'auto'`. Supplying a fee was therefore the one
 * path that discarded the fee AND disabled the ENG-556 gas ceiling.
 *
 * These guards are derived from the module registry and the source tree rather
 * than hand-listed, so a newly added tx module cannot reintroduce the gap by
 * simply not being added to a list.
 */
describe('ENG-665 — txExtras reaches every tx route', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  describe('registry-derived: every registered handler declares txExtras', () => {
    // Derived from the registry's own accessor, not a hand-maintained list, so
    // a module added to TX_MODULES is covered here the moment it is registered.
    const txModules = Object.keys(getSupportedModules().tx);

    it('covers a non-trivial number of modules (guards against an empty sweep)', () => {
      expect(txModules.length).toBeGreaterThanOrEqual(14);
    });

    it.each(txModules)(
      '%s handler declares all 8 positional parameters',
      (name) => {
        // `Function.length` counts parameters before the first default/rest.
        // TypeScript optional params compile to plain params, so a handler that
        // omits `context` / `txExtras` reports 6 here — exactly the pre-fix
        // shape. This is the check that fails when a new module forgets them.
        expect(getTxHandler(name).length).toBe(8);
      },
    );
  });

  describe('source-derived: every route file resolves fee and memo centrally', () => {
    const routeFiles = readdirSync(here).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test-d.ts') &&
        f !== 'utils.ts' &&
        f !== 'index.ts' &&
        f !== 'types.ts',
    );

    it('found the route files', () => {
      expect(routeFiles.length).toBeGreaterThanOrEqual(14);
    });

    it.each(routeFiles)(
      '%s calls resolveTxFeeAndMemo, never buildGasFee directly',
      (file) => {
        const src = stripComments(readFileSync(join(here, file), 'utf8'));
        if (!src.includes('Transaction(')) return; // not a route module

        expect(src).toContain('resolveTxFeeAndMemo(');
        // Calling buildGasFee directly bypasses the FEE-WINS branch, which is
        // how the fee got dropped in the first place.
        expect(src).not.toMatch(/\bawait buildGasFee\(/);
      },
    );
  });

  describe('behavioural: the supplied fee and memo reach the signed tx', () => {
    it('bank send honours an explicit fee and memo', async () => {
      const client = makeMockSigningClient();
      await routeBankTransaction(
        client,
        SENDER,
        'send',
        [RECIPIENT, '1000umfx'],
        true,
        undefined,
        undefined,
        { fee: EXPLICIT_FEE, memo: 'explicit-memo' },
      );

      const call = (
        client as unknown as {
          signAndBroadcast: { mock: { calls: unknown[][] } };
        }
      ).signAndBroadcast.mock.calls[0];
      expect(call[2]).toEqual(EXPLICIT_FEE);
      expect(call[3]).toBe('explicit-memo');
    });

    it('staking delegate honours an explicit fee and memo', async () => {
      const client = makeMockSigningClient();
      await routeStakingTransaction(
        client,
        SENDER,
        'delegate',
        [VALOPER, '1000umfx'],
        true,
        undefined,
        undefined,
        { fee: EXPLICIT_FEE, memo: 'explicit-memo' },
      );

      const call = (
        client as unknown as {
          signAndBroadcast: { mock: { calls: unknown[][] } };
        }
      ).signAndBroadcast.mock.calls[0];
      expect(call[2]).toEqual(EXPLICIT_FEE);
      expect(call[3]).toBe('explicit-memo');
    });

    it('an explicit memo overrides the one parsed from --memo', async () => {
      const client = makeMockSigningClient();
      await routeBankTransaction(
        client,
        SENDER,
        'send',
        [RECIPIENT, '1000umfx', '--memo', 'from-flag'],
        true,
        undefined,
        undefined,
        { fee: EXPLICIT_FEE, memo: 'from-txExtras' },
      );

      const call = (
        client as unknown as {
          signAndBroadcast: { mock: { calls: unknown[][] } };
        }
      ).signAndBroadcast.mock.calls[0];
      expect(call[3]).toBe('from-txExtras');
    });

    it('falls back to the built memo when txExtras carries none', async () => {
      const client = makeMockSigningClient();
      await routeBankTransaction(
        client,
        SENDER,
        'send',
        [RECIPIENT, '1000umfx', '--memo', 'from-flag'],
        true,
        undefined,
        undefined,
        { fee: EXPLICIT_FEE },
      );

      const call = (
        client as unknown as {
          signAndBroadcast: { mock: { calls: unknown[][] } };
        }
      ).signAndBroadcast.mock.calls[0];
      expect(call[3]).toBe('from-flag');
    });
  });

  describe('resolveTxFeeAndMemo', () => {
    it('returns the explicit fee without simulating', async () => {
      const client = makeMockSigningClient();
      const out = await resolveTxFeeAndMemo(
        client,
        SENDER,
        [],
        undefined,
        'built',
        { fee: EXPLICIT_FEE },
      );

      expect(out.fee).toEqual(EXPLICIT_FEE);
      expect(out.memo).toBe('built');
      expect(
        (client as unknown as { simulate: { mock: { calls: unknown[] } } })
          .simulate.mock.calls,
      ).toHaveLength(0);
    });

    it('feeds the effective memo to the simulate leg, not the built one', async () => {
      // The simulate and broadcast legs must sign the same bytes; simulating
      // with a different memo under-estimates gas for the tx actually sent.
      const simulate = vi.fn().mockResolvedValue(50_000);
      const client = { simulate } as never;

      await resolveTxFeeAndMemo(
        client,
        SENDER,
        [],
        {
          gasMultiplier: 1.5,
          gasPrice: undefined as never,
          maxGas: -1,
        } as never,
        'built',
        { memo: 'override' },
      ).catch(() => undefined); // calculateFee may reject on the stub gasPrice

      expect(simulate).toHaveBeenCalledWith(SENDER, [], 'override');
    });
  });

  describe('the ENG-556 ceiling still applies to an explicit fee', () => {
    it('rejects an explicit fee whose gas exceeds the ceiling', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling(
          { ...EXPLICIT_FEE, gas: '60000000' },
          50_000_000,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
        }),
      );
    });

    it('accepts an explicit fee at exactly the ceiling', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling(
          { ...EXPLICIT_FEE, gas: '50000000' },
          50_000_000,
        ),
      ).not.toThrow();
    });

    it('treats -1 as disabled', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling(
          { ...EXPLICIT_FEE, gas: '999999999999' },
          -1,
        ),
      ).not.toThrow();
    });

    it('still validates explicit gas when the upper bound is disabled', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling({ ...EXPLICIT_FEE, gas: '-1' }, -1),
      ).toThrowError(
        expect.objectContaining({ code: ManifestMCPErrorCode.INVALID_CONFIG }),
      );
    });

    it('does not interpret the denom-dependent fee.amount as a gas limit', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling(
          {
            amount: [{ denom: 'umfx', amount: '999999999999999' }],
            gas: '200000',
          },
          50_000_000,
        ),
      ).not.toThrow();
    });

    it.each([
      ['negative', '-1'],
      ['zero', '0'],
      ['hexadecimal', '0x2710'],
      ['scientific notation', '1e3'],
      ['fractional', '200000.5'],
      ['outside the safe-integer range', '9007199254740992'],
      ['non-numeric', 'lots'],
    ])('rejects a %s gas string rather than signing it', (_case, gas) => {
      expect(() =>
        assertExplicitFeeWithinCeiling({ ...EXPLICIT_FEE, gas }, 50_000_000),
      ).toThrowError(
        expect.objectContaining({ code: ManifestMCPErrorCode.INVALID_CONFIG }),
      );
    });

    it('rejects a null fee from an untyped caller with INVALID_CONFIG', () => {
      expect(() =>
        assertExplicitFeeWithinCeiling(null as never, 50_000_000),
      ).toThrowError(
        expect.objectContaining({ code: ManifestMCPErrorCode.INVALID_CONFIG }),
      );
    });
  });
});

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.test-d.ts')
    ) {
      return [];
    }
    return [path];
  });
}

function callsBroadcastGasResolver(source: string): boolean {
  return stripComments(source).includes('resolveBroadcastGasOptions(');
}

describe('ENG-744 — broadcast gas guards stay centralized', () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const entryPoints = productionTypeScriptFiles(sourceRoot)
    .map((file) => ({
      file: relative(sourceRoot, file),
      source: readFileSync(file, 'utf8'),
    }))
    .filter(
      ({ source }) =>
        source.includes('export async function cosmosTx(') ||
        (source.includes('TxCallOptions') &&
          /\.signAndBroadcast(?:Sync)?\(/.test(source)),
    );

  it('finds both existing broadcast entry-point shapes', () => {
    expect(entryPoints.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['line', '// resolveBroadcastGasOptions(config, call);'],
    [
      'block',
      ['/*', ' * resolveBroadcastGasOptions(config, call);', ' */'].join('\n'),
    ],
  ])('does not accept a resolver call in a %s comment', (_kind, source) => {
    expect(callsBroadcastGasResolver(source)).toBe(false);
  });

  it.each(entryPoints)(
    '$file resolves fee and simulation gas options through the shared guard',
    ({ source }) => {
      expect(callsBroadcastGasResolver(source)).toBe(true);
    },
  );
});
