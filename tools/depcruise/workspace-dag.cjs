const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** Architectural dependencies, independently specified rather than inferred from package.json. */
const WORKSPACE_DEPENDENCIES = {
  core: [],
  chain: ['core'],
  lease: ['core'],
  fred: ['core'],
  cosmwasm: ['core'],
  'agent-core': ['core', 'fred'],
  agent: ['core', 'agent-core'],
  sdk: ['core', 'fred', 'agent-core'],
  node: ['core', 'chain', 'lease', 'fred', 'cosmwasm', 'agent'],
};

const packages = join(__dirname, '..', '..', 'packages');
const actual = readdirSync(packages)
  .filter((name) => existsSync(join(packages, name, 'package.json')))
  .sort();
const covered = Object.keys(WORKSPACE_DEPENDENCIES).sort();
if (JSON.stringify(actual) !== JSON.stringify(covered)) {
  throw new Error(
    'Workspace DAG does not cover every package. Explicitly update tools/depcruise/workspace-dag.cjs when adding or removing a workspace.',
  );
}

const workspaceRules = Object.entries(WORKSPACE_DEPENDENCIES).map(
  ([name, dependencies]) => ({
    name: `workspace-${name}-dependencies`,
    severity: 'error',
    comment: `${name} may depend only on ${dependencies.join(', ') || 'itself'} within the workspace.`,
    // Integration tests may exercise another package's public API; shipped source stays directional.
    from: { path: `^packages/${name}/src/`, pathNot: '\\.(test|test-d)\\.ts$' },
    to: {
      path: '^packages/[^/]+/src/',
      pathNot: `^packages/(${[name, ...dependencies].join('|')})/src/`,
    },
  }),
);

module.exports = { WORKSPACE_DEPENDENCIES, workspaceRules };
