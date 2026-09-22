# Published dependency security (ENG-805 / ENG-808)

The v0.22.0 packages were published with declarations permitting vulnerable
Axios and protobufjs versions. The monorepo's overrides do not travel with the libraries:
[npm considers overrides only in the consuming application's root package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).
The unreleased branch now adopts ManifestJS `4.0.0`, Stargate `0.32.4-ll.5`,
LCD `0.14.7` and ICS23 `0.6.10` from the reviewed source releases below. Their
declarations repair the audited Axios/protobufjs paths and coordinate one
Stargate identity. **These dependency publications do not release the SDK/CLI.**
A coordinated SDK/core/CLI release must still pass the repository, fresh-consumer
and cryptographic provenance gates. The previous manual-publication exception
remains withdrawn.

The current public v0.22.0 graph also needs a compatibility correction: its core
pins Stargate ll.3, while ManifestJS `^3.0.0` can select 3.0.1 with Stargate ll.4.
A clean SDK/CLI installation therefore installs two class identities. Passing
imports do not make this a compatible graph, and this observation alone does not
establish an exploitable signing bug.

## Initial manual repair artifacts

These historical versions still exist on npm, but the adopted graph now uses
their successors. This table records the initial manual repair, not the current
artifact allowlist:

| Package | Version | Published dependency repair | Source |
| --- | --- | --- | --- |
| `@manifest-network/lcd` | `0.14.6` | `axios ^1.19.0` | ManifestJS `vendor/lcd` |
| `@manifest-network/ics23` | `0.6.9` | `protobufjs ^7.6.5` | CosmJS fork `vendor/ics23/js` |
| `@manifest-network/stargate` | `0.32.4-ll.4` | `@confio/ics23: npm:@manifest-network/ics23@^0.6.9` | CosmJS fork `packages/stargate` |
| `@manifest-network/manifestjs` | `3.0.1` | LCD alias and the patched Stargate version | ManifestJS root |

The LCD and ICS23 runtime source is preserved; package metadata and tarball
contents intentionally differ. LCD's upstream npm tarball declares
`SEE LICENSE IN LICENSE` but omits that file. The fork includes the upstream
source commit's [MIT license](https://github.com/hyperweb-io/telescope/blob/eaae9e070119fe97bd63b781e070ef50ad4a35b9/packages/lcd/LICENSE-MIT)
and [Apache license](https://github.com/hyperweb-io/telescope/blob/eaae9e070119fe97bd63b781e070ef50ad4a35b9/packages/lcd/LICENSE-Apache),
and declares `(MIT OR Apache-2.0)`. ICS23 retains `Apache-2.0`, adds its source
license file, and excludes compiled specs from the published artifact.

Compatibility suites live in the source forks, not in these runtime tarballs or
this monorepo's test suite. The [LCD HTTP tests](https://github.com/manifest-network/manifestjs/blob/5df11dcf6c41db000355ab0214c7ee091392a972/vendor/lcd/test/compatibility.test.cjs)
cover requests, cancellation and deadlines; [generated LCD tests](https://github.com/manifest-network/manifestjs/blob/5df11dcf6c41db000355ab0214c7ee091392a972/__tests__/lcd.compatibility.test.ts)
cover generated queries. The [ICS23 source suite](https://github.com/manifest-network/cosmjs/tree/d9ec2a47735d252fdda90f7aaeddd8eec4d3cee7/vendor/ics23/js/src)
retains upstream proof vectors and adds exact codec round trips and negative
proof controls. Reproduction commands are in each source PR's release runbook.
The Stargate patch retains its existing Amino workaround and CosmJS 0.32.4
dependencies. This repair does not remove elliptic; ENG-808 remains separate.

Before publication, the candidate tarballs can be tested through a temporary
registry using these exact declarations, without consumer overrides. That is
candidate evidence, not proof that the public registry is repaired. After
publication, regenerate/verify lockfiles against public npm, run the complete
consumer check below, and retain both audit reports and the resolved trees.
Do not commit temporary-registry URLs or replace failed audits with staging
results. CI and release validation both run the same consumer check.

## Publication provenance and release gate

The four initial repair versions were published manually by `fmorency_` and have
**no provenance attestations**. Their recorded source commits and SHA-512 hashes
establish neither the builder identity nor that those commits produced the
artifacts. They are historical evidence, not an accepted release exception.
Existing npm versions cannot gain build provenance retroactively; publish new
versions from reviewed source using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

`npm run check:dependency-provenance` fails release validation until each of the
four exact adopted artifacts passes. It requires the reviewed npm **11.19.1**
verifier and consumes the output of a successful
`npm audit signatures --json --include-attestations`. npm checks the signature,
certificate chain and transparency-log evidence. The additional policy inspects
those same verified bundles, requiring the exact package/version/SHA-512 subject,
GitHub Actions OIDC issuer, signing-certificate workflow identity and authenticated
source repository, full commit and the repository's release branch identity.
The signed SLSA v1 statement must agree with those identities and name GitHub's
hosted builder.
Metadata presence or a separately downloaded, unverified statement cannot pass.

The trusted source workflows are:

| Dependencies | Repository | Workflow | Required ref |
| --- | --- | --- | --- |
| LCD, ManifestJS | `manifest-network/manifestjs` | `.github/workflows/release.yaml` | `refs/heads/main` |
| ICS23, Stargate | `manifest-network/cosmjs` | `.github/workflows/manifest-release.yml` | `refs/heads/manifest/0.32` |

CosmJS releases use the protected `manifest/0.32` maintenance branch, which is
the fork's default branch. Its `main` remains an upstream reference and is not an
accepted release source. ManifestJS continues to release from `main`; its policy
does not accept the CosmJS maintenance ref. The certificate and signed statement
must both match the repository's exact allowed ref.

The evidence file's `packages` array is the exact adopted artifact/source allowlist.
`check:dependency-hygiene` guards its name, version, integrity, URL and dependency
declarations against the lockfile. The provenance gate additionally binds each
artifact to its reviewed commit and the fixed workflow policy. Historical manual
source references cannot satisfy that gate. Each adoption updates versions,
digests and source commits together; an attestation for a different release
cannot stand in for the installed artifact.

Release runs this check for the repository and both fresh packed consumer graphs,
after their audits/import checks. A caret dependency resolving a different future
artifact must be reviewed and added to the record; root-lock evidence alone is
insufficient. Ordinary PR CI runs offline policy regression tests; those tests
do not replace verification of the installed public artifacts during release.
There is no provenance skip flag. The general emergency audit procedure does not
waive this provenance requirement.

Provenance proves the authenticated source/build association. It does not prove
that a source change is secure or reproducible, or attest every transitive
package. The upstream advisory review below remains required.

## Adopted dependency releases and remaining rollout

The source changes and publishing workflows in
[CosmJS PR #2](https://github.com/manifest-network/cosmjs/pull/2) and
[ManifestJS PR #21](https://github.com/manifest-network/manifestjs/pull/21) are
merged. The selected dependencies were published through their protected
`npm-release` environments using npm trusted publishing. All four public
artifacts have verified signed provenance binding their exact hashes to these
reviewed source commits:

| Package | Adopted version | Reviewed source commit | Release run |
| --- | --- | --- | --- |
| LCD | `0.14.7` | `c69387ceefcb23165c58c92aee123c97dce3e9e9` | [ManifestJS run 35650499591](https://github.com/manifest-network/manifestjs/actions/runs/35650499591) |
| ICS23 | `0.6.10` | `e464b5c21ae097e06e5505b7a8d3834359199840` | [CosmJS run 35650590941](https://github.com/manifest-network/cosmjs/actions/runs/35650590941) |
| Stargate | `0.32.4-ll.5` | `f700b2f6268b1ee0fb41a133b1719a889f632754` | [CosmJS run 35653654841](https://github.com/manifest-network/cosmjs/actions/runs/35653654841) |
| ManifestJS | `4.0.0` | `1c79ad8c9f968aa5cf3c7955e8b5db28a6ab2f0b` | [ManifestJS run 35728806801](https://github.com/manifest-network/manifestjs/actions/runs/35728806801) |

The ManifestJS run remains failed because its bounded post-publication install
retries ended before npm exposed the new version. Publication succeeded at
12:48:16 UTC on 2026-09-22; the package became publicly available at 12:51:15 UTC.
An independent local recovery using the unchanged source verifier and pinned
npm `11.19.1` subsequently passed cryptographic verification, including the exact
hash, repository, workflow, `main` ref and full commit. The public tarball is
byte-identical to the tested CI artifact. This recovered verification does not
claim a successful CI run; neither publication nor the workflow was rerun.

LCD retains `axios ^1.19.0`; ICS23 retains `protobufjs ^7.6.5`. Stargate ll.5
raises its ICS23 alias floor to `^0.6.10` and retains the signing workaround.
ManifestJS 4 pins Stargate ll.5 exactly and raises its LCD alias floor to
`^0.14.7`. Its major version separates this coordinated graph from existing
ManifestJS `^3.0.0` consumers whose core still pins Stargate ll.3.

The remaining SDK/core/CLI rollout is:

1. Validate the adopted declarations and public-npm lockfile against the exact
   artifact/source allowlist. Candidate-registry tests are useful preparation;
   the release gates must verify the actual public packages.
2. Require verified provenance for the repository and both fresh packed
   consumers, one shared identity, zero high/critical consumer findings and the
   existing compatibility, browser, type and live-chain gates. Preserve complete
   reports, including lower-severity findings.
3. Review and publish the coordinated SDK/core/CLI release. Existing applications
   need that SDK upgrade and a regenerated lockfile for the full repair. The
   public v0.22.0 packages remain unrepaired by these dependency publications.

ManifestJS `3.0.2` remains an **optional, unpublished legacy correction requiring
a separate policy decision**. Restoring exact Stargate ll.3 could repair the
duplicate identity for existing SDK v0.22.0 consumers, but that immutable old
core pin retains its dependency vulnerabilities and provenance gap. This is not
part of the adopted ManifestJS 4 line. Any audit exception for publishing a
legacy correction must be explicit, maintainer approved and scoped to that exact
release; the present SDK/CLI provenance requirement is not waived.

A broad required Stargate peer was tested and rejected: npm auto-installed a
newer peer for ManifestJS while nesting ll.3 under old core, despite `npm ls`
passing. Separating the ManifestJS major lines preserves actual npm resolution.
The fixture suite stages both lines in the same registry and checks real client
constructor identities, including a negative future-patch control.

## Fork advisory coverage

npm audit matches the installed package's real name, including when an npm alias
preserves the original import name. It does **not** automatically match advisories
against the original package names to these renamed runtime implementations:

| Installed fork | Retained upstream identity to review |
| --- | --- |
| `@manifest-network/lcd` | `@cosmology/lcd@0.14.5` |
| `@manifest-network/ics23` | `@confio/ics23@0.6.8` |
| `@manifest-network/stargate` | `@cosmjs/stargate@0.32.4` |

The maintainer preparing each release or changing a fork dependency owns this
additional review: query the upstream identities in the GitHub Advisory Database,
check their source repositories' security notices, and assess whether each finding
applies to the retained or modified code. Record the date, advisory URLs and
applicability in the PR/release evidence. An applicable high/critical finding
blocks release even if npm audit is green; use the documented
[reviewed exception procedure](dependency-hygiene.md#release-audit-failures-and-emergency-exceptions)
for an urgent exception. Lower-severity findings remain visible.

For example, repeat this query for each identity in the table:

```sh
gh api --method GET /advisories --paginate \
  -f ecosystem=npm -f type=reviewed -f 'affects=@confio/ics23@0.6.8'
```

On 2026-09-22 these three queries returned no matching reviewed advisories;
the corresponding public repository advisory endpoints also returned no published
notices. The evidence file records that bounded result. This is not proof of absence
of vulnerabilities or coverage of unpublished/unreviewed notices. The ordinary audit
still checks Axios, protobufjs and the other transitive packages under their real
names. No advisory allowlist or severity suppression is configured, but the
upstream-name gap is a separate maintenance obligation, not automated coverage.

## Adoption validation (2026-09-22)

A clean public-npm installation and full source build passed with the four
adopted artifacts. Coverage passed all configured thresholds: 205 files,
5,539 tests passed, 17 skipped and no type errors. Lint, E2E typechecking,
package/export checks, browser and type contracts, dependency boundaries,
workflow guards, bundle budgets and CLI metadata checks also passed.

Fresh packed SDK/CLI consumers passed imports, CLI startup, dependency identity,
and production audits: 11/15 low affected-package entries respectively, with
zero moderate, high or critical findings. The unchanged npm 11.19.1 provenance
gate verified all four exact dependency artifacts in the repository and both
consumer graphs. Constructor and decoder-registry checks confirmed shared
identities. All nine consumer-tested tarballs matched the stable source rebuild.

The full repository audit also passed its high/critical gate, retaining seven
low and four moderate affected-package entries. The moderate entries are the
existing pinned Vitest/mocker/coverage and Hono findings; the fresh production
consumers have none. The [adoption evidence](dependency-repair-2026-09-21.json)
records these scopes separately. These results validate the adoption branch;
SDK/CLI publication still requires review and a coordinated new version.

## Historical candidate validation (2026-09-21)

All four initial public npm tarballs match the integrities of the tested artifacts.
These checks do not make their unattested publication acceptable for release.
The then-current monorepo lockfile installed with `npm ci` using a fresh
public-npm cache.
The complete consumer check then installed the repair branch's packed SDK and CLI
with the published upstream dependencies and no application overrides:

| Consumer | High | Critical | Low | Import/CLI smoke checks |
| --- | --- | --- | --- | --- |
| SDK | 0 | 0 | 11 | Passed |
| CLI | 0 | 0 | 15 | Passed |

The low counts include affected-parent rollups of the existing elliptic advisory
`GHSA-848j-6mx2-7j84`; they do not represent separate underlying vulnerabilities.
These counts describe the historical manual-artifact graph; they are not results
for the adopted successors. The [adoption evidence](dependency-repair-2026-09-21.json)
records the current artifact allowlist and separately scoped validation. The
source patches are
[CosmJS PR #2](https://github.com/manifest-network/cosmjs/pull/2) and
[ManifestJS PR #21](https://github.com/manifest-network/manifestjs/pull/21).

That historical validation also passed the monorepo build, lint, type-test
harness, workflow and package checks, bundle budgets, eight MCP annotation
checks, and the coverage
suite (5,539 passed, 17 skipped). Live-chain results are tracked separately in the PR checks.

That historical evidence covered the packages packed at that time. A new
SDK/CLI release is still required to ship these declarations. Existing v0.22.0
packages retain their direct pin to the older Stargate patch.

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

The check verifies tarball integrity and rejects duplicate sibling installations
and multiple Stargate or ManifestJS copies (including aliases and same-version copies),
validates npm's installed dependency tree, audits production/optional/peer
dependencies, imports public runtime entries, and starts each CLI through its
invalid-subcommand usage path. It does not read a wallet, sign, or contact a chain
or provider. These import/CLI checks complement the repository's browser and type
tests; they are not live transaction acceptance tests.

High/critical advisories, malformed audit results, registry errors, failed imports,
and invalid installation graphs all fail the command. Lower-severity findings stay
in the complete audit report. The renamed-fork coverage limits and manual review
are described above. A security failure does
not skip import smoke tests, and both consumers are checked before returning the
overall result.

The fresh consumers resolve the libraries' ManifestJS caret ranges from npm; the
repository's exact development pin is not copied. This catches a currently
published ManifestJS update that would install a second Stargate alongside core's
direct pin. It cannot prevent a future publication from causing that skew.
Coordinate ManifestJS and core changes and retain a compatible Stargate identity
throughout a supported ManifestJS range; use a new ManifestJS major if necessary.
The broadcast coordination singleton itself lives in core and is already covered
by the sibling-identity guard.

The command prints its evidence directory under the system temporary directory.
To choose a persistent location, pass `--output /absolute/path/outside/the/workspace`.
Each run has separate `sdk/` and `node/` package manifests, lockfiles,
`dependency-tree.json`, `audit.json`, and smoke logs, plus `summary.json` and the
packed tarballs. The directory also retains its installed dependencies and npm
cache for investigation; remove it after retaining the reports you need. The
output location must be outside the workspace so missing consumer dependencies
cannot accidentally resolve from the repository's `node_modules`.

## Check published consumers and release provenance

To reproduce the existing public graph without workspace sibling substitutions:

```sh
node scripts/check-consumers.mjs --published-version 0.22.0 --output /tmp/manifest-published-check
```

This packs only the exact published SDK/CLI entry tarballs and resolves their
published dependencies normally. Its report separates `identityPasses`,
`auditPasses` and `smokePasses`; any failing component still returns nonzero.
In the recorded v0.22.0 check, both import checks passed, both installed Stargate
ll.3 and ll.4, and audits retained high/critical entries. Those entries include
affected-parent rollups and are not counts of independently demonstrated
exploits. A future legacy
compatibility correction may fix identity while leaving its audit nonzero.

After building a candidate, release validation uses a new, empty output directory
and the pinned verifier:

```sh
npm run check:consumers -- --output /tmp/manifest-release-consumers
# Requires npm 11.19.1 and verified provenance for every adopted dependency artifact.
npm run check:dependency-provenance -- --consumers /tmp/manifest-release-consumers
```

The gate retains complete npm signature reports and a summary under its printed
`manifest-provenance-*` temporary directory. Multiple runs in one consumer output
directory are rejected rather than selecting stale passing evidence. Missing or
invalid provenance, wrong source identities, unreviewed artifacts and registry
errors block release. Correct the source release/adoption record, then repeat the
checks; do not substitute historical counts or remove the gate.

## Interim application workaround

Until a corrected SDK/CLI release is published and adopted, npm applications
using v0.22.0 can merge the following into their **application-root**
`package.json`, regenerate their lockfile with `npm install`, review the diff,
and rerun their acceptance tests:

```json
{
  "overrides": {
    "axios": "1.19.0",
    "protobufjs": "7.6.5"
  }
}
```

These were the validated pre-repair workaround versions. Do not overwrite existing
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

**Remove these two temporary overrides after upgrading the SDK/CLI to a release
that includes the repaired declarations.** Updating ManifestJS alone is not enough
while a v0.22.0 core package still directly pins the older Stargate. Regenerate the
application lockfile, inspect `npm ls axios protobufjs @cosmjs/stargate --all`,
rerun the audit and acceptance tests, and retain unrelated application overrides.
An exact override prevents compatible dependency updates even when the audit is
currently green; `npm update` cannot move it past the overridden version.

## Original remediation assessment (2026-09-08)

On 2026-09-08, the clean v0.22.0 SDK consumer reported one critical, nine high, and
five low affected package entries; the CLI reported one critical, thirteen high,
and five low. Both smoke checks passed. These are historical counts with
parent-package rollups, not current output or independent vulnerability counts.
The underlying high/critical paths included:

```text
@manifest-network/manifestjs@3.0.0
  -> @cosmology/lcd@0.14.5 -> axios@1.8.2
@manifest-network/stargate@0.32.4-ll.3
  -> @confio/ics23@0.6.8 -> protobufjs@6.11.6
```

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

The broader combined F01/F16 repair would remove obsolete crypto/proof dependencies
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

The original assessment did not publish upstream packages or change dependency
versions. The narrow repair plan above targets F01; the separate combined migration
and its compatibility checks remain necessary to close ENG-808. Lifecycle patching, library
overrides, and bundling an opaque copy of the old dependency tree do not satisfy
the acceptance criteria.
