import { OpenAIProvider } from './openai.js';

/**
 * Groq provider — OpenAI-compatible Chat Completions at api.groq.com.
 *
 * Groq serves open models (Llama 3.x, Qwen, Gemma, DeepSeek-distill, etc.) at
 * very high throughput. It is OpenAI-compatible, but its open-model tool-calling
 * has quirks the strict OpenAI parser doesn't expect — see
 * {@link parseGroqToolArguments}. This class inherits OpenAIProvider's streaming
 * and overrides the endpoint, context table, and tool-argument parsing.
 */
const GROQ_CONTEXT: Record<string, number> = {
  'llama-3.3-70b-versatile': 131072,
  'llama-3.1-8b-instant': 131072,
  'llama-3.1-70b-versatile': 131072,
  'llama3-70b-8192': 8192,
  'llama3-8b-8192': 8192,
  'gemma2-9b-it': 8192,
  'qwen-2.5-32b': 131072,
  'qwen-2.5-coder-32b': 131072,
  'deepseek-r1-distill-llama-70b': 131072,
  'mixtral-8x7b-32768': 32768,
  'moonshotai/kimi-k2-instruct': 131072,
};

/**
 * Parse Groq tool-call `arguments` robustly. Groq's open models occasionally:
 *  - return an empty string for no-arg tools (→ {}),
 *  - wrap the JSON in a ```json … ``` markdown fence,
 *  - double-encode the args as a JSON string of a JSON object,
 *  - emit a non-object (array / scalar / null) where an object is expected.
 * Always returns a plain object; never throws.
 */
export function parseGroqToolArguments(raw: string): Record<string, unknown> {
  if (raw == null) return {};
  let s = String(raw).trim();
  if (!s) return {};

  // Strip a surrounding ```json … ``` / ``` … ``` code fence.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = (fence[1] ?? '').trim();
  if (!s) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return {};
  }

  // Double-encoded: arguments came through as a JSON string of a JSON object.
  if (typeof parsed === 'string') {
    const inner = parsed.trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        parsed = JSON.parse(inner);
      } catch {
        return {};
      }
    } else {
      return {};
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export class GroqProvider extends OpenAIProvider {
  override name = 'groq';
  readonly baseURL = 'https://api.groq.com/openai/v1';
  override maxContextWindow = 131072;

  constructor(apiKey?: string) {
    super(apiKey ?? process.env['GROQ_API_KEY'], 'https://api.groq.com/openai/v1');
  }

  override contextWindowFor(model: string): number {
    return GROQ_CONTEXT[model] ?? 131072;
  }

  protected override parseToolCallArguments(raw: string): Record<string, unknown> {
    return parseGroqToolArguments(raw);
  }
}
