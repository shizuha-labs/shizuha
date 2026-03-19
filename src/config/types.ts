import type { PermissionMode, PermissionRule } from '../permissions/types.js';
import type { MCPServerConfig } from '../agent/types.js';
import type { HookConfig } from '../hooks/types.js';
import type { SandboxMode } from '../sandbox/types.js';

export interface AutoReplyRuleConfig {
  pattern: string;
  response: string;
  channels?: string[];
  caseSensitive: boolean;
  priority: number;
}

export interface AutoReplySection {
  enabled: boolean;
  rules: AutoReplyRuleConfig[];
}

export interface ShizuhaConfig {
  agent: AgentSection;
  providers: ProvidersSection;
  permissions: PermissionsSection;
  mcp: MCPSection;
  hooks: HooksSection;
  skills: SkillsSection;
  sandbox: SandboxSection;
  logging: LoggingSection;
  autoReply: AutoReplySection;
}

export interface HooksSection {
  hooks: HookConfig[];
}

export interface AgentSection {
  defaultModel: string;
  maxTurns: number;
  maxContextTokens?: number;
  temperature: number;
  maxOutputTokens: number;
  cwd: string;
  toolset?: string;
}

export interface ProvidersSection {
  anthropic?: { apiKey?: string; baseUrl?: string };
  openai?: { apiKey?: string; baseUrl?: string };
  google?: { apiKey?: string };
  openrouter?: { apiKey?: string; appName?: string; siteUrl?: string };
  ollama?: { baseUrl?: string };
  vllm?: { baseUrl?: string; apiKey?: string };
}

export interface PermissionsSection {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export interface ToolSearchSection {
  mode: 'auto' | 'on' | 'off';
  awareness: 'none' | 'servers' | 'tools';
  autoThresholdPercent: number;
  maxResults: number;
}

export interface MCPSection {
  servers: MCPServerConfig[];
  toolSearch: ToolSearchSection;
}

export interface SkillsSection {
  trustProjectSkills: boolean;
}

export interface SandboxSection {
  /** Sandbox mode: 'unrestricted' | 'read-only' | 'workspace-write' | 'external' */
  mode: SandboxMode;
  /** Additional writable paths (workspace-write mode). cwd + /tmp always writable. */
  writablePaths: string[];
  /** Allow outbound network access (default: false) */
  networkAccess: boolean;
  /** Allowed destination hosts for outbound requests (empty = all allowed) */
  allowedHosts: string[];
  /** Paths protected from writes even within writable roots */
  protectedPaths: string[];
}

export interface LoggingSection {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
}

/** Per-agent runtime config from ~/.shizuha/agents/{username}/agent.toml */
export interface PerAgentConfig {
  model?: string;
  thinkingLevel?: 'off' | 'on' | 'low' | 'medium' | 'high';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  permissionMode?: 'plan' | 'supervised' | 'autonomous';
  temperature?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  toolset?: string;
  mcp?: { servers: import('../agent/types.js').MCPServerConfig[] };
}
