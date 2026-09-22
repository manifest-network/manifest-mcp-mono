# Dependency hygiene

The locked repository graph and fresh SDK/CLI installations have separate,
standing CI/release gates. Monorepo overrides do not propagate to consumers
(ENG-805 F01). [Published dependency security](dependency-consumers.md) records the
repaired declarations, fork provenance limits, upstream advisory-review obligation,
and the historical temporary mitigation for applications still on v0.22.0.

The published SDK/core/CLI v0.23.0 release adopts ManifestJS `4.0.0`, Stargate
`0.32.4-ll.5`, LCD `0.14.7` and ICS23 `0.6.10`. Their protected source release runs and exact source
commits are recorded in the [dependency rollout](dependency-consumers.md#adopted-dependency-releases-and-application-rollout).
Their public artifact hashes and signed provenance have been verified; ManifestJS
verification completed locally after the CI registry-availability retries expired.
All nine v0.23.0 packages are published with verified provenance and public
tarballs matching the tested artifacts; see the [publication evidence](releases/v0.23.0-verification.json).
Applications still using v0.22.0 must upgrade their directly installed monorepo
packages together and refresh their lockfile. The immutable v0.22.0 SDK/core
declarations are unchanged by the new release.

## Automated gates

`npm run audit:dependencies` audits the locked production and development graph,
including optional and peer dependencies. High and critical findings fail CI's
`audit` job and the release validation job. Lower-severity advisories remain in the
report. The policy uses npm's failure threshold rather than filtering the report
or suppressing individual advisories; see the [npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

The standalone CI audit reads `package-lock.json` without installing dependencies.
The `test` job's `npm ci` separately checks manifest/lockfile consistency. Advisory
coverage is unchanged without `node_modules`, but npm's remediation hints and
reverse-dependency annotations can differ; investigate fixes from an installed
checkout.

`npm run check:consumers` separately packs this branch's SDK/CLI and their runtime
siblings, installs them in fresh applications without repository overrides or a
copied lockfile, audits them, and checks imports and CLI startup. It rejects
duplicate workspace identities and duplicate Stargate/ManifestJS copies,
including aliases and same-version copies. CI runs the registry-dependent command
at the end of `test`, after lint, coverage, type, browser and size checks; its
regression suite runs once through `check:review-tooling`. Release validation runs
the complete command after local checks. Neither gate filters advisory reports.

An override is not a permanent security exception. Keep the justified Stargate
alias and `ipaddr.js` overrides; Axios/protobufjs now have compatible repaired
declarations and no override. Update their lockfile resolutions normally instead
of retaining an exact override that blocks compatible fixes.

The historical 2026-09-21 manual-artifact consumer baseline was zero high/critical
findings, with 11 low affected package entries for the SDK and 15 for the CLI.
These are parent rollups of `elliptic` (`GHSA-848j-6mx2-7j84`), not independent vulnerabilities. Repository
and consumer counts cover different graphs and are point-in-time measurements.
That baseline is separate from the post-publication v0.23.0 consumer checks:
the public SDK/CLI installations also retained 11/15 low entries respectively,
with zero moderate, high or critical findings. The [release evidence](releases/v0.23.0-verification.json)
records those results; each subsequent release must run the gates again.
The crypto migration remains ENG-808. npm audit does not automatically cover
renamed forks under their original package names: the release/dependency-update
maintainer must also perform the [upstream advisory review](dependency-consumers.md#fork-advisory-coverage).

`npm run check:dependency-hygiene` tests the actual E2E summary shell against
success, failure, cancellation, missing outputs, and skipped live coverage. A
deploy-relevant Dependabot/fork PR cannot appear covered merely because secrets
were unavailable. The existing secret boundary stays in place; a maintainer can
carry the changes onto a same-repository, non-Dependabot PR to run acceptance.

The same command builds a small package with the real SDK tsdown config while
denying validator imports originating inside tsdown. Both injected validators
must execute successfully; removing either injected module must fail. This checks
the resolution boundary without moving the developer's shared node_modules.

It also verifies that every adopted fork artifact recorded in
`docs/dependency-repair-2026-09-21.json` matches the lockfile's real package name,
version, integrity, URL and dependency declarations, including nested copies.
An intentional fork update must refresh this adoption record and its provenance
assessment; an unrelated lockfile update must not silently detach the evidence.
This consistency check does not create or verify build provenance. The four
initial manual repair releases are [historical, unattested artifacts](dependency-consumers.md#publication-provenance-and-release-gate),
superseded in the adopted graph rather than accepted through an exception.

The dependency-cruiser positive controls scan the full workspace graph. Each scan
has a 30-second subprocess deadline within a 45-second test deadline, so the
ordinary five-second unit-test default does not reject a successful scan on a
busy runner. Their expected rule violations and clean-tree assertions remain
mandatory.

The repository's `main` ruleset had no required status checks when inspected on
2026-09-08. Require `test`, `audit`, and `e2e-gate` there to enforce these checks at
merge time; this is separate from the checked-in workflow definitions.

Release also runs `check:dependency-provenance` with npm 11.19.1 against the
repository and both fresh consumers. It requires cryptographically verified npm
bundles bound to the exact reviewed artifact, source commit and workflow identity.
The historical manual dependency releases remain unacceptable; their previous
publication exception remains withdrawn. The adopted successors must pass with
their own exact source identities and digests. Offline regression tests run in PR CI.
The emergency audit process below does not waive this provenance requirement.

## Consumer gate recovery

Reproduce from the failing commit after `npm ci` and `npm run build`:

```sh
npm run check:consumers -- --output /absolute/path/outside/the/workspace
```

Retain the printed run directory's SDK/CLI `audit.json`, install and smoke logs,
dependency trees, lockfiles, and `summary.json`. The root audit and consumer audit
can legitimately differ; inspect the graph that actually failed.

- **Registry error or timeout:** restore connectivity and rerun the gate. An error
  is not a clean audit; do not substitute the repository's passing audit.
- **High/critical advisory:** update the declaring package or maintained fork,
  publish its compatible fix, then update declarations/evidence/lockfile and rerun
  both gates. A root override alone cannot repair consumers.
- **Duplicate Stargate or ManifestJS:** compare the two reported installation
  paths and the installed ManifestJS/Stargate declarations. Coordinate their
  compatible versions with core, then rerun a fresh consumer install. Do not hide
  skew with a repository override or loosen the identity check.
- **Artifact evidence mismatch:** inspect the lockfile change against the public
  tarball and intended source release. Correct an unintended change; for an
  intentional adoption, update the record with its provenance assessment and
  upstream advisory review in the same PR.
- **Import or CLI failure:** fix the packed package's exports, files or declared
  runtime dependencies and rebuild before repeating the check.

An applicable upstream advisory discovered by manual fork review also blocks the
release at high/critical severity, even when both automated audits pass. Use the
same reviewed, release-specific exception process below if remediation cannot wait.

## Release audit failures and emergency exceptions

Release validation fails on audit errors as well as high/critical findings. The
advisory feed can change independently of the lockfile: a severity increase on an
unfixed dependency (including the elliptic chain tracked by ENG-808) can block an
otherwise unchanged release. A missing upstream fix is not evidence of safety.

For a transient registry failure, restore connectivity and re-run the failed
validation job. For an advisory with a compatible fix, update and validate the
dependency graph through the normal PR and release flow.

If an urgent release cannot wait for an upstream fix or registry recovery, use a
reviewed workflow change for that release. There is no standing skip flag or
advisory allowlist:

1. Record the failed run, complete audit output (or registry error), affected
   advisories and dependency paths, lockfile hash, why delaying the release is
   riskier, and the mitigation/follow-up owner. Follow [SECURITY.md](../SECURITY.md) for nonpublic
   vulnerability details. A maintainer must explicitly approve that assessment
   and the exact release commit before tagging.
2. Open a PR that bumps to a **new** release version and temporarily replaces only
   the release validation audit step with the following steps. Replace `vX.Y.Z`
   with that exact tag and `REVIEW_URL` with the approval record. Keep the full
   audit command, all other validation, and CI's separate failing `audit` check.
   If required checks block the PR, obtain an authorized ruleset exception;
   do not remove the required check globally.

   ```yaml
   - name: Audit all dependencies (approved exception for vX.Y.Z)
     id: dependency_audit
     continue-on-error: ${{ github.ref == 'refs/tags/vX.Y.Z' }}
     run: npm run audit:dependencies

   - name: Record approved audit exception
     if: ${{ github.ref == 'refs/tags/vX.Y.Z' && steps.dependency_audit.outcome == 'failure' }}
     run: |
       echo "::warning::Audit failed; release vX.Y.Z uses the exception approved in REVIEW_URL."
       echo "Audit failed; release vX.Y.Z uses the exception approved in REVIEW_URL." >> "$GITHUB_STEP_SUMMARY"
   ```

3. After review, push the new tag at the approved commit. Re-running an old tag's
   workflow uses its original commit, so it cannot pick up the exception. Do not
   move an existing tag or switch to publishing manually. Include the exception
   and mitigation in the release notes.
4. Remove the temporary steps in a follow-up PR immediately after the release,
   restoring the ordinary blocking audit step. The exact-tag condition already
   blocks audit failures on every other release while that cleanup is pending.

The audit still runs and its failure remains in the log and job summary. GitHub's
[step `continue-on-error` behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepscontinue-on-error)
permits the approved release to continue; [re-runs retain the original ref and SHA](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

## Bundle measurements

Measured with the unchanged v0.22.0 lockfile, `npm run build`, and
`npm run size -- --json` on Node 24.15.0/npm 11.12.1:

| SDK entry | Before (gzip bytes) | After | Saved | New budget |
| --- | ---: | ---: | ---: | ---: |
| `/reads` | 26,071 | 26,071 | 0 | 27,460 |
| `/catalog` | 26,375 | 26,375 | 0 | 27,790 |
| `/deploy` | 1,090,661 | 1,089,190 | 1,471 | 1,089,639 |
| root client | 1,079,035 | 1,077,580 | 1,455 | 1,077,958 |

Production imports now target ManifestJS's generated namespace `bundle.js` and
`client.js` modules. The objects, codecs, and signing registries are the same
exports used by the root barrel. Browser tests inspect actual bundle module IDs
and reject the package-wide `dist/index` and `dist/codegen/index` modules, with a
direct ManifestJS bundle as the positive control. Size budgets ratchet down by
the measured savings, preserving their previous headroom.

The 2026-09-21 declaration repair removes the Axios/protobufjs overrides. Updating
only their resolutions from 1.19.0/7.6.5 to 1.20.0/7.6.6 raises the root-client
measurement from 1,077,623 to 1,078,429 gzip bytes. Dependency-only bundle probes
confirm that both updates contribute to the increase. Its budget increases by
the same 806 bytes to 1,078,764, preserving the previous 335 bytes of headroom.
The other budgets stay unchanged: `/reads` measures 26,073 bytes, `/catalog`
27,770, and `/deploy` 1,089,043. No runtime code, ignored dependencies, or
tree-shaking settings change for this adjustment.

The namespace-import reduction leaves large crypto and codegen costs that need
upstream work:

- `@cosmjs/crypto@0.32.4` uses `libsodium-wrappers-sumo` for
  `Argon2id.execute`, Ed25519, and XChaCha20-Poly1305. Argon2 calls
  `crypto_pwhash`, which the ordinary libsodium build does not supply. The source
  explicitly requires sumo until Argon2 is migrated. An alias to non-sumo would
  break this API; a compatible crypto migration belongs with ENG-808 and needs
  signing/key-derivation vectors and integration coverage.
- ManifestJS's generated codecs populate `GlobalDecoderRegistry` at import time.
  Query and signing factories alone do not provide equivalent registration: an
  isolated probe loading the six namespace signing/RPC factories plus the auth
  query module registered 516 decoders, compared with 1,124 through the root.
  Missing registrations included public-key codecs, `SendAuthorization`, and
  allowance types. Some account/authz/feegrant values are decoded through that
  global registry rather than through explicit imports. Narrowing all the way to
  individual query/transaction modules therefore requires an upstream interface
  decoder contract and isolated decoding tests, not just a passing bundle build.

Retaining each supported namespace preserves those registrations while avoiding
the extra package-wide barrel. Do not declare ManifestJS side-effect-free or
externalize libsodium in the size measurement to hide their remaining cost.
