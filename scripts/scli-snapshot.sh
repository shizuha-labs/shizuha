#!/usr/bin/env bash
# scli-snapshot.sh — freeze a known-good shizuha CLI build into a
# self-contained, dev-tree-independent snapshot, and manage fallback channels
# (stable / gamma / beta / alpha).
#
# Usage:
#   scli-snapshot.sh snapshot              # create a verified snapshot from the dev tree
#   scli-snapshot.sh promote               # snapshot + rotate gamma<-beta<-alpha<-new
#   scli-snapshot.sh bless-stable          # soak-gated stable bless of oldest eligible snapshot
#   scli-snapshot.sh bootstrap             # first-time: snapshot + point all channels at it
#   scli-snapshot.sh status                # show channels + snapshots
#   scli-snapshot.sh verify <dir>          # verify a snapshot/channel runs standalone
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCLI_HOME="${SCLI_HOME:-$HOME/.shizuha}"
CONFIG_FILE="${SCLI_CONFIG:-$SCLI_HOME/scli.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

DEV="${SCLI_DEV:-$REPO_DEFAULT}"
ROOT="${SCLI_VERSIONS_DIR:-$SCLI_HOME/cli-versions}"
SNAPS="$ROOT/snapshots"
CHAN="$ROOT/channels"
BIN="${SCLI_BIN:-$HOME/.local/bin}"
NODE_BIN="${SCLI_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
LOG="${SCLI_SNAPSHOT_LOG:-$SCLI_HOME/scli-snapshot.log}"
CHANNEL_HISTORY="${SCLI_CHANNEL_HISTORY:-$ROOT/channel-history.tsv}"
HEALTH_EVENTS="${SCLI_HEALTH_EVENTS:-$ROOT/health-events.tsv}"
STABLE_SOAK_DAYS="${SCLI_STABLE_SOAK_DAYS:-3}"
STABLE_MIN_OK_CHECKS="${SCLI_STABLE_MIN_OK_CHECKS:-1}"
MAX_SNAPSHOTS="${SCLI_MAX_SNAPSHOTS:-$((STABLE_SOAK_DAYS + 4))}"
[ "$MAX_SNAPSHOTS" -lt 7 ] && MAX_SNAPSHOTS=7
SEARCH_BASE_URL_DEFAULT="${SEARCH_BASE_URL:-http://gx10-1:30088}"

mkdir -p "$SNAPS" "$CHAN" "$BIN" "$(dirname "$LOG")"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" | tee -a "$LOG" >&2; }

resolve_channel() {
  local ch="$1"
  readlink -f "$CHAN/$ch" 2>/dev/null || true
}

snapshot_id() {
  basename "${1%/}"
}

manifest_value() {
  local d="$1" key="$2"
  [ -f "$d/MANIFEST.txt" ] || return 1
  awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }' "$d/MANIFEST.txt"
}

epoch_from_iso() {
  date -u -d "$1" +%s 2>/dev/null || return 1
}

snapshot_created_epoch() {
  local d="$1" created
  created="$(manifest_value "$d" created 2>/dev/null || true)"
  [ -n "$created" ] && epoch_from_iso "$created" && return 0
  # Fallback for hand-seeded/legacy snapshots; MANIFEST.created is authoritative when present.
  stat -c %Y "$d" 2>/dev/null
}

record_channel_point() {
  local ch="$1" target="$2" id
  id="$(snapshot_id "$target")"
  printf '%s\tpoint\t%s\t%s\n' "$(ts)" "$ch" "$id" >> "$CHANNEL_HISTORY"
}

verify() {
  local d="${1:?snapshot/channel dir required}" node
  d="$(readlink -f "$d" 2>/dev/null || echo "$d")"
  node="$d/node"
  [ -x "$node" ] || node="$NODE_BIN"
  [ -f "$d/dist/shizuha.js" ] || { echo "FAIL: missing dist/shizuha.js in $d"; return 1; }
  [ -d "$d/node_modules" ] || { echo "FAIL: missing node_modules in $d"; return 1; }
  "$node" -e "require('$d/node_modules/better-sqlite3')" >/dev/null 2>&1 || { echo "FAIL: better-sqlite3 not loadable in $d"; return 1; }
  "$node" "$d/dist/shizuha.js" --version >/dev/null 2>&1 || { echo "FAIL: shizuha.js --version failed in $d"; return 1; }
  echo "OK"
}

