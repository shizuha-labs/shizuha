# mcp-auth-proxy

PLAT-76 Milestone-A MVP sidecar for ADR-PLAT-002.

## Local build

From the repository root:

```sh
make mcp-auth-proxy
make mcp-auth-proxy-test
make mcp-auth-proxy-image IMAGE=mcp-auth-proxy TAG=dev
./build-mcp-auth-proxy.sh   # multi-arch push to gx10-1:30500
```

The Makefile uses a local Go toolchain when present and falls back to `docker run golang:1.22-alpine` for build/test in agent workspaces that do not have Go installed.

Or from this directory:

```sh
go test ./...
go build -o bin/mcp-auth-proxy ./cmd/mcp-auth-proxy
docker build -t mcp-auth-proxy:dev .
```

## Runtime contract

The MVP intentionally listens only on a pod-local Unix Domain Socket. It does **not** open a TCP listener or loopback OAuth callback listener. Agent traffic must use the UDS path configured by `MCP_AUTH_PROXY_SOCKET` (default `/run/shizuha/mcp-auth-proxy/proxy.sock`).

Bootstrap is fail-closed by default:

1. The sidecar reads `SO_PEERCRED` from the accepted UDS connection.
2. The agent posts a projected service-account token to `POST /bootstrap`.
3. The sidecar calls Kubernetes `TokenReview` with audience `shizuha-mcp-auth-proxy`.
4. The sidecar calls the configured shizuha-id mint endpoint seam.

Until PLAT-49's mint endpoint lands, local-only tests may set both stub gates explicitly:

```sh
MCP_AUTH_PROXY_TOKENREVIEW_MODE=stub \
MCP_AUTH_PROXY_STUB_TOKENREVIEW_ALLOW=true \
MCP_AUTH_PROXY_MINT_MODE=stub \
MCP_AUTH_PROXY_STUB_MINT_ALLOW=true \
./bin/mcp-auth-proxy
```

Those stubs are opt-in only; without them, missing TokenReview/mint configuration rejects bootstrap and emits audit events.

## Health surfaces

- `GET /healthz` — process liveness.
- `GET /readyz` — bootstrap and upstream summary.
- `GET /upstreams/health` — per-upstream bounded reconnect state.

Audit events are JSON lines on stderr by default and include identity/auth/transport failure points required by ADR-PLAT-002.

## Multi-arch fleet image

Fleet runtime pods run on both amd64 (s1/v1-x64) and arm64 (GB10) nodes. Build
and push the sidecar as a manifest-list tag so Kubernetes pulls the native
image for each node architecture:

```bash
REGISTRY=gx10-1:30500 TAG=src-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD) ./build-mcp-auth-proxy.sh
```

The script also updates `gx10-1:30500/mcp-auth-proxy:latest` to the same
manifest list. Verify with:

```bash
docker manifest inspect --insecure gx10-1:30500/mcp-auth-proxy:latest
```
