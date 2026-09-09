/** Re-anchor production rules to known-bad fixtures while retaining their target matchers. */
const production = require('../../.dependency-cruiser.cjs');
const anchors = {
  'no-production-cycles': 'cycle-src',
  'manifestjs-types-chokepoint': 'pkg-src',
  'no-static-node-in-browser-src': 'browser-src',
  'no-static-undici-ws-in-browser-src': 'browser-src',
  'example-composes-only-sdk': 'example-src',
  'no-example-to-non-sdk-package': 'example-src',
};
module.exports = {
  forbidden: production.forbidden.map((rule) => {
    const directory = rule.name.startsWith('workspace-')
      ? rule.name.slice('workspace-'.length, -'-dependencies'.length) + '-src'
      : anchors[rule.name];
    if (!directory) throw new Error(`No fixture anchor for ${rule.name}`);
    return { ...rule, from: { path: `^tools/depcruise-fixtures/${directory}/` } };
  }),
  options: production.options,
};
