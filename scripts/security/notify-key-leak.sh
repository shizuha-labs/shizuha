#!/usr/bin/env bash
#
# notify-key-leak.sh — Notify repo owners about exposed API keys via GitHub Issues.
#
# Takes a scan report JSON and creates GitHub Issues for each finding.
# Run MANUALLY after reviewing the scan report to avoid false positives.
#
# Usage:
#   ./notify-key-leak.sh docs/security-reports/leaked-keys-2026-03-26.json
#   ./notify-key-leak.sh docs/security-reports/leaked-keys-2026-03-26.json --dry-run
#
# The script:
#   1. Reads the scan report JSON
#   2. For each finding, checks if we've already notified (tracking file)
#   3. Creates a GitHub Issue with the details
#   4. Records the notification to avoid duplicates
#
# Requires: gh CLI (authenticated), jq

set -euo pipefail

REPORT_FILE="${1:?Usage: $0 <report.json> [--dry-run]}"
DRY_RUN="${2:-}"
TRACKING_FILE="/home/phoenix/work/shizuha-stack/docs/security-reports/.notified-repos.txt"

if [ ! -f "$REPORT_FILE" ]; then
  echo "ERROR: Report file not found: $REPORT_FILE" >&2
  exit 1
fi

# Load tracking file (repos we've already notified)
touch "$TRACKING_FILE"
NOTIFIED=$(cat "$TRACKING_FILE")

TOTAL=$(jq '.total_findings' "$REPORT_FILE")
echo "=== Key Leak Notification ==="
echo "Report: $REPORT_FILE"
echo "Findings: $TOTAL"
echo "Mode: ${DRY_RUN:-LIVE (will create issues)}"
echo ""

NOTIFIED_COUNT=0
SKIPPED_COUNT=0

jq -c '.findings[]' "$REPORT_FILE" | while IFS= read -r finding; do
  repo=$(echo "$finding" | jq -r '.repo')
  file_path=$(echo "$finding" | jq -r '.file_path')
  file_url=$(echo "$finding" | jq -r '.file_url')
  key_preview=$(echo "$finding" | jq -r '.key_preview')
  pattern=$(echo "$finding" | jq -r '.pattern')

  # Check if already notified
  TRACKING_KEY="${repo}:${file_path}"
  if echo "$NOTIFIED" | grep -qF "$TRACKING_KEY"; then
    echo "SKIP (already notified): $repo / $file_path"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Determine key type for the issue title
  case "$pattern" in
    anthropic-api) KEY_TYPE="Anthropic API Key" ;;
    anthropic-oauth) KEY_TYPE="Anthropic OAuth Token (Claude Code)" ;;
    anthropic-session) KEY_TYPE="Anthropic Session Token" ;;
    openai-project) KEY_TYPE="OpenAI API Key" ;;
    *) KEY_TYPE="API Key" ;;
  esac

  ISSUE_TITLE="Security: Exposed $KEY_TYPE in $file_path"
  ISSUE_BODY="## Exposed API Key Detected

Hi there! We detected what appears to be an exposed **$KEY_TYPE** in your public repository.

**File:** [\`$file_path\`]($file_url)
**Key preview:** \`$key_preview\` (partially masked)

### Recommended Actions

1. **Revoke the key immediately** — Go to your [Anthropic Console](https://console.anthropic.com/) or [OpenAI Dashboard](https://platform.openai.com/api-keys) and revoke/rotate this key
2. **Remove from the repository** — Delete the key from the file and commit
3. **Clean git history** — The key exists in git history even after deletion. Use \`git filter-repo\` or \`BFG Repo Cleaner\` to remove it from all commits
4. **Use environment variables** — Store API keys in \`.env\` files (add \`.env\` to \`.gitignore\`) or use a secrets manager

### Why This Matters

Exposed API keys can be exploited for:
- Unauthorized API usage billed to your account
- Access to your AI conversation history (for OAuth tokens)
- Rate limit exhaustion affecting your service

### About This Notification

This was detected by an automated security scan. We're reaching out as a courtesy to help protect your credentials. No action is needed on this issue other than securing your key.

---
*Automated security notification by [Shizuha Security](https://github.com/shizuha-labs)*"

  echo ""
  echo "--- Finding ---"
  echo "  Repo: $repo"
  echo "  File: $file_path"
  echo "  Key:  $key_preview"
  echo "  Type: $KEY_TYPE"

  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "  [DRY RUN] Would create issue: $ISSUE_TITLE"
  else
    echo "  Creating issue..."
    ISSUE_URL=$(gh issue create --repo "$repo" \
      --title "$ISSUE_TITLE" \
      --body "$ISSUE_BODY" \
      --label "security" 2>&1 || echo "FAILED")

    if echo "$ISSUE_URL" | grep -q "FAILED\|error\|403\|404"; then
      echo "  FAILED to create issue (repo may have issues disabled or we lack access)"
      echo "  Error: $ISSUE_URL"
    else
      echo "  Issue created: $ISSUE_URL"
      echo "$TRACKING_KEY" >> "$TRACKING_FILE"
      NOTIFIED_COUNT=$((NOTIFIED_COUNT + 1))
    fi

    # Rate limit: wait between issue creations
    sleep 5
  fi
done

echo ""
echo "=== Done ==="
echo "Notified: $NOTIFIED_COUNT"
echo "Skipped: $SKIPPED_COUNT"
