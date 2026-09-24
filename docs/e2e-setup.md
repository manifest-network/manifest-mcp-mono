# Local E2E environment

The full suite creates a local chain and real Fred containers, including retained
volumes. Run it on a Linux host with a local Docker Engine 28.1+ (API 1.49+) and Compose, initialized
submodules, `xfsprogs`, systemd, and sudo permission to launch the backend and
prepare its filesystem. Fred's stateful backend runs natively on the Docker host. Use a
dedicated development host or Linux VM; ordinary Docker Desktop setup on macOS or
Windows does not provide the required host-identical XFS path. Run the checkout,
Docker daemon, and commands inside the Linux VM, or use the project's Linux CI.
Unit tests and the read-only annotation suite need no XFS mount.

The PR and nightly workflows use Ubuntu 24.04 and install Docker Engine 29.7.2
with pinned containerd, Buildx, and Compose versions from Docker's signed package
repository before preflight. The installer also sets
`features.containerd-snapshotter: false` in `/etc/docker/daemon.json`, merged
with any existing settings, so the runner uses the classic `overlay2` image store
as production does. Docker 29 otherwise uses the containerd store on a data root
with no prior `overlay2` state. The installer prints the storage driver and fails
if it is not classic `overlay2`. It is restricted to GitHub Actions; local setup
uses the Docker installation you manage (see [Image admission](#image-admission)).

Both workflows test Fred v0.13.0 (`8f0cbd9431b482732d60d81fb59f94a37cd06486`)
and PR #240 in separate jobs. Each deploys through the SDK, checks actual HTTP
CORS preflight responses for its maintenance headers, runs maintenance and retained
volume restore, and restarts with persistent state. Command-key replay and conflict
assertions run only on PR #240. The preflight check uses Node HTTP requests; it
does not launch a browser.

Fred PR #240 supports the backend container image only for stateless development.
Do not run the stateful backend or its initializer in containers with a writable
bind of the XFS root: Fred correctly sees those mounts as potential writers to
every tenant volume and refuses a fresh launch. Providerd and the chain remain
containerized; the provider reaches the native backend through Docker's host gateway.

## Prepare a disposable volume

The native backend uses `/mnt/fred-xfs` directly and mounts individual tenant
volume directories into workload containers. It must be a **dedicated XFS mount with project quota
accounting and enforcement enabled**, not an ordinary directory on ext4.

These commands match the CI setup on Debian/Ubuntu. They require sudo and create
a disposable 2 GiB image. First verify that neither path contains existing data;
do not format an existing disk or overwrite a mount used by another application.
Run each command only after the previous one succeeds.

```bash
sudo apt-get install xfsprogs
test ! -e /tmp/manifest-e2e-xfs.img
! mountpoint -q /mnt/fred-xfs
sudo mkdir -p /mnt/fred-xfs
test -z "$(ls -A /mnt/fred-xfs)"
# noclobber prevents replacing an existing image if the earlier check raced.
(set -C; : > /tmp/manifest-e2e-xfs.img)
truncate -s 2G /tmp/manifest-e2e-xfs.img
sudo mkfs.xfs /tmp/manifest-e2e-xfs.img
sudo mount -o loop,prjquota /tmp/manifest-e2e-xfs.img /mnt/fred-xfs
sudo chmod 0777 /mnt/fred-xfs
findmnt --mountpoint /mnt/fred-xfs
xfs_quota -x -c 'state -p' /mnt/fred-xfs
```

The broad directory mode is for this disposable test mount. Do not apply it to
production data. `state -p` must report project `Accounting: ON` and
`Enforcement: ON`. Install `xfsprogs` and verify quota support if it does not.

## Verify and run

```bash
git submodule update --init --recursive
npm ci
npm run build
npm run check:e2e-env
bash e2e/scripts/devnet.sh build
bash e2e/scripts/devnet.sh up
npm run test:e2e
```

`check:e2e-env` is read-only. It checks the exact mount, filesystem, mount flags,
project quota state, local Docker socket selection, daemon reachability, and the
Docker API version required for Fred's image admission. It
does not install packages, mount filesystems, or start containers. A missing tool
or permission fails with setup guidance. Passing preflight cannot guarantee image
builds, registry availability, or chain/provider health. Use
`bash e2e/scripts/devnet.sh logs` to collect Compose and native backend logs.

The local launcher and E2E tests default to `FRED_COMPATIBILITY=pr240` and explicitly
configure the clients for that devnet. The public SDK and MCP servers default to
`v0.13`. To test the legacy provider, first perform the complete disposable storage
reset below, then clone its source separately:

```bash
git clone git@github.com:manifest-network/fred.git e2e/.fred-v013
git -C e2e/.fred-v013 checkout --detach 8f0cbd9431b482732d60d81fb59f94a37cd06486
export FRED_COMPATIBILITY=v0.13
export MANIFEST_FRED_COMPATIBILITY=v0.13
bash e2e/scripts/devnet.sh build
bash e2e/scripts/devnet.sh up
npm run test:e2e
```

This ignored checkout leaves `submodules/fred` and the manifest schema provenance
at PR #240. Legacy mode uses Go 1.26.6 and the v0.13 container backend, with its own
Compose project and named volumes. Modern mode uses Go 1.26.8 and the native backend.
The modes share fixed ports and the dedicated XFS root, so they cannot run together.
Changing modes requires removing the current mode's named volumes **and recreating
the matching XFS image**; neither mode may reuse the other's storage. Keep the same
`FRED_COMPATIBILITY` value for build, up, tests, down, and logs.

The launcher's named-volume guards are supplemented by Fred's storage checks.
If legacy named volumes were removed but managed tenant or retained data remains
on XFS, PR240's `--initialize-storage-identity new` refuses the nonempty managed
volume inventory before publishing new authority. Initialization failure stops
the launcher before backend or provider startup; removing named volumes alone
does not make a cross-version reset valid.

In PR240 mode, the launcher initializes Fred in order: billing/configuration containers, native
backend storage identity, native backend startup, placement authority, then
providerd. It extracts the static backend executable from the built Fred image
and starts the dedicated `manifest-mcp-e2e-backend` systemd unit. The placement
initializer verifies backend HTTPS using the generated test certificate and
proves that the new provider and backend are empty. It explicitly accepts this
isolated test chain's plaintext gRPC. Keep tenant lease traffic and the test
runner stopped until `devnet.sh up` completes. The Fred image builds with Go 1.26.8
and includes `placement-preflight` for this step.

For a normal restart, use `bash e2e/scripts/devnet.sh down`, then
`bash e2e/scripts/devnet.sh up`. Preserve the XFS image and every
Compose volume. The backend's primary identity marker lives on XFS; its anchor
and journals live in `mcp-e2e-docker-backend-data`, and placement authority lives
in `mcp-e2e-providerd-data`. The native backend opens the host paths of its
named-volume journals; they are not copied into temporary storage. Existing
authority is verified at service startup.
The initializers refuse to replace partial, mismatched, or old authority. A
devnet created before this bootstrap needs Fred's documented upgrade procedure,
or a complete reset of the disposable devnet using the cleanup below followed
by a new XFS image. Deleting only Docker volumes or only the XFS image leaves an
incomplete storage identity and prevents startup.
PR240 configuration bootstrap `4` adds image admission. A devnet initialized
with an earlier Fred pin stops at the `init` service with
`Fred bootstrap version '3' does not match required '4'`. Its generated backend
configuration lacks the limits below. Once the new backend admits an image, its
journals cannot be reopened by older Fred binaries. Perform the complete reset.

## Image admission

Fred stages and verifies each new registry image under
`<callback_db_path>.image-staging` before Docker imports it. Registry requests
come from the native backend process over HTTPS, using the host CA roots and the
proxy environment of the backend's systemd unit (the systemd manager's
environment; `devnet.sh` does not forward a shell's `HTTPS_PROXY`/`NO_PROXY`).
Docker daemon mirrors and `certs.d` do not apply. The generated
PR240 configuration limits new images to `image_max_size_mb: 1024`. It keeps an
`image_disk_min_free_mb: 256` free-space floor instead of Fred's 10 GiB and
2 GiB defaults, because the 2 GiB XFS image can never have 2 GiB free. Values
are MiB, and zero selects Fred's default.

The floor applies before every launch to `/mnt/fred-xfs`, Docker's data root
(and, on the containerd image store, its content root), the backend journal
directory and its staging directory. Each concurrent image download also needs 1 GiB above the floor on
the staging filesystem. That is the Docker volume `mcp-e2e-docker-backend-data`,
usually `/var/lib/docker/volumes/mcp-e2e-docker-backend-data/_data/callbacks.db.image-staging`.
Refused admissions name the filesystem and the byte counts. The staging directory
belongs to the backend authority: preserve it across restarts, and do not
delete it or its `image-import-debit-v1` record by hand.
`devnet.sh down --volumes` removes it with the backend volume.

Fred supports two Docker image stores:

- **Classic `overlay2`** (Docker 28 and upgraded installations) needs no
  configuration. Fred accounts the data root that Docker reports.
- **Containerd `overlayfs`** is the default for fresh Docker 29 installations.
  `docker info` reports storage driver `overlayfs` with
  `driver-type io.containerd.snapshotter.v1`. Fred then requires the content
  root as `image_data_path`. `devnet.sh up` adds `/var/lib/containerd` when
  Docker uses the system containerd socket (`/run/containerd/containerd.sock`).
  Otherwise, set `FRED_IMAGE_DATA_PATH` to the containerd root before
  `devnet.sh up`. Admission on this store also creates and removes stopped
  inspection containers.

Fred refuses other drivers, including `btrfs`, `zfs`, `vfs` and
`fuse-overlayfs`, and `devnet.sh up` stops before initializing backend
authority. Switch Docker to one of the supported stores first.

On first start, the development-mode backend creates the Docker volume
`fred-image-cache-owner-v1` labeled `fred.image_cache_mode=shared`. It marks
the whole daemon as a shared, non-collecting image cache and is not devnet
state. `devnet.sh down --volumes` keeps it, and later devnets reuse it. Do not
remove it while any Fred backend on this daemon holds active or retained
authority. If backend startup reports `docker image store has exclusive
ownership`, a production-mode Fred owns this daemon; use a separate Docker
daemon for the E2E devnet.

## Cleanup

Stop the stack before unmounting. This removes test chain, backend, and provider state.
Remove the image only if it is the disposable image you created above.
Complete the whole cleanup before starting a fresh devnet; removing named volumes
alone does not remove the backend identity and tenant data on the XFS image.
The backend volume also holds the image staging directory. The daemon-wide
`fred-image-cache-owner-v1` marker and images Docker already imported remain.

```bash
bash e2e/scripts/devnet.sh down --volumes
# Confirm this mount is backed by the disposable image before unmounting.
findmnt --mountpoint /mnt/fred-xfs
sudo umount /mnt/fred-xfs
rm /tmp/manifest-e2e-xfs.img
sudo rmdir /mnt/fred-xfs
```

If unmount reports busy, find and stop the remaining test containers first. Do not
force unmount a filesystem still used by Docker.
