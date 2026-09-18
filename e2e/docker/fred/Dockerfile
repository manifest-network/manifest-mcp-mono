# Multi-stage build for fred (providerd + placement-preflight + docker-backend)
#
# Pinned to the EXACT patch that submodules/fred's go.mod names, never a floating
# `golang:1.26-alpine`. These images set GOTOOLCHAIN=local, so the go command will
# not download a newer toolchain to satisfy the directive — a builder even one patch
# behind fails outright at `go mod download` below with
#   go: go.mod requires go >= 1.26.8 (running go 1.26.6; GOTOOLCHAIN=local)
# rather than degrading gracefully. Bump this line in the same commit as any
# submodules/fred gitlink move whose go.mod floor advanced.
FROM golang:1.26.8-alpine AS builder

RUN apk add --no-cache ca-certificates build-base git

WORKDIR /code

# Copy go module files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the services and the offline placement initializer
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/providerd ./cmd/providerd
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/placement-preflight ./cmd/placement-preflight
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/docker-backend ./cmd/docker-backend

# ============================================================================
# Providerd runtime
# ============================================================================
FROM alpine:3.22 AS providerd

RUN apk add --no-cache ca-certificates curl

COPY --from=builder /build/providerd /usr/bin/providerd
COPY --from=builder /build/placement-preflight /usr/bin/placement-preflight
# devnet.sh extracts this static artifact without starting a backend container.
COPY --from=builder /build/docker-backend /usr/bin/docker-backend

WORKDIR /app

EXPOSE 8080

CMD ["/usr/bin/providerd"]
