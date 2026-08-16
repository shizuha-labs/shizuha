#!/usr/bin/env bash
# PLAT-4740 regression: production require_safe_token rejects injection payloads
# and hostile values never reach a kubectl apply / Job render path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/require-safe-token.sh
. scripts/require-safe-token.sh

VERSION_RE="$PLAT4740_VERSION_RE"
TAG_RE="$PLAT4740_TAG_RE"

pass=0
fail=0
expect_reject() {
  local name="$1" value="$2" pattern="$3"
  if require_safe_token "$name" "$value" "$pattern"; then
    echo "FAIL: expected reject for $name=$(printf %q "$value")"
    fail=$((fail+1))
  else
    pass=$((pass+1))
  fi
}
expect_accept() {
  local name="$1" value="$2" pattern="$3"
  if require_safe_token "$name" "$value" "$pattern"; then
    pass=$((pass+1))
  else
    echo "FAIL: expected accept for $name=$(printf %q "$value")"
    fail=$((fail+1))
  fi
}

expect_reject quote "x'; echo PWNED; #" "$VERSION_RE"
expect_reject newline $'1.0.0\nmalicious: true' "$VERSION_RE"
expect_reject carriage_return $'1.0.0\rmalicious' "$VERSION_RE"
expect_reject tab $'1.0.0\tmalicious' "$VERSION_RE"
expect_reject space "1.0.0 pwn" "$VERSION_RE"
expect_reject dollar '$(id)' "$VERSION_RE"
expect_reject backtick '`id`' "$VERSION_RE"
expect_reject yaml $'1.0.0\n  - inject' "$TAG_RE"
expect_reject upper_tag "Harness-ABC" "$TAG_RE"
expect_reject underscore_tag "harness_tmp" "$TAG_RE"
expect_accept ok_ver "1.2.3-beta.1" "$VERSION_RE"
expect_accept ok_tag "harness-20260716-abc1234" "$TAG_RE"

# Structural: smoke renderer must not embed raw version into shell source
WF=".forgejo/workflows/build-agent-runtime.yml"
RENDER="scripts/render-agent-runtime-smoke-job.py"
if grep -q "assert_version claude '\${CC_VER}'" "$WF"; then
  echo "FAIL: smoke still interpolates CC_VER into nested shell source"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'render-agent-runtime-smoke-job.py' "$WF"; then
  echo "FAIL: workflow does not call external smoke JSON renderer"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'json.dump(job' "$RENDER"; then
  echo "FAIL: smoke job not JSON-emitted by renderer script"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'assert_version claude "\$CC_VER"' "$RENDER"; then
  echo "FAIL: renderer script missing static quoted env expansion"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
# Production path: workflow must source the shared validator (not a private copy).
if ! grep -q 'require-safe-token.sh' "$WF"; then
  echo "FAIL: workflow does not source scripts/require-safe-token.sh"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'PLAT4740_TAG_RE\|\$TAG_RE\|PLAT4740_TAG' "$WF" && ! grep -q "PLAT4740_TAG_RE" "$WF"; then
  # workflow should use the shared TAG pattern variable
  if ! grep -q 'PLAT4740_TAG_RE' "$WF"; then
    echo "FAIL: workflow does not use PLAT4740_TAG_RE for TAG validation"
    fail=$((fail+1))
  else
    pass=$((pass+1))
  fi
else
  pass=$((pass+1))
fi

# Real-path sentinel: simulate the production gate before any kubectl apply.
# Hostile TAG must fail require_safe_token and must NOT invoke kubectl.
KUBECTL_SENTINEL="$(mktemp)"
export KUBECTL_SENTINEL
kubectl() {
  echo "kubectl-invoked $*" >>"$KUBECTL_SENTINEL"
  return 0
}
# Production-order fragment (mirrors workflow after TAG is known):
if require_safe_token TAG "x'; echo PWNED; #" "$TAG_RE"; then
  echo "FAIL: production validator accepted quote payload"
  fail=$((fail+1))
  kubectl apply -f /dev/null || true
else
  pass=$((pass+1))
fi
if require_safe_token TAG $'bad\nname' "$TAG_RE"; then
  echo "FAIL: production validator accepted newline TAG"
  fail=$((fail+1))
  kubectl apply -f /dev/null || true
else
  pass=$((pass+1))
fi
if [ -s "$KUBECTL_SENTINEL" ]; then
  echo "FAIL: kubectl was invoked after rejected tokens: $(cat "$KUBECTL_SENTINEL")"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
rm -f "$KUBECTL_SENTINEL"

# Good TAG may proceed to a dry render (no cluster).
if require_safe_token TAG "harness-20260716-abc1234" "$TAG_RE"; then
  out="$(python3 scripts/render-agent-runtime-smoke-job.py \
    amd64 harness-20260716-abc1234 img 1.0.0 2.0.0 3.0.0 4.0.0 0.1.0.1 \
    deadbeefdeadbeefdeadbeefdeadbeefdeadbeef \
    sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
  echo "$out" | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j["kind"]=="Job"'
  pass=$((pass+1))
else
  echo "FAIL: good TAG rejected"
  fail=$((fail+1))
fi

# ---- PLAT-4733: npm_latest must not pipe curl into an interpreter, and its
# ---- file-download path must fail closed (no temp-file leak). ---------------
# Structural: no `curl ... | python|bash|sh` (Semgrep gha-curl-pipe-shell).
if grep -Eq 'curl[^|]*\|[^|]*(python[0-9]*|bash|sh)([[:space:]]|$)' "$WF"; then
  echo "FAIL: workflow still pipes curl output into an interpreter (gha-curl-pipe-shell)"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi

