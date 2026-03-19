import type { ToolDefinition, ImageData } from '../tools/types.js';

// ── Chat Messages ──

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentBlock[];
  toolCallId?: string;
}

export interface ChatTextBlock {
  type: 'text';
  text: string;
}

export interface ChatToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** Image data for vision-capable models */
  image?: ImageData;
}

/** Opaque thinking/reasoning block — roundtripped for prompt caching.
 * For Anthropic: encrypted thinking content + signature from the Messages API.
 * For OpenAI: reasoning items from the Responses API. */
export interface ChatReasoningBlock {
  type: 'reasoning';
  id: string;
  encryptedContent?: string | null;
  signature?: string;
  summary?: Array<{ text: string }>;
}

export type ChatContentBlock = ChatTextBlock | ChatToolUseBlock | ChatToolResultBlock | ChatReasoningBlock;

// ── Chat Options ──

/** Rate limit info extracted from provider response headers */
export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt?: number;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  stopSequences?: string[];
  /** Claude extended thinking: 'off' | 'on' (default: 'on') */
  thinkingLevel?: string;
  /** Codex reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' */
  reasoningEffort?: string;
  /** Service tier for speed control: 'auto' | 'default' | 'fast' | 'flex' */
  serviceTier?: string;
  /** Callback for rate limit info from response headers */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Abort signal for cancelling the stream mid-flight */
  abortSignal?: AbortSignal;
}

// ── Stream Chunks ──

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'final_text'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'reasoning'; id: string; encryptedContent?: string | null; signature?: string; summary?: Array<{ text: string }> }
  | { type: 'reasoning_text'; text: string /** Streaming reasoning summary delta — the model's live thinking text */ }
  | { type: 'thinking'; /** Lightweight heartbeat emitted during extended thinking so the TUI knows the stream is alive. */ }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { type: 'web_search'; status: 'searching' | 'done' }
  | { type: 'stop_reason'; reason: string }
  | { type: 'done' };

// ── LLM Provider ──

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk>;
  supportsTools: boolean;
  supportsNativeWebSearch?: boolean;
  maxContextWindow: number;
}
