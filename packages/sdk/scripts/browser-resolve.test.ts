import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

/**
 * The REAL `default:null`-chain guard (B1-secondary; ENG-309).
 *
 * The Node-run barrel-hygiene tests (`../src/index.test.ts`) resolve under the `node`
 * condition, so they PASS even if a browser-safe barrel statically pulls a module whose
 * browser resolution is `default:null` (core's `/guarded-fetch`, agent-core's
 * `/guarded-fetch`). That failure is invisible to vitest and to dependency-cruiser
 * (`doNotFollow:node_modules`). The ONLY thing that catches it is an actual
 * browser-condition bundle: `platform:'browser'` defaults `conditionNames` to
 * `['import','browser','default']` (the `node` condition is NOT applied), so a
 * `default:null` mapping throws a resolution error mid-bundle.
 *
 * This bundles EACH browser-safe SDK subpath entry from `dist/` and asserts the build
 * SUCCEEDS. `/node` is intentionally EXCLUDED — it is the one node-only entry. Requires
 * `dist/` built first (`npm run build -w @manifest-network/manifest-sdk`).
 *
 * (The full browser BUILD + node-builtin string-scan + size budget stay Plan B; this is
 * the minimal fence-verification.)
 */
const BROWSER_SAFE = [
  'index',
  'reads',
  'catalog',
  'deploy',
  'orchestration',
] as const;

describe('manifest-sdk browser resolution (no default:null chain)', () => {
  for (const entry of BROWSER_SAFE) {
    const label = entry === 'index' ? '.' : `/${entry}`;
    it(`${label} resolves under browser conditions`, async () => {
      const bundle = await rolldown({
        input: new URL(`../dist/${entry}.js`, import.meta.url).pathname,
        // platform:'browser' => resolve.conditionNames defaults to ['import','browser','default']
        // for import statements; the 'node' condition is NOT applied, so a browser-safe barrel
        // that ever pulls a `{node,default:null}` subpath throws a resolution error here.
        platform: 'browser',
      });
      try {
        await expect(bundle.generate({ format: 'esm' })).resolves.toBeDefined();
      } finally {
        await bundle.close(); // always close, even if generate() rejects (matches the /node control)
      }
    });
  }

  // POSITIVE CONTROL (MAJOR-3): the whole guard rests on rolldown HARD-FAILING a `default:null`
  // browser resolution. `/node` IS such an entry (it re-exports core's `{node,default:null}`
  // /guarded-fetch). Bundling it under browser conditions MUST reject — if a future rolldown/tsdown
  // bump ever demotes that to a soft warning, this fails LOUDLY instead of letting the 5 positive
  // assertions above pass vacuously.
  it('/node REJECTS under browser conditions (proves the default:null guard still bites)', async () => {
    await expect(
      (async () => {
        const bundle = await rolldown({
          input: new URL('../dist/node.js', import.meta.url).pathname,
          platform: 'browser',
        });
        try {
          await bundle.generate({ format: 'esm' });
        } finally {
          await bundle.close();
        }
      })(),
    ).rejects.toThrow();
  });
});
