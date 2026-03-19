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
 * For OpenAI: reasoning items from the Responses API. */
export interface ReasoningContent {
  type: 'reasoning';
  id: string;
  encryptedContent?: string | null;
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
  /** Codex reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' */
  reasoningEffort?: string;
  /** OS-level sandbox mode override (per-agent). If set, overrides config.sandbox. */
  sandboxMode?: import('../sandbox/types.js').SandboxMode;
  /** Named toolset to restrict available tools (e.g., 'local', 'developer', 'safe') */
  toolset?: string;
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
}
