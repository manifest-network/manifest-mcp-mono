import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bundleForBrowser,
  findNodeOnlyImports,
  hasWebCryptoFallback,
  unallowedBrowserWarnings,
} from '../../../tools/browser-bundle.js';

/**
 * Fail-closed browser build of the compose-only acceptance example (Task B4; ENG-309; spec §9).
 *
 * rolldown `platform:browser` does NOT hard-throw on an unresolved node builtin — it emits an
 * `UNRESOLVED_IMPORT` warning and externalizes the specifier. So the PRIMARY guard captures those
 * warnings and asserts the set is empty MINUS a documented allowlist; any NEW unresolved node
 * builtin (a regression that drags `node:`/`fs`/`undici`/… into the compose-only graph) fails here.
 *
 * The lone allowlisted warning is `@cosmjs/crypto`'s guarded optional `require("crypto")`: it is
 * wrapped in a `try`-fallback that degrades to a pure-JS implementation in browsers (the same shape
 * as core's guarded fetch), so it is browser-SAFE even though it warns. The §9 claim is therefore
 * "no UNGUARDED node-only modules", not the literal "no node builtins" (false today with the pinned
 * cosmjs — see the spec §9 note + B0).
 *
 * The SECONDARY guard scans emitted import/require specifiers against Node's complete builtin list,
 * including rolldown's `__require(...)` CJS form. The two measured guarded CosmJS crypto fallbacks
 * are attributed by their emitted source regions; no package-wide or specifier-wide exception exists.
 *
 * The POSITIVE guard proves the Web-Crypto path actually shipped (the cosmjs guarded crypto degrades
 * to `globalThis.crypto`/`getRandomValues`), so a green build is a real browser bundle, not a node shim.
 */

describe('sdk-acceptance browser build (fail-closed; no UNGUARDED node-only)', () => {
  it('bundles for the browser with no unallowed node-only resolution + clean chunk', async () => {
    const { code, unresolvedWarnings } = await bundleForBrowser(
      new URL('../dist/main.js', import.meta.url).pathname,
    );

    expect(unallowedBrowserWarnings(unresolvedWarnings)).toEqual([]);
    const leaks = findNodeOnlyImports(code);
    expect(leaks, JSON.stringify(leaks, null, 2)).toEqual([]);

    // POSITIVE: prove the Web-Crypto path shipped (not a node-shim) — the cosmjs guarded crypto degrades here.
    expect(hasWebCryptoFallback(code)).toBe(true);
  });

  it('the /reads tree-shaken chunk pulls NO tx/signer/codec symbols (tree-shakability belt)', async () => {
    // Resolve the SDK /reads subpath via the installed package map (hoist-agnostic — the workspace
    // hoists @manifest-network/manifest-sdk to the repo-root node_modules, so a literal
    // ../node_modules/... path would miss it). import.meta.resolve honors the `import` condition.
    const readsPath = fileURLToPath(
      import.meta.resolve('@manifest-network/manifest-sdk/reads'),
    );
    const { code } = await bundleForBrowser(readsPath);
    for (const sym of [
      'executeTx',
      'signArbitraryWithAmino',
      'MsgFundCredit',
      'fundCredits',
    ])
      expect(code.includes(sym), sym).toBe(false);
  });
});
