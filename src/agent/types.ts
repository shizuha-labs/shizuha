import type { z } from 'zod';
import type { ToolDefinition, ToolResult, ImageData } from '../tools/types.js';

// ── Messages ──

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Image data from reading an image file */
  image?: ImageData;
}

/** Opaque thinking/reasoning block — roundtripped for prompt caching.
 * For Anthropic: encrypted thinking content + signature from the Messages API.
 * For OpenAI: reasoning items from the Responses API.
 * For vLLM R1/thinking models: plain-text reasoning_content from the delta. */
export interface ReasoningContent {
  type: 'reasoning';
  id: string;
  encryptedContent?: string | null;
  /** Raw provider reasoning text to round-trip for models that require it (e.g. GLM preserved thinking).
   *  SCLI-24: also used for vLLM reasoning_content (plain-text R1 reasoning), preserved through compaction. */
  rawContent?: string;
  signature?: string;
  summary?: Array<{ text: string }>;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ReasoningContent;

export interface Message {
  /** Stable external chat-bubble identity when one exists. */
  id?: string;
  /** Execution/run identity for grouping streamed assistant turns. */
  executionId?: string;
  role: Role;
  content: string | ContentBlock[];
  timestamp?: number;
}

// ── Tool Calls ──

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ── Turns ──

export interface Turn {
  index: number;
  assistantMessage: Message;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ── Agent Config ──

export interface AgentConfig {
  /** Model identifier (e.g., "claude-sonnet-4-20250514", "codex-mini-latest") */
  model: string;
  /** System prompt override (uses default template if not set) */
  systemPrompt?: string;
  /** Maximum turns before stopping */
  maxTurns?: number;
  /** Maximum tokens for context window before compaction */
  maxContextTokens?: number;
  /**
   * SCLI-218: compaction target policy for dynamic-window aliases (cortex/auto).
   * 'planning' (default) compacts against the current best-known window;
   * 'conservative' caps at the alias's advertised context floor so the session
   * fits every ladder rung (recommended for agents' eternal sessions).
   */
  compactionWindowMode?: 'planning' | 'conservative';
  /** Working directory for file operations */
  cwd?: string;
  /** Permission mode */
  permissionMode?: 'plan' | 'supervised' | 'autonomous';
  /** MCP server configs */
  mcpServers?: MCPServerConfig[];
  /** Additional tools to register */
  tools?: ToolDefinition[];
  /** Session ID for resuming */
  sessionId?: string;
  /** Temperature for LLM */
  temperature?: number;
  /** Max output tokens per turn */
  maxOutputTokens?: number;
  /** Claude extended thinking: 'off' | 'on' */
  thinkingLevel?: string;
  /** Codex reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'ultra' (ultra = gpt-5.6-sol auto-delegation, codex >=0.144) */
  reasoningEffort?: string;
  /** OS-level sandbox mode override (per-agent). If set, overrides config.sandbox. */
  sandboxMode?: import('../sandbox/types.js').SandboxMode;
  /** Named toolset to restrict available tools (e.g., 'local', 'developer', 'safe') */
  toolset?: string;
  /** Caller cancellation, used by sub-agents to interrupt bounded agent-loop waits. */
  abortSignal?: AbortSignal;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http' | 'websocket';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Custom headers for HTTP/WebSocket transports (e.g., auth tokens) */
  headers?: Record<string, string>;
  /** Reconnection options for StreamableHTTP transport */
  reconnection?: {
    maxReconnectionDelay?: number;
    initialReconnectionDelay?: number;
    reconnectionDelayGrowFactor?: number;
    maxRetries?: number;
  };
  /** Per-server tool call timeout in ms (overrides MCP_TOOL_TIMEOUT env / 120s default) */
  toolTimeoutMs?: number;
  /**
   * Set by the loader when this config was wired by the platform (shizuha-pulse, -connect, etc.).
   * Used in client.ts to gate broker JWT refresh — only platform-managed servers should receive
   * a broker-minted identity token; arbitrary user-supplied URLs must not.
   */
  platformManaged?: boolean;
}
