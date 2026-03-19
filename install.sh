#!/usr/bin/env bash
# Shizuha Runtime Installer
#
# Two installation modes (auto-detected):
#
#   1. FROM SOURCE — if this script is in a directory with shizuha/src/,
#      it builds from source and installs locally. For developers.
#
#   2. FROM GITHUB — downloads a prebuilt binary for your platform.
#      For end users: curl -fsSL https://shizuha.com/install.sh | bash
#
set -euo pipefail

SHIZUHA_DIR="${SHIZUHA_DIR:-$HOME/.shizuha}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
GITHUB_REPO="${SHIZUHA_REPO:-shizuha-labs/shizuha}"
FALLBACK_VERSION="0.1.0"

# ── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()  { printf "  ${CYAN}%s${RESET}\n" "$*"; }
ok()    { printf "  ${GREEN}%s${RESET}\n" "$*"; }
warn()  { printf "  ${YELLOW}%s${RESET}\n" "$*"; }
err()   { printf "  ${RED}%s${RESET}\n" "$*" >&2; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

# ── Banner ───────────────────────────────────────────────────────────────
printf "\n"
printf "${BOLD}${CYAN}"
printf "  ╔══════════════════════════════════════╗\n"
printf "  ║          静葉  Shizuha Runtime       ║\n"
printf "  ║     AI agents for your entire stack  ║\n"
printf "  ╚══════════════════════════════════════╝\n"
printf "${RESET}\n"

# ── Detect installation mode ─────────────────────────────────────────────
# Check if we're in a source tree (this script lives next to shizuha/src/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_DIR=""

# Check relative to script location
if [ -f "$SCRIPT_DIR/src/index.ts" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/shizuha/src/index.ts" ] && [ -f "$SCRIPT_DIR/shizuha/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR/shizuha"
fi

if [ -n "$SOURCE_DIR" ]; then
  MODE="source"
  info "Detected source tree at: $SOURCE_DIR"
else
  MODE="binary"
  info "No source tree found — will download prebuilt binary"
fi

# ── Detect platform ─────────────────────────────────────────────────────
step "Detecting platform..."

OS="$(uname -s)"
ARCH="$(uname -m)"

IS_TERMUX=false
if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
fi

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    err "Windows is not supported natively. Use WSL:"
    err "  wsl --install && wsl"
    exit 1 ;;
  *) err "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)    ARCH_NAME="x64" ;;
  aarch64|arm64)   ARCH_NAME="arm64" ;;
  armv7l) err "32-bit ARM is not supported. Use a 64-bit OS."; exit 1 ;;
  *) err "Unsupported architecture: $ARCH"; exit 1 ;;
esac

TARGET="${PLATFORM}-${ARCH_NAME}"
ok "Platform: ${TARGET}${IS_TERMUX:+ (Termux)}"

# ── Ensure Node.js ──────────────────────────────────────────────────────
ensure_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node --version 2>/dev/null || echo "unknown")
    ok "Node.js $ver found"
    return 0
  fi

  if [ "$IS_TERMUX" = true ]; then
    info "Installing Node.js via pkg..."
    pkg install -y nodejs || { err "Failed to install Node.js. Run: pkg install nodejs"; exit 1; }
    return 0
  fi

  # Auto-install Node.js 22 via NodeSource
  step "Installing Node.js 22..."
  if [ "$PLATFORM" = "linux" ]; then
    if command -v curl &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null || {
        err "Failed to install Node.js. Install manually: https://nodejs.org"
        exit 1
      }
    else
      err "Node.js not found and curl not available for auto-install."
      err "Install Node.js 22+: https://nodejs.org"
      exit 1
    fi
  elif [ "$PLATFORM" = "darwin" ]; then
    if command -v brew &>/dev/null; then
      brew install node@22 || { err "brew install node failed"; exit 1; }
    else
      err "Node.js not found. Install via: brew install node@22"
      err "Or download from: https://nodejs.org"
      exit 1
    fi
  fi

  if ! command -v node &>/dev/null; then
    err "Node.js installation failed. Install manually: https://nodejs.org"
    exit 1
  fi
  ok "Node.js $(node --version) installed"
}

