/**
 * Hermetic test environment (SCLI-601).
 *
 * The suite must be deterministic regardless of the runner's ambient
 * environment. When run from an agent pod / agent shell (`npm run ci` on a
 * workstation that is itself a fleet agent), ambient vars leak into tests and
 * produce FALSE failures — none of which reproduce in the clean CI Job
 * (node:22-bookworm, uid 1000, no secret env):
 *
 *   - REASONING_EFFORT / VLLM_REASONING_EFFORT   → reasoning-effort clamp
 *   - SHIZUHA_K8S_PRIMARY_* / AGENT_ID / AGENT_USERNAME / SHIZUHA_AGENT_*
 *     / HIVE_AGENT_ID                            → agent-runtime detection,
 *                                                  cortex auth precedence,
 *                                                  Hive cache TTL (5m vs 30m)
 *   - CORTEX_API_KEY / CORTEX_OAUTH_TOKEN        → cortex credential fallback
 *   - SHIZUHA_CACHE_* / CORTEX_CACHE_*           → cache_control TTL
 *
 * This setup sanitizes those ambient vars so every run is deterministic.
 * Tests that intentionally exercise these paths set/restore their own values
 * in beforeEach/afterEach (after this setup runs once per file).
 *
 * NOTE: the broker UDS is deliberately NOT touched here — tests that exercise
 * the broker (broker-token, external-broker-auth, mcp-multiplexer) mock the
 * broker-token module in their own file, which is the correct isolation seam.
 */
const AMBIENT_ENV_KEYS = [
  'REASONING_EFFORT',
  'VLLM_REASONING_EFFORT',
  'SHIZUHA_K8S_PRIMARY_MODEL',
  'SHIZUHA_K8S_PRIMARY_EFFORT',
  'SHIZUHA_K8S_PRIMARY_METHOD',
  'SHIZUHA_K8S_PRIMARY_COMMAND',
  'SHIZUHA_K8S_INLINE_FAILOVER',
  'SHIZUHA_AGENT_USERNAME',
  'SHIZUHA_AGENT_ID',
  'AGENT_ID',
  'AGENT_USERNAME',
  'HIVE_AGENT_ID',
  'CORTEX_API_KEY',
  'CORTEX_OAUTH_TOKEN',
  'SHIZUHA_CACHE_TTL',
  'CORTEX_CACHE_TTL',
  'SHIZUHA_CACHE_CONTROL',
  'CORTEX_CACHE_CONTROL',
  'SHIZUHA_CORTEX_AUTH_MODE',
];
for (const k of AMBIENT_ENV_KEYS) {
  delete process.env[k];
}
