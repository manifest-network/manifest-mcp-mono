import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Plan } from '../types.js';
import { type DenomMap, loadChainDenomMap } from './humanize-denom.js';
import { renderDeploymentPlan } from './render-deployment-plan.js';

const FIXTURES_ROOT = join(__dirname, '..', '..', '__fixtures__');

function readFixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8');
}

const knownMap: DenomMap = {
  lookup: (denom) =>
    denom === 'umfx'
      ? { symbol: 'MFX', exponent: 6 }
      : denom === 'upwr'
        ? { symbol: 'PWR', exponent: 6 }
        : null,
  raw: null,
};

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    summary: {
      format: 'single',
      serviceCount: 1,
      portCount: 1,
      envCount: 0,
      envKeys: [],
      images: ['nginx:1.27'],
    },
    readiness: {
      status: 'ok',
      reasons: [],
      suggestedActions: [],
      walletBalances: [{ denom: 'umfx', amount: '10000000' }],
      credits: {
        availableBalances: [{ denom: 'umfx', amount: '50000000000' }],
      },
      sku: {
        name: 'small',
        price: { denom: 'umfx', amount: '1000' },
      },
    },
    fees: {
      createLease: {
        coins: [{ denom: 'umfx', amount: '2300' }],
        gas: 142000,
      },
    },
    ...overrides,
  };
}

