import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

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
 * The SECONDARY guard scans the emitted chunk with an IMPORT-SPECIFIER-ANCHORED regex (not a bare
 * substring): a bare `node:` substring false-fails on Telescope's benign `base:{node:…}` object key,
 * and a bare `crypto` would false-fail on the allowlisted cosmjs guarded `require("crypto")` that
 * legitimately appears in the chunk (it is handled BY SOURCE by the PRIMARY warning-capture). So the
 * scan is anchored to `from`/`require(`/`import(` specifiers and excludes bare `crypto`.
 *
 * The POSITIVE guard proves the Web-Crypto path actually shipped (the cosmjs guarded crypto degrades
 * to `globalThis.crypto`/`getRandomValues`), so a green build is a real browser bundle, not a node shim.
 */

// @cosmjs/crypto's guarded optional require("crypto") — degrades to pure-JS in browsers (B0 allowlist).
const ALLOWLISTED = [/@cosmjs\/crypto/];

/**
 * Bundle `input` for the browser and return the joined chunk code (+ captured rolldown warnings).
 *
 * Centralizes the rolldown API surface the plan flags as version-sensitive (the `onLog` signature,
 * `generate({ format: 'esm' })`, `close()`, chunk-filtering) so both tests share one call site. When
 * `onLog` is supplied it is forwarded to rolldown; the helper itself never inspects warnings — callers
 * filter the returned set.
 */
async function bundleChunk(
  input: string,
  onLog?: (level: string, log: { code?: string; message?: string }) => void,
): Promise<{ code: string }> {
  const bundle = await rolldown({ input, platform: 'browser', onLog });
  let code: string;
  try {
    const { output } = await bundle.generate({ format: 'esm' });
    code = output
      .filter((o) => o.type === 'chunk')
      .map((o) => (o as { code: string }).code)
      .join('\n');
  } finally {
    await bundle.close(); // always close, even if generate() rejects (matches browser-resolve.test.ts)
  }
  return { code };
}

describe('sdk-acceptance browser build (fail-closed; no UNGUARDED node-only)', () => {
  it('bundles for the browser with no unallowed node-only resolution + clean chunk', async () => {
    const warnings: string[] = [];
    const { code } = await bundleChunk(
      new URL('../dist/main.js', import.meta.url).pathname,
      (_level, log) => {
        if (log.code === 'UNRESOLVED_IMPORT')
          warnings.push(log.message ?? String(log));
      },
    );

    const unallowed = warnings.filter(
      (w) => !ALLOWLISTED.some((re) => re.test(w)),
    );
    expect(unallowed).toEqual([]); // PRIMARY: fail-closed — any NEW unresolved node builtin fails here.

    // SECONDARY: import-specifier-anchored scan (NOT a bare substring) for a node-only import/require
    // + the browserify SHIM names. The `node:` prefix is COMBINED with the builtin name (`node:[a-z_/]+`)
    // rather than standing alone — a bare `node:` alternative matches the `node:` of `node:fs` but then
    // demands the closing quote (which is `f`, not `"`), so it would MISS the project's `node:`-prefixed
    // imports (the dominant leak shape). Bare `crypto` is intentionally NOT scanned — the allowlisted
    // @cosmjs/crypto guarded `require("crypto")` legitimately appears and is handled BY SOURCE by the
    // PRIMARY warning-capture; scanning `crypto` here would false-fail.
    const leak = code.match(
      /(?:from|require\(|import\()\s*['"](?:node:[a-z_/]+|fs|path|http|https|net|tls|stream|os|async_hooks|undici|ws|crypto-browserify|process\/browser|stream-browserify)['"]/,
    );
    expect(leak, leak?.[0]).toBeNull();

    // POSITIVE: prove the Web-Crypto path shipped (not a node-shim) — the cosmjs guarded crypto degrades here.
    expect(/globalThis\.crypto|crypto\.subtle|getRandomValues/.test(code)).toBe(
      true,
    );
  });

  it('the /reads tree-shaken chunk pulls NO tx/signer/codec symbols (tree-shakability belt)', async () => {
    // Resolve the SDK /reads subpath via the installed package map (hoist-agnostic — the workspace
    // hoists @manifest-network/manifest-sdk to the repo-root node_modules, so a literal
    // ../node_modules/... path would miss it). import.meta.resolve honors the `import` condition.
    const readsPath = fileURLToPath(
      import.meta.resolve('@manifest-network/manifest-sdk/reads'),
    );
    const { code } = await bundleChunk(readsPath);
    for (const sym of [
      'executeTx',
      'signArbitraryWithAmino',
      'MsgFundCredit',
      'fundCredits',
    ])
      expect(code.includes(sym), sym).toBe(false);
  });
});
