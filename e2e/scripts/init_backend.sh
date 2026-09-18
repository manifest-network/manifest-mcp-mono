#!/bin/sh
# Initialize only a completely new disposable E2E backend. Fred itself proves
# that the Docker/XFS substrate is empty and seals the matching journal set.
set -eu

backend_bin=${FRED_BACKEND_BIN:-/usr/bin/docker-backend}
backend_config=${FRED_BACKEND_CONFIG:-/shared/docker-backend.yaml}
backend_data=${FRED_BACKEND_DATA_DIR:-/data}
volume_data=${FRED_VOLUME_DATA_PATH:-/mnt/fred-xfs}

present=0
for path in \
    "$backend_data/callbacks.db" \
    "$backend_data/releases.db" \
    "$backend_data/retention.db" \
    "$backend_data/callbacks.db.storage-identity-anchor.json" \
    "$volume_data/.fred-backend-storage-identity.json"
do
    if [ -e "$path" ] || [ -L "$path" ]; then
        present=$((present + 1))
    fi
done

case "$present" in
    0)
        exec "$backend_bin" --config "$backend_config" --initialize-storage-identity new
        ;;
    5)
        # The backend's normal startup verifies every member, physical storage,
        # and journal identity. Never reseal an existing set to make it pass.
        echo "Backend authority already exists; normal startup will verify it."
        ;;
    *)
        echo "ERROR: incomplete backend authority. Preserve the databases and XFS data together; use Fred's recovery procedure or recreate the entire disposable devnet." >&2
        exit 1
        ;;
esac
