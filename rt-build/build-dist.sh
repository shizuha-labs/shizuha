#!/usr/bin/env bash
# Build Shizuha Runtime distribution archives for all platforms.
#
# Creates self-contained tarballs with:
#   - Node.js binary (platform-specific)
#   - shizuha.min.js (bundled CLI)
#   - node_modules/ (native addons + external deps)
#   - mcp/ (MCP server Python files)
#
# Usage:
#   ./build-dist.sh                    # Build for current platform
#   ./build-dist.sh linux-x64          # Build for specific target
#   ./build-dist.sh all                # Build all platforms (needs Docker for cross-platform)
#
# Output: releases/shizuha-<version>-<platform>-<arch>.tar.gz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Paths relative to monorepo
SHIZUHA_SRC="$SCRIPT_DIR/.."
RT_DIR="$SCRIPT_DIR/../../rt"
DATA_DIR="$SCRIPT_DIR/../../data/rt"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
NODE_VERSION="22.14.0"
RELEASES_DIR="$DATA_DIR/releases"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()  { printf "${CYAN}  %s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}  ✓ %s${RESET}\n" "$*"; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

# All supported targets
ALL_TARGETS="linux-x64 linux-arm64 darwin-x64 darwin-arm64"

# ── Resolve which targets to build ───────────────────────────────────────

TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  # Auto-detect current platform
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "$OS" in
    Linux)  PLAT="linux" ;;
    Darwin) PLAT="darwin" ;;
    *)      echo "Unsupported OS: $OS"; exit 1 ;;
  esac
  case "$ARCH" in
    x86_64|amd64)  ARC="x64" ;;
    aarch64|arm64) ARC="arm64" ;;
    *)             echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  TARGET="${PLAT}-${ARC}"
fi

if [ "$TARGET" = "all" ]; then
  TARGETS="$ALL_TARGETS"
else
  TARGETS="$TARGET"
fi

# ── Node.js download URL helper ──────────────────────────────────────────

node_url() {
  local plat="$1" arch="$2"
  local ext="tar.xz"
  [ "$plat" = "darwin" ] && ext="tar.gz"
  echo "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${plat}-${arch}.${ext}"
}

# ── Build one target ────────────────────────────────────────────────────

