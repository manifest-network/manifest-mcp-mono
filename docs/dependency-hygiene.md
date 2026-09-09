# Dependency hygiene

For the separate published SDK/CLI dependency graph, its blocking consumer audit,
and the current application-root mitigation, see
[Published dependency security](dependency-consumers.md). Monorepo overrides do
not propagate to consumers (ENG-805 F01).

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

An override is not a permanent security exception. Auditing the resolved graph
catches a pin that falls into a newly disclosed vulnerable range. On 2026-09-08,
the full audit passed this threshold with seven low-severity dependency paths
through `elliptic` (GHSA-848j-6mx2-7j84). Its crypto migration remains ENG-808.

`npm run check:dependency-hygiene` tests the actual E2E summary shell against
success, failure, cancellation, missing outputs, and skipped live coverage. A
deploy-relevant Dependabot/fork PR cannot appear covered merely because secrets
were unavailable. The existing secret boundary stays in place; a maintainer can
carry the changes onto a same-repository, non-Dependabot PR to run acceptance.

The same command builds a small package with the real SDK tsdown config while
denying validator imports originating inside tsdown. Both injected validators
must execute successfully; removing either injected module must fail. This checks
the resolution boundary without moving the developer's shared node_modules.

The dependency-cruiser positive controls scan the full workspace graph. Each scan
has a 30-second subprocess deadline within a 45-second test deadline, so the
ordinary five-second unit-test default does not reject a successful scan on a
busy runner. Their expected rule violations and clean-tree assertions remain
mandatory.

The repository's `main` ruleset had no required status checks when inspected on
2026-09-08. Require `test`, `audit`, and `e2e-gate` there to enforce these checks at
merge time; this is separate from the checked-in workflow definitions.

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

This is a small reduction. The large crypto and codegen costs need upstream work:

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
