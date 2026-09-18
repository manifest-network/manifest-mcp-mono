#!/usr/bin/env bash
# Hosted-runner setup only. Fred's Docker SDK requires server API >= 1.49;
# install a known supported daemon on the standard socket used by the devnet.
# Package source: https://docs.docker.com/engine/install/ubuntu/
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_OS:-}" != "Linux" ]]; then
    echo "ERROR: Docker installation is restricted to Linux GitHub Actions runners." >&2
    exit 1
fi
. /etc/os-release
if [[ "$ID" != "ubuntu" || "$VERSION_ID" != "24.04" ]]; then
    echo "ERROR: Docker package pin requires the ubuntu-24.04 runner." >&2
    exit 1
fi

# Keep the Docker toolchain together at versions verified by the live E2E run:
# https://github.com/manifest-network/manifest-mcp-mono/actions/runs/35370613452
docker_version='5:29.7.2-1~ubuntu.24.04~noble'
containerd_version='2.3.5-1~ubuntu.24.04~noble'
buildx_version='0.37.1-1~ubuntu.24.04~noble'
compose_version='5.5.1-1~ubuntu.24.04~noble'

# Remove conflicting distribution packages if present (official Docker docs).
conflicts=()
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" == 'install ok installed' ]]; then
        conflicts+=("$package")
    fi
done
if (( ${#conflicts[@]} )); then
    sudo apt-get remove -y "${conflicts[@]}"
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 5 \
    https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
# Replace the hosted image's Docker source to avoid conflicting Signed-By paths.
sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y --allow-downgrades \
    "docker-ce=$docker_version" "docker-ce-cli=$docker_version" \
    "containerd.io=$containerd_version" \
    "docker-buildx-plugin=$buildx_version" "docker-compose-plugin=$compose_version"
sudo systemctl restart docker
docker context use default
docker version
docker compose version