preflight_dev() {
  [ -d "$DEV" ] || { log "ABORT: SCLI_DEV does not exist: $DEV"; exit 2; }
  [ -f "$DEV/dist/shizuha.js" ] || { log "ABORT: $DEV/dist/shizuha.js missing; run npm run build:node first"; exit 2; }
  [ -d "$DEV/node_modules" ] || { log "ABORT: $DEV/node_modules missing; run npm ci first"; exit 2; }
  "$NODE_BIN" -e "require('$DEV/node_modules/better-sqlite3')" >/dev/null 2>&1 || { log "ABORT: dev tree better-sqlite3 broken — not snapshotting a broken build"; exit 2; }
  "$NODE_BIN" "$DEV/dist/shizuha.js" --version >/dev/null 2>&1 || { log "ABORT: dev tree shizuha.js --version failed — not snapshotting"; exit 2; }
}

make_snapshot() {
  preflight_dev
  local sha id dir v
  sha="$(git -C "$DEV" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  id="$(date -u +%Y%m%d-%H%M%S)-$sha"
  dir="$SNAPS/$id"
  log "creating snapshot $id from $DEV"
  mkdir -p "$dir/dist"
  cp "$DEV/dist/shizuha.js" "$dir/dist/shizuha.js"
  for sub in web skills templates uinput-helper; do
    [ -e "$DEV/dist/$sub" ] && cp -a "$DEV/dist/$sub" "$dir/dist/$sub"
  done
  cp "$DEV/package.json" "$dir/package.json" 2>/dev/null || true
  cp -a "$DEV/node_modules" "$dir/node_modules"
  cp "$NODE_BIN" "$dir/node" 2>/dev/null && chmod +x "$dir/node" || true
  {
    echo "id=$id"
    echo "git_sha=$sha"
    echo "created=$(ts)"
    echo "node=$($NODE_BIN --version)"
    echo "source=$DEV"
  } > "$dir/MANIFEST.txt"
  v="$(verify "$dir")"
  if [ "$v" != "OK" ]; then
    log "SNAPSHOT VERIFY FAILED: $v — removing $dir"
    rm -rf "$dir"
    exit 3
  fi
  echo "verified=OK" >> "$dir/MANIFEST.txt"
  log "snapshot $id verified OK"
  echo "$dir"
}

point() {
  local ch="$1" target="$2"
  [ -n "$target" ] && [ -d "$target" ] || { log "ABORT: cannot point $ch at missing target: $target"; exit 4; }
  ln -sfn "$target" "$CHAN/$ch"
  record_channel_point "$ch" "$target"
  log "channel $ch -> $(basename "$target")"
}

make_wrappers() {
  for ch in stable gamma beta alpha; do
    cat > "$BIN/shizuha-$ch" <<WRAPPER
#!/usr/bin/env bash
# Frozen SCLI channel '$ch' — self-contained, independent of the dev tree.
C="$CHAN/$ch"
export SEARCH_BASE_URL="\${SEARCH_BASE_URL:-$SEARCH_BASE_URL_DEFAULT}"
exec "\$C/node" "\$C/dist/shizuha.js" "\$@"
WRAPPER
    chmod +x "$BIN/shizuha-$ch"
  done
  log "wrappers written: $BIN/shizuha-stable/gamma/beta/alpha"
}

