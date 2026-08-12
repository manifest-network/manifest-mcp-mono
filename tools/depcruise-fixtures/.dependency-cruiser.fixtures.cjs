/**
 * Meta-test config for the dependency-cruiser known-bad fixtures (ENG-309, ENG-641).
 *
 * Proves the PRODUCTION rules' `to`-side matchers (the load-bearing part) actually bite. It reuses
 * the EXACT `to` matchers from `../../.dependency-cruiser.cjs` (so the proof can't drift from the
 * rule it proves) and re-anchors `from` to this fixtures directory — the fixtures are NOT under
 * `packages/`, so the production `from: ^packages…` anchors would never match them. The fixtures
 * step (packages/sdk/scripts/cast-guard.test.ts) cruises these directories with THIS config and
 * asserts every rule fires by NAME; the real tree is cruised separately with the production config
 * and MUST pass clean.
 *
 * CRUISED FROM THE REPO ROOT, not from this directory (ENG-641). The DAG rules' `to` matchers are
 * anchored `^packages/(fred|agent-core)/src`, and dependency-cruiser reports module paths relative
 * to cwd — from here the aliased target would come back as `../../packages/fred/src/index.ts` and
 * match nothing. Running from the root also lets `options` be the production block VERBATIM, which
 * makes production the single source of truth for resolution behaviour as well as for the matchers.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
const production = require('../../.dependency-cruiser.cjs');

const byName = (name) => {
  const rule = production.forbidden.find((r) => r.name === name);
  if (!rule) throw new Error(`fixtures config out of sync: production rule '${name}' not found`);
  return rule;
};

const coreToFredOrAgentCore = byName('no-core-to-fred-or-agentcore');
const fredToAgentCore = byName('no-fred-to-agentcore');
const chokepoint = byName('manifestjs-types-chokepoint');
const staticNode = byName('no-static-node-in-browser-src');
const staticUndiciWs = byName('no-static-undici-ws-in-browser-src');
const exampleComposeOnly = byName('example-composes-only-sdk');
const exampleToNonSdk = byName('no-example-to-non-sdk-package');

// `from` anchors are repo-root-relative because the cruise runs from the repo root (see header).
const FIXTURES = 'tools/depcruise-fixtures';

module.exports = {
  forbidden: [
    {
      name: 'no-core-to-fred-or-agentcore',
      severity: 'error',
      // `core-src/` stands in for `packages/core/src`, which the production `from` anchor requires.
      from: { path: `^${FIXTURES}/core-src/` },
      // Reuse the production `to` matcher verbatim — this is what proves the matcher bites.
      to: coreToFredOrAgentCore.to,
    },
    {
      name: 'no-fred-to-agentcore',
      severity: 'error',
      from: { path: `^${FIXTURES}/fred-src/` },
      to: fredToAgentCore.to,
    },
    {
      name: 'manifestjs-types-chokepoint',
      severity: 'error',
      from: { path: `^${FIXTURES}/pkg-src/` },
      to: chokepoint.to,
    },
    {
      name: 'no-static-node-in-browser-src',
      severity: 'error',
      from: { path: `^${FIXTURES}/browser-src/` },
      to: staticNode.to,
    },
    {
      name: 'no-static-undici-ws-in-browser-src',
      severity: 'error',
      from: { path: `^${FIXTURES}/browser-src/` },
      to: staticUndiciWs.to,
    },
    {
      name: 'example-composes-only-sdk',
      severity: 'error',
      // Re-anchor `from` to the fixtures dir (the production `from: ^examples/[^/]+/src` would never
      // match here); reuse the production `to` ALLOWLIST matcher verbatim — that is what proves it bites.
      from: { path: `^${FIXTURES}/example-src/` },
      to: exampleComposeOnly.to,
    },
    {
      name: 'no-example-to-non-sdk-package',
      severity: 'error',
      from: { path: `^${FIXTURES}/example-src/` },
      to: exampleToNonSdk.to,
    },
  ],
  // Production options verbatim: same tsconfig, same `tsPreCompilationDeps`, and — load-bearing —
  // the same `webpackConfig` package-name-to-`src` alias, without which the DAG fixtures below would
  // resolve into `dist/` (or not at all) and the rules under test would go quiet again.
  options: production.options,
};
