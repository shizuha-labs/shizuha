#!/usr/bin/env bash
# shizuha-agent-runtime entrypoint — runs ONE agent as the pod main process
# (HLD PLAT-147 §4, no DinD). Args are derived from env injected by the hive
# FleetAgent provisioner (PLAT-148) + the broker sidecar (PLAT-149, which hands
# the minted JWT over the pod-local socket — no AGENT_PASSWORD here).
#
# If given explicit args, exec them verbatim (debug / `--version` / `--help`);
# otherwise launch the single-agent bridge from env.
set -euo pipefail

PACKAGE_CACHE_HOST="${SHIZUHA_PACKAGE_CACHE_HOST:-${PACKAGE_CACHE_HOST:-s1.tail.shizuha.com}}"
if [ "$(id -u)" = "0" ]; then
  printf 'registry=http://%s:30512/\n' "$PACKAGE_CACHE_HOST" > /etc/npmrc 2>/dev/null || true
  printf '[global]\nindex-url = http://%s:30511/simple/\ntrusted-host = %s\n' "$PACKAGE_CACHE_HOST" "$PACKAGE_CACHE_HOST" > /etc/pip.conf 2>/dev/null || true
fi
export NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-http://${PACKAGE_CACHE_HOST}:30512/}"
export PIP_INDEX_URL="${PIP_INDEX_URL:-http://${PACKAGE_CACHE_HOST}:30511/simple/}"
export PIP_TRUSTED_HOST="${PIP_TRUSTED_HOST:-$PACKAGE_CACHE_HOST}"

# SCLI heap: V8 caps old-space ~4GB regardless of host/pod RAM; only NODE_OPTIONS
# moves it after startup (k8s-backend injects a pod-sized value for managed
# pods; this default covers direct invocations). Respect any explicit override.
if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=${SHIZUHA_NODE_HEAP_MB:-12288}"
fi

DIST="${SHIZUHA_DIST:-/opt/shizuha/dist}/shizuha.js"

if [ "$#" -gt 0 ]; then
  exec node "$DIST" "$@"
fi

: "${AGENT_ID:?AGENT_ID required}"
: "${AGENT_USERNAME:?AGENT_USERNAME required}"

# Select the runtime bridge from the model's execution METHOD — NOT a hardcoded
# bridge. The old script always launched codex-bridge, which silently broke every
# non-codex model provisioned through this entrypoint: a cortex/DeepSeek agent
# (method=shizuha) must run the native `gateway` (chat/completions to Cortex),
# but codex-bridge speaks the OpenAI `responses` API and falls back to
# api.openai.com → 401 → empty turns → spurious model failover (SCLI-331).
# Method→command mirrors the daemon's k8s-native inline launcher exactly; the
# DEFAULT is `gateway` (the safe self-hosted path), never codex-bridge. Method is
# read from SHIZUHA_K8S_PRIMARY_METHOD, else the first MODEL_FALLBACKS/
# SHIZUHA_MODEL_FALLBACKS entry's `.method`.
COMMAND="$(node -e '
  const byMethod = {
    claude_code_server: "claude-bridge", claude: "claude-bridge",
    codex_app_server: "codex-bridge", codex: "codex-bridge",
    openclaw_app_server: "openclaw-bridge", openclaw_bridge: "openclaw-bridge",
    antigravity_server: "antigravity-bridge", antigravity: "antigravity-bridge",
    // Legacy aliases — Gemini CLI removed; always Antigravity.
    gemini_cli_server: "antigravity-bridge", gemini: "antigravity-bridge",
    grok_build: "gateway", shizuha: "gateway",
  };
  let method = process.env.SHIZUHA_K8S_PRIMARY_METHOD || "";
  if (!method) {
    // Prefer mcp_config-style env when provisioner injects it.
    method = process.env.EXECUTION_METHOD || process.env.SHIZUHA_EXECUTION_METHOD || "";
  }
  if (!method) {
    const raw = process.env.MODEL_FALLBACKS || process.env.SHIZUHA_MODEL_FALLBACKS || "[]";
    try { const c = JSON.parse(raw); if (Array.isArray(c) && c[0] && c[0].method) method = c[0].method; } catch {}
  }
  let cmd = byMethod[method];
  if (!cmd) {
    // No explicit method: infer from the model. Only OpenAI codex/gpt models
    // need codex-bridge (Cortex does not serve them); gemini/antigravity models
    // use Antigravity CLI; everything else takes the native gateway.
    const model = process.env.MODEL || process.env.SHIZUHA_K8S_PRIMARY_MODEL || "";
    if (/^(codex\/|gpt)/i.test(model)) cmd = "codex-bridge";
    else if (/^(gemini|antigravity|agy)/i.test(model)) cmd = "antigravity-bridge";
    else cmd = "gateway";
  }
  process.stdout.write(cmd);
' 2>/dev/null || echo gateway)"

MODEL="${MODEL:-${SHIZUHA_K8S_PRIMARY_MODEL:-}}"
EFFORT="${EFFORT:-${REASONING_EFFORT:-${SHIZUHA_K8S_PRIMARY_EFFORT:-}}}"

args=(
  "$COMMAND"
  --agent-id "$AGENT_ID"
  --agent-name "${AGENT_NAME:-$AGENT_USERNAME}"
  --agent-username "$AGENT_USERNAME"
  --port "${PORT:-8080}"
)
[ -n "${MODEL:-}" ]          && args+=(--model "$MODEL")
[ -n "${EFFORT:-}" ]         && args+=(--effort "$EFFORT")
[ -n "${CONTEXT_PROMPT:-}" ] && args+=(--context-prompt "$CONTEXT_PROMPT")

echo "[entrypoint] method-selected command=${COMMAND} model=${MODEL:-none} effort=${EFFORT:-none}"
exec node "$DIST" "${args[@]}"
