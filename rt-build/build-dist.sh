#!/usr/bin/env bash
# Build Shizuha Runtime distribution archives for all platforms.
#
# Creates self-contained tarballs with:
#   - Node.js binary (platform-specific)
#   - shizuha.min.js (bundled CLI)
#   - node_modules/ (native addons + external deps)
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
RT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)/rt"
DATA_DIR="$RT_DIR"

BASE_VERSION=$(node -p "require('$SHIZUHA_SRC/package.json').version" 2>/dev/null || grep '"version"' "$SHIZUHA_SRC/package.json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
VERSION="${SCLI_VERSION:-$BASE_VERSION}"
BUILD_REVISION="${SCLI_BUILD_REVISION:-$(git -C "$SHIZUHA_SRC" rev-parse --short=12 HEAD 2>/dev/null || true)}"
BUILD_SOURCE="${SCLI_BUILD_SOURCE:-local}"
NODE_VERSION="22.14.0"
# Search tools bundled into bin/ at BUILD time (NOT runtime-downloaded like Pi —
# avoids the first-run GitHub-403). SCLI's grep tool prefers `rg`; glob can use `fd`.
RG_VERSION="${RG_VERSION:-14.1.1}"
FD_VERSION="${FD_VERSION:-10.2.0}"
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

# Bundle ripgrep (rg) + fd into a target's bin/ — fetched per-target at BUILD time
# (cached, no execution on the build host, so cross-arch is fine). Tolerant: a
# failed download just skips that tool (grep falls back to system grep).
bundle_search_tools() {
  local target="$1" staging="$2"
  local work="$RELEASES_DIR/.work/${target}"
  local cache="$RELEASES_DIR/.cache"; mkdir -p "$cache"
  local rg_triple fd_triple
  case "$target" in
    linux-x64)    rg_triple="x86_64-unknown-linux-musl";  fd_triple="x86_64-unknown-linux-musl" ;;
    linux-arm64)  rg_triple="aarch64-unknown-linux-gnu";  fd_triple="aarch64-unknown-linux-musl" ;;
    darwin-arm64) rg_triple="aarch64-apple-darwin";       fd_triple="aarch64-apple-darwin" ;;
    darwin-x64)   rg_triple="x86_64-apple-darwin";        fd_triple="x86_64-apple-darwin" ;;
    *) info "no rg/fd triple for $target — skipping"; return 0 ;;
  esac
  # ripgrep
  local rg_dir="ripgrep-${RG_VERSION}-${rg_triple}"
  local rg_tb="$cache/${rg_dir}.tar.gz"
  [ -f "$rg_tb" ] || { info "Downloading ripgrep ${RG_VERSION} (${rg_triple})..."; \
    curl -fSL --retry 3 "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${rg_dir}.tar.gz" -o "$rg_tb" \
    || { info "rg download failed — skipping (grep falls back to system grep)"; rm -f "$rg_tb"; }; }
  if [ -f "$rg_tb" ] && tar xzf "$rg_tb" -C "$work" "${rg_dir}/rg" 2>/dev/null; then
    mv "$work/${rg_dir}/rg" "$staging/bin/rg"; chmod +x "$staging/bin/rg"; rm -rf "$work/${rg_dir}"; ok "bundled rg"
  fi
  # fd
  local fd_dir="fd-v${FD_VERSION}-${fd_triple}"
  local fd_tb="$cache/${fd_dir}.tar.gz"
  [ -f "$fd_tb" ] || { info "Downloading fd ${FD_VERSION} (${fd_triple})..."; \
    curl -fSL --retry 3 "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${fd_dir}.tar.gz" -o "$fd_tb" \
    || { info "fd download failed — skipping"; rm -f "$fd_tb"; }; }
  if [ -f "$fd_tb" ] && tar xzf "$fd_tb" -C "$work" "${fd_dir}/fd" 2>/dev/null; then
    mv "$work/${fd_dir}/fd" "$staging/bin/fd"; chmod +x "$staging/bin/fd"; rm -rf "$work/${fd_dir}"; ok "bundled fd"
  fi
}

