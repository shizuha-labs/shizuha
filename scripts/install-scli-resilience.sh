#!/usr/bin/env bash
# install-scli-resilience.sh — install SCLI disaster-resilience tooling on this host.
# Idempotent: safe to re-run.
#
# What it does:
#   1. Copies scli-snapshot.sh + shizuha-cli-healthcheck.sh to ~/.shizuha/bin/
#   2. Writes ~/.shizuha/scli.env (configures paths / GLM URL)
#   3. Bootstraps ~/.shizuha/cli-versions/{snapshots,channels} + wrappers
#   4. Installs hourly healthcheck + daily bless-stable cron jobs
#
# Usage: bash scripts/install-scli-resilience.sh [--dev-dir <path>] [--cortex-url <url>]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCLI_HOME="${SCLI_HOME:-$HOME/.shizuha}"
SCLI_BIN="$SCLI_HOME/bin"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
SCLI_DEV="${SCLI_DEV:-$HOME/work/shizuha-stack/cli}"
SCLI_NODE_BIN="${SCLI_NODE_BIN:-$HOME/.nvm/versions/node/v22.22.3/bin/node}"
CORTEX_URL="${CORTEX_URL:-https://cortex.shizuha.com}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev-dir) SCLI_DEV="$2"; shift 2 ;;
    --cortex-url) CORTEX_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$SCLI_BIN" "$LOCAL_BIN" "$SCLI_HOME/cli-versions/snapshots" "$SCLI_HOME/cli-versions/channels"

# 1. Copy scripts.
cp "$REPO_DIR/scripts/scli-snapshot.sh" "$SCLI_BIN/scli-snapshot.sh"
cp "$REPO_DIR/scripts/shizuha-cli-healthcheck.sh" "$SCLI_BIN/shizuha-cli-healthcheck.sh"
chmod +x "$SCLI_BIN/scli-snapshot.sh" "$SCLI_BIN/shizuha-cli-healthcheck.sh"
echo "scripts installed to $SCLI_BIN"

# 2. Write scli.env (only if absent; preserve existing config).
ENV_FILE="$SCLI_HOME/scli.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
SCLI_DEV=$SCLI_DEV
SCLI_HOME=$SCLI_HOME
SCLI_BIN=$LOCAL_BIN
SCLI_VERSIONS_DIR=$SCLI_HOME/cli-versions
SCLI_SNAPSHOT_TOOL=$SCLI_BIN/scli-snapshot.sh
SCLI_NODE_BIN=$SCLI_NODE_BIN
CORTEX_URL=$CORTEX_URL
ENV
  echo "wrote $ENV_FILE"
else
  echo "keeping existing $ENV_FILE"
fi

# 3. Bootstrap if no snapshots yet.
if [ -z "$(ls -A "$SCLI_HOME/cli-versions/snapshots/" 2>/dev/null)" ]; then
  echo "bootstrapping initial snapshot..."
  SCLI_CONFIG="$ENV_FILE" bash "$SCLI_BIN/scli-snapshot.sh" bootstrap
else
  echo "snapshots already present — skipping bootstrap"
fi

# 4. Cron jobs (idempotent via comment tag).
CTAB="$(crontab -l 2>/dev/null || true)"
if ! echo "$CTAB" | grep -q "shizuha-scli-healthcheck"; then
  (echo "$CTAB"; echo "17 * * * * SCLI_CONFIG=$ENV_FILE $SCLI_BIN/shizuha-cli-healthcheck.sh >/dev/null 2>&1 # shizuha-scli-healthcheck") | crontab -
  echo "installed healthcheck cron"
fi
if ! echo "$CTAB" | grep -q "shizuha-scli-bless-stable"; then
  CTAB="$(crontab -l 2>/dev/null || true)"
  (echo "$CTAB"; echo "47 2 * * * SCLI_CONFIG=$ENV_FILE $SCLI_BIN/scli-snapshot.sh bless-stable >/dev/null 2>&1 # shizuha-scli-bless-stable") | crontab -
  echo "installed bless-stable cron"
fi

echo "SCLI resilience tooling installed. Test: SCLI_CONFIG=$ENV_FILE bash $SCLI_BIN/shizuha-cli-healthcheck.sh"
