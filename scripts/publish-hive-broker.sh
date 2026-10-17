#!/usr/bin/env bash
set -euo pipefail
# Only the build Job receives this existing source-publication credential.
# The CI runner intentionally has no read permission on build/forgejo-token.
test -n "${GIT_PASSWORD:-}"
AUTH="$(printf 'x-token-auth:%s' "$GIT_PASSWORD" | base64 | tr -d '\n')"
unset GIT_PASSWORD
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
git -c http.extraHeader="Authorization: Basic ${AUTH}" clone --depth=1 --branch main \
  "http://forgejo-http.origin.svc.cluster.local/shizuha-labs/hive.git" "$WORKDIR/hive"
BROKER_IMAGE="localhost:30500/mcp-auth-proxy:src-${SOURCE_SHA:0:12}"
python3 "$(dirname "$0")/update-hive-broker-pins.py" --hive-root "$WORKDIR/hive" \
  --image "$BROKER_IMAGE" --source-sha "$SOURCE_SHA"
if git -C "$WORKDIR/hive" diff --quiet; then
  echo "Native Hive source already selects the qualified broker"
  exit 0
fi
git -C "$WORKDIR/hive" config user.name "shizuha-broker-ci"
git -C "$WORKDIR/hive" config user.email "broker-ci@shizuha.com"
git -C "$WORKDIR/hive" add hive_project/settings.py k8s/hive-backend-live.yaml \
  k8s/shizuha-hive.yaml .forgejo/scripts/ring-release-fleet.sh
git -C "$WORKDIR/hive" commit -m "fix(runtime): publish qualified broker ${SOURCE_SHA:0:12}"
git -C "$WORKDIR/hive" -c http.extraHeader="Authorization: Basic ${AUTH}" push origin HEAD:main
