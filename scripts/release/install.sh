#!/usr/bin/env bash
# SCLI-12: Shizuha standalone installer with SHA256 verification.
#
# Usage:
#   curl -fsSL https://github.com/shizuha-labs/shizuha-beta/releases/latest/download/install.sh | bash
#   # or with a specific version:
#   SHIZUHA_VERSION=0.1.0 bash install.sh
#
# Environment variables:
#   SHIZUHA_VERSION   — pin a specific release version (default: latest)
#   SHIZUHA_DIR       — install prefix (default: ~/.shizuha)
#   BIN_DIR           — binary symlink directory (default: ~/.local/bin)
#   SKIP_VERIFY       — set to 1 to skip checksum verification (not recommended)

set -euo pipefail

SHIZUHA_DIR="${SHIZUHA_DIR:-$HOME/.shizuha}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
REPO="shizuha-labs/shizuha-beta"
SKIP_VERIFY="${SKIP_VERIFY:-0}"

# ── Detect platform ──────────────────────────────────────────────────────────

detect_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux) ;;
    darwin) os="darwin" ;;
    *) echo >&2 "Unsupported OS: $os"; exit 1 ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo >&2 "Unsupported architecture: $arch"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# ── Resolve version ──────────────────────────────────────────────────────────

resolve_version() {
  if [ -n "${SHIZUHA_VERSION:-}" ]; then
    echo "$SHIZUHA_VERSION"
    return
  fi
  # Fetch latest release tag via GitHub API (no auth required for public repos)
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": *"v\?\([^"]*\)".*/\1/'
}

# ── Download with progress ────────────────────────────────────────────────────

download() {
  local url="$1" dest="$2"
  echo "  → $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$dest" "$url"
  else
    echo >&2 "Neither curl nor wget found. Install one and retry."
    exit 1
  fi
}

# ── SHA256 verification ──────────────────────────────────────────────────────

verify_checksum() {
  local archive="$1" checksums_file="$2" target="$3"
  local filename expected actual

  filename="$(basename "$archive")"
  expected="$(grep "  ${filename}$" "$checksums_file" | awk '{print $1}')"

  if [ -z "$expected" ]; then
    echo >&2 "ERROR: No checksum entry found for '$filename' in checksums.txt."
    echo >&2 "       Archive may be tampered or the checksums file is outdated."
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  else
    echo >&2 "WARNING: Neither sha256sum nor shasum found — skipping verification."
    return
  fi

  if [ "$actual" != "$expected" ]; then
    echo >&2 "ERROR: SHA256 mismatch for '$filename'!"
    echo >&2 "  Expected: $expected"
    echo >&2 "  Got:      $actual"
    echo >&2 "The archive may be corrupted or tampered with. Aborting."
    exit 1
  fi

  echo "✓ SHA256 verified: $filename"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  local target version base_url archive_name archive_url checksums_url
  local tmpdir

  target="$(detect_target)"
  version="$(resolve_version)"

  if [ -z "$version" ]; then
    echo >&2 "Could not determine release version. Set SHIZUHA_VERSION explicitly."
    exit 1
  fi

  echo "Installing shizuha v${version} (${target})..."

  base_url="https://github.com/${REPO}/releases/download/v${version}"
  archive_name="shizuha-${version}-${target}.tar.gz"
  archive_url="${base_url}/${archive_name}"
  checksums_url="${base_url}/checksums.txt"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  echo "Downloading archive..."
  download "$archive_url" "${tmpdir}/${archive_name}"

  if [ "$SKIP_VERIFY" != "1" ]; then
    echo "Downloading checksums..."
    download "$checksums_url" "${tmpdir}/checksums.txt"
    verify_checksum "${tmpdir}/${archive_name}" "${tmpdir}/checksums.txt" "$target"
  else
    echo "WARNING: Checksum verification skipped (SKIP_VERIFY=1)."
  fi

  echo "Extracting..."
  tar xzf "${tmpdir}/${archive_name}" -C "$tmpdir"

  local extracted="${tmpdir}/shizuha-${version}-${target}"
  if [ ! -d "$extracted" ]; then
    echo >&2 "Unexpected archive layout — expected directory: $extracted"
    exit 1
  fi

  echo "Installing to ${SHIZUHA_DIR}..."
  mkdir -p "$SHIZUHA_DIR"
  rm -rf "$SHIZUHA_DIR/bin" "$SHIZUHA_DIR/lib" 2>/dev/null || true
  cp -r "$extracted"/. "$SHIZUHA_DIR/"

  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/shizuha" << WRAPPER
#!/usr/bin/env bash
exec "${SHIZUHA_DIR}/bin/shizuha" "\$@"
WRAPPER
  chmod +x "$BIN_DIR/shizuha"

  echo ""
  echo "✓ Installed shizuha v${version} to ${SHIZUHA_DIR}"
  echo "  Binary: ${BIN_DIR}/shizuha"
  if ! echo "$PATH" | grep -q "$BIN_DIR"; then
    echo ""
    echo "  Add ${BIN_DIR} to your PATH:"
    echo "    export PATH=\"${BIN_DIR}:\$PATH\""
  fi
}

main "$@"
