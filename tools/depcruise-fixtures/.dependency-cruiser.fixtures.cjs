/**
 * Meta-test config for the dependency-cruiser known-bad fixtures (ENG-309).
 *
 * Proves the PRODUCTION rules' `to`-side matchers (the load-bearing part) actually bite. It reuses
 * the EXACT `to` matchers from `../../.dependency-cruiser.cjs` (so the proof can't drift from the
 * rule it proves) and re-anchors `from` to this fixtures directory — the fixtures are NOT under
 * `packages/`, so the production `from: ^packages…` anchors would never match them. The fixtures
 * step (packages/sdk/scripts/cast-guard.test.ts) cruises THIS directory with THIS config and
 * asserts both rules fire; the real tree is cruised separately with the production config and MUST
 * pass clean.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
const production = require('../../.dependency-cruiser.cjs');

const byName = (name) => {
  const rule = production.forbidden.find((r) => r.name === name);
  if (!rule) throw new Error(`fixtures config out of sync: production rule '${name}' not found`);
  return rule;
};

const chokepoint = byName('manifestjs-types-chokepoint');
const staticNode = byName('no-static-node-in-browser-src');
const staticUndiciWs = byName('no-static-undici-ws-in-browser-src');

module.exports = {
  forbidden: [
    {
      name: 'manifestjs-types-chokepoint',
      severity: 'error',
      from: { path: '^pkg-src/' },
      // Reuse the production `to` matcher verbatim — this is what proves the matcher bites.
      to: chokepoint.to,
    },
    {
      name: 'no-static-node-in-browser-src',
      severity: 'error',
      from: { path: '^browser-src/' },
      to: staticNode.to,
    },
    {
      name: 'no-static-undici-ws-in-browser-src',
      severity: 'error',
      from: { path: '^browser-src/' },
      to: staticUndiciWs.to,
    },
  ],
  options: {
    tsConfig: { fileName: '../../tsconfig.base.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  },
};