# ════════════════════════════════════════════════════════════════════════
# MODE: SOURCE — build from local source tree
# ════════════════════════════════════════════════════════════════════════
install_from_source() {
  step "Installing from source..."

  ensure_node

  # Install dependencies
  step "Installing dependencies..."
  (cd "$SOURCE_DIR" && npm install --production=false 2>&1 | tail -3)
  ok "Dependencies installed"

  # Build
  step "Building..."
  (cd "$SOURCE_DIR" && npm run build 2>&1 | tail -5)
  ok "Build complete"

  # Install to ~/.shizuha/lib/
  step "Installing to $SHIZUHA_DIR..."
  mkdir -p "$SHIZUHA_DIR/lib"

  # Copy dist
  cp -r "$SOURCE_DIR/dist/"* "$SHIZUHA_DIR/lib/"

  # Copy node_modules (production only)
  if [ -d "$SOURCE_DIR/node_modules" ]; then
    rsync -a --delete \
      --exclude='.cache' \
      --exclude='vitest' \
      --exclude='@vitest' \
      --exclude='playwright' \
      --exclude='@playwright' \
      --exclude='esbuild' \
      --exclude='@esbuild' \
      --exclude='typescript' \
      --exclude='@types' \
      --exclude='tailwindcss' \
      --exclude='@tailwindcss' \
      "$SOURCE_DIR/node_modules/" "$SHIZUHA_DIR/lib/node_modules/" 2>/dev/null || \
    cp -r "$SOURCE_DIR/node_modules" "$SHIZUHA_DIR/lib/"
  fi

  # Copy package.json
  cp "$SOURCE_DIR/package.json" "$SHIZUHA_DIR/lib/"

  # Create a Node.js wrapper (no bundled binary — uses system Node)
  mkdir -p "$SHIZUHA_DIR/bin"
  cat > "$SHIZUHA_DIR/bin/shizuha" << 'WRAPPER'
#!/usr/bin/env bash
SHIZUHA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
WRAPPER
  chmod +x "$SHIZUHA_DIR/bin/shizuha"

  # Store version (read from package.json if available)
  local src_version
  src_version=$(node -e "console.log(require('$SOURCE_DIR/package.json').version)" 2>/dev/null || echo "$FALLBACK_VERSION")
  echo "$src_version" > "$SHIZUHA_DIR/VERSION"
  echo "source" > "$SHIZUHA_DIR/INSTALL_MODE"

  VERSION="$src_version"
  ok "Installed to $SHIZUHA_DIR"
}

