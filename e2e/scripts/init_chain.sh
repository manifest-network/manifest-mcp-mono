#!/usr/bin/env bash
# Initialize the manifest-ledger genesis and start a local chain node.
# Adapted from lease-e2e/scripts/init_chain.sh

set -e

update_test_genesis () {
  cat $HOME_DIR/config/genesis.json | jq "$1" > $HOME_DIR/config/tmp_genesis.json && mv $HOME_DIR/config/tmp_genesis.json $HOME_DIR/config/genesis.json
}

# Check if chain is already initialized
if [ -f "$HOME_DIR/config/genesis.json" ]; then
    echo "=== Chain already initialized, starting node ==="

    # Copy keyring to shared volume (in case it was cleared)
    mkdir -p /shared/keyring
    cp -r $HOME_DIR/keyring-test /shared/keyring/ 2>/dev/null || true

    # Start the node
    POA_ADMIN_ADDRESS=${POA_ADMIN_ADDRESS} $BINARY start --home=${HOME_DIR} --pruning=nothing --minimum-gas-prices=0${DENOM} --rpc.laddr="tcp://0.0.0.0:$RPC" --api.enabled-unsafe-cors
    exit 0
fi

echo "=== Initializing chain ==="

# Import provider key
echo "$MNEMO1" | $BINARY keys add "$KEY" --home="$HOME_DIR" --keyring-backend "$KEYRING" --recover

# Import tenant key
echo "$MNEMO2" | $BINARY keys add "$KEY2" --home="$HOME_DIR" --keyring-backend "$KEYRING" --recover

# Initialize chain
$BINARY init $MONIKER --home=$HOME_DIR --chain-id $CHAIN_ID

echo "=== Configuring genesis ==="

# Consensus params
update_test_genesis '.consensus["params"]["block"]["max_gas"]="1000000000"'

# Bank denom metadata (MFX)
update_test_genesis '.app_state["bank"]["denom_metadata"]=[{"base":"umfx","denom_units":[{"aliases":[],"denom":"umfx","exponent":0},{"aliases":[],"denom":"MFX","exponent":6}],"description":"MFX","display":"MFX","name":"MFX","symbol":"MFX","uri":"","uri_hash":""}]'

# Add PWR denom metadata
update_test_genesis '.app_state["bank"]["denom_metadata"] |= . + [{"description": "PWR", "denom_units": [{"denom": "factory/'${POA_ADMIN_ADDRESS}'/upwr", "exponent": 0, "aliases": ["PWR"]}, {"denom": "PWR", "exponent": 6, "aliases": ["factory/'${POA_ADMIN_ADDRESS}'/upwr"]}], "base": "factory/'${POA_ADMIN_ADDRESS}'/upwr", "display": "PWR", "name": "POWER", "symbol": "PWR", "uri": "", "uri_hash": ""}]'

# Governance params (fast voting for testing)
update_test_genesis '.app_state["gov"]["params"]["min_deposit"]=[{"denom":"'$DENOM'","amount":"1000000"}]'
update_test_genesis '.app_state["gov"]["params"]["voting_period"]="15s"'
update_test_genesis '.app_state["gov"]["params"]["expedited_voting_period"]="10s"'

# Staking params
update_test_genesis '.app_state["staking"]["params"]["bond_denom"]="'${BOND_DENOM}'"'
update_test_genesis '.app_state["staking"]["params"]["min_commission_rate"]="0.000000000000000000"'

# Mint params
update_test_genesis '.app_state["mint"]["params"]["mint_denom"]="'$DENOM'"'
update_test_genesis '.app_state["mint"]["params"]["blocks_per_year"]="6311520"'

# Token factory params
update_test_genesis '.app_state["tokenfactory"]["params"]["denom_creation_fee"]=[]'
update_test_genesis '.app_state["tokenfactory"]["params"]["denom_creation_gas_consume"]=0'

# Create PWR token via tokenfactory (owned by POA admin)
update_test_genesis '.app_state["tokenfactory"]["factory_denoms"]=[{"denom": "factory/'${POA_ADMIN_ADDRESS}'/upwr", "authority_metadata": {"admin": "'${POA_ADMIN_ADDRESS}'"}}]'

# Group/POA setup
update_test_genesis '.app_state["group"]["group_seq"]="1"'
update_test_genesis '.app_state["group"]["groups"]=[{"id":"1","admin":"'${POA_ADMIN_ADDRESS}'","metadata":"AQ==","version":"2","total_weight":"2","created_at":"2024-05-16T15:10:54.372190727Z"}]'
update_test_genesis '.app_state["group"]["group_members"]=[{"group_id":"1","member":{"address":"'${ADDR1}'","weight":"1","metadata":"provider","added_at":"2024-05-16T15:10:54.372190727Z"}},{"group_id":"1","member":{"address":"'${ADDR2}'","weight":"1","metadata":"tenant","added_at":"2024-05-16T15:10:54.372190727Z"}}]'
update_test_genesis '.app_state["group"]["group_policy_seq"]="1"'
update_test_genesis '.app_state["group"]["group_policies"]=[{"address":"'${POA_ADMIN_ADDRESS}'","group_id":"1","admin":"'${POA_ADMIN_ADDRESS}'","metadata":"AQ==","version":"2","decision_policy":{"@type":"/cosmos.group.v1.ThresholdDecisionPolicy","threshold":"1","windows":{"voting_period":"'${VOTING_TIMEOUT}'","min_execution_period":"0s"}},"created_at":"2024-05-16T15:10:54.372190727Z"}]'

