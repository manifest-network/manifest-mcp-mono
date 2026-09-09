# Published dependency security (ENG-805 / ENG-808)

The v0.22.0 packages permit vulnerable Axios and protobufjs versions in a fresh
application install. The monorepo's overrides do not travel with the libraries:
[npm considers overrides only in the consuming application's root package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).
The release consumer check therefore fails until the published dependency chain
is repaired. A passing monorepo audit does not close ENG-805 F01.

## Reproduce the consumer check

Build the release artifacts, then run:

```sh
npm run build
node --test scripts/check-consumers.test.mjs
node scripts/check-consumers.mjs
```

The last command downloads public dependencies and queries npm's advisory service.
It packs every publishable workspace, creates separate SDK and Node CLI consumers
outside the workspace, and installs with lifecycle scripts disabled. Each consumer
lists only its reachable runtime and required-peer sibling tarballs; these provide
the unpublished release versions without modifying their dependency declarations.
External dependencies resolve from the registry. No root overrides, workspace
symlinks, or repository lockfile are copied.

The check verifies tarball integrity and rejects duplicate sibling installations,
validates npm's installed dependency tree, audits production/optional/peer
dependencies, imports public runtime entries, and starts each CLI through its
invalid-subcommand usage path. It does not read a wallet, sign, or contact a chain
or provider. These import/CLI checks complement the repository's browser and type
tests; they are not live transaction acceptance tests.

High/critical advisories, malformed audit results, registry errors, failed imports,
and invalid installation graphs all fail the command. Lower-severity findings stay
in the complete audit report. No advisory is suppressed. A security failure does
not skip import smoke tests, and both consumers are checked before returning the
overall result.

The command prints its evidence directory under the system temporary directory.
To choose a persistent location, pass `--output /absolute/path/outside/the/workspace`.
Each run has separate `sdk/` and `node/` package manifests, lockfiles,
`dependency-tree.json`, `audit.json`, and smoke logs, plus `summary.json` and the
packed tarballs. The directory also retains its installed dependencies and npm
cache for investigation; remove it after retaining the reports you need. The
output location must be outside the workspace so missing consumer dependencies
cannot accidentally resolve from the repository's `node_modules`.

On 2026-09-08, the clean v0.22.0 SDK consumer reported one critical, nine high, and
five low affected package entries; the CLI reported one critical, thirteen high,
and five low. Both smoke checks passed. These counts include parent-package
rollups, not that many independent vulnerabilities. The underlying high/critical
paths include:

```text
@manifest-network/manifestjs@3.0.0
  -> @cosmology/lcd@0.14.5 -> axios@1.8.2
@manifest-network/stargate@0.32.4-ll.3
  -> @confio/ics23@0.6.8 -> protobufjs@6.11.6
```

## Interim application workaround

Until corrected dependencies are published, npm applications using these versions
can merge the following into their **application-root** `package.json`, regenerate
their lockfile with `npm install`, review the diff, and rerun their acceptance tests:

```json
{
  "overrides": {
    "axios": "1.19.0",
    "protobufjs": "7.6.5"
  }
}
```

These exact versions match the validated monorepo graph. Do not overwrite existing
application overrides or force an incompatible direct dependency; reconcile any
`EOVERRIDE` conflict in the application's declared dependencies. Recheck the
current advisory feed when adopting or retaining these pins:

```sh
npm audit --include=dev --include=optional --include=peer --audit-level=high
npm ls axios protobufjs elliptic --all
```

This is an explicit consumer mitigation, not a package-level fix or a claim of
zero vulnerabilities. The same two overrides were tested in separate fresh SDK
and CLI consumers; their high/critical audit threshold passed. The elliptic
advisory remained, as tracked by ENG-808. Putting this block into one of this
repository's library manifests will not protect its consumers. An ephemeral
`npx` installation is also not a substitute for a managed application root with
the reviewed dependency graph; CLI operators can install locally in such an
application and invoke its `node_modules/.bin/manifest-mcp-*` commands.

## Durable remediation and release order

Registry metadata was checked on 2026-09-08: ManifestJS's latest release is 3.0.0,
the Stargate fork's is 0.32.4-ll.3, and ICS23's is 0.6.8. Even LCD's newer 0.16.0
still pins Axios 1.8.2. Merely raising the LCD version or this repository's direct
CosmJS versions does not remove those old transitive trees.

The narrow F01-only repair requires changes in the packages that declare the
blocked dependencies:

1. Release an LCD patch on ManifestJS's accepted `^0.14.0` line with a safe Axios
   dependency (currently `^1.19.0`), or publish a maintained LCD fork and make
   ManifestJS depend on it explicitly. Validate request construction, successful
   responses, errors, cancellation, and browser imports using generated clients.
2. Release a maintained ICS23 patch with a safe protobufjs dependency (currently
   `^7.6.5`), or publish a scoped ICS23 fork and update the Stargate fork's actual
   `dependencies` to that alias. This crosses protobufjs's old major boundary;
   run codec round trips and membership/nonmembership proof vectors. The
   monorepo's existing override is compatibility evidence, not a replacement for
   those proof tests.
3. If scoped forks are necessary, release the Stargate fork and ManifestJS with
   those explicit declarations, then update this repository's dependency ranges
   and lockfile through the normal version tooling. Run the clean consumer gate
   without consumer overrides before publishing the next SDK/CLI release.

The preferred combined F01/F16 repair removes obsolete crypto/proof dependencies
through a matched CosmJS migration. **0.34.1 is a candidate for compatibility
testing, not an approved upgrade.** [CosmJS's changelog](https://github.com/cosmos/cosmjs/blob/main/CHANGELOG.md)
records removal of ICS23 verified queries in 0.33 and replacement of elliptic and
RPC Axios in 0.34. Its Stargate package still uses `cosmjs-types ^0.9.0`, like the
current fork. Latest 0.39.0 has additional changes, including bigint account
numbers; jumping there is a broader migration.

A comparison of the published 0.32.4 packages found one runtime logic change in
the Manifest Stargate fork: `signAmino` keeps the original protobuf `messages`
when assembling the signed transaction body, instead of reconstructing them from
`signed.msgs`. This works around Telescope Amino conversion asymmetry. The same
reconstruction code exists in upstream 0.34.1, so a narrowly carried fork patch is
possible. It needs review of wallet-returned message changes and conversion
symmetry; do not remove the fork or blindly carry its signing semantics based on
an import test alone.

The combined migration should proceed as follows:

1. Rebase and test the Stargate fork on the selected compatible CosmJS release,
   explicitly testing the Amino workaround or replacing it with corrected
   generated converters. Current core/SDK and generated ManifestJS runtime code
   do not call the verified-query methods removed in 0.33.
2. Upgrade ManifestJS's complete CosmJS family to that same release line and
   consume the new fork; also fix/replace LCD's Axios declaration. Regenerate and
   validate codegen where required. A local direct-dependency bump alone leaves
   ManifestJS's `^0.32.4` dependencies installed alongside the new ones.
3. Before release, validate fixed-vector address derivation, direct and Amino
   signatures, signature verification, ADR-036 authentication, hardware/browser
   signer behavior, encrypted keyfile compatibility, account/sequence fields,
   Manifest transaction bytes, RPC/LCD queries, and interface decoder registration.
   Re-run browser bundles, type checks, size budgets, and live devnet transactions.
4. Publish the reviewed upstream/fork packages, update this repository's matched
   dependency declarations, and require both clean terminal-consumer audits and
   smoke tests to pass. Confirm the installed tree has no obsolete elliptic or
   ICS23 branch; retain every remaining advisory in the audit evidence.

No upstream packages were published and no repository dependency versions were
changed while preparing this plan. These external releases and compatibility
checks remain necessary to close F01 and ENG-808. Lifecycle patching, library
overrides, and bundling an opaque copy of the old dependency tree do not satisfy
the acceptance criteria.
