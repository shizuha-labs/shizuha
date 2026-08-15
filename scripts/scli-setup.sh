#!/usr/bin/env bash
# scli-setup.sh — idempotently install Shizuha CLI resilience tooling on a host.
# From a clean checkout: bash scripts/scli-setup.sh
# Installs stable/gamma/beta/alpha wrappers, an hourly healthcheck cron, and a daily soak-gated stable-bless cron.
set -euo pipefail

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [--no-build] [--no-bootstrap] [--no-cron]

Environment overrides:
  SCLI_HOME          default: \$HOME/.shizuha
  SCLI_BIN           default: \$HOME/.local/bin
  SCLI_DEV           default: repository root containing this script
  SCLI_CRON_FILE     if set, write cron entry to this file instead of crontab(1)
  CORTEX_URL         default used by healthcheck: https://cortex.shizuha.com
  SCLI_STABLE_SOAK_DAYS       default used by bless-stable: 3
  SCLI_STABLE_MIN_OK_CHECKS   default used by bless-stable: 1
USAGE
}

DRY_RUN=0
DO_BUILD=1
DO_BOOTSTRAP=1
DO_CRON=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) DO_BUILD=0 ;;
    --no-bootstrap) DO_BOOTSTRAP=0 ;;
    --no-cron) DO_CRON=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCLI_HOME="${SCLI_HOME:-$HOME/.shizuha}"
SCLI_BIN="${SCLI_BIN:-$HOME/.local/bin}"
SCLI_DEV="${SCLI_DEV:-$REPO_ROOT}"
SCLI_CONFIG="${SCLI_CONFIG:-$SCLI_HOME/scli.env}"
SCLI_TOOL_BIN="$SCLI_HOME/bin"
NODE_BIN="${SCLI_NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { echo "node not found in PATH" >&2; exit 2; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %q' "$1"
    shift || true
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

write_file() {
  local path="$1" content="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] write $path"
  else
    mkdir -p "$(dirname "$path")"
    printf '%s\n' "$content" > "$path"
  fi
}

install_cron() {
  local health_line bless_line health_marker bless_marker current next target
  health_marker='# shizuha-scli-healthcheck'
  bless_marker='# shizuha-scli-bless-stable'
  health_line="17 * * * * SCLI_CONFIG=$SCLI_CONFIG $SCLI_TOOL_BIN/shizuha-cli-healthcheck.sh >/dev/null 2>&1 $health_marker"
  bless_line="47 2 * * * SCLI_CONFIG=$SCLI_CONFIG $SCLI_TOOL_BIN/scli-snapshot.sh bless-stable >/dev/null 2>&1 $bless_marker"
  if [ -n "${SCLI_CRON_FILE:-}" ]; then
    target="$SCLI_CRON_FILE"
    current=""
    [ -f "$target" ] && current="$(grep -vF "$health_marker" "$target" | grep -vF "$bless_marker" || true)"
    if [ -n "$current" ]; then
      next="$(printf '%s\n%s\n%s' "$current" "$health_line" "$bless_line")"
    else
      next="$(printf '%s\n%s' "$health_line" "$bless_line")"
    fi
    write_file "$target" "$next"
    return
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    echo "crontab not found; set SCLI_CRON_FILE or install cron" >&2
    exit 2
  fi
  current="$(crontab -l 2>/dev/null | grep -vF "$health_marker" | grep -vF "$bless_marker" || true)"
  if [ -n "$current" ]; then
    next="$(printf '%s\n%s\n%s' "$current" "$health_line" "$bless_line")"
  else
    next="$(printf '%s\n%s' "$health_line" "$bless_line")"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] install crontab line: $health_line"
    echo "[dry-run] install crontab line: $bless_line"
  else
    printf '%s\n' "$next" | crontab -
  fi
}

echo "SCLI setup: repo=$SCLI_DEV home=$SCLI_HOME bin=$SCLI_BIN"
run mkdir -p "$SCLI_TOOL_BIN" "$SCLI_BIN" "$SCLI_HOME/cli-versions/snapshots" "$SCLI_HOME/cli-versions/channels"
if [ "$DRY_RUN" -eq 0 ]; then
  cp "$SCRIPT_DIR/scli-snapshot.sh" "$SCLI_TOOL_BIN/scli-snapshot.sh"
  cp "$SCRIPT_DIR/shizuha-cli-healthcheck.sh" "$SCLI_TOOL_BIN/shizuha-cli-healthcheck.sh"
  chmod +x "$SCLI_TOOL_BIN/scli-snapshot.sh" "$SCLI_TOOL_BIN/shizuha-cli-healthcheck.sh"
else
  echo "[dry-run] install scripts into $SCLI_TOOL_BIN"
fi

config_content="SCLI_DEV=$SCLI_DEV
SCLI_HOME=$SCLI_HOME
SCLI_BIN=$SCLI_BIN
SCLI_VERSIONS_DIR=$SCLI_HOME/cli-versions
SCLI_SNAPSHOT_TOOL=$SCLI_TOOL_BIN/scli-snapshot.sh
SCLI_NODE_BIN=$NODE_BIN
CORTEX_URL=${CORTEX_URL:-https://cortex.shizuha.com}
SCLI_STABLE_SOAK_DAYS=${SCLI_STABLE_SOAK_DAYS:-3}
SCLI_STABLE_MIN_OK_CHECKS=${SCLI_STABLE_MIN_OK_CHECKS:-1}"
write_file "$SCLI_CONFIG" "$config_content"

if [ "$DO_BUILD" -eq 1 ]; then
  if [ ! -d "$SCLI_DEV/node_modules" ]; then
    run npm --prefix "$SCLI_DEV" ci
  fi
  run npm --prefix "$SCLI_DEV" run build:node
  [ "$DRY_RUN" -eq 1 ] || chmod +x "$SCLI_DEV/dist/shizuha.js"
fi

if [ "$DO_BOOTSTRAP" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $SCLI_TOOL_BIN/scli-snapshot.sh bootstrap"
  else
    SCLI_CONFIG="$SCLI_CONFIG" "$SCLI_TOOL_BIN/scli-snapshot.sh" bootstrap
  fi
elif [ "$DRY_RUN" -eq 0 ]; then
  SCLI_CONFIG="$SCLI_CONFIG" "$SCLI_TOOL_BIN/scli-snapshot.sh" wrappers || true
fi

[ "$DO_CRON" -eq 0 ] || install_cron

echo "SCLI setup complete. Add $SCLI_BIN to PATH if needed. Try: shizuha-stable --version"