describe('renderDeploymentPlan', () => {
  describe('basic single-service rendering (no domain)', () => {
    it('renders the standard 5-line header (Image / Size / Manifest / meta_hash + SKU)', () => {
      const out = renderDeploymentPlan({
        plan: basePlan(),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain('DeploymentPlan');
      expect(out.text).toContain('  Image:                     nginx:1.27');
      expect(out.text).toContain('  Size:                      small');
      expect(out.text).toContain(
        '  Manifest:                  single, services=1, ports=1, env=0',
      );
      expect(out.text).toContain('  meta_hash:                 abcd1234');
    });

    it('omits the Custom domain line when no domain is set', () => {
      const out = renderDeploymentPlan({
        plan: basePlan(),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).not.toContain('Custom domain:');
    });

    it('uses single-line `Tx fee:` (no labels) when no domain is set', () => {
      const out = renderDeploymentPlan({
        plan: basePlan(),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain(
        '  Tx fee:                    0.0023 MFX (gas 142000)',
      );
      expect(out.text).not.toContain('Tx fee (create-lease)');
      expect(out.text).not.toContain('Total fee:');
    });
  });

  describe('custom-domain (two-tx layout)', () => {
    it('renders the Custom domain line + dual fee lines + Total fee', () => {
      const plan = basePlan({
        fees: {
          createLease: {
            coins: [{ denom: 'umfx', amount: '2300' }],
            gas: 142000,
          },
          setDomain: { coins: [{ denom: 'umfx', amount: '1100' }], gas: 60000 },
        },
      });
      const out = renderDeploymentPlan({
        plan,
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.testnet.manifest.app',
      });
      expect(out.text).toContain(
        '  Custom domain:             app.testnet.manifest.app -> single-service lease',
      );
      expect(out.text).toContain(
        '  Tx fee (create-lease):     0.0023 MFX (gas 142000)',
      );
      expect(out.text).toContain(
        '  Tx fee (set-domain):       0.0011 MFX (gas 60000)',
      );
      expect(out.text).toContain('  Total fee:                 0.0034 MFX');
    });

    it('renders "-> service <name>" target for stack-lease + customDomainService', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '2300' }],
              gas: 142000,
            },
            setDomain: {
              coins: [{ denom: 'umfx', amount: '1100' }],
              gas: 60000,
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'web.example.com',
        customDomainService: 'web',
      });
      expect(out.text).toContain(
        '  Custom domain:             web.example.com -> service web',
      );
    });

    it('renders "(not estimated — <reason>)" set-domain line for notEstimated sentinel', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '2300' }],
              gas: 142000,
            },
            setDomain: {
              notEstimated: true,
              reason: 'no representative lease for pre-broadcast simulation',
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.example.com',
      });
      expect(out.text).toContain(
        '  Tx fee (set-domain):       (not estimated — no representative lease for pre-broadcast simulation)',
      );
      // Total falls through to the placeholder when set-domain is not numeric.
      expect(out.text).toContain(
        '  Total fee:                 (partial — see fee lines above)',
      );
    });

    it('renders the policy-violation marker when setDomain is undefined despite hasDomain', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '2300' }],
              gas: 142000,
            },
            // setDomain undefined despite hasDomain — orchestrator bug we want loud.
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.example.com',
      });
      expect(out.text).toMatch(/Tx fee \(set-domain\):\s+\(not estimated/);
      expect(out.text).toContain(
        '  Total fee:                 (partial — see fee lines above)',
      );
    });
  });

  describe('fee humanization', () => {
    it('renders multi-coin createLease fee via humanizeBalances (comma-joined)', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [
                { denom: 'umfx', amount: '2300' },
                { denom: 'upwr', amount: '100' },
              ],
              gas: 200000,
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain(
        '  Tx fee:                    0.0023 MFX, 0.0001 PWR (gas 200000)',
      );
    });

    it('renders empty-coins fee as "(empty) (gas <n>)"', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: { createLease: { coins: [], gas: 0 } },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain(
        '  Tx fee:                    (empty) (gas 0)',
      );
    });

    it('falls back to raw on-chain denoms when no denomMap supplied', () => {
      const out = renderDeploymentPlan({
        plan: basePlan(),
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        // denomMap omitted; default EMPTY_DENOM_MAP applies.
      });
      expect(out.text).toContain(
        '  Tx fee:                    2300 umfx (gas 142000)',
      );
    });

    it('sums same-denom dual-fee total at max input precision', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '2300' }],
              gas: 142000,
            },
            setDomain: {
              coins: [{ denom: 'umfx', amount: '1100' }],
              gas: 60000,
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.example.com',
      });
      // 0.0023 + 0.0011 = 0.0034 (4 decimals from inputs)
      expect(out.text).toContain('  Total fee:                 0.0034 MFX');
    });

    it('joins different-denom dual-fee total with " + "', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              coins: [{ denom: 'umfx', amount: '2300' }],
              gas: 142000,
            },
            setDomain: {
              coins: [{ denom: 'upwr', amount: '100' }],
              gas: 60000,
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.example.com',
      });
      expect(out.text).toContain(
        '  Total fee:                 0.0023 MFX + 0.0001 PWR',
      );
    });

    // Copilot review fix (PR #58 r3250445951): same-denom sums must
    // preserve BigInt precision. The prior `sumHumanFees` parsed to
    // float64, losing precision past `Number.MAX_SAFE_INTEGER`
    // (2^53-1 ≈ 9.0e15). Realistic fees were tiny so the hit rate
    // was low; the invariant inconsistency was real and could
    // silently round. `sumFees` (the replacement) operates on the
    // underlying `FeeEstimate.coins` arrays via BigInt.
    it('preserves BigInt precision for same-denom amounts above 2^53', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          fees: {
            createLease: {
              // 2^53 + 1 in umfx — exact value Number cannot round-trip.
              coins: [{ denom: 'umfx', amount: '9007199254740993' }],
              gas: 142000,
            },
            setDomain: {
              // 2^53 + 1 in umfx.
              coins: [{ denom: 'umfx', amount: '9007199254740993' }],
              gas: 60000,
            },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
        customDomain: 'app.example.com',
      });
      // Exact BigInt sum: 9007199254740993 + 9007199254740993
      //                = 18014398509481986 (2^54 + 2).
      // Humanized via the umfx→MFX exponent (6):
      //   18014398509481986 / 10^6 = 18014398509.481986 MFX (exact).
      // Float64 sum would round to 18014398509481984 (lost the +2).
      expect(out.text).toContain(
        '  Total fee:                 18014398509.481986 MFX',
      );
      // Negative assertion: the rounded-by-float64 value must NOT
      // appear (would surface if `sumFees` regressed to numeric).
      expect(out.text).not.toContain('18014398509.481984');
    });
  });

  describe('readiness rendering', () => {
    it('renders SKU price per hour with humanization', () => {
      const out = renderDeploymentPlan({
        plan: basePlan(),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain(
        '  SKU price:                 0.001 MFX / hour',
      );
    });

    it('renders SKU "(unknown — ...)" when sku is null', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          readiness: { ...basePlan().readiness, sku: null },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain(
        '  SKU price:                 (unknown — SKU has no listed price)',
      );
    });

    it('renders Credits "none" when credits is null', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          readiness: { ...basePlan().readiness, credits: null },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain('  Credits:                   none');
    });

    it('renders Credits "(empty)" when availableBalances is empty array', () => {
      const out = renderDeploymentPlan({
        plan: basePlan({
          readiness: {
            ...basePlan().readiness,
            credits: { availableBalances: [] },
          },
        }),
        denomMap: knownMap,
        image: 'nginx:1.27',
        size: 'small',
        metaHash: 'abcd1234',
      });
      expect(out.text).toContain('  Credits:                   (empty)');
    });
  });

  describe('ENG-258 provider pin rendering', () => {
    it('renders the pinned provider when supplied', () => {
      const block = renderDeploymentPlan({
        plan: basePlan(),
        image: 'nginx',
        size: 'docker-micro',
        metaHash: 'abc',
        providerUuid: 'prov-2',
      });
      expect(block.text).toContain('Provider:');
      expect(block.text).toContain('prov-2');
    });

    it('omits the Provider line when providerUuid is not supplied', () => {
      const block = renderDeploymentPlan({
        plan: basePlan(),
        image: 'nginx',
        size: 'docker-micro',
        metaHash: 'abc',
      });
      expect(block.text).not.toContain('Provider:');
    });

    it('omits the Provider line when providerUuid is an empty string', () => {
      const block = renderDeploymentPlan({
        plan: basePlan(),
        image: 'nginx',
        size: 'docker-micro',
        metaHash: 'abc',
        providerUuid: '',
      });
      expect(block.text).not.toContain('Provider:');
    });
  });

  describe('byte-baseline parity', () => {
    it('matches expected output for 01-fast-path-active fixture', async () => {
      // Load the canonical chain-data fixture to drive humanization.
      const denomMap = await loadChainDenomMap(
        join(FIXTURES_ROOT, 'chain-data', 'testnet.json'),
      );

      // Build the typed Plan from fixture inputs. The byte-baseline contract
      // is on the render output, not the Plan-construction logic — so we
      // assemble Plan directly here. deploy-app.ts (commit B) will do this
      // composition at runtime.
      const plan: Plan = {
        summary: {
          format: 'single',
          serviceCount: 1,
          portCount: 1,
          envCount: 2,
          envKeys: ['NGINX_HOST', 'NGINX_PORT'],
          images: ['docker.io/library/nginx:1.27'],
        },
        readiness: {
          status: 'ok',
          reasons: [],
          suggestedActions: [],
          walletBalances: [{ denom: 'umfx', amount: '10000000' }],
          credits: {
            availableBalances: [{ denom: 'umfx', amount: '50000000000' }],
          },
          sku: {
            name: 'small',
            price: { denom: 'umfx', amount: '1000' },
          },
        },
        fees: {
          createLease: {
            coins: [{ denom: 'umfx', amount: '2300' }],
            gas: 142000,
          },
        },
      };

      const expected = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'expected-plan.txt',
      );
      const actual = renderDeploymentPlan({
        plan,
        denomMap,
        image: 'docker.io/library/nginx:1.27',
        size: 'small',
        metaHash:
          '6e1670ec56b86c3feea27755205c5f9972dc3e80e58a6936a17e2c63953e6baf',
      });
      // Fixture has trailing newline from CJS console.log; strip for compare.
      expect(actual.text).toBe(expected.replace(/\n$/, ''));
    });

    it('matches expected output for 03-partial-success-set-domain-failed fixture', async () => {
      const denomMap = await loadChainDenomMap(
        join(FIXTURES_ROOT, 'chain-data', 'testnet.json'),
      );

      const plan: Plan = {
        summary: {
          format: 'single',
          serviceCount: 1,
          portCount: 1,
          envCount: 2,
          envKeys: ['NGINX_HOST', 'NGINX_PORT'],
          images: ['docker.io/library/nginx:1.27'],
        },
        readiness: {
          status: 'ok',
          reasons: [],
          suggestedActions: [],
          walletBalances: [{ denom: 'umfx', amount: '10000000' }],
          credits: {
            availableBalances: [{ denom: 'umfx', amount: '50000000000' }],
          },
          sku: {
            name: 'small',
            price: { denom: 'umfx', amount: '1000' },
          },
        },
        fees: {
          createLease: {
            coins: [{ denom: 'umfx', amount: '2300' }],
            gas: 142000,
          },
          setDomain: {
            coins: [{ denom: 'umfx', amount: '1100' }],
            gas: 60000,
          },
        } satisfies Plan['fees'],
      };

      const expected = readFixture(
        'skills',
        'deploy-app',
        '03-partial-success-set-domain-failed',
        'expected-plan.txt',
      );
      const actual = renderDeploymentPlan({
        plan,
        denomMap,
        image: 'docker.io/library/nginx:1.27',
        size: 'small',
        metaHash:
          '6e1670ec56b86c3feea27755205c5f9972dc3e80e58a6936a17e2c63953e6baf',
        customDomain: 'app.testnet.manifest.app',
      });
      expect(actual.text).toBe(expected.replace(/\n$/, ''));
    });
  });
});