# Functional: extract the real npm_latest() and exercise it with a mocked curl
# (no network). Assert fetch-failure and malformed-JSON both return non-zero, a
# stable/prerelease responses resolve, cache-derived injection is rejected
# before kubectl, and no response temp file is leaked.
PLAT4733_TMPDIR="$(mktemp -d)"
(
  export TMPDIR="$PLAT4733_TMPDIR"
  NPM_META_REG="mock-authoritative"
  eval "$(sed -n '/npm_latest() {/,/^          }/p' "$ROOT/$WF" | sed 's/^          //')"
  rc=0
  # fetch failure -> non-zero
  curl() { return 22; }
  npm_latest pkg >/dev/null 2>&1 && { echo "FAIL: npm_latest fetch failure not propagated"; rc=1; }
  # malformed JSON -> non-zero
  curl() { local o=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done; printf 'not json{' >"$o"; return 0; }
  npm_latest pkg >/dev/null 2>&1 && { echo "FAIL: npm_latest malformed JSON not propagated"; rc=1; }
  # stable -> resolves and passes the same validator used by the workflow
  curl() { local o=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done; printf '{"version":"9.9.9"}' >"$o"; return 0; }
  resolved="$(npm_latest pkg 2>/dev/null)"
  [ "$resolved" = "9.9.9" ] && require_safe_token resolved_version "$resolved" "$VERSION_RE" \
    || { echo "FAIL: npm_latest did not accept stable version"; rc=1; }
  # prerelease/build metadata -> also remains supported
  curl() { local o=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done; printf '{"version":"1.2.3-beta.4+build.7"}' >"$o"; return 0; }
  resolved="$(npm_latest pkg 2>/dev/null)"
  [ "$resolved" = "1.2.3-beta.4+build.7" ] && require_safe_token resolved_version "$resolved" "$VERSION_RE" \
    || { echo "FAIL: npm_latest did not accept prerelease version"; rc=1; }
  # A compromised cache can return valid JSON containing quote + newline +
  # YAML/shell text. Mirror the production order: resolve, validate, and only
  # then allow kubectl. The sentinel proves Job creation is unreachable.
  CACHE_KUBECTL_SENTINEL="$PLAT4733_TMPDIR/kubectl-invoked"
  kubectl() { printf 'kubectl-invoked %s\n' "$*" >>"$CACHE_KUBECTL_SENTINEL"; }
  curl() {
    local o=""
    while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done
    python3 -c 'import json,sys; json.dump({"version": "1.2.3" + chr(39) + "\napiVersion: batch/v1\nkind: Job\n# $(id)"}, open(sys.argv[1], "w"))' "$o"
    return 0
  }
  resolved="$(npm_latest pkg 2>/dev/null)"
  if [ -z "$resolved" ]; then
    echo "FAIL: npm_latest did not return the cache-derived malicious fixture"
    rc=1
  elif require_safe_token resolved_version "$resolved" "$VERSION_RE"; then
    echo "FAIL: cache-derived quote/newline/YAML payload passed validation"
    rc=1
    kubectl apply -f /dev/null
  fi
  if [ -e "$CACHE_KUBECTL_SENTINEL" ]; then
    echo "FAIL: kubectl was invoked for cache-derived malicious version"
    rc=1
  fi
  exit "$rc"
) && pass=$((pass+1)) || fail=$((fail+1))

# SCLI-334: release intent must come from authoritative npm metadata, while
# exact package availability is proven through the LAN cache before builders
# start. Never trust Verdaccio's potentially stale /latest dist-tag.
if grep -q '"${NPM_REG}/${encoded_pkg}/latest"' "$WF"; then
  echo "FAIL: workflow still resolves latest from the npm cache"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'NPM_META_REG="https://registry.npmjs.org"' "$WF"; then
  echo "FAIL: workflow is missing the authoritative npm metadata source"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
# Three npm harnesses (claude-code, codex, openclaw) prove exact versions
# through the LAN cache. Antigravity is a native Google binary (not npm) and
# is proven via antigravity_manifest_version() against the official channel
# (PLAT-5577) — do not count it as an npm_exact_available_in_cache call.
if [ "$(grep -c "npm_exact_available_in_cache '" "$WF")" -ne 3 ]; then
  echo "FAIL: workflow does not prove all three npm harness versions through the cache"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
if ! grep -q 'antigravity_manifest_version()' "$WF"; then
  echo "FAIL: workflow missing antigravity_manifest_version() (must not curl|python)"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
(
  export TMPDIR="$PLAT4733_TMPDIR"
  NPM_REG="mock-cache"
  eval "$(sed -n '/npm_exact_available_in_cache() {/,/^          }/p' "$ROOT/$WF" | sed 's/^          //')"
  rc=0
  curl() {
    local o=""
    while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done
    printf '{"version":"2026.7.1-2"}' >"$o"
  }
  npm_exact_available_in_cache openclaw 2026.7.1-2 \
    || { echo "FAIL: exact-version cache proof rejected matching metadata"; rc=1; }
  npm_exact_available_in_cache openclaw 2026.7.1 \
    && { echo "FAIL: exact-version cache proof accepted mismatched metadata"; rc=1; }
  exit "$rc"
) && pass=$((pass+1)) || fail=$((fail+1))
# No response temp file leaked across any fetch/parse/validation path above.
if [ -n "$(ls -A "$PLAT4733_TMPDIR" 2>/dev/null)" ]; then
  echo "FAIL: npm_latest leaked temp file(s): $(ls -A "$PLAT4733_TMPDIR")"
  fail=$((fail+1))
else
  pass=$((pass+1))
fi
rm -rf "$PLAT4733_TMPDIR"

echo "plat4740-allowlist: pass=$pass fail=$fail"
test "$fail" -eq 0
