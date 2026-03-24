#!/usr/bin/env bash
# Initialize billing module data after chain is running:
# - Register the provider on-chain
# - Create test SKUs (docker-micro, docker-small, docker-medium, docker-large)
# - Query SKU UUIDs
# - Copy keyring to shared volume
# - Generate a self-signed TLS certificate for providerd
# - Generate providerd.yaml and docker-backend.yaml configs

set -e

echo "=== Waiting for chain to be healthy ==="

# Wait for chain to be ready
until curl -s http://chain:26657/status | grep -q '"catching_up":false'; do
    echo "Waiting for chain to sync..."
    sleep 2
done

echo "Chain is ready!"

# Give it a moment for blocks to be produced
sleep 3

# Check if provider already exists (idempotent restart)
echo "=== Checking if provider already exists ==="
EXISTING_PROVIDER=$(curl -s "http://chain:1317/liftedinit/sku/v1/provider/address/${ADDR1}" | jq -r '.providers[0].uuid // empty')

if [ -n "$EXISTING_PROVIDER" ]; then
    echo "Provider already exists with UUID: $EXISTING_PROVIDER"
    if [ -f /shared/providerd.yaml ] && [ -f /shared/docker-backend.yaml ] && [ -f /shared/tls/cert.pem ] && [ -f /shared/tls/key.pem ]; then
        echo "Configs already exist. Skipping."
        exit 0
    fi
    PROVIDER_UUID=$EXISTING_PROVIDER
else
    echo "=== Registering provider ==="

    # Create provider on-chain
    # api-url must use HTTPS (chain validation). Providerd is configured with
    # a self-signed TLS cert; the MCP server trusts it via NODE_EXTRA_CA_CERTS.
    $BINARY tx sku create-provider \
        "$ADDR1" \
        "$ADDR1" \
        --api-url "https://localhost:8080" \
        --from $KEY \
        --home $HOME_DIR \
        --keyring-backend $KEYRING \
        --chain-id $CHAIN_ID \
        --node http://chain:$RPC \
        --gas auto \
        --gas-adjustment 1.5 \
        --gas-prices 0.025$DENOM \
        --yes

    # Wait for tx to be included
    sleep 5

    echo "=== Querying provider UUID ==="

    PROVIDER_INFO=$($BINARY query sku provider-by-address $ADDR1 \
        --node http://chain:$RPC \
        --output json)

    echo "Provider info: $PROVIDER_INFO"

    PROVIDER_UUID=$(echo "$PROVIDER_INFO" | jq -r '.providers[0].uuid')

    if [ -z "$PROVIDER_UUID" ] || [ "$PROVIDER_UUID" = "null" ]; then
        echo "ERROR: Failed to get provider UUID"
        exit 1
    fi

    echo "Provider UUID: $PROVIDER_UUID"

    echo "=== Creating SKUs ==="

    # PWR denom (tokenfactory)
    PWR_DENOM="factory/${POA_ADMIN_ADDRESS}/upwr"

    # Create 4 SKU tiers
    # Unit: 1 = per hour
    # Price must be divisible by 3600 (seconds in hour) for non-zero per-second rate
    for SKU_INFO in "docker-micro:3600000" "docker-small:7200000" "docker-medium:14400000" "docker-large:28800000"; do
        NAME=$(echo $SKU_INFO | cut -d: -f1)
        PRICE=$(echo $SKU_INFO | cut -d: -f2)

        echo "Creating SKU: $NAME (price: ${PRICE}${PWR_DENOM})"
        $BINARY tx sku create-sku \
            "$PROVIDER_UUID" \
            "$NAME" \
            1 \
            "${PRICE}${PWR_DENOM}" \
            --from $KEY \
            --home $HOME_DIR \
            --keyring-backend $KEYRING \
            --chain-id $CHAIN_ID \
            --node http://chain:$RPC \
            --gas auto \
            --gas-adjustment 1.5 \
            --gas-prices 0.025$DENOM \
            --yes

        sleep 3
    done

    # Extra wait for final tx
    sleep 3
fi

echo "=== Querying SKU UUIDs ==="

SKUS_JSON=$($BINARY query sku skus-by-provider $PROVIDER_UUID \
    --node http://chain:$RPC \
    --output json)

echo "SKUs: $SKUS_JSON"

