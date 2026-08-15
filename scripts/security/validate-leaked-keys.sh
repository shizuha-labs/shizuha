#!/usr/bin/env bash
#
# validate-leaked-keys.sh — Test which leaked keys are still active
#
# Reads a scan report JSON and tests each key against the appropriate API.
# Categorizes results into: active, expired/revoked, invalid
#
# Usage:
#   ./validate-leaked-keys.sh <report.json>
#
# Output: validated report with status for each key

set -euo pipefail

REPORT_FILE="${1:?Usage: $0 <report.json>}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

CACHE_DIR="$(dirname "$REPORT_FILE")/.cache"
CACHE_FILE="$CACHE_DIR/revoked-keys.json"

if [ ! -f "$REPORT_FILE" ]; then
  echo "ERROR: $REPORT_FILE not found" >&2
  exit 1
fi

# Load cache of known-revoked keys (skip re-testing these)
CACHED_KEYS=""
CACHE_HITS=0
if [ -f "$CACHE_FILE" ]; then
  CACHED_KEYS=$(cat "$CACHE_FILE")
  echo "Cache loaded: $(echo "$CACHED_KEYS" | jq 'length') known-revoked keys" >&2
fi

echo "=== Leaked Key Validator ===" >&2
echo "Report: $REPORT_FILE" >&2
echo "Timestamp: $TIMESTAMP" >&2
echo "" >&2

ACTIVE=0
REVOKED=0
INVALID=0
RESULTS="[]"

# Read each finding
jq -c '.[]' "$REPORT_FILE" | while IFS= read -r finding; do
  repo=$(echo "$finding" | jq -r '.repo')
  path=$(echo "$finding" | jq -r '.path')
  key_preview=$(echo "$finding" | jq -r '.key_preview')
  key_length=$(echo "$finding" | jq -r '.key_length')
  
  # Check cache — skip known-revoked keys
  CACHE_KEY="${repo}:${path}:${key_preview}"
  if [ -n "$CACHED_KEYS" ] && echo "$CACHED_KEYS" | jq -e --arg k "$CACHE_KEY" '.[$k]' &>/dev/null; then
    CACHED_STATUS=$(echo "$CACHED_KEYS" | jq -r --arg k "$CACHE_KEY" '.[$k].status')
    echo "CACHED ($CACHED_STATUS): $repo / $path — skipping" >&2
    CACHE_HITS=$((CACHE_HITS+1))
    echo "$finding" | jq --arg status "$CACHED_STATUS" --arg provider "anthropic-oauth" --arg validated "$TIMESTAMP" \
      '. + {status: $status, provider: $provider, http_code: "cached", validated_at: $validated, from_cache: true}'
    continue
  fi

  echo -n "Testing $repo / $path ($key_preview)... " >&2

  # Extract the full key from the preview — we need to re-fetch it
  # since the report only has masked keys
  FULL_KEY=""
  if command -v gh &>/dev/null; then
    FULL_KEY=$(gh api "repos/$repo/contents/$path" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null | grep -oP 'sk-ant-oat01-[A-Za-z0-9_-]{20,200}' | head -1 || echo "")
  fi
  
  if [ -z "$FULL_KEY" ]; then
    echo "SKIP (couldn't fetch key)" >&2
    continue
  fi
  
  # Determine key type and test
  STATUS="unknown"
  PROVIDER="unknown"
  ERROR_MSG=""
  
  if [[ "$FULL_KEY" == sk-ant-oat01-* ]]; then
    PROVIDER="anthropic-oauth"
    # Test against Anthropic API — minimal request (just auth check)
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $FULL_KEY" \
      -H "Content-Type: application/json" \
      -H "anthropic-version: 2023-06-01" \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
      "https://api.anthropic.com/v1/messages" 2>/dev/null || echo "000")
    
    case "$RESPONSE" in
      200|201) STATUS="ACTIVE"; ACTIVE=$((ACTIVE+1)) ;;
      401) STATUS="revoked"; REVOKED=$((REVOKED+1)) ;;
      403) STATUS="forbidden"; REVOKED=$((REVOKED+1)) ;;
      429) STATUS="ACTIVE-rate-limited"; ACTIVE=$((ACTIVE+1)) ;;  # rate limited = key works
      *) STATUS="error-$RESPONSE"; INVALID=$((INVALID+1)) ;;
    esac
    
  elif [[ "$FULL_KEY" == sk-ant-api03-* ]]; then
    PROVIDER="anthropic-api"
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "x-api-key: $FULL_KEY" \
      -H "Content-Type: application/json" \
      -H "anthropic-version: 2023-06-01" \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
      "https://api.anthropic.com/v1/messages" 2>/dev/null || echo "000")
    
    case "$RESPONSE" in
      200|201) STATUS="ACTIVE"; ACTIVE=$((ACTIVE+1)) ;;
      401) STATUS="revoked"; REVOKED=$((REVOKED+1)) ;;
      403) STATUS="forbidden"; REVOKED=$((REVOKED+1)) ;;
      429) STATUS="ACTIVE-rate-limited"; ACTIVE=$((ACTIVE+1)) ;;
      *) STATUS="error-$RESPONSE"; INVALID=$((INVALID+1)) ;;
    esac
    
  elif [[ "$FULL_KEY" == sk-proj-* ]]; then
    PROVIDER="openai"
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $FULL_KEY" \
      -H "Content-Type: application/json" \
      -d '{"model":"gpt-4o-mini","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
      "https://api.openai.com/v1/chat/completions" 2>/dev/null || echo "000")
    
    case "$RESPONSE" in
      200|201) STATUS="ACTIVE"; ACTIVE=$((ACTIVE+1)) ;;
      401) STATUS="revoked"; REVOKED=$((REVOKED+1)) ;;
      403) STATUS="forbidden"; REVOKED=$((REVOKED+1)) ;;
      429) STATUS="ACTIVE-rate-limited"; ACTIVE=$((ACTIVE+1)) ;;
      *) STATUS="error-$RESPONSE"; INVALID=$((INVALID+1)) ;;
    esac
  fi
  
  echo "$STATUS ($PROVIDER, HTTP $RESPONSE)" >&2
  
  # Append result
  echo "$finding" | jq --arg status "$STATUS" --arg provider "$PROVIDER" --arg http "$RESPONSE" --arg validated "$TIMESTAMP" \
    '. + {status: $status, provider: $provider, http_code: $http, validated_at: $validated}'
  
  # Rate limit between API calls
  sleep 2
  
