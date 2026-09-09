# Architecture guard fixtures

These deliberately invalid sources exercise the production rules in `.dependency-cruiser.cjs`.
They live outside workspace source and are never compiled or published. The fixture config
changes only the rules' source anchors; it preserves their target matchers and resolver.

Run from the repository root:

```bash
npx depcruise tools/depcruise-fixtures --config tools/depcruise-fixtures/.dependency-cruiser.fixtures.cjs
```

Each `<workspace>-src` directory contains an import forbidden by that workspace's allowlist in
`tools/depcruise/workspace-dag.cjs`. All nine workspaces are covered. The CLI package has no root
barrel, so imports targeting it use its `bootstrap` subpath. Package names resolve to source
through `tools/depcruise/resolve.cjs`; this must continue to work before any package is built.

The other fixtures cover these boundaries:

- `cycle-src/a.ts` and `b.ts` form a runtime import cycle.
- `pkg-src` bypasses the canonical generated-type export boundary.
- `browser-src` imports Node builtins and Undici statically from browser source.
- `example-src` imports an unapproved npm dependency and reaches past the public SDK.

`packages/sdk/scripts/cast-guard.test.ts` requires a failing fixture and a production probe for
every rule. Its production probes check all 72 directed pairs of distinct workspaces, including
allowed pairs and actual source resolution, plus every other boundary and a circular import.
The probes are written together, cruised once with the real production config, and removed in
`finally`. A separate check requires the real project graph to pass without violations and the
root TypeScript reference index to include every workspace.

Production dependency direction applies to runtime and type imports. Test files are exempt from
package direction so integration tests can exercise another package's public API. Production
module cycles are prohibited, including type-only cycles; executable registration, static command
metadata, and query-client types are separated to avoid existing registration/type cycles.

Brand casts cannot be expressed as import edges. Their existing source-level checks remain in
`cast-guard.test.ts` alongside the LCD read-path constructor check.
