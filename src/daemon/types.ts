/**
 * Daemon types for `shizuha up` — manages agent runtimes.
 */

// ── Failover Chain ──

export interface FailoverChainStep {
  /** Execution method: 'claude_code_server' | 'codex_app_server' | 'openclaw_bridge' | 'grok_build' | 'shizuha' | 'antigravity_server' (legacy aliases gemini_cli_server → antigravity) */
  method: string;
  /** Model identifier (e.g., 'claude-opus-4-7', 'gpt-5.5') */
  model: string;
  /** Reasoning effort for this step */
  reasoningEffort?: string;
  /** Thinking level for this step (claude-bridge) */
  thinkingLevel?: string;
  /** Max token rotations before moving to next step. Default: try all available tokens. */
  maxTokenRetries?: number;
}

export interface FailoverChain {
  /** Unique identifier (slug, e.g. "claude-primary") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Ordered steps — tried in sequence on failure */
  steps: FailoverChainStep[];
  /** Created timestamp */
  createdAt: string;
  /** Last modified timestamp */
  updatedAt: string;
}

// ── Agent Credentials ──

export type AgentCredentialScope =
  | 'fleet-ssh'
  | 'kubeconfig'
  | 'vault-token'
  | 'shizuha-id'
  | 'github'
  | 'gitlab'
  | 'aws'
  | 'npm'
  | 'docker'
  | 'custom';

export type AgentCredentialAuditRole =
  | 'metadata-audit'
  | 'security-lead';

export interface AgentCredential {
  /** @deprecated Use grantId. Kept as a wire-compatibility alias during migration. */
  id: string;
  /** UUID primary key for this credential grant */
  grantId?: string;
  /** Transport-derived ID of the actor that granted/staged this credential */
  grantorId?: string;
  /** Closed credential scope enum. The sentinel value "reserved" is intentionally non-instantiable. */
  scope?: AgentCredentialScope;
  /** @deprecated Use scope. Kept as a wire-compatibility alias during migration. */
  service?: AgentCredentialScope;
  /** Arbitrary service name for custom-scope credentials (e.g. "hackernews", "x-twitter"). Set by upsert_self_credential. */
  customService?: string;
  /** Display label (e.g. "GitHub Personal Access Token") */
  label: string;
  /** The credential data — opaque object (tokens, keys, etc.) */
  credentialData: Record<string, string>;
  /** ISO timestamp when the grant expires; null means no scheduled expiry. */
  expiresAt?: string | null;
  /** Whether to inject as environment variables into the agent runtime */
  injectAsEnv: boolean;
  /** Environment variable mappings: credentialData key → env var name */
  envMapping?: Record<string, string>;
  /** Whether this credential is active */
  isActive: boolean;
}


export interface EffectiveCapabilityDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  capability?: string;
  mcpServer?: string;
}

export interface HiveCredentialMaterialization {
  grantId: string;
  scope: 'agent' | 'team';
  organizationSlug?: string;
  teamSlug?: string;
  provider: string;
  purpose: string;
  /** Broker/vault/Kubernetes handle only; never credential bytes. */
  secretRef: string;
  isActive: true;
}

export interface HiveOrganizationTeamMembership {
  organizationSlug: string;
  teamSlug: string;
}

export interface AgentEffectiveCapabilities {
  source: 'hive' | 'legacy';
  capabilities: string[];
  skills: string[];
  eagerSkills: string[];
  mcpServers: string[];
  sourceTeams: string[];
  sourceTeamMemberships?: HiveOrganizationTeamMembership[];
  credentialGrantScopes: AgentCredentialScope[];
  credentialCustomGrantServices: string[];
  teamCredentialEligibleTeams?: string[];
  teamCredentialEligibleMemberships?: HiveOrganizationTeamMembership[];
  credentialMaterializations?: HiveCredentialMaterialization[];
  runtimeFlags: Record<string, unknown>;
  diagnostics: EffectiveCapabilityDiagnostic[];
  catalogVersion?: string | number;
  computedAt?: string;
  expiresAt?: string;
  definitionHashes?: Record<string, string>;
  sourceAttribution?: Record<string, unknown>;
  migrationAllowlistVersion?: string | number;
  signature?: string;
  signatureVerified?: boolean;
  trustedForSensitive?: boolean;
  stale?: boolean;
  appliedAt: string;
}

