# Local E2E environment

The full suite creates a local chain and real Fred containers, including retained
volumes. Run it on a Linux host with a local Docker Engine and Compose, initialized
submodules, `xfsprogs`, and permission to create a loop device and mount a
filesystem. Fred's backend is privileged and mounts the Docker socket. Use a
dedicated development host or Linux VM; ordinary Docker Desktop setup on macOS or
Windows does not provide the required host-identical XFS path. Run the checkout,
Docker daemon, and commands inside the Linux VM, or use the project's Linux CI.
Unit tests and the read-only annotation suite need no XFS mount.

## Prepare a disposable volume

The Compose file binds `/mnt/fred-xfs` at the same path inside the backend and the
containers it provisions. It must be a **dedicated XFS mount with project quota
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
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
```

`check:e2e-env` is read-only. It checks the exact mount, filesystem, mount flags,
project quota state, local Docker socket selection, and daemon reachability. It
does not install packages, mount filesystems, or start containers. A missing tool
or permission fails with setup guidance. Passing preflight cannot guarantee image
builds, registry availability, or chain/provider health; inspect Compose logs for
those failures.

## Cleanup

Stop the stack before unmounting. This removes test chain and provider state.
Remove the image only if it is the disposable image you created above.

```bash
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
# Confirm this mount is backed by the disposable image before unmounting.
findmnt --mountpoint /mnt/fred-xfs
sudo umount /mnt/fred-xfs
rm /tmp/manifest-e2e-xfs.img
sudo rmdir /mnt/fred-xfs
```

If unmount reports busy, find and stop the remaining test containers first. Do not
force unmount a filesystem still used by Docker.
