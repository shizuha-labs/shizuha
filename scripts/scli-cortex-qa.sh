#!/usr/bin/env bash
# scli-cortex-qa.sh — SCLI-109 recurring QA: fresh-install -> hosted Cortex access.
#
# Verifies that a brand-new user can install the Shizuha CLI from the live
# installer and reach the hosted Cortex models through ALL supported login
# mechanisms, exactly as a customer would with the shared instructions.
#
# Guard history: the 2026-06-22 incident (live install.sh serving the stale
# GitHub-releases installer -> CLI with NO cortex provider -> cortex/<model>
# routed to Ollama -> "Cannot connect to Ollama") is the class this QA exists
# to catch on every CLI build/publish.
#
# Usage A (documented docker invocation, CLEAN container, no host state):
#   docker run --rm --network host \
#     -e QA_ID_USER=scli-qa -e QA_ID_PASS=<vault> \
#     -e QA_CORTEX_KEY=<a valid sk-cortex- key> \
#     -v $PWD/scripts/scli-cortex-qa.sh:/qa.sh:ro debian:12-slim bash /qa.sh
#
# Usage B (dockerless — agent containers without docker; simulates clean state
# with a throwaway HOME and scrubbed env):
#   QA_ID_USER=... QA_ID_PASS=... QA_CORTEX_KEY=... \
#     bash scripts/scli-cortex-qa.sh --dockerless
#
# Secrets come ONLY from the environment (QA secret store); never commit them.
# Exit 0 only when all 8 checks pass.
set -uo pipefail

INSTALL_URL="${INSTALL_URL:-https://shizuha.com/install.sh}"
MODE="docker"
[ "${1:-}" = "--dockerless" ] && MODE="dockerless"

pass=0; fail=0
ok()   { echo "PASS: $*"; pass=$((pass+1)); }
bad()  { echo "FAIL: $*"; fail=$((fail+1)); }
need() { [ -n "${!1:-}" ] || { echo "FAIL: required env $1 is empty (set it from the QA secret store)"; exit 2; }; }

for v in QA_ID_USER QA_ID_PASS QA_CORTEX_KEY; do need "$v"; done

# Isolated scratch state. In dockerless mode this is the "clean container":
# throwaway HOME + scrubbed env so no host shizuha state can leak in.
if [ "$MODE" = "dockerless" ]; then
  SCRATCH="$(mktemp -d /tmp/scli-cortex-qa.XXXXXX)"
  export HOME="$SCRATCH/home"; mkdir -p "$HOME"
  unset SHIZUHA_HOME SCLI_HOME SCLI_CONFIG CORTEX_API_KEY CORTEX_URL || true
  export PATH="$HOME/.shizuha/bin:$HOME/.local/bin:$PATH"
  trap 'rm -rf "$SCRATCH"' EXIT
fi

run_cli() { shizuha "$@" >/dev/null 2>&1; }
exec_model() { # exec_model <model> -> stdout answer or empty
  shizuha exec --model "$1" 2>/dev/null | tr -d '\n' | head -c 200
}

echo "== SCLI-109 fresh-install -> Cortex QA (mode=$MODE) =="

# 1. Live installer installs the CLI.
if curl -fsSL "$INSTALL_URL" -o /tmp/install.sh.$$ 2>/dev/null; then
  if bash /tmp/install.sh.$$ >/dev/null 2>&1 && run_cli --version; then
    ok "1/8 install via live install.sh; shizuha --version responds ($(shizuha --version 2>/dev/null | head -c 40))"
  else
    bad "1/8 installer ran but shizuha --version failed"
  fi
else
  bad "1/8 could not fetch $INSTALL_URL"
fi
rm -f /tmp/install.sh.$$

# 2. shizuha login (Shizuha ID email/password) -> auto-provisioned Cortex key -> exec.
if run_cli login "$QA_ID_USER" "$QA_ID_PASS"; then
  ans="$(exec_model cortex/Qwen3.6-27B)"
  if [ -n "$ans" ]; then
    ok "2/8 login -> auto-provisioned key -> exec cortex/Qwen3.6-27B answered"
  else
    bad "2/8 login succeeded but exec cortex/Qwen3.6-27B returned no answer"
  fi
else
  bad "2/8 shizuha login failed"
fi

# 3. Stored key: shizuha auth cortex <key> -> exec.
if run_cli auth cortex "$QA_CORTEX_KEY"; then
  ans="$(exec_model cortex/Qwen3.6-27B-FP8)"
  if [ -n "$ans" ]; then
    ok "3/8 stored key (shizuha auth cortex) -> exec cortex/Qwen3.6-27B-FP8 answered"
  else
    bad "3/8 stored key accepted but exec cortex/Qwen3.6-27B-FP8 returned no answer"
  fi
else
  bad "3/8 shizuha auth cortex failed"
fi

# 4. Env var: CORTEX_API_KEY -> exec.
if CORTEX_API_KEY="$QA_CORTEX_KEY" shizuha exec --model cortex/Gemma-4-31B >/dev/null 2>&1; then
  ok "4/8 CORTEX_API_KEY env -> exec cortex/Gemma-4-31B answered"
else
  bad "4/8 CORTEX_API_KEY env -> exec cortex/Gemma-4-31B failed"
fi

# 5. All hosted models respond (login mechanism).
for m in cortex/Qwen3.6-27B cortex/Qwen3.6-27B-FP8 cortex/Gemma-4-31B; do
  if shizuha exec --model "$m" >/dev/null 2>&1; then
    ok "5-7/8 hosted model $m responded"
  else
    bad "5-7/8 hosted model $m failed"
  fi
done

echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ] && { echo "SCLI-CORTEX-QA: PASS 8/8"; exit 0; }
echo "SCLI-CORTEX-QA: FAIL ($fail failing legs)"
exit 1
