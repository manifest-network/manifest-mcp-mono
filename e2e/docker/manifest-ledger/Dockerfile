# Build stage - compile manifestd from source
FROM golang:1.25-alpine AS go-builder

SHELL ["/bin/sh", "-ecuxo", "pipefail"]

RUN apk add --no-cache ca-certificates build-base git

WORKDIR /code

# Copy go module files first for better caching
COPY go.mod go.sum ./

# Download wasmvm library and dependencies
RUN set -eux; \
    export ARCH=$(uname -m); \
    WASM_VERSION=$(go list -m all | grep github.com/CosmWasm/wasmvm/v2); \
    if [ ! -z "${WASM_VERSION}" ]; then \
      WASMVM_REPO=$(echo $WASM_VERSION | awk '{print $1}'); \
      WASMVM_VERS=$(echo $WASM_VERSION | awk '{print $2}'); \
      wget -O /lib/libwasmvm_muslc.a https://${WASMVM_REPO%/v2}/releases/download/${WASMVM_VERS}/libwasmvm_muslc.${ARCH}.a; \
      chmod +x /lib/libwasmvm_muslc.a; \
      ln -s /lib/libwasmvm_muslc.a /lib/libwasmvm_muslc.${ARCH}.a; \
    fi; \
    go mod download;

# Copy source code
COPY . /code

# Build the binary with static linking
RUN LEDGER_ENABLED=false BUILD_TAGS=muslc LINK_STATICALLY=true make build \
  && file /code/build/manifestd \
  && echo "Ensuring binary is statically linked ..." \
  && (file /code/build/manifestd | grep "statically linked")

# Runtime stage
FROM alpine:3.22

COPY --from=go-builder /code/build/manifestd /usr/bin/manifestd

# Install runtime dependencies
RUN apk add --no-cache curl make bash jq sed openssl

WORKDIR /opt

# REST API, P2P, RPC, gRPC
EXPOSE 1317 26656 26657 9090

CMD ["/usr/bin/manifestd", "version"]
