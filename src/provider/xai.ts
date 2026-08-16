import { OpenAIProvider } from './openai.js';

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
}
