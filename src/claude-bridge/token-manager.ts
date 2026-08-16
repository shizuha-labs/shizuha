// Re-export — the canonical home is src/auth/agent-token-manager.ts.
// Kept here so existing imports (../claude-bridge/token-manager) keep working
// during the transition.
export { AgentTokenManager } from '../auth/agent-token-manager.js';
export type { AgentTokenManagerOptions } from '../auth/agent-token-manager.js';
