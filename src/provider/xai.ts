import { OpenAIProvider } from './openai.js';
import type { ChatMessage, ChatOptions, StreamChunk } from './types.js';
import type { XaiDirectBudget } from './xai-direct-budget.js';

/**
 * xAI (Grok) provider — OpenAI-compatible Chat Completions.
 *
 * Grok models are natively OpenAI-compatible (standard `tools` + streamed
 * tool_calls), so this inherits OpenAIProvider's streaming/tool/retry logic and
 * only overrides the endpoint, name, auth wire, and per-model context window.
 *
 * Two credential classes reach this provider:
 *  - `api_key`: a console key (`xai-…`, XAI_API_KEY) → https://api.x.ai/v1.
 *  - `oauth_subscription`: a SuperGrok / Grok Build OAuth access token leased
 *    from the Hive TokenPool. The console endpoint does not serve subscription
 *    allowance for these; Grok Build uses its CLI chat proxy with Grok CLI
 *    client headers. Same contract as Cortex's XaiGrokAdapter (CTX-5382).
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

export type XaiAuthMode = 'api_key' | 'oauth_subscription';

export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
export const XAI_OAUTH_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
/**
 * Proxy protocol compatibility pin (grok-build xai-grok-version 1.0.45,
 * agent/proxy_headers.rs) — identical to Cortex's pin. This is the proxy wire
 * version, not Shizuha's version; our product is identified separately.
 */
export const GROK_CLI_PROXY_CLIENT_VERSION = '1.0.45';
export const GROK_CLI_PROXY_CLIENT_IDENTIFIER = 'shizuha-cli';

/**
 * Infer the credential class from the token shape when the issuer did not say.
 * Console API keys are opaque `xai-…` strings (no dots); OAuth access tokens
 * from the Grok Build device grant are JWT-shaped. Hive's TokenPool serves
 * only OAuth grants (`auth_mode: xaiAccessToken`), so ambiguity resolves to
 * OAuth there; a raw console key someone pasted into the pool still works.
 */
export function inferXaiAuthMode(token: string | undefined): XaiAuthMode {
  const value = String(token || '').trim();
  if (!value) return 'api_key';
  if (value.startsWith('xai-') && !value.includes('.')) return 'api_key';
  return 'oauth_subscription';
}

export interface XaiProviderOptions {
  authMode?: XaiAuthMode;
  /** Explicit endpoint override (tests / custom deployments). */
  baseURL?: string;
  /** Rolling spend breaker for the Hive direct path (CTX-5382). */
  budget?: XaiDirectBudget;
  /** Opaque, non-secret lease label for usage records (e.g. account email). */
  accountLabel?: string;
}

function defaultBaseURL(authMode: XaiAuthMode): string {
  if (authMode === 'oauth_subscription') {
    return (process.env['SHIZUHA_XAI_OAUTH_BASE_URL'] || '').trim() || XAI_OAUTH_PROXY_BASE_URL;
  }
  return XAI_API_BASE_URL;
}

export class XaiProvider extends OpenAIProvider {
  override name = 'xai';
  readonly baseURL: string;
  readonly authMode: XaiAuthMode;
  readonly budget?: XaiDirectBudget;
  readonly accountLabel: string;
  override maxContextWindow = 131072;

  constructor(apiKey?: string, opts: XaiProviderOptions = {}) {
    const authMode = opts.authMode ?? 'api_key';
    const baseURL = opts.baseURL ?? defaultBaseURL(authMode);
    super(apiKey ?? process.env['XAI_API_KEY'], baseURL);
    this.baseURL = baseURL;
    this.authMode = authMode;
    this.budget = opts.budget;
    this.accountLabel = opts.accountLabel ?? '';
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
    const headers: Record<string, string> = key ? { 'x-grok-conv-id': key } : {};
    if (this.authMode === 'oauth_subscription') {
      // Grok CLI chat proxy contract (mirrors Cortex XaiGrokAdapter). All
      // values are constant per model, so they never perturb the prefix cache.
      Object.assign(headers, {
        'x-grok-client-version': GROK_CLI_PROXY_CLIENT_VERSION,
        'x-grok-client-identifier': GROK_CLI_PROXY_CLIENT_IDENTIFIER,
        'x-grok-client-mode': 'headless',
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-authenticateresponse': 'authenticate-response',
        'x-grok-model-override': options.model,
        Accept: 'text/event-stream',
      });
    }
    return headers;
  }

  protected override extraCompletionBody(options: ChatOptions): Record<string, unknown> {
    const key = this.conversationCacheKey(options);
    // Chat Completions contract is x-grok-conv-id; prompt_cache_key is the
    // Responses-API / OpenAI-compatible twin. Send both with the same value.
    return key ? { prompt_cache_key: key } : {};
  }

  override async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const budget = this.budget;
    if (!budget) {
      yield* super.chat(messages, options);
      return;
    }
    // Fail closed BEFORE spending: a tripped breaker throws a 429-shaped,
    // non-retryable error so the gateway's fallback chain (or idle) takes over.
    budget.assertAvailable();
    const started = Date.now();
    for await (const chunk of super.chat(messages, options)) {
      if (chunk.type === 'usage') {
        budget.record({
          model: options.model,
          sessionId: this.conversationCacheKey(options),
          account: this.accountLabel,
          promptTokens: chunk.inputTokens,
          cachedTokens: chunk.cacheReadInputTokens ?? 0,
          outputTokens: chunk.outputTokens,
          latencyMs: Date.now() - started,
        });
      }
      yield chunk;
    }
  }
}