prune() {
  ls -1dt "$SNAPS"/*/ 2>/dev/null | tail -n +$((MAX_SNAPSHOTS + 1)) | while read -r d; do
    local keep=0 target="${d%/}"
    for ch in stable gamma beta alpha; do
      [ "$(resolve_channel "$ch")" = "$target" ] && keep=1
    done
    [ "$keep" -eq 0 ] && { log "pruning old snapshot $(basename "$target")"; rm -rf "$target"; }
  done
}

case "${1:-status}" in
  snapshot) make_snapshot ;;
  bootstrap)
    d="$(make_snapshot)"
    for ch in stable gamma beta alpha; do point "$ch" "$d"; done
    make_wrappers
    prune
    log "bootstrap complete — all channels at $(basename "$d")" ;;
  promote)
    d="$(make_snapshot)"
    beta_target="$(resolve_channel beta)"
    alpha_target="$(resolve_channel alpha)"
    [ -n "$beta_target" ] || beta_target="$d"
    [ -n "$alpha_target" ] || alpha_target="$d"
    point gamma "$beta_target"
    point beta  "$alpha_target"
    point alpha "$d"
    make_wrappers
    prune
    log "promote complete — alpha=$(basename "$d")" ;;
  bless-stable)
    now="$(date -u +%s)"
    soak_seconds=$((STABLE_SOAK_DAYS * 86400))
    chosen=""
    while IFS= read -r s; do
      s="${s%/}"
      [ -d "$s" ] || continue
      id="$(snapshot_id "$s")"
      created_epoch="$(snapshot_created_epoch "$s" 2>/dev/null || echo 0)"
      age=$((now - created_epoch))
      if [ "$age" -lt "$soak_seconds" ]; then
        log "stable candidate $id not soaked: age=${age}s required=${soak_seconds}s"
        continue
      fi
      if ! awk -F '\t' -v id="$id" '$3 == "gamma" && $4 == id { found=1 } END { exit found ? 0 : 1 }' "$CHANNEL_HISTORY" 2>/dev/null; then
        log "stable candidate $id rejected: never recorded on gamma"
        continue
      fi
      ok_count="$(awk -F '\t' -v id="$id" '$4 == id && $2 == "OK" { c++ } END { print c + 0 }' "$HEALTH_EVENTS" 2>/dev/null || echo 0)"
      if [ "$ok_count" -lt "$STABLE_MIN_OK_CHECKS" ]; then
        log "stable candidate $id rejected: ok_checks=$ok_count required=$STABLE_MIN_OK_CHECKS"
        continue
      fi
      fail_count="$(awk -F '\t' -v id="$id" '$4 == id && ($2 == "DEGRADED" || $2 == "CRITICAL") { c++ } END { print c + 0 }' "$HEALTH_EVENTS" 2>/dev/null || echo 0)"
      if [ "$fail_count" -ne 0 ]; then
        log "stable candidate $id rejected: health_failures=$fail_count"
        continue
      fi
      if ! verify "$s" >/dev/null; then
        log "stable candidate $id rejected: current verify failed"
        continue
      fi
      chosen="$s"
      break
    done < <(ls -1dt "$SNAPS"/*/ 2>/dev/null | tac)
    [ -n "$chosen" ] || { log "no eligible stable candidate (soak_days=$STABLE_SOAK_DAYS min_ok=$STABLE_MIN_OK_CHECKS)"; exit 5; }
    current="$(resolve_channel stable)"
    if [ "$current" = "$chosen" ]; then
      log "stable already blessed -> $(basename "$chosen")"
    else
      point stable "$chosen"
      log "stable blessed -> $(basename "$chosen") after soak_days=$STABLE_SOAK_DAYS"
    fi
    make_wrappers ;;
  verify) verify "${2:?dir required}" ;;
  wrappers) make_wrappers ;;
  status)
    echo "config: $CONFIG_FILE"
    echo "dev:    $DEV"
    echo "root:   $ROOT"
    echo "bin:    $BIN"
    echo "channels:"
    for ch in stable gamma beta alpha; do
      target="$(resolve_channel "$ch")"
      printf "  %-7s -> %s\n" "$ch" "${target##*/}"
    done
    echo "snapshots:"
    ls -1dt "$SNAPS"/*/ 2>/dev/null | sed 's#.*/\([^/]*\)/#  \1#' || true ;;
  *) echo "usage: $0 {snapshot|promote|bless-stable|bootstrap|status|verify <dir>|wrappers}"; exit 1 ;;
esac
