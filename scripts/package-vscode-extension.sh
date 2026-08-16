#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extensions/vscode"
SOURCE_SHA="${1:-${GITHUB_SHA:-}}"
OUT="${2:-$ROOT/artifacts/shizuha-vscode.vsix}"
NODE_VERSION="${NODE_VERSION:-22.23.1}"
NPM_VERSION="${NPM_VERSION:-10.9.8}"

[[ "$SOURCE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo "source SHA must be an exact 40-character commit" >&2
  exit 2
}
test "$(node --version)" = "v${NODE_VERSION}" || {
  echo "expected Node v${NODE_VERSION}, got $(node --version)" >&2
  exit 2
}
test "$(npm --version)" = "${NPM_VERSION}" || {
  echo "expected npm ${NPM_VERSION}, got $(npm --version)" >&2
  exit 2
}

if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(git -C "$ROOT" show -s --format=%ct "$SOURCE_SHA")"
fi
[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || {
  echo "SOURCE_DATE_EPOCH must be an integer" >&2
  exit 2
}

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
RAW="$(mktemp --suffix=.vsix)"
TREE="$(mktemp -d)"
cleanup() {
  rm -f "$EXT/SOURCE_SHA" "$RAW"
  rm -rf "$TREE"
}
trap cleanup EXIT

cd "$EXT"
umask 022
npm ci --ignore-scripts
npm run compile
printf '%s\n' "$SOURCE_SHA" > SOURCE_SHA
./node_modules/.bin/vsce package --no-dependencies --out "$RAW"

# vsce writes build-time ZIP timestamps. Repack from a normalized tree so two
# clean builds of one source SHA are byte-identical. The repacker also refuses
# symlinks and other non-regular payloads before publication.
unzip -q "$RAW" -d "$TREE"
python3 "$ROOT/scripts/repack-vscode-vsix.py" "$TREE" "$OUT" "$SOURCE_DATE_EPOCH"
