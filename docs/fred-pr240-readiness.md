# Fred PR #240 compatibility

[ENG-1028](https://linear.app/liftedinit/issue/ENG-1028) prepares this repository
against immutable Fred revision `4f00091cd7ace41c92bb2d1ebcd2c1a68fb7d234`
from [PR #240](https://github.com/manifest-network/fred/pull/240). The submodule
and generated manifest artifacts use that revision. Runtime clients continue
defaulting to released Fred v0.13; PR240 behavior requires explicit opt-in.
Revalidate the pin against Fred's final merged revision before rollout.

## Client changes

- SDK clients accept `fredCompatibility: 'v0.13' | 'pr240'` or a map keyed by
  provider API URL. Unlisted providers use v0.13. Deploy and maintenance calls
  can override the configured mode. Raw restart/update helpers take the mode
  after the optional key argument and also default to v0.13.
- Legacy restart/update omit the command header and returned key, so the v0.13
  browser CORS contract remains usable. Supplied keys are rejected locally.
  Legacy failures preserve recovery context and prevent automatic replay;
  reconcile lease status and releases before deliberately submitting again.
- PR240 restart/update send a canonical UUIDv4 command key. SDK lifecycle options
  use `idempotencyKey`; MCP input and result/error context use `idempotency_key`.
- In PR240, a lost response or 503 can leave an admitted command pending. Exact retries
  retain the key and final manifest bytes and use fresh authentication. Raw and
  high-level errors prevent generic automatic retries from creating new work.
- Readiness errors preserve their public subclasses, reason, timing, and failure
  guidance while identifying the accepted command. Native call deadlines remain
  timeouts. MCP error budgeting preserves the lease and command identity.
- Manifest validation applies the selected provider policy before mutation.
  The default preserves v0.13 admission; PR240 adds reserved Compose labels,
  Unicode case folding, and stricter user syntax. The vendored schema remains a
  PR240 drift/test artifact. Image-baked reserved labels also cause PR240
  admission refusal; rebuilding the image is required in that case.
- Restore continues preserving both lease IDs after every uncertain POST result.
  A missing retention deadline is valid when age-based expiry is disabled.

See the [SDK command-key contract](library-usage.md#restarting-and-updating-with-a-command-key).
MCP operators set `MANIFEST_FRED_COMPATIBILITY` to `v0.13`, `pr240`, or a JSON
provider URL map; the `FredMCPServer` constructor's `fredCompatibility` option
takes precedence. No provider version is inferred from a failed mutation.
Deduplication requires the upgraded provider: configuring an older Fred as PR240
cannot add that guarantee and can break browser CORS. Keep the restore safety fix
in any client release adopted for
the rollout; [ENG-980](https://linear.app/liftedinit/issue/ENG-980) tracks its
publication and consumer adoption.

## Devnet and verification

The local devnet independently defaults to `FRED_COMPATIBILITY=pr240`; this does
not change the SDK/MCP default. Its v0.13 mode uses a separate legacy backend
topology. Never start either mode against the other version's persisted authority.

The PR240 devnet builds Go 1.26.8 and includes `placement-preflight`. CI installs a
pinned compatible Docker daemon before checking the required server API floor.
The devnet launcher seals a fresh backend storage identity and runs the backend
natively on the Docker host under systemd. Stateful backend containers are
unsupported by the new writer inventory: their writable XFS-root mount covers
every tenant volume. Provider placement initialization and providerd remain
containerized and reach the native backend over verified HTTPS. Journals, the identity
anchor, XFS data, and provider state must remain together across restarts. The
initializers never reseal partial or existing authority. Follow
[local E2E setup](e2e-setup.md) for fresh setup or a complete disposable reset;
existing v0.13 data requires Fred's upstream stopped-upgrade procedure.

Run builds and the unit suite sequentially: architecture tests temporarily create
source probes, and building during those tests can collect the probes.

```bash
npm ci
npm run check:fred-manifest-schema
npm run check:review-tooling
npm run lint:e2e
npm exec -- vitest run --maxWorkers=2 --testTimeout=30000
npm run check
npm run depcruise
```

Live acceptance additionally requires a dedicated `/mnt/fred-xfs` mount with
project quota accounting/enforcement. It must exercise initial bootstrap,
deployment, restart/update, retained restore, and startup with the existing state
after service recreation against both pinned revisions. Exact-key replay and
placement-authority checks apply to PR240. PR CI runs the single SDK acceptance
flow plus lifecycle and restore tests in a two-version matrix; the nightly job
runs the full E2E suite against both. Live OPTIONS checks verify that the selected
maintenance headers fit each provider's CORS policy; these are not a browser run.

`e2e/fred-wire-golden.json` preserves its original baseline provenance alongside
actual status/release observations against the new pin. The diagnostics
projection records `lease_state` as a required field derived by mono. Conditional
fields not seen in a healthy run retain their baseline provenance; do not invent
observations from Go source. Local unit and bootstrap-script tests do not
establish live XFS or rollout acceptance.
