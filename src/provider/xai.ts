import { OpenAIProvider } from './openai.js';
import type { ChatOptions } from './types.js';

/**
 * xAI (Grok) provider — OpenAI-compatible Chat Completions at api.x.ai.
 *
 * Grok models are natively OpenAI-compatible (standard `tools` + streamed
 * tool_calls), so this inherits OpenAIProvider's streaming/tool/retry logic and
 * only overrides the endpoint, name, and per-model context window. Previously
 * Grok fell through to the generic OpenAI-compatible path with the wrong default
 * context window (128K) and the undersized DEFAULT model profile.
 */
const GROK_CONTEXT: Record<string, number> = {
  'grok-4.7': 500000,
  'grok-4.7-latest': 500000,
  'grok-4.6': 500000,
  'grok-4.6-latest': 500000,
  'grok-4.5': 500000,
  'grok-4.5-latest': 500000,
  'grok-4': 256000,
  'grok-4-latest': 256000,
  'grok-3': 131072,
  'grok-3-latest': 131072,
  'grok-3-mini': 131072,
  'grok-2': 131072,
  'grok-2-latest': 131072,
  'grok-beta': 131072,
};

export class XaiProvider extends OpenAIProvider {
  override name = 'xai';
  readonly baseURL = 'https://api.x.ai/v1';
  override maxContextWindow = 131072;

  constructor(apiKey?: string) {
    super(apiKey ?? process.env['XAI_API_KEY'], 'https://api.x.ai/v1');
  }

  override contextWindowFor(model: string): number {
    return GROK_CONTEXT[model] ?? 131072;
  }

  /**
   * Stable per-conversation cache identity for xAI prefix cache.
   * Must be the durable session id (not a per-request UUID or timestamp)
   * so heartbeats reuse the same cache server. Empty when no session is known
   * — we never invent a volatile fallback that would force a miss every turn.
   */
  private conversationCacheKey(options: ChatOptions): string {
    return (options.sessionId || '').trim();
  }

  protected override extraCompletionHeaders(options: ChatOptions): Record<string, string> {
    const key = this.conversationCacheKey(options);
    return key ? { 'x-grok-conv-id': key } : {};
  }

  protected override extraCompletionBody(options: ChatOptions): Record<string, unknown> {
    const key = this.conversationCacheKey(options);
    // Chat Completions contract is x-grok-conv-id; prompt_cache_key is the
    // Responses-API / OpenAI-compatible twin. Send both with the same value.
    return key ? { prompt_cache_key: key } : {};
  }
}
