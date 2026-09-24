#!/usr/bin/env bash
# Stateful Fred runs on the Docker host: its writer inventory must never see an
# infrastructure container with a writable bind covering every tenant volume.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
compatibility=${FRED_COMPATIBILITY:-pr240}
compose=(docker compose -f "$repo_root/e2e/docker-compose.yml")
native_dir=${FRED_NATIVE_BACKEND_DIR:-"$repo_root/e2e/.native-backend"}
backend_unit=${FRED_BACKEND_UNIT:-manifest-mcp-e2e-backend}
wait_timeout=${FRED_DEVNET_WAIT_TIMEOUT:-600}
backend_volume=mcp-e2e-docker-backend-data
shared_volume=mcp-e2e-shared-data
backend_image=mcp-e2e-fred:local
artifact_container=

fail() { echo "ERROR: $*" >&2; exit 1; }
root_exec() {
    if [ "$(id -u)" = 0 ]; then "$@"; else sudo -- "$@"; fi
}
cleanup_artifact() {
    if [ -n "$artifact_container" ]; then
        docker rm "$artifact_container" >/dev/null
    fi
}
trap cleanup_artifact EXIT

[[ "$backend_unit" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]] || fail 'Invalid FRED_BACKEND_UNIT'
[[ "$wait_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'FRED_DEVNET_WAIT_TIMEOUT must be a positive number of seconds'

case "$compatibility" in
    pr240) ;;
    v0.13)
        compose=(docker compose --project-name mcp-e2e-v013 -f "$repo_root/e2e/docker-compose.v013.yml")
        ;;
    *) fail 'FRED_COMPATIBILITY must be v0.13 or pr240' ;;
esac

build_devnet() {
    if [ "$compatibility" = v0.13 ]; then
        local source_dir="$repo_root/e2e/.fred-v013"
        local expected=8f0cbd9431b482732d60d81fb59f94a37cd06486
        [ "$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null)" = "$source_dir" ] &&
            [ "$(git -C "$source_dir" rev-parse HEAD)" = "$expected" ] ||
            fail "Clone Fred $expected into e2e/.fred-v013; keep submodules/fred unchanged"
        [ -z "$(git -C "$source_dir" status --porcelain)" ] || fail 'Legacy Fred source checkout must be clean'
    fi
    "${compose[@]}" build
}

refuse_opposite_storage() {
    local prefix=$1 other_mode=$2 suffix
    # A partial reset may remove the config volume while leaving authority or
    # chain journals behind. Every member must be gone before changing modes.
    for suffix in shared-data docker-backend-data providerd-data chain-data; do
        if docker volume inspect "$prefix-$suffix" >/dev/null 2>&1; then
            fail "$other_mode devnet storage exists ($prefix-$suffix); recreate matching disposable XFS and named volumes before switching Fred versions"
        fi
    done
}

start_legacy_devnet() {
    # The two protocols have incompatible storage authority. Separate named
    # volumes do not make their shared host XFS root safe for a downgrade.
    [ ! -e /mnt/fred-xfs/.fred-backend-storage-identity.json ] &&
        [ ! -L /mnt/fred-xfs/.fred-backend-storage-identity.json ] ||
        fail 'PR #240 storage identity exists; recreate matching disposable XFS and named volumes before switching Fred versions'
    refuse_opposite_storage mcp-e2e 'PR #240'
    if systemctl is-active --quiet "$backend_unit"; then
        fail 'PR #240 native backend is running; stop it before switching Fred versions'
    fi
    "${compose[@]}" up -d --wait --wait-timeout "$wait_timeout" --remove-orphans
}

