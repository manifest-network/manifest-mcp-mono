#!/bin/sh
# Startup wrapper for the CosmJS faucet (vendored + patched in
# e2e/docker/faucet for factory-denom support).
#
# Computes the sanitized PWR denom env-var name at runtime so the compose
# file does not need to hardcode the POA admin address.

set -e

# Validate required environment variables
MISSING=""
[ -z "$FAUCET_MNEMONIC" ] && MISSING="$MISSING FAUCET_MNEMONIC"
[ -z "$FAUCET_PWR_DENOM" ] && MISSING="$MISSING FAUCET_PWR_DENOM"
[ -z "$FAUCET_CREDIT_AMOUNT_PWR" ] && MISSING="$MISSING FAUCET_CREDIT_AMOUNT_PWR"
[ -z "$FAUCET_CREDIT_AMOUNT_UMFX" ] && MISSING="$MISSING FAUCET_CREDIT_AMOUNT_UMFX"
[ -z "$FAUCET_TOKENS" ] && MISSING="$MISSING FAUCET_TOKENS"

if [ -n "$MISSING" ]; then
  echo "FATAL: Missing required environment variables:$MISSING"
  exit 1
fi

echo "=== Waiting for chain to be healthy ==="
MAX_RETRIES=60
RETRY=0
until wget -q -O - http://chain:26657/status 2>/dev/null | grep -q '"catching_up":false'; do
  RETRY=$((RETRY + 1))
  if [ "$RETRY" -ge "$MAX_RETRIES" ]; then
    echo "FATAL: Chain not ready after $MAX_RETRIES attempts"
    exit 1
  fi
  echo "  Waiting for chain... (attempt $RETRY/$MAX_RETRIES)"
  sleep 2
done
echo "Chain is ready"

# The patched tokenmanager.ts sanitizes denoms before env-var lookup:
#   denom.toUpperCase().replace(/[^A-Z0-9]/g, "_")
# Replicate that logic in shell so we can set the correct env-var.
SANITIZED=$(printf '%s' "$FAUCET_PWR_DENOM" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')
export "FAUCET_CREDIT_AMOUNT_${SANITIZED}=${FAUCET_CREDIT_AMOUNT_PWR}"

echo "=== Starting faucet ==="
echo "  Tokens: ${FAUCET_TOKENS}"
echo "  MFX credit: ${FAUCET_CREDIT_AMOUNT_UMFX}"
echo "  PWR credit: ${FAUCET_CREDIT_AMOUNT_PWR} (env: FAUCET_CREDIT_AMOUNT_${SANITIZED})"

exec /app/packages/faucet/bin/cosmos-faucet-dist start http://chain:26657
