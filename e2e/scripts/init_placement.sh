#!/bin/sh
# Compose keeps providerd and the test runner stopped until this initializer
# succeeds. The backend serves inventory over verified HTTPS, and this private
# test chain/provider has no tenant lease activity during fresh initialization.
set -eu

preflight_bin=${FRED_PREFLIGHT_BIN:-/usr/bin/placement-preflight}
provider_config=${FRED_PROVIDER_CONFIG:-/shared/providerd.yaml}
placement_db=${FRED_PLACEMENT_DB:-/data/placements.db}
expected_backends='["docker-1"]'

if [ -e "$placement_db" ] || [ -L "$placement_db" ]; then
    # Never overwrite an old, empty, foreign, or damaged authority. Providerd
    # verifies the existing database and its backend identities on startup.
    echo "Placement authority already exists; providerd will verify it."
    exit 0
fi

confirmation=$("$preflight_bin" --config "$provider_config" \
    --print-fresh-confirmation --expected-backends "$expected_backends")

exec "$preflight_bin" --config "$provider_config" \
    --initialize-fresh --expected-backends "$expected_backends" \
    --confirm-insecure-chain 'I ACCEPT UNAUTHENTICATED CHAIN EVIDENCE FOR LOCAL DEVELOPMENT' \
    --confirm-quiesced "$confirmation"
