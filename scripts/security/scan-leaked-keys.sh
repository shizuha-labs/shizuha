#!/usr/bin/env bash
#
# scan-leaked-keys.sh — Search GitHub for exposed AI API keys in public repos.
#
# Scans for:
#   - Anthropic API keys (sk-ant-api03-*)
#   - Anthropic OAuth tokens (sk-ant-oat01-*) — Claude Code setup tokens, 1-year validity
#   - Anthropic session IDs (sk-ant-sid01-*)
#   - OpenAI project keys (sk-proj-*)
#
# Outputs a JSON report of findings to stdout.
# Requires: gh CLI (authenticated), jq
#
# Usage:
#   ./scan-leaked-keys.sh                    # scan all patterns
#   ./scan-leaked-keys.sh --pattern anthropic # scan only Anthropic keys
#   ./scan-leaked-keys.sh --output report.json
#
# Rate limits: GitHub code search API allows ~10 requests/minute for authenticated users.
# The script includes delays between searches to avoid hitting limits.

set -euo pipefail

OUTPUT_FILE="${1:--}"
REPORT_DIR="/home/phoenix/work/shizuha-stack/docs/security-reports"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATE_SLUG=$(date -u +"%Y-%m-%d")

mkdir -p "$REPORT_DIR"

# Verify gh CLI is authenticated
if ! gh auth status &>/dev/null; then
  echo "ERROR: gh CLI not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

echo "=== GitHub Leaked Key Scanner ===" >&2
echo "Timestamp: $TIMESTAMP" >&2
echo "" >&2

# Key patterns to search for
declare -A PATTERNS=(
  ["anthropic-api"]="sk-ant-api03-"
  ["anthropic-oauth"]="sk-ant-oat01-"
  ["anthropic-session"]="sk-ant-sid01-"
  ["openai-project"]="sk-proj-"
)

# File extensions to search (reduces noise from binary/minified files)
EXTENSIONS=("py" "js" "ts" "env" "yaml" "yml" "json" "toml" "ini" "cfg" "conf" "sh" "bash" "rb" "go" "java" "rs" "php" "ipynb" "md" "txt")

# Collect all findings
FINDINGS="[]"
TOTAL_FOUND=0

for pattern_name in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$pattern_name]}"
  echo "Scanning: $pattern_name ($pattern)" >&2

  # Search across multiple file types
  for ext in "${EXTENSIONS[@]}"; do
    # Rate limit: wait between searches
    sleep 3

    # GitHub code search — returns up to 100 results per query
    RESULTS=$(gh api "search/code?q=${pattern}+extension:${ext}&per_page=30" \
      --jq '.items[] | {
        repo: .repository.full_name,
        repo_url: .repository.html_url,
        file_path: .path,
        file_url: .html_url,
        repo_private: .repository.private,
        repo_owner: .repository.owner.login,
        repo_description: (.repository.description // ""),
        score: .score
      }' 2>/dev/null || echo "")

    if [ -z "$RESULTS" ]; then
      continue
    fi

    # Process each result
    while IFS= read -r line; do
      if [ -z "$line" ]; then continue; fi

      repo=$(echo "$line" | jq -r '.repo')
      file_path=$(echo "$line" | jq -r '.file_path')
      file_url=$(echo "$line" | jq -r '.file_url')
      repo_owner=$(echo "$line" | jq -r '.repo_owner')

      # Skip known false positives
      # - Documentation/examples that mention the prefix
      # - Regex patterns in scanning tools
      # - This script itself
      if echo "$file_path" | grep -qiE "(test|example|mock|fake|dummy|sample|template|readme|doc|changelog|\.md)"; then
        continue
      fi

      # Try to fetch the actual file content to extract the key
      # (only first 500 chars around the match to avoid downloading huge files)
      KEY_PREVIEW=""
      sleep 1
      RAW_CONTENT=$(gh api "repos/$repo/contents/$file_path" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null | grep -oP "${pattern}[A-Za-z0-9_\-]{10,200}" | head -1 || echo "")

      if [ -n "$RAW_CONTENT" ]; then
        # Mask the key: show first 20 chars + ... + last 4 chars
        KEY_LEN=${#RAW_CONTENT}
        if [ "$KEY_LEN" -gt 24 ]; then
          KEY_PREVIEW="${RAW_CONTENT:0:20}...${RAW_CONTENT: -4}"
        else
          KEY_PREVIEW="${RAW_CONTENT:0:20}..."
        fi
      fi

      # Skip if no actual key found (just a mention of the prefix in docs)
      if [ -z "$KEY_PREVIEW" ]; then
        continue
      fi

      TOTAL_FOUND=$((TOTAL_FOUND + 1))

      # Add to findings
      FINDING=$(jq -n \
        --arg pattern "$pattern_name" \
        --arg repo "$repo" \
        --arg file_path "$file_path" \
        --arg file_url "$file_url" \
        --arg repo_owner "$repo_owner" \
        --arg key_preview "$KEY_PREVIEW" \
        --arg scan_time "$TIMESTAMP" \
        '{
          pattern: $pattern,
          repo: $repo,
          file_path: $file_path,
          file_url: $file_url,
          repo_owner: $repo_owner,
          key_preview: $key_preview,
          scan_time: $scan_time
        }')

      FINDINGS=$(echo "$FINDINGS" | jq ". + [$FINDING]")

      echo "  FOUND: $repo / $file_path ($KEY_PREVIEW)" >&2

    done <<< "$(echo "$RESULTS" | jq -c '.')"
  done

  echo "  Done scanning $pattern_name" >&2
done

# Build final report
REPORT=$(jq -n \
  --arg timestamp "$TIMESTAMP" \
  --arg total "$TOTAL_FOUND" \
  --argjson findings "$FINDINGS" \
  '{
    scan_timestamp: $timestamp,
    total_findings: ($total | tonumber),
    findings: $findings,
    patterns_searched: ["sk-ant-api03-", "sk-ant-oat01-", "sk-ant-sid01-", "sk-proj-"],
    note: "Keys are partially masked. Verify each finding before contacting repo owners."
  }')

# Save report
REPORT_FILE="$REPORT_DIR/leaked-keys-$DATE_SLUG.json"
echo "$REPORT" > "$REPORT_FILE"
echo "" >&2
echo "=== Scan Complete ===" >&2
echo "Total findings: $TOTAL_FOUND" >&2
echo "Report saved: $REPORT_FILE" >&2

# Also output to stdout
echo "$REPORT"
