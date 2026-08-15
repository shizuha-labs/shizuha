import { OpenAIProvider } from './openai.js';

/**
 * Together AI provider — OpenAI-compatible Chat Completions at api.together.xyz.
 *
 * Together serves open models under `org/Model` IDs (e.g.
 * `meta-llama/Llama-3.3-70B-Instruct-Turbo`). It is OpenAI-compatible, so this
 * inherits OpenAIProvider's streaming/tool/retry logic and overrides only the
 * endpoint, name, and per-model context window. Note the slash in model IDs is
 * part of the model name, not provider routing — explicit routing uses the
 * `together:` / `together/` prefix (handled in the registry).
 */
const TOGETHER_CONTEXT: Record<string, number> = {
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 131072,
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': 131072,
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': 131072,
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': 130815,
  'Qwen/Qwen2.5-72B-Instruct-Turbo': 32768,
  'Qwen/Qwen2.5-Coder-32B-Instruct': 32768,
  'deepseek-ai/DeepSeek-R1': 131072,
  'deepseek-ai/DeepSeek-V3': 131072,
  'mistralai/Mixtral-8x7B-Instruct-v0.1': 32768,
};

export class TogetherProvider extends OpenAIProvider {
  override name = 'together';
  readonly baseURL = 'https://api.together.xyz/v1';
  override maxContextWindow = 131072;

  constructor(apiKey?: string) {
    super(apiKey ?? process.env['TOGETHER_API_KEY'], 'https://api.together.xyz/v1');
  }

  override contextWindowFor(model: string): number {
    return TOGETHER_CONTEXT[model] ?? 32768;
  }
}
