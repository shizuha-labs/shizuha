#!/usr/bin/env bash
# Shizuha Runtime Installer
#
# Two installation modes (auto-detected):
#
#   1. FROM SOURCE — if this script is in a directory with cli/src/,
#      it builds from source and installs locally. For developers.
#
#   2. FROM BUILDS — downloads a prebuilt binary for your platform from
#      https://shizuha.com/builds/releases/latest.json.
#      For end users: curl -fsSL https://shizuha.com/install.sh | bash
#
set -euo pipefail

SHIZUHA_DIR="${SHIZUHA_DIR:-$HOME/.shizuha}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
# Self-hosted release manifest (SCLI-108). Override with SHIZUHA_BUILDS_URL for testing.
BUILDS_URL="${SHIZUHA_BUILDS_URL:-https://shizuha.com/builds/releases}"
FALLBACK_VERSION="0.1.0"

# Handle help/version BEFORE any detection, download, install, PATH mutation,
# banner, or daemon shutdown. SCLI-586: `install.sh --help` must be a pure,
# read-only, side-effect-free probe.
usage() {
  cat <<'EOF'
Shizuha Runtime Installer

Usage:
  bash install.sh [options]

Options:
  -h, --help         Show this help message and exit.
  -v, --version      Print the installer version and exit.

Environment variables:
  SHIZUHA_DIR        Install directory (default: $HOME/.shizuha)
  BIN_DIR            Binary install directory (default: $HOME/.local/bin)
  SHIZUHA_BUILDS_URL Release manifest base (default: https://shizuha.com/builds/releases)

Examples:
  curl -fsSL https://shizuha.com/install.sh | bash
  bash install.sh --help
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      echo "Shizuha Runtime Installer ${FALLBACK_VERSION}"
      exit 0
      ;;
    *)
      usage >&2
      echo "Error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

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

curl_shizuha() {
  # Keep network failures from looking like an installer hang. Extra flags can
  # be passed as SHIZUHA_CURL_OPTS, e.g. SHIZUHA_CURL_OPTS="-4" for WSL IPv4.
  curl ${SHIZUHA_CURL_OPTS:-} \
    --connect-timeout "${SHIZUHA_CURL_CONNECT_TIMEOUT:-20}" \
    --retry "${SHIZUHA_CURL_RETRIES:-2}" \
    --retry-delay "${SHIZUHA_CURL_RETRY_DELAY:-2}" \
    --max-time "${SHIZUHA_CURL_MAX_TIME:-600}" \
    "$@"
}

prepare_existing_install() {
  if [ -x "$SHIZUHA_DIR/bin/shizuha" ]; then
    info "Stopping existing Shizuha daemon..."
    "$SHIZUHA_DIR/bin/shizuha" down >/dev/null 2>&1 || true
    sleep 1
  fi

  if [ ! -d "$SHIZUHA_DIR" ]; then
    return 0
  fi

  # Running Linux binaries cannot be overwritten in place. Move old runtime
  # trees aside so extraction creates fresh files even if a stale process still
  # holds the old bundled node inode.
  local backup_dir
  backup_dir="$SHIZUHA_DIR/.install-backup-$(date +%s)"
  mkdir -p "$backup_dir"
  local entry
  for entry in bin lib dist; do
    if [ -e "$SHIZUHA_DIR/$entry" ]; then
      mv "$SHIZUHA_DIR/$entry" "$backup_dir/$entry" 2>/dev/null || rm -rf "$SHIZUHA_DIR/$entry" 2>/dev/null || true
    fi
  done
}

# ── Banner ───────────────────────────────────────────────────────────────
printf "\n"
printf "${BOLD}${CYAN}"
printf "  ╔══════════════════════════════════════╗\n"
printf "  ║          静葉  Shizuha Runtime       ║\n"
printf "  ║     AI agents for your entire stack  ║\n"
printf "  ╚══════════════════════════════════════╝\n"
printf "${RESET}\n"

# ── Detect installation mode ─────────────────────────────────────────────
# Check if we're in a source tree (this script lives next to src/ or cli/src/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_DIR=""

# Check relative to script location
if [ -f "$SCRIPT_DIR/src/index.ts" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/cli/src/index.ts" ] && [ -f "$SCRIPT_DIR/cli/package.json" ]; then
  SOURCE_DIR="$SCRIPT_DIR/cli"
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

IS_TERMUX=""
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
      curl_shizuha -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
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

  # Copy dist. Developer installs may have an existing symlink from
  # ~/.shizuha/lib/shizuha.js back to this source tree's dist/shizuha.js; skip
  # same-inode entries so source reinstalls stay idempotent.
  local dist_entry dist_dest
  for dist_entry in "$SOURCE_DIR/dist/"*; do
    dist_dest="$SHIZUHA_DIR/lib/$(basename "$dist_entry")"
    if [ -e "$dist_dest" ] && [ "$(readlink -f "$dist_entry")" = "$(readlink -f "$dist_dest")" ]; then
      continue
    fi
    rm -rf "$dist_dest"
    cp -r "$dist_entry" "$SHIZUHA_DIR/lib/"
  done

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
# SCLI heap: V8 defaults to a ~4GB old-space cap regardless of host RAM, which
# killed deep interactive/TUI sessions (2026-08-07 OOM at 3.8GB on a 499GB
# host mid-session). `v8.setFlagsFromString` cannot move it after startup; only
# NODE_OPTIONS can. Default to 12GB, respect an operator override. An explicit
# NODE_OPTIONS in the environment stays authoritative.
if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=${SHIZUHA_NODE_HEAP_MB:-12288}"
fi
node "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
SCLI_EXIT=$?
# Hard-crash recovery hint: a V8 OOM abort (or any crash) bypasses JS handlers,
# so the TUI can't print its own "Resume with" line. The TUI persists the active
# session id to ~/.shizuha/.last-tui-session; if node died with a crash code,
# surface the resume command so the user can pick the session back up.
if [ "$SCLI_EXIT" -ne 0 ] && [ -f "$SHIZUHA_ROOT/.last-tui-session" ]; then
  SID="$(head -n1 "$SHIZUHA_ROOT/.last-tui-session" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$SID" ]; then
    printf '\nℹ Shizuha exited abnormally (code %s).\n' "$SCLI_EXIT" >&2
    printf 'ℹ Resume this session with: shizuha resume %s\n' "$SID" >&2
  fi
fi
exit "$SCLI_EXIT"
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
# MODE: BINARY — download prebuilt from self-hosted builds (SCLI-108)
# ════════════════════════════════════════════════════════════════════════
install_from_binary() {
  # Resolve version + download URL from the self-hosted latest.json manifest.
  # If the user pinned a version via SHIZUHA_VERSION, skip the manifest fetch
  # and construct the URL directly.
  TMPDIR_DL="$(mktemp -d)"
  trap "rm -rf '$TMPDIR_DL'" EXIT

  if [ -n "${SHIZUHA_VERSION:-}" ]; then
    VERSION="$SHIZUHA_VERSION"
    DOWNLOAD_URL="${BUILDS_URL}/shizuha-${VERSION}-${TARGET}.tar.gz"
    EXPECTED_SHA256=""
    info "Using specified version: v${VERSION}"
  else
    step "Checking latest version..."
    MANIFEST_URL="${BUILDS_URL}/latest.json"
    MANIFEST_FILE="$TMPDIR_DL/latest.json"
    if ! curl_shizuha -fsSL "$MANIFEST_URL" -o "$MANIFEST_FILE" 2>/dev/null; then
      if [ "${SHIZUHA_ALLOW_INSTALL_FALLBACK:-0}" = "1" ]; then
        VERSION="$FALLBACK_VERSION"
        DOWNLOAD_URL="${BUILDS_URL}/shizuha-${VERSION}-${TARGET}.tar.gz"
        EXPECTED_SHA256=""
        warn "Could not fetch latest.json — using explicit fallback v${VERSION}"
      else
        err "Could not fetch release manifest: $MANIFEST_URL"
        err "Refusing to silently install fallback v${FALLBACK_VERSION}."
        err "Set SHIZUHA_ALLOW_INSTALL_FALLBACK=1 only for emergency recovery."
        exit 1
      fi
    else
      # Parse per-platform URL and sha256.
      # Extract the block for this target, then grab url/sha256 from it.
      PLATFORM_BLOCK=$(awk "/$TARGET/{found=1} found{print; if (/}/) {found=0}}" "$MANIFEST_FILE" 2>/dev/null || true)
      DOWNLOAD_URL=$(echo "$PLATFORM_BLOCK" | grep '"url"' | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
      EXPECTED_SHA256=$(echo "$PLATFORM_BLOCK" | grep '"sha256"' | sed 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
      # Parse version from JSON when present. Some generated manifests only
      # carry per-platform URLs, so derive the version from the artifact name.
      VERSION=$(grep '"version"' "$MANIFEST_FILE" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
      if [ -z "$VERSION" ] && [ -n "$DOWNLOAD_URL" ]; then
        VERSION=$(basename "$DOWNLOAD_URL" | sed -n "s/^shizuha-\\(.*\\)-${TARGET}\\.tar\\.gz$/\\1/p" || true)
      fi
      if [ -z "$VERSION" ] || [ -z "$DOWNLOAD_URL" ]; then
        if [ "${SHIZUHA_ALLOW_INSTALL_FALLBACK:-0}" = "1" ]; then
          warn "Could not parse latest.json for platform ${TARGET} — using explicit fallback v${FALLBACK_VERSION}"
          VERSION="$FALLBACK_VERSION"
          DOWNLOAD_URL="${BUILDS_URL}/shizuha-${VERSION}-${TARGET}.tar.gz"
          EXPECTED_SHA256=""
        else
          err "Could not parse latest.json for platform ${TARGET}: $MANIFEST_URL"
          err "Refusing to silently install fallback v${FALLBACK_VERSION}."
          err "Set SHIZUHA_ALLOW_INSTALL_FALLBACK=1 only for emergency recovery."
          exit 1
        fi
      else
        ok "Latest version: v${VERSION}"
      fi
    fi
  fi

  step "Downloading Shizuha Runtime v${VERSION}..."

  ARCHIVE_NAME="shizuha-${VERSION}-${TARGET}.tar.gz"

  info "Fetching ${ARCHIVE_NAME}..."
  if ! curl_shizuha -fSL --progress-bar "$DOWNLOAD_URL" -o "$TMPDIR_DL/$ARCHIVE_NAME"; then
    err "Download failed: $DOWNLOAD_URL"
    err ""
    err "This platform (${TARGET}) may not have a prebuilt binary yet."
    err "Available platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64"
    err ""
    err "Alternative: install from source:"
    err "  git clone https://github.com/shizuha-labs/shizuha-beta && cd shizuha-beta && ./install.sh"
    exit 1
  fi

  # SHA256 verification — use the sha256 from latest.json if available.
  if [ -n "${EXPECTED_SHA256:-}" ] && [ "${SKIP_VERIFY:-0}" != "1" ]; then
    if command -v sha256sum &>/dev/null; then
      ACTUAL_SHA=$(sha256sum "$TMPDIR_DL/$ARCHIVE_NAME" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
      ACTUAL_SHA=$(shasum -a 256 "$TMPDIR_DL/$ARCHIVE_NAME" | awk '{print $1}')
    else
      ACTUAL_SHA=""
      warn "No sha256sum/shasum found — skipping checksum verification"
    fi
    if [ -n "$ACTUAL_SHA" ] && [ "$ACTUAL_SHA" != "$EXPECTED_SHA256" ]; then
      err "SHA256 mismatch for ${ARCHIVE_NAME}!"
      err "  Expected: $EXPECTED_SHA256"
      err "  Got:      $ACTUAL_SHA"
      err "The archive may be corrupted or tampered with. Aborting."
      exit 1
    fi
    [ -n "$ACTUAL_SHA" ] && ok "SHA256 verified: ${ARCHIVE_NAME}"
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
    # Last resort: flat binary in the archive root (no directory wrapper)
    FLAT_BIN="$TMPDIR_DL/shizuha"
    if [ -f "$FLAT_BIN" ]; then
      chmod +x "$FLAT_BIN"
      mkdir -p "$SHIZUHA_DIR/bin"
      cp "$FLAT_BIN" "$SHIZUHA_DIR/bin/shizuha"
      chmod +x "$SHIZUHA_DIR/bin/shizuha"
      echo "$VERSION" > "$SHIZUHA_DIR/VERSION"
      echo "binary" > "$SHIZUHA_DIR/INSTALL_MODE"
      echo "${ACTUAL_SHA:-${EXPECTED_SHA256:-}}" > "$SHIZUHA_DIR/.installed-sha256"
      rm -rf "$TMPDIR_DL"
      trap - EXIT
      ok "Installed flat binary to $SHIZUHA_DIR/bin/shizuha"
      return 0
    fi
    err "Archive format unexpected — no directory or binary found after extraction"
    exit 1
  fi

  prepare_existing_install
  mkdir -p "$SHIZUHA_DIR"
  ( cd "$EXTRACTED_DIR" && tar cf - . ) | ( cd "$SHIZUHA_DIR" && tar xf - )

  # Store version + artifact sha (read back by `shizuha update` to detect
  # newer releases even when the semver string is unchanged).
  echo "$VERSION" > "$SHIZUHA_DIR/VERSION"
  echo "binary" > "$SHIZUHA_DIR/INSTALL_MODE"
  echo "${ACTUAL_SHA:-${EXPECTED_SHA256:-}}" > "$SHIZUHA_DIR/.installed-sha256"

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
# SCLI heap default + hard-crash resume hint (see the source-mode wrapper).
if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=${SHIZUHA_NODE_HEAP_MB:-12288}"
fi
node "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
SCLI_EXIT=$?
if [ "$SCLI_EXIT" -ne 0 ] && [ -f "$SHIZUHA_ROOT/.last-tui-session" ]; then
  SID="$(head -n1 "$SHIZUHA_ROOT/.last-tui-session" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$SID" ]; then
    printf '\nℹ Shizuha exited abnormally (code %s).\n' "$SCLI_EXIT" >&2
    printf 'ℹ Resume this session with: shizuha resume %s\n' "$SID" >&2
  fi
fi
exit "$SCLI_EXIT"
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

# ── Cortex key setup (BYO agent flow — SCLI-108) ────────────────────────
# Check if a cortex key is already saved; if not, show setup instructions.
CORTEX_CREDS="$HOME/.shizuha/credentials.json"
CORTEX_KEY_FOUND=false
if [ -f "$CORTEX_CREDS" ] && grep -q '"cortex"' "$CORTEX_CREDS" 2>/dev/null; then
  CORTEX_KEY_FOUND=true
elif [ -n "${CORTEX_API_KEY:-}" ]; then
  CORTEX_KEY_FOUND=true
fi

if [ "$CORTEX_KEY_FOUND" = true ]; then
  printf "  ${GREEN}Cortex:${RESET} ${DIM}key configured — ready to run agents${RESET}\n"
  printf "\n"
else
  printf "  ${BOLD}Connect to Cortex (shizuha.com inference):${RESET}\n"
  printf "\n"
  printf "     ${CYAN}shizuha auth cortex${RESET}             # paste your sk-cortex-… key\n"
  printf "\n"
  printf "  ${DIM}Get a key at ${CYAN}https://cortex.shizuha.com${DIM} → API Keys${RESET}\n"
  printf "\n"
fi

# Show Claude auth hint only if no token is auto-discoverable
CLAUDE_AUTH_FOUND=false
if [ -f "$HOME/.claude/.credentials.json" ]; then
  CLAUDE_AUTH_FOUND=true
elif [ -d "$HOME/.claude/accounts" ] && ls "$HOME/.claude/accounts"/*.json &>/dev/null; then
  CLAUDE_AUTH_FOUND=true
elif [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CLAUDE_AUTH_FOUND=true
fi

if [ "$CLAUDE_AUTH_FOUND" = false ] && [ "$CORTEX_KEY_FOUND" = false ]; then
  printf "  ${DIM}Other providers:${RESET}\n"
  printf "     ${CYAN}shizuha auth claude <token>${RESET}    # Anthropic API key or OAuth token\n"
  printf "     ${CYAN}shizuha auth codex${RESET}             # ChatGPT (free, device-code flow)\n"
  printf "\n"
fi

printf "  ${DIM}Commands:${RESET}\n"
printf "     ${CYAN}shizuha${RESET}                        # Interactive TUI\n"
printf "     ${CYAN}shizuha exec -p \"hello\"${RESET}       # Single prompt (configured model)\n"
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
