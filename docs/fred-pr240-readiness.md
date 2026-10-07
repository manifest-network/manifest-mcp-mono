# Fred PR #240 compatibility

[ENG-1028](https://linear.app/liftedinit/issue/ENG-1028) prepared this repository
against Fred revision `4f00091cd7ace41c92bb2d1ebcd2c1a68fb7d234` from
[PR #240](https://github.com/manifest-network/fred/pull/240). The submodule and
generated manifest artifacts now use Fred `main`
`9c063b4735124bd518e75cedf7db7b6dde0b131e`. It adds
[PR #242](https://github.com/manifest-network/fred/pull/242), which fixes
[ENG-1055](https://linear.app/liftedinit/issue/ENG-1055),
[PR #243](https://github.com/manifest-network/fred/pull/243), the operator
controls of [PR #244](https://github.com/manifest-network/fred/pull/244) and
[PR #245](https://github.com/manifest-network/fred/pull/245), and PRs #247
through #257 to PR #240's merge.
Runtime clients continue defaulting to released Fred v0.13; PR240 behavior
requires explicit opt-in. Revalidate against Fred's released revision before
rollout.

PR #243 adds tenant `410` answers with a `reason`: `backend_storage_lost` for a
lease whose backend an operator retired as lost, and `maintenance_expired` for a
restart or update older than the newest command Fred has accepted for the lease.
PR #242 adds `429` with `maintenance_capacity_reserved` when the provider's
shared maintenance capacity is held for tenants without pending work. A lost
lease's `/status` instead reports `provision_status: failed` with the failure
reason `BackendStorageLost`. Mono treats `reason` as an open string and records
any well-formed body `reason` as `details.provider_reason`. Only these three
exact status and reason pairs replace the exact-retry advice with a specific
`next_step`: a new key after `maintenance_expired`, no further maintenance or
restore after `backend_storage_lost`, and the same command for
`maintenance_capacity_reserved` once the tenant's command pending on another
lease completes. The automatic-retry veto and `outcome: 'unknown'` are
unchanged. `app_diagnostics` and the restore pre-flight report storage loss as
a definitive answer instead of the raw body. Fred gives these answers only
until the lease has ended and a later sweep prunes its placement record; it
then answers like any other ended lease.

PR #243 also lets an operator keep pre-PR240 clients working: a tenant address
listed in `maintenance_legacy_idempotency_tenants` may omit `Idempotency-Key`,
and Fred keys each such request by its single-use signed token, so every retry
is a new command, as in v0.13. Any other keyless restart or update receives
`400` (`Idempotency-Key header must occur exactly once`) before Fred records it.
In v0.13 mode mono reports that refusal as a command that did not run, with the
two fixes. The list holds exact addresses, so it suits a fixed agent wallet; an
application whose users sign with their own wallets, such as a browser front
end, should instead map each upgraded provider URL to `pr240` as it upgrades.

PR #242 pins each admitted image to its lease and manifest. Resubmitting an
unchanged manifest, including an exact retry, reuses the pinned image even if
its tag has moved, and a restart reuses it too. To deploy new image content,
change the image reference, preferably to a digest. Image admission also
requires an HTTPS registry and enforces the provider's image size budget
(10 GiB by default), at most 128 layers, a manifest for the provider platform,
and supported layer contents; a refusal surfaces as `ImagePullFailed`, which a
`ready` lease can retain after a failed update.

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
  admission refusal; rebuilding the image is required in that case. Since
  PR #242, the three exact Compose build stamps (`com.docker.compose.project`,
  `.service`, and `.version`) are the exception: Fred discards their image
  values, so Compose-built images carrying only those need no rebuild. Manifest
  labels with the `com.docker.compose.` prefix remain reserved.
- Previews identify their applied policy in `validation.fred_compatibility`.
  Standalone MCP preview with a provider map uses v0.13 until a provider is
  selected. Orchestrated previews use the selected provider's actual policy,
  including after edits, and show validation in the confirmation plan.
- Restore continues preserving both lease IDs after every uncertain POST result.
  A missing retention deadline is valid when age-based expiry is disabled.

See the [SDK command-key contract](library-usage.md#restarting-and-updating-with-a-command-key).
Legacy label and user-syntax admission deliberately matches v0.13; applying the
PR240 restrictions in both modes would reject previously accepted inputs. The
provider remains responsible for enforcing its admission rules.

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

At the PR #242 pin, a restart or update can overlap admitted lifecycle work
whose outcome is not yet journaled: a maintenance just after Ready, a not yet
journaled close, or a pending provision or restore. Fred then answers `503` and
keeps the command
pending, where it previously refused it with `409 invalid state`. A command that
overlaps a journaled but undelivered completion still receives
`409 invalid state`. Fred's tenant `503` body is generic, so the devnet
maintenance harness retries only Fred's own `503` body for the same command
key, within a bounded budget, and rethrows the final answer unchanged. Fred
deduplicates the command, and its own recovery may already have applied it. An
update now remains pending until its signed completion callback succeeds. A new
command in that interval receives `409` "already undergoing a lifecycle
operation".

PR #244 and PR #245 add operator controls that need no client change: rolling
HMAC key rotation, online placement snapshots, a `placement-repair` generation
adoption mode, and `backends[].fenced`. Leases on a fenced backend keep their
placement and wait. Their restart, update and restore answer Fred's generic
`503` before anything is journaled, which mono reports as the usual uncertain
outcome; an exact retry keeps receiving `503` until the operator lifts the
fence. Reads fail closed: `/provision` answers `500`, and `/status` omits
`provision_status`, exactly as for any backend Fred cannot read. The devnet
configures no fence and keeps its legacy shared `callback_secret`, so the new
per-backend key rules do not apply to it.

PRs #247 through #257 change four things a client sees. PR #254 bounds
`health_check` timings at admission: a negative value, or one between 0 and
Docker's 1ms minimum, is refused, and mono's `pr240` preflight now refuses the
same. PR #252 closes an ACTIVE lease for repeated failure only when the backend
reports an exhausted consecutive-failure budget. `/status` and `/provision`
carry it as `terminal_budget`, which mono surfaces, and `fail_count` becomes a
lifetime diagnostic. PR #255 fails a startup crash definitely instead of leaving
the lease provisioning, with the new reasons `HealthCheckFailed` and
`ContainerStartFailed`. PR #250 adds `VolumeDeletePending` and
`VolumeDeletionInProgress` for held volume deletions. Mono has curated guidance
for all four reasons. PR #251 runs tenant containers under a restricted seccomp
profile, PR #257 fixes restart and update of leases adopted from v0.13, and PR
#256 documents the existing token scope; none needs a client change.

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
the latest live status/release observation. That observation records its Fred
revision and run; it now comes from the green full E2E run at Fred `main`
`315ed5a`, whose key sets matched the earlier `8a26371` and `4f00091`
observations. Replace it
only from a green live run at a newer pin. The diagnostics
projection records `lease_state` as a required field derived by mono. Conditional
fields not seen in a healthy run retain their baseline provenance; do not invent
observations from Go source. Local unit and bootstrap-script tests do not
establish live XFS or rollout acceptance.