export interface AgentCredentialRequest {
  id: string;
  requesterId: string;
  requesterUsername: string;
  requesterRole?: string | null;
  scope: AgentCredentialScope;
  reason: string;
  requestedAt: string;
  expiry?: string | null;
  status: 'pending' | 'fulfilled' | 'denied' | 'expired';
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
  /**
   * Team membership (PLAT-458 §3.3) — provenance for role/team-targeted skill
   * loading. Trusted (Pulse identity / agent config), never self-asserted.
   * Propagated to the agent process as the AGENT_TEAM env, mirroring AGENT_ROLE.
   * Optional/nullable so existing agents.json without a team keep working.
   */
  team?: string | null;
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
  runtimeEnvironment?: 'bare_metal' | 'container' | 'restricted_container' | 'sandbox' | 'k8s';
  /** Container resource limits (only applies when runtimeEnvironment is container-based) */
  resourceLimits?: {
    /** Memory limit, e.g. "512m", "2g" (Docker --memory format) */
    memory?: string;
    /** CPU limit, e.g. "1.0", "0.5", "2" (Docker --cpus format) */
    cpus?: string;
    /** Max PIDs inside the container (Docker --pids-limit) */
    pidsLimit?: number;
  };
  /** Primary model identifier persisted by the agent-state store compatibility export. */
  model?: string;
  modelOverrides?: Record<string, string>;
  /** Ordered fallback chain: [{method, model}, ...]. First that works is pinned. */
  modelFallbacks?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
  /** Exact Hive RuntimeLane fence rendered into the active workload. */
  runtimeLaneGeneration?: number;
  runtimeLaneDigest?: string;
  /** Named failover chain policy ID. When set, overrides modelFallbacks. */
  failoverChainId?: string;
  contextPrompt?: string;
  /** Custom environment variables injected into the agent's child process */
  env?: Record<string, string>;

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
  /**
   * Per-agent override for which skills are eager-loaded into the system prompt.
   * Names listed here are treated as if their SKILL.md had `starred: true` in
   * frontmatter — full content is injected (or copied to ~/.claude/skills/ for
   * Claude Code agents). Union with file-level starred flag.
   */
  eagerSkills?: string[];

  // ── Platform-aligned fields (for sync compatibility) ──

  /** Service credentials injected as env vars into the agent runtime */
  credentials?: AgentCredential[];
  /**
   * Platform/broker permission record for AgentCredential grant authority.
   * This is intentionally separate from mutable custom env: only agents with
   * at least one scope here may receive the grant broker socket.
   */
  credentialGrantScopes?: AgentCredentialScope[];
  /** Service-scoped cross-agent authority for custom credentials (for example forgejo). '*' is break-glass only. */
  credentialCustomGrantServices?: string[];
  /**
   * Dedicated break-glass payload-read authority. Grant authority alone must
   * never imply credential payload disclosure. The sentinel '*' may be used for
   * security leads that can read any scope through the audited grant socket path.
   */
  credentialPayloadReadScopes?: Array<AgentCredentialScope | '*'>;
  /** Explicit Unix peer UID allowed to use shared broker sockets; absent means fail closed. */
  credentialBrokerPeerUid?: number;
  /** Durable credential request queue written by the broker request socket. */
  credentialRequests?: AgentCredentialRequest[];
  /**
   * Platform/broker credential-audit roles. `metadata-audit` permits grant
   * metadata inventory only; `security-lead` is a separate break-glass payload
   * role and is intentionally unassigned by the bootstrap seed.
   */
  credentialAuditRoles?: AgentCredentialAuditRole[];
  /** One-shot seed version for bootstrap credential grant/audit permissions. */
  credentialPermissionSeedVersion?: string;
  /** Hive-managed effective runtime capabilities applied by the daemon. */
  effectiveCapabilities?: AgentEffectiveCapabilities;
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
  /** SSH key configuration — enables SSH access from agent containers */
  sshKeys?: {
    /** Whether SSH keys are injected into this agent's container */
    enabled: boolean;
    /** Path to the SSH directory to mount (default: ~/.ssh) */
    sshDir?: string;
    /** Specific key files to mount (e.g. ["id_rsa", "id_ed25519"]). If empty, mounts all keys. */
    keyFiles?: string[];
    /** SSH username for remote hosts (default: current user) */
    remoteUser?: string;
  };
  /**
   * Inline Ed25519 keypair stored in agents.json during provisioning.
   * Used by k3s-fleet (rt-fleet) daemons that lack access to the host's
   * ~/.shizuha/agents/<username>/identity/ tree. When present, takes precedence
   * over the filesystem path. Absent (or false/null) means the daemon falls
   * back to the legacy file-based path.
   */
  keypair?: { publicKey: string; privateKey?: string } | false | null;
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
  status: 'starting' | 'running' | 'stopped' | 'offline' | 'error';
  /** Whether the agent runtime is enabled (user toggle) */
  enabled: boolean;
  /** Error message if status is 'error' */
  error?: string;
  /** Label of the Claude OAuth token assigned to this agent */
  oauthTokenLabel?: string;
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
