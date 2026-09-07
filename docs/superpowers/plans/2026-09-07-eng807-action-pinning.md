# ENG-807 — immutable GitHub Actions

## Plan

1. Resolve every existing action's `v7` tag and exact release tag against its
   official GitHub repository. Replace all external `uses:` tags with the matching
   full commit SHA and retain the exact release version in a trailing comment.
2. Declare read-only workflow defaults. Separate read-only release validation,
   npm publishing (`contents: read`, `id-token: write`), and GitHub Release
   creation (`contents: write`, no checkout or OIDC). Keep Node 22, npm 11.5.1,
   publish order, idempotent publishing, and best-effort release creation.
3. Retain the existing weekly GitHub Actions Dependabot configuration. Add a
   YAML-aware, fail-closed action-reference check with negative fixtures, wired
   into CI and release validation. Document provenance and normal review.
4. Run the policy tests, existing script regression tests, formatting, and
   actionlint against all four workflows. Do not publish packages or dispatch a
   release as a test.

## Verified provenance (2026-09-07)

Both the existing major tag and the exact release tag resolved to the same
`commit` object through GitHub's official repository Git refs API:

| Action | Release | Commit | Verification |
| --- | --- | --- | --- |
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [Release ref](https://api.github.com/repos/actions/checkout/git/ref/tags/v7.0.1) |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` | [Release ref](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7.0.0) |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | [Release ref](https://api.github.com/repos/actions/upload-artifact/git/ref/tags/v7.0.1) |

The policy checks syntax and version comments offline; provenance remains a
review-time check against the official repository, not a claim inferred from a
40-character string. See GitHub's [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).

## Review enforcement

The existing weekly `github-actions` Dependabot entry already proposes updates
as PRs; no automatic approval or merge workflow exists. Repository ruleset
`main` (14291882) is active but only prevents deletion and non-fast-forward
updates. There is no required-review rule or legacy branch protection.
Enforcing one required approval therefore needs a repository-setting change,
not just a workflow patch; user approval has been requested before changing it.

## Validation results

- `npm run check:workflows`: all 48 policy and wiring tests pass, including
  negative CLI fixtures and YAML aliases, flow mappings, block scalars, reusable
  workflows, Docker digests, comments, and invalid/empty input.
- Existing package-integrity, E2E typecheck-build, and Fred schema script
  regression tests: all 41 pass.
- `npm run check`: passes, with only existing informational Biome diagnostics.
- Official actionlint `v1.7.12`, with its release archive checksum verified:
  all four workflows pass (`-shellcheck=` because shellcheck is not installed).
- `bash -n`: all 47 workflow shell steps pass without executing them.
- Parsed workflow comparison against HEAD confirms unchanged CI/E2E triggers,
  filters, commands, release validation, publishing order, and best-effort
  GitHub Release logic, apart from the intended security changes and the
  publishing job's repeated locked install/build.
- `git diff --check`: passes. The lockfile adds only `yaml@2.9.0`; existing
  action versions, Node 22, and npm 11.5.1 remain unchanged.

Node subprocess checks initially hit sandbox `EPERM`; rerunning the same checks
with approved escalation passed. No sandbox-specific test workaround was added.

Hosted E2E and actual OIDC publishing were not run and cannot be proven by static
workflow validation; those require the normal GitHub runs. Review enforcement
remains pending the requested approval. Repository-setting changes and release
dispatches are not part of this patch.
