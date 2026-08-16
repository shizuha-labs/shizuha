#!/usr/bin/env bash
# =============================================================================
# build-mcp-auth-proxy.sh — multi-arch (amd64+arm64) mcp-auth-proxy build
#
# Builds and pushes one manifest-list tag to the local k3s registry so runtime
# pods pull the correct sidecar binary on both s1/v1-x64 (amd64) and the GB10
# nodes (arm64). The registry is plain HTTP inside the cluster, so the script
# uses a docker-container buildx builder configured to trust it.
#
# Usage:
#   REGISTRY=gx10-1:30500 TAG=src-YYYYMMDD-<sha> ./build-mcp-auth-proxy.sh
#
# Defaults:
#   REGISTRY=gx10-1:30500
#   IMAGE=mcp-auth-proxy
#   TAG=src-<utc yyyymmdd>-<git short sha>
#   PLATFORMS=linux/amd64,linux/arm64
# =============================================================================
set -euo pipefail

REGISTRY="${REGISTRY:-gx10-1:30500}"
IMAGE="${IMAGE:-mcp-auth-proxy}"
TAG="${TAG:-src-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-shizuha-multiarch}"
REF="$REGISTRY/$IMAGE:$TAG"
LATEST_REF="$REGISTRY/$IMAGE:latest"

if ! docker buildx version >/dev/null 2>&1; then
  echo "[build] docker buildx is required" >&2
  exit 1
fi

CFG="$(mktemp /tmp/buildkitd-XXXX.toml)"
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<CONFIG
[registry."docker.io"]
  mirrors = ["http://s1.tail.shizuha.com:30501"]
  http = true
  insecure = true
[registry."ghcr.io"]
  mirrors = ["http://s1.tail.shizuha.com:30502"]
  http = true
  insecure = true
[registry."${REGISTRY}"]
  http = true
  insecure = true
CONFIG

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container --config "$CFG" --bootstrap >/dev/null
fi

echo "[build] $REF platforms=$PLATFORMS builder=$BUILDER"
docker buildx build --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  -f mcp-auth-proxy/Dockerfile \
  -t "$REF" \
  -t "$LATEST_REF" \
  --push mcp-auth-proxy

echo "[build] DONE ref=$REF latest=$LATEST_REF"
echo "[build] verify: docker manifest inspect --insecure $REF"
