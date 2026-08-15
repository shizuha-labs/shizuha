#!/usr/bin/env bash
# PLAT-4740 production validator for untrusted workflow_dispatch / CI tokens.
# Sourced by build-agent-runtime.yml AND by the regression harness so tests
# execute the same control path (not a duplicated copy).
#
# Usage (source):
#   # shellcheck source=scripts/require-safe-token.sh
#   . scripts/require-safe-token.sh
#   require_safe_token NAME VALUE PATTERN
#
# On failure: prints ::error:: and returns 1 (caller may exit).

require_safe_token() {
  local name="$1" value="$2" pattern="$3"
  if [ -z "$value" ]; then
    return 0
  fi
  # Reject C0 controls / DEL (newlines, CR, TAB, etc.) without ANSI-C quotes
  # that would break YAML run: | blocks if inlined.
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    echo "::error::${name} failed allowlist validation (control characters)"
    return 1
  fi
  if ! printf '%s' "$value" | grep -Eq "$pattern"; then
    echo "::error::${name} failed allowlist validation (rejected unsafe characters)"
    return 1
  fi
  local matched
  matched="$(printf '%s' "$value" | grep -Eo "$pattern" | head -n1 || true)"
  if [ "$matched" != "$value" ]; then
    echo "::error::${name} failed allowlist validation (partial match only)"
    return 1
  fi
  return 0
}

# Version tokens (npm / scli): no quotes, whitespace, shell metacharacters.
PLAT4740_VERSION_RE='^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
# Kubernetes Job metadata.name fragment (DNS-1123 label-ish, lowercase only).
# Used inside names like ci-build-agentrt-${TAG}-${ARCH} (must be valid K8s name).
PLAT4740_TAG_RE='^[a-z0-9]([a-z0-9.-]{0,40}[a-z0-9])?$'
PLAT4740_SHA_RE='^[0-9a-f]{7,64}$'
