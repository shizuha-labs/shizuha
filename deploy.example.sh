#!/usr/bin/env bash
# deploy.example.sh — Example deploy script for Shizuha.
#
# Copy this file to deploy.sh and customize the hosts below.
#
# Usage:
#   ./deploy.sh                    # deploy to default host
#   ./deploy.sh my-server          # deploy to a specific host
#   ./deploy.sh user@host.com      # deploy to remote (installed layout)
#   ./deploy.sh --build-only       # just build, don't deploy
#   ./deploy.sh --all              # deploy to all known hosts
#
set -euo pipefail

# ── Known hosts ──
# Format: HOST:LAYOUT
#   dev       = ~/work/shizuha-stack/shizuha/dist (development, source checkout)
#   installed = ~/.shizuha/lib (production, standalone install)
KNOWN_HOSTS=(
  "your-dev-server:dev"
  "user@deploy-host.example.com:installed"
)

build_all() {
  echo "==> Building backend (esbuild)..."
  npm run build

  echo "==> Building web UI (vite)..."
  npm run build:web
}

deploy_dev() {
  local HOST="$1"
  echo "==> Deploying to $HOST (dev layout)..."
  rsync -az --delete dist/ "$HOST:work/shizuha-stack/shizuha/dist/"

  echo "==> Restarting daemon on $HOST..."
  ssh "$HOST" 'cd "$HOME/work/shizuha-stack/shizuha"
    nohup node dist/shizuha.js up --foreground > /tmp/shizuha-daemon.log 2>&1 &
    echo "  Started new daemon (PID: $!)"'
  echo "==> $HOST deployed."
}

deploy_installed() {
  local HOST="$1"
  echo "==> Deploying to $HOST (installed layout)..."
  rsync -az --delete \
    --exclude='node_modules' \
    --exclude='package.json' \
    --exclude='package-lock.json' \
    dist/ "$HOST:.shizuha/lib/"

  echo "==> Restarting daemon on $HOST..."
  ssh "$HOST" 'nohup "$HOME/.shizuha/bin/node" "$HOME/.shizuha/lib/shizuha.js" up --foreground > /tmp/shizuha-daemon.log 2>&1 &
    echo "  Started new daemon (PID: $!)"'
  echo "==> $HOST deployed."
}

detect_layout() {
  local HOST="$1"
  for entry in "${KNOWN_HOSTS[@]}"; do
    local h="${entry%%:*}"
    local l="${entry##*:}"
    if [[ "$h" == "$HOST" ]]; then
      echo "$l"
      return
    fi
  done
  # Default: if host contains @ or dots, assume installed layout
  if [[ "$HOST" == *"@"* ]] || [[ "$HOST" == *"."* ]]; then
    echo "installed"
  else
    echo "dev"
  fi
}

# ── Main ──

ARG="${1:-${KNOWN_HOSTS[0]%%:*}}"

if [[ "$ARG" == "--build-only" ]]; then
  build_all
  echo "==> Build complete."
  exit 0
fi

build_all

if [[ "$ARG" == "--all" ]]; then
  for entry in "${KNOWN_HOSTS[@]}"; do
    HOST="${entry%%:*}"
    LAYOUT="${entry##*:}"
    if [[ "$LAYOUT" == "dev" ]]; then
      deploy_dev "$HOST"
    else
      deploy_installed "$HOST"
    fi
  done
  echo "==> All hosts deployed."
else
  LAYOUT=$(detect_layout "$ARG")
  if [[ "$LAYOUT" == "dev" ]]; then
    deploy_dev "$ARG"
  else
    deploy_installed "$ARG"
  fi
fi

echo "==> Done."
