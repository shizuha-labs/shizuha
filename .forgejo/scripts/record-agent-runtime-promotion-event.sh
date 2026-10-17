#!/usr/bin/env bash
# Record the runtime promotion in Pulse's idempotent deployment ledger.
#
# PLAT-10017 / PLAT-6165 delta: build-agent-runtime produced successful runs
# that promoted a new runtime image (Auto-promote DesiredRuntimeRelease) but
# published no correlated DeploymentEvent, so the PLS-675/PLAT-1351 v4
# deploy-verified gate stayed at missing_correlated_deploy_event and live
# acceptance tasks stranded at Awaiting Deploy.
#
# Honesty contract (do not weaken):
#   - state is `rollout_started`: the build lane PROVED the promoted digest
#     exists in the registry and the promote commit landed on deploy@master.
#     It has NOT observed the broker roll or runtime convergence — only the
#     rt-fleet controller (fresh-runtime live-probe receipt, PLAT-6165 #276)
#     and post-rollout DevOps-carrier upserts may add convergence/smoke
#     evidence. This script never claims smoke_passed.
#   - metadata merge semantics (PLS-952) let later partial upserts add
#     replicas_ready/fresh_runtime_evidence without destroying these fields.
set -euo pipefail

usage() {
  echo "usage: $0 <service> <component> <image> <image-digest> <source-sha>" >&2
  exit 64
}

[ "$#" -eq 5 ] || usage
SERVICE="$1"
COMPONENT="$2"
IMAGE="$3"
IMAGE_DIGEST="$4"
SOURCE_SHA="$5"

[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "::error::image digest must be a full sha256 digest" >&2
  exit 2
}
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "::error::source SHA must be a full lowercase SHA" >&2
  exit 2
}

REPO="${GITHUB_REPOSITORY:-shizuha-labs/shizuha}"
BRANCH="${GITHUB_REF_NAME:-master}"
RUN_ID="${GITHUB_RUN_ID:-${GITHUB_RUN_NUMBER:-unknown}}"
FORGEJO_API="${FORGEJO_API:-http://forgejo-http.origin.svc.cluster.local/api/v1}"
PULSE_URL="${PULSE_URL:-http://shizuha-pulse.shizuha.svc.cluster.local:8002}"
ID_LOGIN_URL="${ID_LOGIN_URL:-http://shizuha-id.shizuha.svc.cluster.local:8001/api/auth/login/}"

# --- resolve the merged PR(s) that produced SOURCE_SHA (receipt binding) ---
PR_JSON="$(curl -fsS --connect-timeout 5 --max-time 20 \
  "${FORGEJO_API}/repos/${REPO}/commits/${SOURCE_SHA}/pulls" 2>/dev/null || echo '[]')"
PR_NUMBERS="$(printf '%s' "$PR_JSON" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
print(json.dumps(sorted({int(r["number"]) for r in rows if isinstance(r, dict) and r.get("number")})))
' 2>/dev/null || echo '[]')"
FIRST_PR="$(printf '%s' "$PR_NUMBERS" | python3 -c 'import json,sys; ns=json.load(sys.stdin); print(ns[0] if ns else "")')"

# --- source task correlation: best-effort from the associated PRs ---
TASK_KEYS="$(printf '%s' "$PR_JSON" | python3 -c '
import json, re, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
keys = set()
for r in rows:
    if not isinstance(r, dict):
        continue
    blob = " ".join(str(r.get(k) or "") for k in ("title", "body"))
    keys.update(m.group(0).upper() for m in re.finditer(r"\b[A-Z]{2,8}-\d{2,6}\b", blob))
print(json.dumps(sorted(keys)[:5]))
' 2>/dev/null || echo '[]')"

