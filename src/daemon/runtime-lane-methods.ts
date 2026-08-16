export const RUNTIME_LANE_EXECUTION_METHODS = {
  codex_app_server: { command: 'codex-bridge', healthBridge: 'codex-app-server' },
  openclaw_app_server: { command: 'openclaw-bridge', healthBridge: 'openclaw' },
  claude_code_server: { command: 'claude-bridge', healthBridge: 'claude-code' },
  antigravity_server: { command: 'antigravity-bridge', healthBridge: 'antigravity-cli' },
  grok_build: { command: 'gateway', healthBridge: 'shizuha-gateway' },
  shizuha: { command: 'gateway', healthBridge: 'shizuha-gateway' },
} as const;

/** Legacy method names accepted for one release, always routed to Antigravity. */
const LEGACY_EXECUTION_METHODS = {
  openclaw_bridge: { command: 'openclaw-bridge', healthBridge: 'openclaw' },
  // Gemini CLI removed permanently — aliases map to Antigravity CLI.
  gemini_cli_server: { command: 'antigravity-bridge', healthBridge: 'antigravity-cli' },
  gemini: { command: 'antigravity-bridge', healthBridge: 'antigravity-cli' },
  antigravity: { command: 'antigravity-bridge', healthBridge: 'antigravity-cli' },
} as const;

const ALL_EXECUTION_METHODS: Record<string, { command: string; healthBridge: string }> = {
  ...RUNTIME_LANE_EXECUTION_METHODS,
  ...LEGACY_EXECUTION_METHODS,
};

/** Runtime command selected by both full manifest and narrow template renders. */
export function runtimeCommandForExecutionMethod(method: string): string {
  return ALL_EXECUTION_METHODS[method]?.command ?? 'gateway';
}

/** Bridge identity emitted by the selected harness health endpoint. */
export function expectedBridgeForExecutionMethod(method: string): string {
  return ALL_EXECUTION_METHODS[method]?.healthBridge ?? method;
}

/** Mapping embedded into the pod's inline failover supervisor. */
export const RUNTIME_COMMAND_BY_EXECUTION_METHOD: Readonly<Record<string, string>> =
  Object.freeze(Object.fromEntries(
    Object.entries(ALL_EXECUTION_METHODS).map(([method, capability]) => [method, capability.command]),
  ));