# ════════════════════════════════════════════════════════════════════════
# MODE: BINARY — download prebuilt from GitHub
# ════════════════════════════════════════════════════════════════════════
install_from_binary() {
  # Resolve version: user override > GitHub latest > fallback
  if [ -n "${SHIZUHA_VERSION:-}" ]; then
    VERSION="$SHIZUHA_VERSION"
    info "Using specified version: v${VERSION}"
  else
    step "Checking latest version..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/' || echo "")
    if [ -z "$VERSION" ]; then
      VERSION="$FALLBACK_VERSION"
      warn "Could not detect latest version — using fallback v${VERSION}"
    else
      ok "Latest version: v${VERSION}"
    fi
  fi

  step "Downloading Shizuha Runtime v${VERSION}..."

  ARCHIVE_NAME="shizuha-${VERSION}-${TARGET}.tar.gz"
  DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${ARCHIVE_NAME}"

  TMPDIR_DL="$(mktemp -d)"
  trap "rm -rf '$TMPDIR_DL'" EXIT

  info "Fetching ${ARCHIVE_NAME}..."
  if ! curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$TMPDIR_DL/$ARCHIVE_NAME"; then
    err "Download failed: $DOWNLOAD_URL"
    err ""
    err "This platform (${TARGET}) may not have a prebuilt binary yet."
    err "Available platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64"
    err ""
    err "Alternative: install from source:"
    err "  git clone https://github.com/shizuha-labs/shizuha && cd shizuha && ./install.sh"
    exit 1
  fi

  step "Installing..."

  info "Extracting..."
  tar xzf "$TMPDIR_DL/$ARCHIVE_NAME" -C "$TMPDIR_DL"

  # Try versioned directory first, then generic
  EXTRACTED_DIR="$TMPDIR_DL/shizuha-${VERSION}-${TARGET}"
  if [ ! -d "$EXTRACTED_DIR" ]; then
    # Some archives extract to a single top-level dir
    EXTRACTED_DIR=$(find "$TMPDIR_DL" -maxdepth 1 -mindepth 1 -type d | head -1)
  fi
  if [ -z "$EXTRACTED_DIR" ] || [ ! -d "$EXTRACTED_DIR" ]; then
    err "Archive format unexpected — no directory found after extraction"
    exit 1
  fi

  # Delegate to bundled installer if available
  if [ -x "$EXTRACTED_DIR/install" ]; then
    SHIZUHA_DIR="$SHIZUHA_DIR" BIN_DIR="$BIN_DIR" "$EXTRACTED_DIR/install"
  else
    mkdir -p "$SHIZUHA_DIR"
    cp -r "$EXTRACTED_DIR"/* "$SHIZUHA_DIR/"
  fi

  # Store version
  echo "$VERSION" > "$SHIZUHA_DIR/VERSION"
  echo "binary" > "$SHIZUHA_DIR/INSTALL_MODE"

  rm -rf "$TMPDIR_DL"
  trap - EXIT

  ok "Installed to $SHIZUHA_DIR"

  # Termux fixup
  if [ "$IS_TERMUX" = true ]; then
    ensure_node
    info "Configuring for Termux (using system Node.js)..."
    cat > "$SHIZUHA_DIR/bin/shizuha" << 'TERMUX_WRAPPER'
#!/usr/bin/env bash
SHIZUHA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
TERMUX_WRAPPER
    chmod +x "$SHIZUHA_DIR/bin/shizuha"
    rm -f "$SHIZUHA_DIR/bin/node"

    info "Rebuilding native modules for Termux..."
    pkg install -y build-essential python3 libsqlite 2>/dev/null || true
    npx node-gyp install 2>/dev/null || true
    NODE_VER="$(node -v | tr -d v)"
    COMMON_GYPI="$HOME/.cache/node-gyp/${NODE_VER}/include/node/common.gypi"
    if [ -f "$COMMON_GYPI" ] && grep -q "android_ndk_path" "$COMMON_GYPI"; then
      sed -i "s|<(android_ndk_path)|$PREFIX|g" "$COMMON_GYPI"
    fi
    SQLITE3_DIR="$SHIZUHA_DIR/lib/node_modules/better-sqlite3"
    if [ -d "$SQLITE3_DIR" ]; then
      (cd "$SQLITE3_DIR" && npx node-gyp rebuild --release 2>/dev/null) || warn "better-sqlite3 build failed"
    fi
    (cd "$SHIZUHA_DIR/lib" && npm rebuild tiktoken 2>/dev/null) || true
    ok "Termux configuration complete"
  fi
}

# ── Run the appropriate installer ────────────────────────────────────────

if [ "$MODE" = "source" ]; then
  install_from_source
else
  install_from_binary
fi

# ── Set up PATH ─────────────────────────────────────────────────────────
step "Configuring PATH..."

# Create wrapper in BIN_DIR (not a symlink — symlinks break dirname resolution)
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/shizuha" << WRAPPER
#!/usr/bin/env bash
exec "$SHIZUHA_DIR/bin/shizuha" "\$@"
WRAPPER
chmod +x "$BIN_DIR/shizuha"

PATH_ADDED=false
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
  export PATH="$BIN_DIR:$PATH"
  PATH_ADDED=true
  warn "Added $BIN_DIR to PATH in $RC_FILE"
fi

# ── Verify ──────────────────────────────────────────────────────────────
step "Verifying installation..."

if shizuha --version &>/dev/null 2>&1; then
  INSTALLED_VERSION=$(shizuha --version 2>/dev/null || echo "$VERSION")
  ok "Shizuha Runtime v${INSTALLED_VERSION} installed successfully!"
else
  warn "Binary installed but verification failed."
  warn "Try: source ~/.bashrc && shizuha --version"
fi

# ── Start daemon ────────────────────────────────────────────────────────
step "Starting daemon..."
shizuha down 2>/dev/null || true
DAEMON_STARTED=false
if shizuha up 2>/dev/null; then
  DAEMON_STARTED=true
fi

# ── Done ────────────────────────────────────────────────────────────────
printf "\n"
printf "${BOLD}${GREEN}  Installation complete!${RESET}\n"
printf "\n"

if [ "$DAEMON_STARTED" = true ]; then
  printf "  ${BOLD}${GREEN}Daemon is running.${RESET}\n"
  printf "  ${BOLD}Dashboard:${RESET}  ${CYAN}https://localhost:8015${RESET}\n"
  printf "  ${BOLD}Login:${RESET}      ${CYAN}shizuha${RESET} / ${CYAN}shizuha${RESET}  ${DIM}(change in Settings)${RESET}\n"
  printf "\n"
fi

printf "  ${DIM}Commands:${RESET}\n"
printf "     ${CYAN}shizuha${RESET}                        # Interactive TUI\n"
printf "     ${CYAN}shizuha exec -p \"hello\"${RESET}        # Single prompt\n"
printf "     ${CYAN}shizuha up${RESET}                      # Start daemon + dashboard\n"
printf "     ${CYAN}shizuha down${RESET}                    # Stop daemon\n"
printf "\n"

if [ "$MODE" = "source" ]; then
  printf "  ${DIM}Installed from source: ${SOURCE_DIR}${RESET}\n"
  printf "  ${DIM}To rebuild after changes: cd ${SOURCE_DIR} && npm run build${RESET}\n"
  printf "\n"
fi

if [ "$PATH_ADDED" = true ]; then
  SHELL_NAME=$(basename "${SHELL:-bash}")
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac
  printf "  ${BOLD}${YELLOW}>>> Run this to activate: ${RESET}\n"
  printf "\n"
  printf "     ${BOLD}${CYAN}source ${RC_FILE}${RESET}\n"
  printf "\n"
fi
