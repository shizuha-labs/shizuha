#!/usr/bin/env bash
# shizuha-cli-healthcheck.sh — recurring guard for SCLI fallback channels on this host.
# Verifies frozen stable/gamma/beta/alpha channels, checks the live dev-tree CLI,
# and checks the GLM/Cortex endpoint. It auto-heals only by repointing broken
# channels at an already-good snapshot.
set -euo pipefail

SCLI_HOME="${SCLI_HOME:-$HOME/.shizuha}"
CONFIG_FILE="${SCLI_CONFIG:-$SCLI_HOME/scli.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

DEV="${SCLI_DEV:-$(pwd)}"
ROOT="${SCLI_VERSIONS_DIR:-$SCLI_HOME/cli-versions}"
CHAN="$ROOT/channels"
SNAPS="$ROOT/snapshots"
SNAP_TOOL="${SCLI_SNAPSHOT_TOOL:-$SCLI_HOME/bin/scli-snapshot.sh}"
LOG="${SCLI_HEALTH_LOG:-$SCLI_HOME/cli-healthcheck.log}"
HEALTH_EVENTS="${SCLI_HEALTH_EVENTS:-$ROOT/health-events.tsv}"
NODE_BIN="${SCLI_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
CORTEX="${CORTEX_URL:-https://cortex.shizuha.com}"
mkdir -p "$(dirname "$LOG")"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" >> "$LOG"; }
snapshot_id() { basename "${1%/}"; }
record_health_event() {
  local status="$1" ch="$2" d="${3:-}" id=""
  [ -n "$d" ] && id="$(snapshot_id "$d")"
  printf '%s\t%s\t%s\t%s\n' "$(ts)" "$status" "$ch" "$id" >> "$HEALTH_EVENTS"
}
rc=0

verify_dir() {
  local d="$1" node="$1/node"
  [ -x "$node" ] || node="$NODE_BIN"
  [ -f "$d/dist/shizuha.js" ] \
    && [ -d "$d/node_modules" ] \
    && "$node" -e "require('$d/node_modules/better-sqlite3')" >/dev/null 2>&1 \
    && "$node" "$d/dist/shizuha.js" --version >/dev/null 2>&1
}

newest_verified_snapshot() {
  ls -1dt "$SNAPS"/*/ 2>/dev/null | while read -r s; do
    s="${s%/}"
    verify_dir "$s" && { echo "$s"; break; }
  done
}

# 1. Frozen fallback channels.
newest_good=""
for ch in stable gamma beta alpha; do
  d="$(readlink -f "$CHAN/$ch" 2>/dev/null || true)"
  if [ -n "$d" ] && verify_dir "$d"; then
    log "OK channel $ch ($(basename "$d"))"
    record_health_event OK "$ch" "$d"
    [ -z "$newest_good" ] && newest_good="$d"
  else
    log "DEGRADED channel $ch — attempting safe auto-heal"
    [ -n "$d" ] && record_health_event DEGRADED "$ch" "$d" || record_health_event DEGRADED "$ch"
    good="$newest_good"
    [ -z "$good" ] && good="$(newest_verified_snapshot || true)"
    if [ -n "$good" ]; then
      ln -sfn "$good" "$CHAN/$ch"
      if verify_dir "$(readlink -f "$CHAN/$ch")"; then
        log "RECOVERED channel $ch -> $(basename "$good")"
        record_health_event OK "$ch" "$good"
      else
        log "CRITICAL channel $ch still broken after re-point"
        record_health_event CRITICAL "$ch" "$(readlink -f "$CHAN/$ch" 2>/dev/null || true)"
        rc=2
      fi
    else
      log "CRITICAL no good snapshot to heal channel $ch"
      record_health_event CRITICAL "$ch"
      rc=2
    fi
  fi
done

# Ensure wrappers exist even after a partial reprovision.
[ -x "$SNAP_TOOL" ] && "$SNAP_TOOL" wrappers >/dev/null 2>&1 || true

# 2. Live dev-tree CLI. This is non-fatal when frozen fallbacks are healthy.
if [ -d "$DEV" ] \
   && [ -f "$DEV/dist/shizuha.js" ] \
   && "$NODE_BIN" -e "require('$DEV/node_modules/better-sqlite3')" >/dev/null 2>&1 \
   && "$NODE_BIN" "$DEV/dist/shizuha.js" --version >/dev/null 2>&1; then
  log "OK live dev-tree shizuha"
else
  log "WARN live dev-tree shizuha broken/missing (use shizuha-stable); fallbacks decide health"
fi

# 3. GLM/Cortex reachability.
code="$(curl -sSk -m 12 -o /dev/null -w '%{http_code}' "$CORTEX/v1/models" 2>/dev/null || echo 000)"
if [ "$code" = "200" ]; then
  log "OK GLM endpoint ($CORTEX/v1/models = 200)"
else
  log "DEGRADED GLM endpoint = $code (cluster/cortex)"
  rc=3
fi

[ "$rc" -eq 0 ] && log "HEALTHY: channels + GLM ok" || log "ISSUES rc=$rc (see above)"
exit "$rc"
