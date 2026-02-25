# Multi-stage build for fred (providerd + docker-backend)
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache ca-certificates build-base git

WORKDIR /code

# Copy go module files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build both binaries
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/providerd ./cmd/providerd
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/docker-backend ./cmd/docker-backend

# ============================================================================
# Providerd runtime
# ============================================================================
FROM alpine:3.22 AS providerd

RUN apk add --no-cache ca-certificates curl

COPY --from=builder /build/providerd /usr/bin/providerd

WORKDIR /app

EXPOSE 8080

CMD ["/usr/bin/providerd"]

# ============================================================================
# Docker-backend runtime
# ============================================================================
FROM alpine:3.22 AS docker-backend

RUN apk add --no-cache ca-certificates curl

COPY --from=builder /build/docker-backend /usr/bin/docker-backend

WORKDIR /data

EXPOSE 9001

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
    CMD curl -f http://localhost:9001/health || exit 1

CMD ["/usr/bin/docker-backend"]
