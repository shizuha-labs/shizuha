/** Canonical model context windows used for compaction thresholds and status display. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic (native + Copilot/LiteLLM slugs)
  'claude-opus-4-20250514': 1000000,
  'claude-sonnet-4-20250514': 200000,
  'claude-haiku-4-20250514': 200000,
  'claude-opus-4.6': 1000000,
  'claude-opus-4.6-fast': 1000000,
  'claude-opus-4.5': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4.6': 200000,
  'claude-sonnet-4.5': 200000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4.5': 200000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-4-5-20251001': 200000,

  // OpenAI / Codex
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-4.1-nano': 1047576,
  'gpt-5': 272000,
  'gpt-5-codex': 272000,
  'gpt-5-codex-mini': 272000,
  'gpt-5.1': 272000,
  'gpt-5.1-codex': 272000,
  'gpt-5.1-codex-max': 272000,
  'gpt-5.1-codex-mini': 272000,
  'gpt-5.2': 272000,
  'gpt-5.2-codex': 272000,
  'gpt-5.3-codex': 272000,
  'gpt-5.3-codex-spark': 272000,
  'gpt-5.3-xhigh': 272000,
  'gpt-5.4': 272000,
  'codex-mini-latest': 192000,
  'o3-mini': 200000,
  'o4-mini': 200000,

  // Google
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,

  // DeepSeek
  'deepseek-chat': 65536,
  'deepseek-coder': 65536,
  'deepseek-reasoner': 65536,

  // Mistral
  'mistral-large-latest': 128000,
  'mistral-medium-latest': 128000,
  'mistral-small-latest': 128000,
  'codestral-latest': 256000,

  // xAI
  'grok-2': 131072,
  'grok-3': 131072,
  'grok-3-mini': 131072,
};

/** Resolve context window for a specific model, falling back to provider default when unknown. */
export function resolveModelContextWindow(model: string, providerFallback: number): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? providerFallback;
}
