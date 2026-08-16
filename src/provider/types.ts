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
  /** Raw provider reasoning text to round-trip for OpenAI-compatible models that require it. */
  rawContent?: string;
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
  /** OpenAI-compatible tool selection policy for this turn. Providers that do
   *  not support an explicit policy may ignore it. */
  toolChoice?: 'auto' | 'required' | 'none' | {
    type: 'function';
    function: { name: string };
  };
  systemPrompt?: string;
  stopSequences?: string[];
  /** Claude extended thinking: 'off' | 'on' (default: 'on') */
  thinkingLevel?: string;
  /** Codex reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'ultra' (ultra = gpt-5.6-sol auto-delegation, codex >=0.144) */
  reasoningEffort?: string;
  /** Service tier for speed control: 'auto' | 'default' | 'fast' | 'flex' */
  serviceTier?: string;
  /** Callback for rate limit info from response headers */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Abort signal for cancelling the stream mid-flight */
  abortSignal?: AbortSignal;
  /** Session identity forwarded to the provider (CTX-292): Cortex routes a
   *  session to its KV/prefix-warm replica by this key (OpenAI-standard `user`
   *  field), avoiding ~50s cold prefills on replica hops for 100k+ contexts. */
  sessionId?: string;
  /** Maintenance / cold-prefill attribution tag (2026-07-14 + PLAT-4189):
   *  - 'compaction' (preferred; legacy alias 'bulk'): full-context summarization.
   *    Cortex meters stage=compaction_ttft (never interactive stream_ttft) and
   *    routes off-home (kv reason compaction_offhome) so interactive KV stays warm.
   *  - 'warmup': post-restart pre-warm of the session home (also compaction_ttft, sticky).
   *  - 'post_compaction': first interactive turn after a head rewrite — sticky
   *    interactive routing/TTFT, but Cortex marks the cold prefill EXPECTED
   *    (not the ideally-zero mid-session miss surface).
   *  Providers without metadata support ignore it. Always prefer 'compaction'
   *  over 'bulk' in new code — same wire meaning, clearer ops surface. */
  requestKind?: string;
  /** CTX soft-drain handoff intent. Cortex accepts this only for a warmup and
   * routes the full prefix away from the session's draining warm-only home. */
  cortexRehome?: 'soft-drain';
  /** Response-header signal from Cortex that the current session home is in
   * warm-only soft drain. Internal lifecycle callback; other providers ignore. */
  onCortexRehomeRequired?: () => void;
}

// ── Stream Chunks ──

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'final_text'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'reasoning'; id: string; encryptedContent?: string | null; rawContent?: string /** SCLI-24: plain-text reasoning from vLLM reasoning_content */; signature?: string; summary?: Array<{ text: string }> }
  | { type: 'reasoning_text'; text: string /** Streaming reasoning summary delta — the model's live thinking text */ }
  | { type: 'thinking'; /** Lightweight heartbeat emitted during extended thinking so the TUI knows the stream is alive. */ }
  | {
      type: 'status';
      message: string;
      level?: 'info' | 'warning';
      provider?: string;
      code?: string;
      attempt?: number;
      maxAttempts?: number;
      retryInMs?: number;
      traceId?: string;
      requestId?: string;
      sessionId?: string;
      waitPhase?: 'headers' | 'first_chunk' | 'retry_backoff' | 'stream' | 'none';
      elapsedMs?: number;
      timeoutMs?: number;
      /** Upstream request correlation for this exact admission attempt. */
      upstreamRequestId?: string;
      attemptWaitMs?: number;
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; providerPromptEstimate?: number }
  /**
   * SCLI-218: the CONCRETE model the backend served this response with. For
   * virtual aliases (cortex/auto) this differs from the requested model and the
   * effective context window differs per response — the agent loop re-resolves
   * its compaction budget when this changes. Emitted at most once per response,
   * as soon as the served model is known.
   */
  | { type: 'served_model'; model: string; contextWindow?: number }
  | {
      type: 'inference_telemetry';
      traceId: string; requestId: string; spanId: string; sessionId?: string; agentId?: string; runtimeId?: string;
      provider: string; harness?: string; requestedModel: string; resolvedModel: string;
      /** Cortex request id for the final accepted attempt (server-side log/UsageRecord join key). */
      upstreamRequestId?: string;
      /** Rejected admission attempts preceding the accepted response. */
      admissionAttempts?: Array<{ requestId?: string; status: number; waitMs: number; retryInMs: number }>;
      backend?: { id?: string; baseUrl?: string; pod?: string; node?: string; hint?: string };
      lifecycle: { requestStart: number; headersReceived?: number; firstChunk?: number; firstToken?: number; completion?: number; abort?: number };
      timeoutPhase?: 'connect' | 'headers' | 'first_chunk' | 'mid_stream_stall' | 'finalization' | 'none';
      errorClass?: string; upstreamStatus?: number; upstreamCode?: string | number; upstreamMessage?: string;
      retryCount: number; outcome: 'success' | 'error' | 'timeout' | 'aborted';
      inputTokens?: number; outputTokens?: number; thinkingMode?: string; toolMode?: boolean; maxTokens?: number;
      timestamp: number;
    }
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
  /**
   * SCLI-81: per-model native context window, resolvable WITHOUT a chat() call.
   * Lets budget/compaction use the correct window before the first turn (e.g.
   * opus-4-8 / fable-5 = 1M, not the 200K class default). Optional: providers
   * with a fixed per-model table (Anthropic/OpenAI family) implement it; others
   * (self-hosted, auto-discovered via maxContextWindow) leave it undefined.
   */
  contextWindowFor?(model: string): number;
}