# Extract each SKU's UUID by name
MICRO_UUID=$(echo "$SKUS_JSON" | jq -r '.skus[] | select(.name == "docker-micro") | .uuid')
SMALL_UUID=$(echo "$SKUS_JSON" | jq -r '.skus[] | select(.name == "docker-small") | .uuid')
MEDIUM_UUID=$(echo "$SKUS_JSON" | jq -r '.skus[] | select(.name == "docker-medium") | .uuid')
LARGE_UUID=$(echo "$SKUS_JSON" | jq -r '.skus[] | select(.name == "docker-large") | .uuid')

echo "SKU UUIDs:"
echo "  docker-micro:  $MICRO_UUID"
echo "  docker-small:  $SMALL_UUID"
echo "  docker-medium: $MEDIUM_UUID"
echo "  docker-large:  $LARGE_UUID"

# Verify all UUIDs were found
for PAIR in "docker-micro:$MICRO_UUID" "docker-small:$SMALL_UUID" "docker-medium:$MEDIUM_UUID" "docker-large:$LARGE_UUID"; do
    NAME=$(echo $PAIR | cut -d: -f1)
    VALUE=$(echo $PAIR | cut -d: -f2)
    if [ -z "$VALUE" ] || [ "$VALUE" = "null" ]; then
        echo "ERROR: Failed to get UUID for $NAME"
        exit 1
    fi
done

echo "=== Copying keyring to shared volume ==="

mkdir -p /shared/keyring
cp -r $HOME_DIR/keyring-test /shared/keyring/

echo "=== Generating self-signed TLS certificate ==="

mkdir -p /shared/tls
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout /shared/tls/key.pem -out /shared/tls/cert.pem \
    -days 365 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:providerd,IP:127.0.0.1"

echo "=== Generating providerd.yaml ==="

cat > /shared/providerd.yaml << YAML
# Auto-generated by init_billing.sh
production_mode: false

chain_id: "${CHAIN_ID}"
grpc_endpoint: "chain:9090"
websocket_url: "ws://chain:26657/websocket"
grpc_tls_enabled: false

provider_uuid: "${PROVIDER_UUID}"
provider_address: "${ADDR1}"

keyring_backend: "test"
keyring_dir: "/shared/keyring"
key_name: "${KEY}"

api_listen_addr: ":8080"
tls_cert_file: "/shared/tls/cert.pem"
tls_key_file: "/shared/tls/key.pem"
rate_limit_rps: 100
rate_limit_burst: 200

backends:
  - name: docker-1
    url: "http://docker-backend:9001"
    timeout: 30s
    default: true

callback_base_url: "https://providerd:8080"
callback_secret: "${CALLBACK_SECRET}"

withdraw_interval: "1m"
reconciliation_interval: "30s"
bech32_prefix: "manifest"

token_tracker_db_path: "/data/tokens.db"
payload_store_db_path: "/data/payloads.db"
payload_store_ttl: "1h"
payload_store_cleanup_freq: "10m"

gas_limit: 1500000
gas_price: 0
fee_denom: "${DENOM}"
tx_timeout: "30s"
tx_poll_interval: "500ms"
YAML

echo "=== Generating docker-backend.yaml ==="

cat > /shared/docker-backend.yaml << YAML
# Auto-generated by init_billing.sh
name: docker-1
listen_addr: ":9001"
docker_host: "unix:///var/run/docker.sock"
host_address: "localhost"
callback_secret: "${CALLBACK_SECRET}"
callback_insecure_skip_verify: true
container_readonly_rootfs: false
network_isolation: false

# Map on-chain SKU UUIDs to local profile names
sku_mapping:
  "${MICRO_UUID}": "docker-micro"
  "${SMALL_UUID}": "docker-small"
  "${MEDIUM_UUID}": "docker-medium"
  "${LARGE_UUID}": "docker-large"

# Override default profiles with disk_mb=0 (avoids filesystem quota requirement)
sku_profiles:
  docker-micro:
    cpu_cores: 0.25
    memory_mb: 256
    disk_mb: 0
  docker-small:
    cpu_cores: 0.5
    memory_mb: 512
    disk_mb: 0
  docker-medium:
    cpu_cores: 1.0
    memory_mb: 1024
    disk_mb: 0
  docker-large:
    cpu_cores: 2.0
    memory_mb: 2048
    disk_mb: 0

allowed_registries:
  - "docker.io"
  - "ghcr.io"
YAML

echo "=== Generated configs ==="
echo "--- providerd.yaml ---"
cat /shared/providerd.yaml
echo ""
echo "--- docker-backend.yaml ---"
cat /shared/docker-backend.yaml

echo "=== Billing module initialized successfully ==="
echo "Provider UUID: $PROVIDER_UUID"
echo "SKU docker-micro UUID: $MICRO_UUID"
