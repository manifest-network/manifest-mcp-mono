# CosmJS faucet — patched to accept Manifest factory denoms
# Based on: https://github.com/cosmos/cosmjs/blob/v0.38.0/packages/faucet/Dockerfile

FROM node:22-alpine AS builder

RUN apk add --no-cache git alpine-sdk linux-headers build-base gcc libusb-dev python3 py3-pip eudev-dev
RUN ln -sf python3 /usr/bin/python

ARG COSMJS_VERSION=v0.38.0

WORKDIR /app
RUN git clone --depth 1 --branch ${COSMJS_VERSION} https://github.com/cosmos/cosmjs.git .

# Apply patches for factory denom support
COPY apply-patches.js /tmp/apply-patches.js
RUN node /tmp/apply-patches.js

# Build (with relaxed yarn lockfile checksum for patched sources)
RUN YARN_CHECKSUM_BEHAVIOR=update yarn install && yarn run build
RUN (cd packages/faucet && SKIP_BUILD=1 yarn pack-node)

# Runtime
FROM alpine:3.22
RUN apk add --update --no-cache nodejs

COPY --from=builder /app/packages/faucet /app/packages/faucet

WORKDIR /app
EXPOSE 8000
CMD ["/app/packages/faucet/bin/cosmos-faucet-dist"]