# --- Pulse credential (build-ns secret; login for a fresh access token) ---
PULSE_USERNAME="${PULSE_USERNAME:-$(kubectl -n build get secret pulse-api-token -o jsonpath='{.data.username}' 2>/dev/null | base64 -d || true)}"
PULSE_PASSWORD="${PULSE_PASSWORD:-$(kubectl -n build get secret pulse-api-token -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)}"
if [ -n "$PULSE_USERNAME" ] && [ -n "$PULSE_PASSWORD" ]; then
  login_payload="$(PULSE_USERNAME="$PULSE_USERNAME" PULSE_PASSWORD="$PULSE_PASSWORD" python3 -c 'import json,os; print(json.dumps({"username":os.environ["PULSE_USERNAME"],"password":os.environ["PULSE_PASSWORD"]}))')"
  login_response="$(curl -fsS \
    --retry 4 --retry-all-errors --retry-delay 2 --retry-max-time 75 \
    --connect-timeout 5 --max-time 15 \
    -H 'Content-Type: application/json' -d "$login_payload" "$ID_LOGIN_URL")" || {
    echo "::error::ID login failed while minting a fresh Pulse access token" >&2
    exit 1
  }
  PULSE_TOKEN="$(printf '%s' "$login_response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tokens"]["access"])')"
  unset PULSE_PASSWORD login_payload login_response
elif [ -z "${PULSE_TOKEN:-}" ]; then
  PULSE_TOKEN="$(kubectl -n build get secret pulse-api-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
fi
[ -n "${PULSE_TOKEN:-}" ] || { echo "::error::no Pulse credential available (build/pulse-api-token)" >&2; exit 1; }

export REPO SERVICE COMPONENT IMAGE IMAGE_DIGEST SOURCE_SHA BRANCH RUN_ID PR_NUMBERS FIRST_PR TASK_KEYS
payload="$(python3 - <<'PY'
import json
import os

pr_numbers = json.loads(os.environ.get('PR_NUMBERS') or '[]')
task_keys = json.loads(os.environ.get('TASK_KEYS') or '[]')
metadata = {
    'risk_labels': ['agent-runtime', 'user-facing', 'requires-live-qa'],
    'truth_contract': 'runtime-promotion-rollout_started-v1',
    'promotion': {
        'image': os.environ['IMAGE'],
        'image_digest': os.environ['IMAGE_DIGEST'],
        'source_sha': os.environ['SOURCE_SHA'],
        'note': 'promotion commit landed on deploy@master; broker applies DesiredRuntimeRelease; convergence is NOT yet observed by this lane',
    },
}
if os.environ.get('FIRST_PR'):
    metadata['origin_pr_number'] = int(os.environ['FIRST_PR'])
print(json.dumps({
    'idempotency_key': ':'.join([
        'origin', os.environ['REPO'], os.environ['SERVICE'],
        os.environ['COMPONENT'], os.environ['SOURCE_SHA'],
    ]),
    'repo': os.environ['REPO'],
    'branch': os.environ['BRANCH'],
    'commit_sha': os.environ['SOURCE_SHA'],
    'service': os.environ['SERVICE'],
    'component': os.environ['COMPONENT'],
    'environment': 'live',
    'cluster': 'shizuha-k3s',
    'namespace': 'rt-fleet',
    'deployment_target': os.environ['COMPONENT'],
    'image': os.environ['IMAGE'],
    'image_digest': os.environ['IMAGE_DIGEST'],
    'pipeline_system': 'origin-forgejo',
    'pipeline_run_id': os.environ['RUN_ID'],
    'state': 'rollout_started',
    'pr_numbers': pr_numbers,
    'source_task_keys': task_keys,
    'metadata': metadata,
}, separators=(',', ':')))
PY
)"

IDEMPOTENCY_KEY="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["idempotency_key"])')"
# Same replay discipline as hive's record-deployment-event.sh: a POST timeout
# is indeterminate; the unique idempotency key makes replay a
# read-after-uncertain-write recovery, not a duplicate.
response="$(curl -fsS \
  --retry 4 --retry-all-errors --retry-delay 2 --retry-max-time 150 \
  --connect-timeout 5 --max-time 30 -X POST \
  -H "Authorization: Bearer ${PULSE_TOKEN}" \
  -H "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  "${PULSE_URL}/api/deployment-events/ingest/")"
unset PULSE_TOKEN IDEMPOTENCY_KEY payload
printf '%s' "$response" | python3 -c '
import json, sys
row = json.load(sys.stdin)
print("Pulse DeploymentEvent {} state={} created={} devops_task={}".format(
    row.get("id"), row.get("state"), row.get("created"), row.get("devops_task_key")
))'