start_devnet() {
    [ "$(uname -s)" = Linux ] || fail 'Stateful E2E requires a Linux Docker host with systemd and XFS'
    for prerequisite in docker node systemctl systemd-run curl xfs_quota; do
        command -v "$prerequisite" >/dev/null || fail "Missing prerequisite: $prerequisite"
    done
    refuse_opposite_storage mcp-e2e-v013 v0.13
    if systemctl is-active --quiet "$backend_unit"; then
        fail "Native backend $backend_unit is already running; use devnet.sh down before up"
    fi
    running_services=$("${compose[@]}" ps --status running --services)
    if [[ $'\n'"$running_services"$'\n' == *$'\nproviderd\n'* ]]; then
        fail 'Provider ingress is already running; use devnet.sh down before up'
    fi

    # Remove old Compose backend/initializer orphans as part of startup, before
    # any host-managed volume launch. Their RW storage binds would be writers.
    "${compose[@]}" up -d --wait --wait-timeout "$wait_timeout" --remove-orphans chain
    "${compose[@]}" up --no-deps --exit-code-from init init

    mkdir -p "$native_dir"
    chmod 0700 "$native_dir"
    native_dir=$(cd -- "$native_dir" && pwd -P)
    # The extractor is never started and has no storage mounts. The artifact is
    # the exact static binary built alongside providerd from the pinned Fred SHA.
    artifact_container=$(docker create --entrypoint /bin/true "$backend_image")
    docker cp "$artifact_container:/usr/bin/docker-backend" "$native_dir/docker-backend"
    docker rm "$artifact_container" >/dev/null
    artifact_container=
    chmod 0755 "$native_dir/docker-backend"

    docker volume create "$backend_volume" >/dev/null
    backend_data=$(docker volume inspect --format '{{ .Mountpoint }}' "$backend_volume")
    shared_data=$(docker volume inspect --format '{{ .Mountpoint }}' "$shared_volume")
    [ -n "$backend_data" ] && [ -n "$shared_data" ] || fail 'Docker did not return the persistent volume locations'
    # Fred classifies the image store from these daemon fields at every
    # admission; the containerd store also needs its content root configured.
    docker info --format '{{json .}}' >"$native_dir/docker-info.json" ||
        fail 'Cannot inspect the Docker image store'
    node_bin=$(command -v node)
    root_exec env FRED_IMAGE_DATA_PATH="${FRED_IMAGE_DATA_PATH:-}" \
        "$node_bin" "$repo_root/e2e/scripts/native-backend-config.mjs" \
        "$shared_data/docker-backend.yaml" "$native_dir/docker-backend.yaml" \
        "$backend_data" "$shared_data" "$native_dir/docker-info.json"
    root_exec env \
        FRED_BACKEND_BIN="$native_dir/docker-backend" \
        FRED_BACKEND_CONFIG="$native_dir/docker-backend.yaml" \
        FRED_BACKEND_DATA_DIR="$backend_data" \
        FRED_VOLUME_DATA_PATH=/mnt/fred-xfs \
        sh "$repo_root/e2e/scripts/init_backend.sh"

    # Fred needs at most 30s HTTP shutdown + 90s worker drain. Let it finish its
    # typed shutdown rather than systemd's default 90s killing it mid-recovery.
    root_exec systemd-run --unit "$backend_unit" --collect \
        --property Type=exec --property TimeoutStopSec=180s \
        --property "WorkingDirectory=$native_dir" \
        --property StandardOutput=journal --property StandardError=journal \
        "$native_dir/docker-backend" --config "$native_dir/docker-backend.yaml"

    deadline=$((SECONDS + wait_timeout))
    until root_exec curl --silent --show-error --fail --max-time 5 \
        --cacert "$shared_data/tls/cert.pem" https://127.0.0.1:9001/health >/dev/null 2>&1; do
        systemctl is-active --quiet "$backend_unit" || fail 'Native backend stopped; inspect devnet.sh logs'
        [ "$SECONDS" -lt "$deadline" ] || fail 'Timed out waiting for native backend health'
        sleep 2
    done
    # Only inventory is available until this proof succeeds. No provider or
    # tenant runner is started while fresh placement authority is initialized.
    "${compose[@]}" up --no-deps --exit-code-from placement-init placement-init
    "${compose[@]}" up -d --wait --wait-timeout "$wait_timeout" --no-deps providerd faucet
}

stop_devnet() {
    local remove_volumes=${1:-}
    [ -z "$remove_volumes" ] || [ "$remove_volumes" = --volumes ] || fail 'Usage: devnet.sh down [--volumes]'
    local load_state
    load_state=$(systemctl show --property=LoadState --value "$backend_unit") || {
        [ "$load_state" = not-found ] || fail 'Cannot inspect native backend unit; refusing to tear down around it'
    }
    if [ "$load_state" != not-found ]; then
        # Provider stays available while the backend drains its callbacks.
        root_exec systemctl stop "$backend_unit"
    fi
    if [ "$remove_volumes" = --volumes ]; then
        "${compose[@]}" down --volumes --remove-orphans
        # This host-owned journal volume is intentionally not mounted by Compose.
        # It also holds <callback_db_path>.image-staging and its import debit.
        if docker volume inspect "$backend_volume" >/dev/null 2>&1; then
            docker volume rm "$backend_volume"
        fi
        # Fred's daemon-wide fred-image-cache-owner-v1 marker is not devnet
        # state; other backends on this daemon may depend on it. Keep it.
        echo 'Named volumes removed. Recreate the matching disposable XFS storage before the next up.'
    else
        "${compose[@]}" down --remove-orphans
    fi
}

case "${1:-}" in
    build) [ "$#" = 1 ] || fail 'Usage: devnet.sh build'; build_devnet ;;
    up)
        [ "$#" = 1 ] || fail 'Usage: devnet.sh up'
        if [ "$compatibility" = v0.13 ]; then start_legacy_devnet; else start_devnet; fi
        ;;
    down)
        [ "$#" -le 2 ] || fail 'Usage: devnet.sh down [--volumes]'
        if [ "$compatibility" = v0.13 ]; then
            [ -z "${2:-}" ] || [ "$2" = --volumes ] || fail 'Usage: devnet.sh down [--volumes]'
            "${compose[@]}" down --remove-orphans ${2:+"$2"}
        else stop_devnet "${2:-}"; fi
        ;;
    logs)
        [ "$#" = 1 ] || fail 'Usage: devnet.sh logs'
        "${compose[@]}" logs
        if [ "$compatibility" = pr240 ]; then
            root_exec journalctl --unit "$backend_unit" --no-pager --output short-iso
        fi
        ;;
    *) fail 'Usage: devnet.sh build | up | down [--volumes] | logs' ;;
esac