# WASM permissions (allow everyone for testing)
update_test_genesis '.app_state["wasm"]["params"]["code_upload_access"]["permission"]="Everybody"'
update_test_genesis '.app_state["wasm"]["params"]["instantiate_default_permission"]="Everybody"'

# SKU module - add provider to allowed_list
# ADDR2 is included so the e2e test wallet (tenant) can also self-register
# as a provider via cosmos_tx, unlocking sku/billing routing coverage that
# would otherwise require a second signing key.
update_test_genesis '.app_state["sku"]["params"]["allowed_list"]=["'${ADDR1}'","'${ADDR2}'"]'

# Billing module - add provider to allowed_list
update_test_genesis '.app_state["billing"]["params"]["allowed_list"]=["'${ADDR1}'","'${ADDR2}'"]'

echo "=== Adding genesis accounts ==="

# PWR denom (tokenfactory)
PWR_DENOM="factory/${POA_ADMIN_ADDRESS}/upwr"

# Add provider account with bond denom, fee denom, and PWR
$BINARY genesis add-genesis-account $KEY 100000000000000000${BOND_DENOM},100000000000000000000000000000${DENOM},1000000000000${PWR_DENOM} --keyring-backend $KEYRING --home=$HOME_DIR

# Add tenant account with fee denom and PWR
$BINARY genesis add-genesis-account $KEY2 100000000000000000000000000000${DENOM},1000000000000${PWR_DENOM} --keyring-backend $KEYRING --home=$HOME_DIR

echo "=== Creating validator ==="

# Create validator gentx
$BINARY genesis gentx $KEY 1000000${BOND_DENOM} --keyring-backend $KEYRING --home=$HOME_DIR --chain-id $CHAIN_ID --commission-rate=0.0 --commission-max-rate=1.0 --commission-max-change-rate=0.1

# Collect gentxs
$BINARY genesis collect-gentxs --home=$HOME_DIR

# Validate genesis
$BINARY genesis validate-genesis --home=$HOME_DIR

echo "=== Configuring node ==="

# Configure RPC to listen on all interfaces
sed -i 's/laddr = "tcp:\/\/127.0.0.1:26657"/laddr = "tcp:\/\/0.0.0.0:'$RPC'"/g' $HOME_DIR/config/config.toml

# Enable CORS
sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = \["\*"\]/g' $HOME_DIR/config/config.toml

# Configure REST API
sed -i 's/address = "tcp:\/\/localhost:1317"/address = "tcp:\/\/0.0.0.0:'$REST'"/g' $HOME_DIR/config/app.toml
sed -i 's/enable = false/enable = true/g' $HOME_DIR/config/app.toml

# Configure pprof
sed -i 's/pprof_laddr = "localhost:6060"/pprof_laddr = "localhost:'$PROFF'"/g' $HOME_DIR/config/config.toml

# Configure P2P
sed -i 's/laddr = "tcp:\/\/0.0.0.0:26656"/laddr = "tcp:\/\/0.0.0.0:'$P2P'"/g' $HOME_DIR/config/config.toml

# Configure gRPC
sed -i 's/address = "localhost:9090"/address = "0.0.0.0:'$GRPC'"/g' $HOME_DIR/config/app.toml
sed -i 's/address = "localhost:9091"/address = "0.0.0.0:'$GRPC_WEB'"/g' $HOME_DIR/config/app.toml

# Configure Rosetta
sed -i 's/address = ":8080"/address = "0.0.0.0:'$ROSETTA'"/g' $HOME_DIR/config/app.toml

# Configure fast block times
sed -i 's/timeout_commit = "5s"/timeout_commit = "'$TIMEOUT_COMMIT'"/g' $HOME_DIR/config/config.toml

echo "=== Copying keyring for providerd ==="

# Copy keyring to shared volume so providerd can access it
mkdir -p /shared/keyring
cp -r $HOME_DIR/keyring-test /shared/keyring/

echo "=== Starting node ==="

# Start the node
POA_ADMIN_ADDRESS=${POA_ADMIN_ADDRESS} $BINARY start --home=${HOME_DIR} --pruning=nothing --minimum-gas-prices=0${DENOM} --rpc.laddr="tcp://0.0.0.0:$RPC" --api.enabled-unsafe-cors
