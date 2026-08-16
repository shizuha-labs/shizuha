export interface ImageAttachment {
  dataUrl: string;
  mimeType: string;
  name?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: ImageAttachment[];
  reasoningSummaries?: string[];
  toolCalls?: ToolCall[];
  status?: 'complete' | 'failed' | 'streaming';
  errorMessage?: string;
  createdAt: string;
  /** Message source — 'user' for dashboard chat, 'agent:username' for inter-agent, 'heartbeat' for heartbeat */
  source?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Event sequence number from the server (primary ordering key; see MESSAGING_PROTOCOL.md). */
  seqNum?: number;
  /**
   * Local optimistic send that has not yet been echoed by the server.
   * When the echo arrives (by matching `id` to `request_id`/`client_message_id`),
   * the pending entry is replaced in place with the server's `id`/`createdAt`/`seqNum`.
   */
  pending?: boolean;
  /**
   * Client-generated UUID carried through Connect's `client_message_id`
   * field. This is the stable primary dedup key — set on optimistic send,
   * echoed back by the server unchanged, and used by `insertOrdered` to
   * replace pending entries with their server-echoed counterparts even when
   * the echo's `id` (server UUID) differs. Matches the WhatsApp pattern and
   * mirrors `unique(conversation_id, client_message_id)` on DirectMessage.
   * See MESSAGING_PROTOCOL.md § Resilience Contract (1).
   */
  clientMessageId?: string;
  /** Inline device auth data (shown as a special card in chat) */
  authData?: {
    provider: string;
    stage: 'required' | 'device_code' | 'polling' | 'complete' | 'error' | 'token_input';
    userCode?: string;
    verificationUrl?: string;
    email?: string;
    /** Token input fields (for providers like Claude that use paste-in tokens) */
    instructions?: string;
    placeholder?: string;
    tokenLabel?: string;
    envVar?: string;
    /** Agent ID (for restarting the agent after token is saved) */
    agentId?: string;
  };
  /** Canvas app data (interactive HTML/JS content for CanvasApp rendering) */
  canvasApp?: {
    html: string;
    title?: string;
  };
}

export interface ToolCall {
  tool: string;
  input?: Record<string, unknown>;
  output?: string;
  diff?: string;
  durationMs?: number;
  isError?: boolean;
}

export interface Session {
  id: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  name?: string;
  firstMessage?: string;
}

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

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
  grantId?: string;
  grantorId?: string;
  scope?: AgentCredentialScope;
  /** @deprecated Use scope. */
  service?: AgentCredentialScope;
  label: string;
  credentialData: Record<string, string>;
  expiresAt?: string | null;
  injectAsEnv: boolean;
  envMapping?: Record<string, string>;
  isActive: boolean;
}

export interface AgentWorkSchedule {
  days: number[];
  startHour: number;
  endHour: number;
  timezone: string;
}

export interface AgentTokenBudget {
  monthlyLimit: number;
  tokensUsed: number;
  resetDay: number;
}

export interface Agent {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string | null;
  env?: Record<string, string>;
  executionMethod?: string;
  runtimeEnvironment?: 'bare_metal' | 'container' | 'restricted_container' | 'sandbox';
  resourceLimits?: { memory?: string; cpus?: string; pidsLimit?: number };
  modelOverrides?: Record<string, string>;
  modelFallbacks?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
  skills: string[];
  eagerSkills?: string[];
  personalityTraits: Record<string, string>;
  mcpServers: Array<{ name: string; slug: string }>;
  status: 'running' | 'starting' | 'error' | 'stopped' | 'unknown';
  enabled?: boolean;
  pid?: number;
  error?: string;
  // Platform-aligned fields
  credentials?: AgentCredential[];
  credentialGrantScopes?: AgentCredentialScope[];
  credentialAuditRoles?: AgentCredentialAuditRole[];
  credentialPermissionSeedVersion?: string;
  agentMemory?: string;
  workSchedule?: AgentWorkSchedule;
  tokenBudget?: AgentTokenBudget;
  maxConcurrentTasks?: number;
  allowParallelExecution?: boolean;
  warmPoolSize?: number;
  tier?: 'normal' | 'superuser';
  contextPrompt?: string;
  lastActiveAt?: string | null;
  startedAt?: string | null;
}

/** Derive the configured model for an agent from its fallbacks/overrides + execution method */
export function getAgentModel(agent: Agent): string {
  // New: model_fallbacks takes priority — primary is first entry
  if (agent.modelFallbacks?.length) {
    return agent.modelFallbacks[0]!.model;
  }
  // Legacy: model_overrides map
  const overrides = agent.modelOverrides ?? {};
  const method = agent.executionMethod ?? 'shizuha';
  const m = overrides[method] || overrides['shizuha'] || '';
  if (m) return m;
  // Default based on execution method
  if (method.startsWith('codex')) return 'gpt-5.5';
  if (method.startsWith('claude')) return 'claude-sonnet-4-6';
  return 'auto';
}

/** Get the primary execution method for an agent */
export function getAgentMethod(agent: Agent): string {
  if (agent.modelFallbacks?.length) {
    return agent.modelFallbacks[0]!.method;
  }
  return agent.executionMethod ?? 'shizuha';
}

/** Get the primary reasoning effort for an agent (from model chain entry) */
export function getAgentEffort(agent: Agent): string | undefined {
  return agent.modelFallbacks?.[0]?.reasoningEffort;
}

/** Get the primary thinking level for an agent (from model chain entry) */
export function getAgentThinking(agent: Agent): string | undefined {
  return agent.modelFallbacks?.[0]?.thinkingLevel;
}

/** Build a compact summary string: method/model [effort] [thinking:on] */
export function getAgentSummary(agent: Agent): string {
  const method = getAgentMethod(agent);
  const model = getAgentModel(agent);
  const effort = getAgentEffort(agent);
  const thinking = getAgentThinking(agent);
  let s = `${method}/${model}`;
  if (effort) s += ` · effort:${effort}`;
  if (thinking) s += ` · thinking:${thinking}`;
  return s;
}
