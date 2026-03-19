import { z } from 'zod';

export const agentSchema = z.object({
  defaultModel: z.string().default('auto'),
  maxTurns: z.number().int().min(0).default(0), // 0 = unlimited
  maxContextTokens: z.number().int().min(1000).optional(),
  temperature: z.number().min(0).max(2).default(0),
  maxOutputTokens: z.number().int().min(100).default(32000),
  cwd: z.string().default(process.cwd()),
  toolset: z.string().optional().describe('Named toolset to use (default: full)'),
});

export const providersSchema = z.object({
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  openai: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  google: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  openrouter: z
    .object({
      apiKey: z.string().optional(),
      appName: z.string().optional(),
      siteUrl: z.string().optional(),
    })
    .optional(),
  ollama: z
    .object({
      baseUrl: z.string().default('http://localhost:11434'),
    })
    .optional(),
});

export const permissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().optional(),
  decision: z.enum(['allow', 'deny', 'ask']),
});

export const permissionsSchema = z.object({
  mode: z.enum(['plan', 'supervised', 'autonomous']).default('supervised'),
  rules: z.array(permissionRuleSchema).default([]),
});

export const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'streamable-http', 'websocket']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  reconnection: z.object({
    maxReconnectionDelay: z.number().int().min(0).optional(),
    initialReconnectionDelay: z.number().int().min(0).optional(),
    reconnectionDelayGrowFactor: z.number().min(1).optional(),
    maxRetries: z.number().int().min(0).optional(),
  }).optional(),
  toolTimeoutMs: z.number().int().min(0).optional(),
});

export const toolSearchSchema = z.object({
  /** 'auto' = enable when MCP tools exceed threshold, 'on' = always, 'off' = never */
  mode: z.enum(['auto', 'on', 'off']).default('auto'),
  /** What to show in system prompt: 'none' | 'servers' (names + desc) | 'tools' (all tool names) */
  awareness: z.enum(['none', 'servers', 'tools']).default('servers'),
  /** Percent of context window; auto-enable when MCP tool tokens exceed this */
  autoThresholdPercent: z.number().min(0).max(100).default(10),
  /** Max results per ToolSearch call */
  maxResults: z.number().int().min(1).max(20).default(5),
});

export const mcpSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
  toolSearch: toolSearchSchema.default({}),
});

export const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().optional(),
});

export const hookSchema = z.object({
  event: z.enum(['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionStop']),
  matcher: z.string().optional(),
  command: z.string(),
  timeout: z.number().int().min(100).max(60000).optional(),
});

export const hooksSchema = z.object({
  hooks: z.array(hookSchema).default([]),
});

export const skillsSchema = z.object({
  /** Trust project-level skills (.shizuha/skills/, .claude/commands/ in cwd).
   *  When false (default), project skills from cloned repos are NOT loaded —
   *  preventing prompt injection from untrusted SKILL.md files. */
  trustProjectSkills: z.boolean().default(false),
});

export const sandboxSchema = z.object({
  /** Sandbox mode for OS-level process isolation.
   *  - 'unrestricted': no restrictions (default)
   *  - 'read-only': read-only filesystem, no network
   *  - 'workspace-write': write only in cwd + /tmp + writablePaths; network configurable
   *  - 'external': already sandboxed (Docker) — skip OS sandbox */
  mode: z.enum(['unrestricted', 'read-only', 'workspace-write', 'external']).default('unrestricted'),
  /** Additional directories with write access (workspace-write mode) */
  writablePaths: z.array(z.string()).default([]),
  /** Allow outbound network access (default: false) */
  networkAccess: z.boolean().default(false),
  /** Allowed destination hosts for outbound network requests.
   *  Supports exact hostnames and wildcard prefixes (e.g., "*.example.com").
   *  Empty = all hosts allowed. Only enforced when networkAccess=true. */
  allowedHosts: z.array(z.string()).default([]),
  /** Paths protected from writes even within writable roots.
   *  Relative to cwd — e.g., '.git', '.env'. */
  protectedPaths: z.array(z.string()).default(['.git', '.shizuha', '.env', '.claude']),
});

export const autoReplyRuleSchema = z.object({
  pattern: z.string(),
  response: z.string(),
  channels: z.array(z.string()).optional(),
  caseSensitive: z.boolean().default(false),
  priority: z.number().default(0),
});

export const autoReplySchema = z.object({
  enabled: z.boolean().default(false),
  rules: z.array(autoReplyRuleSchema).default([]),
}).default({ enabled: false, rules: [] });

export const configSchema = z.object({
  agent: agentSchema.default({}),
  providers: providersSchema.default({}),
  permissions: permissionsSchema.default({}),
  mcp: mcpSchema.default({}),
  hooks: hooksSchema.default({}),
  skills: skillsSchema.default({}),
  sandbox: sandboxSchema.default({}),
  logging: loggingSchema.default({}),
  autoReply: autoReplySchema,
});

export type ConfigInput = z.input<typeof configSchema>;

/**
 * Per-agent config schema — loaded from ~/.shizuha/agents/{username}/agent.toml.
 * All fields optional; overrides global config for this specific agent.
 */
export const perAgentConfigSchema = z.object({
  model: z.string().optional(),
  thinkingLevel: z.enum(['off', 'on', 'low', 'medium', 'high']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  permissionMode: z.enum(['plan', 'supervised', 'autonomous']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(100).optional(),
  maxContextTokens: z.number().int().min(1000).optional(),
  toolset: z.string().optional().describe('Named toolset to use (overrides global)'),
  mcp: z.object({
    servers: z.array(mcpServerSchema).default([]),
  }).optional(),
});

export type PerAgentConfig = z.infer<typeof perAgentConfigSchema>;
