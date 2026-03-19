/**
 * Daemon types for `shizuha up` — manages agent runtimes.
 */

export interface AgentCredential {
  /** Unique ID for this credential */
  id: string;
  /** Service name (e.g. "github", "gitlab", "aws", "npm") */
  service: string;
  /** Display label (e.g. "GitHub Personal Access Token") */
  label: string;
  /** The credential data — opaque object (tokens, keys, etc.) */
  credentialData: Record<string, string>;
  /** Whether to inject as environment variables into the agent runtime */
  injectAsEnv: boolean;
  /** Environment variable mappings: credentialData key → env var name */
  envMapping?: Record<string, string>;
  /** Whether this credential is active */
  isActive: boolean;
}

export interface AgentWorkSchedule {
  /** Days of the week the agent is allowed to work (0=Mon, 6=Sun) */
  days: number[];
  /** Start hour (0-23) in the specified timezone */
  startHour: number;
  /** End hour (0-23) in the specified timezone */
  endHour: number;
  /** IANA timezone (e.g. "Asia/Kolkata", "UTC") */
  timezone: string;
}

export interface AgentTokenBudget {
  /** Monthly token budget (0 = unlimited) */
  monthlyLimit: number;
  /** Tokens used in the current billing period */
  tokensUsed: number;
  /** Day of month the budget resets (1-28) */
  resetDay: number;
}

export interface AgentInfo {
  /** Agent identity — always from platform */
  id: string;
  name: string;
  username: string;
  email: string;
  role: string | null;
  status: 'active' | 'paused' | 'disabled';

  /** @deprecated All agents are local. Kept for backward compat with older agents.json files. */
  isLocal?: boolean;
  /** Gateway port assigned at daemon startup. */
  localPort?: number;

  /**
   * Platform-provided runtime hints (deprecated — prefer per-agent TOML).
   * These are only used as fallbacks when no local config exists at
   * ~/.shizuha/agents/{username}/agent.toml.
   */
  executionMethod?: string;
  runtimeEnvironment?: 'bare_metal' | 'container' | 'restricted_container' | 'sandbox';
  /** Container resource limits (only applies when runtimeEnvironment is container-based) */
  resourceLimits?: {
    /** Memory limit, e.g. "512m", "2g" (Docker --memory format) */
    memory?: string;
    /** CPU limit, e.g. "1.0", "0.5", "2" (Docker --cpus format) */
    cpus?: string;
    /** Max PIDs inside the container (Docker --pids-limit) */
    pidsLimit?: number;
  };
  modelOverrides?: Record<string, string>;
  /** Ordered fallback chain: [{method, model}, ...]. First that works is pinned. */
  modelFallbacks?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
  contextPrompt?: string;

  /** MCP servers the agent is authorized to use on the platform */
  mcpServers: Array<{
    name: string;
    slug: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    transportType: string;
  }>;
  personalityTraits: Record<string, string>;
  skills: string[];

  // ── Platform-aligned fields (for sync compatibility) ──

  /** Service credentials injected as env vars into the agent runtime */
  credentials?: AgentCredential[];
  /** Agent-specific persistent memory (MEMORY.md content) */
  agentMemory?: string;
  /** Work schedule — when the agent is allowed to execute tasks */
  workSchedule?: AgentWorkSchedule;
  /** Token budget for cost control */
  tokenBudget?: AgentTokenBudget;
  /** Max concurrent task executions (default: 1) */
  maxConcurrentTasks?: number;
  /** Whether to allow parallel task execution */
  allowParallelExecution?: boolean;
  /** Warm pool size — number of pre-warmed runtime instances (default: 0) */
  warmPoolSize?: number;
  /** Agent tier: normal or superuser (superuser bypasses approval checkpoints) */
  tier?: 'normal' | 'superuser';
}

export interface RunnerToken {
  id: string;
  token: string; // raw token, only available at creation
  tokenPrefix: string;
  agentId: string;
  agentName: string;
  scopes: string[];
  expiresAt: string | null;
}

export interface DaemonState {
  /** PID of the daemon process */
  pid: number;
  /** When the daemon started */
  startedAt: string;
  /** Platform URL */
  platformUrl: string;
  /** Agents being managed */
  agents: DaemonAgentState[];
}

export interface DaemonAgentState {
  agentId: string;
  agentName: string;
  /** PID of the agent gateway process (or container ID) */
  pid?: number;
  containerId?: string;
  containerName?: string;
  /** Runner token prefix for identification */
  tokenPrefix: string;
  /** Agent status */
  status: 'starting' | 'running' | 'stopped' | 'error';
  /** Whether the agent runtime is enabled (user toggle) */
  enabled: boolean;
  /** Error message if status is 'error' */
  error?: string;
  /** When this agent was started */
  startedAt: string;
}

export interface DaemonConfig {
  /** Platform base URL */
  platformUrl: string;
  /** WebSocket URL for runner connection */
  wsUrl: string;
  /** Whether to run agents in containers (default) or bare metal */
  containerMode: boolean;
  /** Docker image for agent containers */
  image: string;
  /** Specific agent names/IDs to start (empty = all) */
  agentFilter: string[];
  /** Run in foreground instead of daemonizing */
  foreground?: boolean;
}
