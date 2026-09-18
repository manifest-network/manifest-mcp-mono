# Fred PR #240 compatibility

[ENG-1028](https://linear.app/liftedinit/issue/ENG-1028) prepares this repository
against immutable Fred revision `4f00091cd7ace41c92bb2d1ebcd2c1a68fb7d234`
from [PR #240](https://github.com/manifest-network/fred/pull/240). The submodule,
vendored manifest schema, and generated validator use that revision. Revalidate
the pin against Fred's final merged revision before rollout.

## Client changes

- Restart/update send a canonical UUIDv4 command key. SDK lifecycle options use
  `idempotencyKey`; MCP input and result/error context use `idempotency_key`.
- A lost response or 503 can leave an admitted command pending. Exact retries
  retain the key and final manifest bytes and use fresh authentication. Raw and
  high-level errors prevent generic automatic retries from creating new work.
- Readiness errors preserve their public subclasses, reason, timing, and failure
  guidance while identifying the accepted command. Native call deadlines remain
  timeouts. MCP error budgeting preserves the lease and command identity.
- Manifest validation matches Fred's reserved Compose labels, Unicode case
  folding, and stricter user syntax. Image-baked reserved labels also cause
  upstream admission refusal; rebuilding the image is required in that case.
- Restore continues preserving both lease IDs after every uncertain POST result.
  A missing retention deadline is valid when age-based expiry is disabled.

See the [SDK command-key contract](library-usage.md#restarting-and-updating-with-a-command-key).
Deduplication requires the upgraded provider; older Fred versions can ignore the
header. Keep the existing restore safety fix in any client release adopted for
the rollout; [ENG-980](https://linear.app/liftedinit/issue/ENG-980) tracks its
publication and consumer adoption.

## Devnet and verification

The devnet builds Go 1.26.8 and includes `placement-preflight`. CI installs a
pinned compatible Docker daemon before checking the required server API floor. Compose seals a
fresh backend storage identity, starts the backend with verified HTTPS, prepares
provider placement authority, then starts providerd. Journals, the identity
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
deployment, restart/update exact-key replay, retained restore, and startup with
the existing authority after container recreation. PR CI runs the single SDK
acceptance flow plus lifecycle and restore tests. The nightly job retains the
full E2E suite.

`e2e/fred-wire-golden.json` still records its actual v0.13 observation. Do not
change that provenance or its expected fields based solely on reading Go source;
refresh it after successful live capture against the upgraded pin. Local unit
and bootstrap-script tests do not establish live XFS or rollout acceptance.