done | jq -s '.' > /tmp/validated-results.json

# Build final report
TOTAL=$(jq 'length' /tmp/validated-results.json)
ACTIVE_COUNT=$(jq '[.[] | select(.status | startswith("ACTIVE"))] | length' /tmp/validated-results.json)
REVOKED_COUNT=$(jq '[.[] | select(.status == "revoked" or .status == "forbidden")] | length' /tmp/validated-results.json)

jq -n \
  --arg timestamp "$TIMESTAMP" \
  --argjson findings "$(cat /tmp/validated-results.json)" \
  --argjson total "$TOTAL" \
  --argjson active "$ACTIVE_COUNT" \
  --argjson revoked "$REVOKED_COUNT" \
  '{
    scan_timestamp: $timestamp,
    total_tested: $total,
    active_keys: $active,
    revoked_keys: $revoked,
    other: ($total - $active - $revoked),
    findings_by_status: {
      active: [$findings[] | select(.status | startswith("ACTIVE"))],
      revoked: [$findings[] | select(.status == "revoked" or .status == "forbidden")],
      other: [$findings[] | select(.status | startswith("ACTIVE") or . == "revoked" or . == "forbidden" | not)]
    },
    all_findings: $findings
  }'

# Update cache with newly found revoked keys
if [ -f /tmp/validated-results.json ]; then
  mkdir -p "$CACHE_DIR"
  python3 -c "
import json, os
cache_file = '$CACHE_FILE'
cache = {}
if os.path.exists(cache_file):
    with open(cache_file) as f:
        cache = json.load(f)
with open('/tmp/validated-results.json') as f:
    results = json.load(f)
for r in results:
    if r.get('status') in ('revoked', 'forbidden'):
        key = f\"{r['repo']}:{r['path']}:{r['key_preview']}\"
        cache[key] = {'status': r['status'], 'http_code': r.get('http_code',''), 'validated_at': r.get('validated_at',''), 'provider': r.get('provider','')}
with open(cache_file, 'w') as f:
    json.dump(cache, f, indent=2)
print(f'Cache updated: {len(cache)} total revoked keys', flush=True)
" >&2
fi

echo "" >&2
echo "=== Validation Complete ===" >&2
echo "Total tested: $TOTAL" >&2
echo "ACTIVE (exploitable): $ACTIVE_COUNT" >&2
echo "Revoked/expired: $REVOKED_COUNT" >&2
echo "From cache (skipped): $CACHE_HITS" >&2
