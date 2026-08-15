#!/usr/bin/env bash
# Rotates the agent keypair for a given agent workspace
# Usage: ./scripts/rotate-agent-keypair.sh [workspace_dir]
# Default workspace_dir: /workspace

set -euo pipefail

WORKSPACE="${1:-/workspace}"
IDENTITY_DIR="${WORKSPACE}/.identity"
KEYPAIR_FILE="${IDENTITY_DIR}/agent-keypair.json"

# Also check new path (post-migration)
AGENT_USERNAME="${AGENT_USERNAME:-}"
if [ -n "$AGENT_USERNAME" ]; then
  NEW_KEYPAIR_DIR="${HOME}/.shizuha/agents/${AGENT_USERNAME}/identity"
  NEW_KEYPAIR_FILE="${NEW_KEYPAIR_DIR}/agent-keypair.json"
fi

# Compromised key fingerprints to check against
COMPROMISED_KEYS=(
  "7c2d75d37f26f143ddb1cfa9e7c06a2cb2eaa291aac6a839871913fbf3a59cce"
)

rotate_keypair() {
  local keyfile="$1"
  if [ ! -f "$keyfile" ]; then
    echo "[INFO] No keypair at $keyfile — will be auto-generated on next startup"
    return 0
  fi

  # Check if this is a compromised key
  local pubkey
  pubkey=$(KEYFILE="$keyfile" node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.KEYFILE,'utf-8')).publicKey || '')" 2>/dev/null || echo "")

  local is_compromised=false
  for ck in "${COMPROMISED_KEYS[@]}"; do
    if [ "$pubkey" = "$ck" ]; then
      is_compromised=true
      break
    fi
  done

  if [ "$is_compromised" = true ]; then
    echo "[CRITICAL] Found compromised key: ${pubkey:0:16}..."
    echo "[ACTION] Backing up and removing compromised keypair"
    mv "$keyfile" "${keyfile}.compromised.$(date +%s)"
    echo "[OK] Compromised keypair removed. New keypair will be auto-generated on next startup."
  else
    echo "[INFO] Key ${pubkey:0:16}... is not in compromised list. No rotation needed."
    echo "[INFO] To force rotation, delete $keyfile manually and restart the agent."
  fi
}

echo "=== Agent Keypair Rotation ==="
echo ""

# Check old path
echo "Checking workspace path: $KEYPAIR_FILE"
rotate_keypair "$KEYPAIR_FILE"

# Check new path (if AGENT_USERNAME set)
if [ -n "${NEW_KEYPAIR_FILE:-}" ]; then
  echo ""
  echo "Checking config path: $NEW_KEYPAIR_FILE"
  rotate_keypair "$NEW_KEYPAIR_FILE"
fi

echo ""
echo "=== Rotation complete ==="
echo "Restart the agent to generate a new keypair and re-authenticate."
