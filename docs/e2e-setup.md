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
repository before preflight. Their installer is
restricted to GitHub Actions; local setup uses the Docker installation you manage.

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
docker compose -f e2e/docker-compose.yml build
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

The launcher initializes Fred in order: billing/configuration containers, native
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

## Cleanup

Stop the stack before unmounting. This removes test chain, backend, and provider state.
Remove the image only if it is the disposable image you created above.
Complete the whole cleanup before starting a fresh devnet; removing named volumes
alone does not remove the backend identity and tenant data on the XFS image.

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