build_target() {
  local target="$1"
  local plat="${target%-*}"
  local arch="${target#*-}"
  local name="shizuha-${VERSION}-${target}"

  step "Building ${name}..."

  local work="$RELEASES_DIR/.work/${target}"
  local staging="$work/$name"
  rm -rf "$work"
  mkdir -p "$staging"/{bin,lib,mcp}

  # 1. Download Node.js
  local node_tarball="$work/node.tar"
  local url
  url=$(node_url "$plat" "$arch")
  if [ ! -f "$RELEASES_DIR/.cache/node-v${NODE_VERSION}-${target}.tar" ]; then
    info "Downloading Node.js ${NODE_VERSION} for ${target}..."
    mkdir -p "$RELEASES_DIR/.cache"
    curl -fSL --progress-bar "$url" -o "$RELEASES_DIR/.cache/node-v${NODE_VERSION}-${target}.tar"
  else
    info "Using cached Node.js ${NODE_VERSION} for ${target}"
  fi
  cp "$RELEASES_DIR/.cache/node-v${NODE_VERSION}-${target}.tar" "$node_tarball"

  # Extract just the node binary
  info "Extracting Node.js binary..."
  local strip_dir="node-v${NODE_VERSION}-${plat}-${arch}"
  if [ "$plat" = "darwin" ]; then
    tar xzf "$node_tarball" -C "$work" "${strip_dir}/bin/node" "${strip_dir}/bin/npm" "${strip_dir}/bin/npx" "${strip_dir}/lib/"
  else
    tar xJf "$node_tarball" -C "$work" "${strip_dir}/bin/node" "${strip_dir}/bin/npm" "${strip_dir}/bin/npx" "${strip_dir}/lib/"
  fi
  mv "$work/${strip_dir}/bin/node" "$staging/bin/node"
  # Copy npm/npx and lib for npm to work during install
  mv "$work/${strip_dir}/bin/npm" "$staging/bin/npm"
  mv "$work/${strip_dir}/bin/npx" "$staging/bin/npx"
  cp -r "$work/${strip_dir}/lib" "$staging/"
  rm -rf "$work/${strip_dir}"

  # 2. Copy shizuha bundle
  info "Copying CLI bundle..."
  cp "$DATA_DIR/dist/shizuha.min.js" "$staging/lib/shizuha.js"

  # 3. Install npm dependencies (native addons need to match target platform)
  info "Installing npm dependencies..."
  cp "$SCRIPT_DIR/package.json" "$staging/lib/package.json"

  local current_plat current_arch
  current_plat="$(uname -s | tr '[:upper:]' '[:lower:]')"
  current_arch="$(uname -m)"
  [ "$current_arch" = "x86_64" ] && current_arch="x64"
  [ "$current_arch" = "aarch64" ] && current_arch="arm64"

  if [ "$plat" = "$current_plat" ] && [ "$arch" = "$current_arch" ]; then
    # Native build — just npm install
    (cd "$staging/lib" && PATH="$staging/bin:$PATH" npm install --production --silent 2>&1 | tail -5)
  else
    # Cross-platform — use Docker
    info "Cross-building native modules via Docker..."
    local docker_plat="${plat}/${arch}"
    docker run --rm --platform "$docker_plat" \
      -v "$staging/lib:/build" \
      -w /build \
      node:${NODE_VERSION}-bookworm-slim \
      sh -c "npm install --production --silent 2>&1 | tail -5" || {
        echo "Docker cross-build failed for $target. Skipping."
        rm -rf "$work"
        return 1
      }
  fi
  ok "Dependencies installed"

  # 4. Copy web UI (dashboard)
  local shizuha_web_dir="$SHIZUHA_SRC/dist/web"
  if [ -d "$shizuha_web_dir" ]; then
    info "Copying web UI..."
    mkdir -p "$staging/dist/web"
    cp -r "$shizuha_web_dir"/* "$staging/dist/web/"
    ok "Web UI bundled"
  else
    info "Web UI not found at $shizuha_web_dir — dashboard will be API-only"
  fi

  # 5. Copy MCP servers
  info "Copying MCP servers..."
  cp "$RT_DIR"/mcp/*.py "$staging/mcp/"
  [ -f "$RT_DIR/mcp/start-mcp-daemons.sh" ] && cp "$RT_DIR/mcp/start-mcp-daemons.sh" "$staging/mcp/"

  # 5. Create the shizuha wrapper
  cat > "$staging/bin/shizuha" << 'WRAPPER'
#!/usr/bin/env bash
# Shizuha Runtime — standalone CLI wrapper
SHIZUHA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$SHIZUHA_ROOT/bin/node" "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
WRAPPER
  chmod +x "$staging/bin/shizuha"

  # 6. Create self-install script
  cat > "$staging/install" << 'INSTALL_SCRIPT'
#!/usr/bin/env bash
# Post-extraction installer — called by install.sh or manually
set -euo pipefail
SHIZUHA_DIR="${SHIZUHA_DIR:-$HOME/.shizuha}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy everything to ~/.shizuha
# Use rsync-style: delete target files first to avoid "Text file busy"
# on Linux (can't overwrite a running binary, but can delete + create)
if [ "$SELF_DIR" != "$SHIZUHA_DIR" ]; then
  mkdir -p "$SHIZUHA_DIR"
  rm -rf "$SHIZUHA_DIR/bin" "$SHIZUHA_DIR/lib" "$SHIZUHA_DIR/dist" "$SHIZUHA_DIR/mcp" 2>/dev/null || true
  cp -r "$SELF_DIR"/* "$SHIZUHA_DIR/"
fi

# Create a standalone wrapper in ~/.local/bin (not a symlink —
# symlinks break the relative-path resolution in bin/shizuha)
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/shizuha" << WRAPPER
#!/usr/bin/env bash
exec "$SHIZUHA_DIR/bin/shizuha" "\$@"
WRAPPER
chmod +x "$BIN_DIR/shizuha"

# Add to PATH if needed
if ! echo "$PATH" | tr ':' '\n' | grep -q "^$BIN_DIR$"; then
  SHELL_NAME=$(basename "${SHELL:-bash}")
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac
  if [ "$SHELL_NAME" = "fish" ]; then
    echo "set -gx PATH \"$BIN_DIR\" \$PATH" >> "$RC_FILE"
  else
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$RC_FILE"
  fi
  echo "  Added $BIN_DIR to PATH in $RC_FILE"
fi

echo "  Installed to $SHIZUHA_DIR"
echo "  Binary at $BIN_DIR/shizuha"
INSTALL_SCRIPT
  chmod +x "$staging/install"

  # 7. Add version file
  echo "$VERSION" > "$staging/VERSION"

  # 8. Create tarball
  info "Creating archive..."
  mkdir -p "$RELEASE_DIR"
  (cd "$RELEASES_DIR/.work/${target}" && tar czf "$RELEASE_DIR/${name}.tar.gz" "$name")
  local size
  size=$(du -sh "$RELEASE_DIR/${name}.tar.gz" | cut -f1)
  ok "${name}.tar.gz (${size})"

  # Cleanup work dir
  rm -rf "$work"
}

# ── Main ────────────────────────────────────────────────────────────────

printf "\n${BOLD}${CYAN}Building Shizuha Runtime v${VERSION}${RESET}\n"
printf "${DIM}  Node.js: ${NODE_VERSION}${RESET}\n"
printf "${DIM}  Targets: ${TARGETS}${RESET}\n"

# Build the CLI bundle
# Public (default): strips Claude OAuth provider for compliance
# Alpha (--alpha): same as public but output to alpha/ (self-hosted, rapid iteration)
# Beta (--beta): includes Claude OAuth provider (self-hosted, internal only)
CHANNEL="public"
for arg in "$@"; do
  [ "$arg" = "--alpha" ] && CHANNEL="alpha"
  [ "$arg" = "--beta" ] && CHANNEL="beta"
done

RELEASE_DIR="$DATA_DIR/releases"
case "$CHANNEL" in
  beta)
    RELEASE_DIR="$SCRIPT_DIR/../../compose/infra/static/beta/releases"
    info "Building CLI bundle (beta — Claude OAuth enabled)..."
    (cd "$SHIZUHA_SRC" && node build-rt.mjs --enable-claude-code-provider --out "$DATA_DIR/dist/shizuha.min.js" 2>&1 | tail -3)
    ;;
  alpha)
    RELEASE_DIR="$SCRIPT_DIR/../../compose/infra/static/alpha/releases"
    info "Building CLI bundle (alpha — public build, self-hosted)..."
    (cd "$SHIZUHA_SRC" && node build-rt.mjs --out "$DATA_DIR/dist/shizuha.min.js" 2>&1 | tail -3)
    ;;
  *)
    info "Building CLI bundle (public — API key only, no Claude OAuth)..."
    (cd "$SHIZUHA_SRC" && node build-rt.mjs --out "$DATA_DIR/dist/shizuha.min.js" 2>&1 | tail -3)
    ;;
esac

if [ ! -f "$DATA_DIR/dist/shizuha.min.js" ]; then
  echo "Error: dist/shizuha.min.js not found. Build failed."
  exit 1
fi

# Keep rt/dist/ in sync (committed to public repo)
mkdir -p "$RT_DIR/dist"
cp "$DATA_DIR/dist/shizuha.min.js" "$RT_DIR/dist/shizuha.min.js"

for t in $TARGETS; do
  build_target "$t" || true
done

step "Build complete!"
printf "\n${DIM}  Archives in: $(cd "$RELEASE_DIR" && pwd)/${RESET}\n"
ls -lh "$RELEASE_DIR"/shizuha-*.tar.gz 2>/dev/null || true
printf "\n"