build_target() {
  local target="$1"
  local plat="${target%-*}"
  local arch="${target#*-}"
  local name="shizuha-${VERSION}-${target}"

  step "Building ${name}..."

  local work="$RELEASES_DIR/.work/${target}"
  local staging="$work/$name"
  rm -rf "$work"
  mkdir -p "$staging"/{bin,lib}

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

  # 1b. Bundle search tools (rg/fd) into bin/ so grep/glob work offline (no runtime fetch)
  bundle_search_tools "$target" "$staging"

  # 2. Copy shizuha bundle
  info "Copying CLI bundle..."
  cp "$DATA_DIR/dist/shizuha.min.js" "$staging/lib/shizuha.js"

  # 2b. Copy daemon templates (HEARTBEAT.md etc.) where the runtime resolver looks.
  # The bundle lands at lib/shizuha.js, so heartbeat-template.ts probes
  # lib/templates/ (and lib/../templates/). build-rt.mjs emits them to
  # $DATA_DIR/dist/templates; stage that into lib/templates/ so workspace
  # seeding works from the release tarball, not just the dev/esbuild layout.
  if [ -d "$DATA_DIR/dist/templates" ]; then
    info "Copying daemon templates..."
    mkdir -p "$staging/lib/templates"
    cp -r "$DATA_DIR/dist/templates/." "$staging/lib/templates/"
  else
    info "No daemon templates at $DATA_DIR/dist/templates — skipping"
  fi

  # 3. Install npm dependencies (native addons need to match target platform)
  # Use `npm ci` (deterministic, from the lockfile) so native addons like
  # better-sqlite3 are ALWAYS compiled fresh against the target Node ABI — never
  # reuse a stale prebuilt .node. (2026-06-16: a stale May-2025 better_sqlite3.node
  # in a dev node_modules — built for an older Node ABI — ERR_DLOPEN_FAILED'd under
  # Node v22 and broke the benchmark. `npm ci` requires package-lock.json, so stage it.)
  info "Installing npm dependencies (npm ci — deterministic, rebuilds native addons)..."
  cp "$SCRIPT_DIR/package.json" "$staging/lib/package.json"
  [ -f "$SCRIPT_DIR/package-lock.json" ] && cp "$SCRIPT_DIR/package-lock.json" "$staging/lib/package-lock.json"

  local current_plat current_arch
  current_plat="$(uname -s | tr '[:upper:]' '[:lower:]')"
  current_arch="$(uname -m)"
  [ "$current_arch" = "x86_64" ] && current_arch="x64"
  [ "$current_arch" = "aarch64" ] && current_arch="arm64"

  # Prefer `npm ci` (lockfile, clean, compiles native to match); fall back to
  # `npm install` if the lockfile isn't present/in-sync so the build never blocks.
  local _npm_install='if [ -f package-lock.json ]; then npm ci --omit=dev --silent 2>&1 | tail -5 || npm install --omit=dev --silent 2>&1 | tail -5; else npm install --omit=dev --silent 2>&1 | tail -5; fi'

  if [ "$plat" = "$current_plat" ] && [ "$arch" = "$current_arch" ]; then
    # Native build — npm ci/install compiles native addons for THIS Node/ABI
    (cd "$staging/lib" && PATH="$staging/bin:$PATH" sh -c "$_npm_install")
  else
    # Cross-platform — use Docker
    info "Cross-building native modules via Docker..."
    local docker_plat="${plat}/${arch}"
    docker run --rm --platform "$docker_plat" \
      -v "$staging/lib:/build" \
      -w /build \
      node:${NODE_VERSION}-bookworm-slim \
      sh -c "$_npm_install" || {
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

  # 5. Create the shizuha wrapper
  cat > "$staging/bin/shizuha" << 'WRAPPER'
#!/usr/bin/env bash
# Shizuha Runtime — standalone CLI wrapper
SHIZUHA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Put the bundle's bin/ first so the agent's grep/glob tools pick up the bundled
# rg/fd (and node) — no runtime download, works offline.
export PATH="$SHIZUHA_ROOT/bin:$PATH"
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
# Delete target files first to avoid "Text file busy" on Linux (can't overwrite a
# running binary, but can delete + create). Copy via a tar pipe rather than `cp -r`:
# the node bundle contains symlinks (bin/npm, bin/npx) and npm's own
# node_modules/@shizuha/runtime -> ../.. self-link; BSD/macOS `cp -r` FOLLOWS those
# and dies on "directory causes a cycle" / "No such file" (broke darwin installs).
# tar preserves symlinks verbatim and never traverses the cycle — works on Linux+macOS.
if [ "$SELF_DIR" != "$SHIZUHA_DIR" ]; then
  mkdir -p "$SHIZUHA_DIR"
  rm -rf "$SHIZUHA_DIR/bin" "$SHIZUHA_DIR/lib" "$SHIZUHA_DIR/dist" 2>/dev/null || true
  ( cd "$SELF_DIR" && tar cf - . ) | ( cd "$SHIZUHA_DIR" && tar xf - )
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
  # COPYFILE_DISABLE=1: stop macOS bsdtar embedding AppleDouble ._* resource-fork
  # files in the archive (they pollute every dir and tripped the darwin install).
  (cd "$RELEASES_DIR/.work/${target}" && COPYFILE_DISABLE=1 tar czf "$RELEASE_DIR/${name}.tar.gz" "$name")
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

# Keep rt/dist/ in sync (committed to public repo) — tolerant if rt/ isn't writable
mkdir -p "$RT_DIR/dist" 2>/dev/null && cp "$DATA_DIR/dist/shizuha.min.js" "$RT_DIR/dist/shizuha.min.js" 2>/dev/null || info "rt/dist sync skipped (rt/ not writable) — not needed for the tarball"

for t in $TARGETS; do
  build_target "$t" || true
done

step "Build complete!"
printf "\n${DIM}  Archives in: $(cd "$RELEASE_DIR" && pwd)/${RESET}\n"
ls -lh "$RELEASE_DIR"/shizuha-*.tar.gz 2>/dev/null || true

# ── Generate latest.json manifest (SCLI-108) ────────────────────────────
# install.sh fetches this to resolve the current version + platform URLs
# and SHA256 checksums without needing GitHub releases API access.
step "Generating latest.json..."
BASE_DOWNLOAD_URL="${SCLI_DOWNLOAD_BASE_URL:-https://shizuha.com/builds/releases}"
LATEST_JSON="$RELEASE_DIR/latest.json"
LATEST_TMP="$LATEST_JSON.tmp.$$"
{
printf '{\n'
printf '  "version": "%s",\n' "$VERSION"
printf '  "baseVersion": "%s",\n' "$BASE_VERSION"
printf '  "channel": "%s",\n' "$CHANNEL"
printf '  "build": {\n'
printf '    "source": "%s",\n' "$BUILD_SOURCE"
printf '    "revision": "%s",\n' "$BUILD_REVISION"
printf '    "publishedAt": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '  },\n'
printf '  "platforms": {\n'
  first=true
  for t in $ALL_TARGETS; do
    archive="$RELEASE_DIR/shizuha-${VERSION}-${t}.tar.gz"
    [ -f "$archive" ] || continue
    if command -v sha256sum &>/dev/null; then
      sha=$(sha256sum "$archive" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
      sha=$(shasum -a 256 "$archive" | awk '{print $1}')
    else
      sha="unavailable"
    fi
    [ "$first" = true ] || printf ',\n'
    first=false
    printf '    "%s": {\n' "$t"
    printf '      "url": "%s/shizuha-%s-%s.tar.gz",\n' "$BASE_DOWNLOAD_URL" "$VERSION" "$t"
    printf '      "sha256": "%s",\n' "$sha"
    printf '      "version": "%s",\n' "$VERSION"
    printf '      "source": "%s",\n' "$BUILD_SOURCE"
    printf '      "revision": "%s"\n' "$BUILD_REVISION"
    printf '    }'
  done
  printf '\n  }\n'
  printf '}\n'
} > "$LATEST_TMP"
mv -f "$LATEST_TMP" "$LATEST_JSON"
ok "latest.json written"
printf "\n"
