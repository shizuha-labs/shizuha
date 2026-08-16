#!/usr/bin/env bash
# =============================================================================
# build-agent-runtime.sh — multi-arch (amd64+arm64) shizuha-agent-runtime build
# (PLAT-150). Run from the shizuha-beta repo root on a host with docker buildx
# + arm64 binfmt (e.g. s1) and access to the in-cluster registry gx10-1:30500.
#
#   1. Build the esbuild dist bundle (dist/ is not committed).
#   2. Multi-arch buildx → push a single tag + manifest list to gx10-1:30500.
#
# Multi-arch needs the docker-container buildx driver (the default `docker`
# driver cannot build multiple platforms); we create a one-off builder with a
# buildkitd config that trusts the plain-HTTP in-cluster registry for --push.
#
# Consumers (fleet pods) PULL via each node's loopback localhost:30500 — same
# registry/backing store, just the node-trusted ref (see PLAT-148 settings).
# =============================================================================
set -euo pipefail

REGISTRY="${REGISTRY:-gx10-1:30500}"
IMAGE="${IMAGE:-shizuha-agent-runtime}"
TAG="${TAG:-src-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-shizuha-multiarch}"
PACKAGE_CACHE_HOST="${PACKAGE_CACHE_HOST:-100.64.0.3}"
ARM64_DOCKER_CONTEXT="${ARM64_DOCKER_CONTEXT:-}"
REF="$REGISTRY/$IMAGE:$TAG"
SKILLS_SOURCE_DIR="${SKILLS_SOURCE_DIR:-../skills}"
SKILLS_SOURCE_SHA="$(tr -d '[:space:]' < runtime-skills.lock)"
RUNTIME_SKILLS_DIR=".runtime-skills"
HARNESS_BUILD_LOCK=".harness-build-versions.lock"
HARNESS_BUILD_LOCK_BACKUP="$(mktemp /tmp/harness-build-versions-XXXX.lock)"
cp "$HARNESS_BUILD_LOCK" "$HARNESS_BUILD_LOCK_BACKUP"

cleanup_runtime_skills() {
  rm -rf "$RUNTIME_SKILLS_DIR"
  mkdir -p "$RUNTIME_SKILLS_DIR"
  : > "$RUNTIME_SKILLS_DIR/.gitkeep"
  mv "$HARNESS_BUILD_LOCK_BACKUP" "$HARNESS_BUILD_LOCK"
}
trap cleanup_runtime_skills EXIT

if [[ ",$PLATFORMS," != *",linux/amd64,"* || ",$PLATFORMS," != *",linux/arm64,"* ]]; then
  echo "[build] ERROR: shizuha-agent-runtime must be published as a multi-arch amd64+arm64 manifest list." >&2
  echo "[build]        Set PLATFORMS=linux/amd64,linux/arm64; arch-specific runtime tags are not production-valid." >&2
  exit 2
fi

# 1. esbuild bundle (public channel: API-key only, no Claude OAuth provider).
echo "[build] building dist bundle (npm ci + build:public)..."
npm ci --no-audit --no-fund
npm run build:public

# Materialize the same pinned canonical skills snapshot as CI. Using git
# archive avoids copying .git metadata or whatever happens to be checked out
# in the sibling repository.
[[ "$SKILLS_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "[build] ERROR: runtime-skills.lock must contain one full git SHA" >&2; exit 2;
}
git -C "$SKILLS_SOURCE_DIR" cat-file -e "${SKILLS_SOURCE_SHA}^{commit}" 2>/dev/null || {
  echo "[build] ERROR: skills revision $SKILLS_SOURCE_SHA is unavailable in $SKILLS_SOURCE_DIR" >&2; exit 2;
}
rm -rf "$RUNTIME_SKILLS_DIR"
mkdir -p "$RUNTIME_SKILLS_DIR"
git -C "$SKILLS_SOURCE_DIR" archive "$SKILLS_SOURCE_SHA" | tar -x -C "$RUNTIME_SKILLS_DIR"
SKILL_COUNT="$(find "$RUNTIME_SKILLS_DIR" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
[[ "$SKILL_COUNT" -ge 50 ]] || {
  echo "[build] ERROR: canonical skills snapshot is incomplete ($SKILL_COUNT skills)" >&2; exit 2;
}

# 2. buildkitd config: trust the plain-HTTP in-cluster registry.
CFG="$(mktemp /tmp/buildkitd-XXXX.toml)"
cat > "$CFG" <<EOF
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
EOF

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create \
    --name "$BUILDER" \
    --driver docker-container \
    --platform linux/amd64 \
    --config "$CFG" \
    --bootstrap
  if [[ -n "$ARM64_DOCKER_CONTEXT" ]]; then
    docker buildx create \
      --append \
      --name "$BUILDER" \
      --platform linux/arm64 \
      --config "$CFG" \
      "$ARM64_DOCKER_CONTEXT" \
      --bootstrap
  fi
elif [[ -n "$ARM64_DOCKER_CONTEXT" ]] && ! docker buildx inspect "$BUILDER" | grep -q "$ARM64_DOCKER_CONTEXT"; then
  echo "[build] WARNING: builder '$BUILDER' already exists without visible context '$ARM64_DOCKER_CONTEXT'." >&2
  echo "[build]          Recreate it or choose a fresh BUILDER to avoid arm64 emulation." >&2
fi

# HIVE-600: scli (our own runtime, the dist bundle baked into this image) is a
# tracked harness too. Version scheme <pkgver>.<distBuildStampUTC> — numerically
# semver-comparable, so Hive's current-vs-latest works like the npm harnesses.
SCLI_PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
SCLI_VERSION="${SCLI_PKG_VERSION}.$(date -u +%Y%m%d%H%M)"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-$(npm view @anthropic-ai/claude-code version)}"
CODEX_VERSION="${CODEX_VERSION:-$(npm view @openai/codex version)}"
# Antigravity CLI is a native binary (not npm). Resolve latest from Google's
# public release manifest — Gemini CLI is permanently removed.
AGY_MANIFEST_URL="${AGY_MANIFEST_URL:-https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json}"
ANTIGRAVITY_VERSION="${ANTIGRAVITY_VERSION:-$(curl -fsSL "$AGY_MANIFEST_URL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-$(npm view openclaw version)}"
printf '%s\n' \
  "claude_code=$CLAUDE_CODE_VERSION" \
  "codex=$CODEX_VERSION" \
  "antigravity=$ANTIGRAVITY_VERSION" \
  "openclaw=$OPENCLAW_VERSION" \
  > "$HARNESS_BUILD_LOCK"

echo "[build] $REF  platforms=$PLATFORMS  builder=$BUILDER  scli=$SCLI_VERSION"
docker buildx build --builder "$BUILDER" \
  --platform "$PLATFORMS" \
  --build-arg "PACKAGE_CACHE_HOST=$PACKAGE_CACHE_HOST" \
  --build-arg "SCLI_VERSION=$SCLI_VERSION" \
  --build-arg "SKILLS_SOURCE_SHA=$SKILLS_SOURCE_SHA" \
  --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" \
  --build-arg "CODEX_VERSION=$CODEX_VERSION" \
  --build-arg "ANTIGRAVITY_VERSION=$ANTIGRAVITY_VERSION" \
  --build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION" \
  -f Dockerfile.agent-runtime \
  -t "$REF" \
  --push .

echo "[build] DONE  ref=$REF"
echo "[build] verify (plain-HTTP registry):"
echo "  curl -s http://${REGISTRY}/v2/${IMAGE}/tags/list"
