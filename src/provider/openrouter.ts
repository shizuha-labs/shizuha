import OpenAI from 'openai';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * OpenRouter provider — routes to 200+ models via a single API key.
 *
 * OpenRouter is OpenAI-compatible but adds:
 * - X-Title / HTTP-Referer headers (for leaderboard + app credits)
 * - Provider routing preferences (provider.order, provider.allow_fallbacks)
 * - Model IDs in org/model format (e.g., anthropic/claude-3-opus)
 */

// Context windows for popular OpenRouter models.
// OpenRouter normalizes model names as org/model-name.
const MODEL_CONTEXT: Record<string, number> = {
  'anthropic/claude-opus-4-6':       200000,
  'anthropic/claude-sonnet-4-6':     200000,
  'anthropic/claude-haiku-4-5':      200000,
  'openai/gpt-4.1':                  1047576,
  'openai/gpt-4.1-mini':             1047576,
  'openai/gpt-4o':                   128000,
  'openai/o4-mini':                   200000,
  'google/gemini-2.5-pro':           1048576,
  'google/gemini-2.5-flash':         1048576,
  'deepseek/deepseek-chat':          128000,
  'deepseek/deepseek-reasoner':      128000,
  'meta-llama/llama-3.3-70b':        131072,
  'mistralai/mistral-large':         128000,
  'qwen/qwen3-coder':               131072,
};

function toOpenAIMessages(
  messages: ChatMessage[],
  systemPrompt?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content,
        });
      } else {
        result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];
    if (msg.role === 'assistant') {
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: (b as { id: string }).id,
          type: 'function' as const,
          function: {
            name: (b as { name: string }).name,
            arguments: JSON.stringify((b as { input: unknown }).input),
          },
        }));

      result.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === 'user') {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      for (const tr of toolResults) {
        const r = tr as { toolUseId: string; content: string; isError?: boolean };
        result.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
      }
      const textParts = blocks.filter((b) => b.type === 'text');
      if (textParts.length) {
        result.push({
          role: 'user',
          content: textParts.map((b) => (b as { text: string }).text).join('\n'),
        });
      }
    }
  }

  return result;
}

export class OpenRouterProvider implements LLMProvider {
  name = 'openrouter';
  supportsTools = true;
  maxContextWindow = 128000;
  private client: OpenAI;

  constructor(apiKey?: string, appName?: string, siteUrl?: string) {
    const key = apiKey ?? process.env['OPENROUTER_API_KEY'];
    if (!key) throw new Error('OPENROUTER_API_KEY not set');

    this.client = new OpenAI({
      apiKey: key,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // OpenRouter uses these for leaderboard ranking and app analytics.
        'X-Title': appName ?? 'Shizuha',
        'HTTP-Referer': siteUrl ?? 'https://shizuha.com',
      },
    });
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.maxContextWindow = MODEL_CONTEXT[options.model] ?? 128000;

    const openaiMessages = toOpenAIMessages(messages, options.systemPrompt);
    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 32000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = await this.client.chat.completions.create({
          model: options.model,
          messages: openaiMessages,
          max_tokens: options.maxTokens ?? 16384,
          temperature: options.temperature ?? 0,
          stream: true,
          ...(tools?.length ? { tools } : {}),
          ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
        });

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let inputTokens = 0;
        let outputTokens = 0;

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          const delta = choice.delta;

          if (delta.content) {
            yield { type: 'text', text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (tc.id) {
                toolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
                yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' };
              }
              if (tc.function?.arguments) {
                const existing = toolCalls.get(idx);
                if (existing) {
                  existing.args += tc.function.arguments;
                  yield { type: 'tool_use_delta', id: existing.id, input: tc.function.arguments };
                }
              }
            }
          }

          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }

          if (choice.finish_reason) {
            for (const [, tc] of toolCalls) {
              try {
                const input = JSON.parse(tc.args || '{}') as Record<string, unknown>;
                yield { type: 'tool_use_end', id: tc.id, input };
              } catch {
                yield { type: 'tool_use_end', id: tc.id, input: {} };
              }
            }
          }
        }

        if (inputTokens || outputTokens) {
          yield { type: 'usage', inputTokens, outputTokens };
        }
        yield { type: 'done' };
        return;
      } catch (err) {
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        const isRetryable = status === 429 || (status != null && status >= 500) ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
        if (!isRetryable || attempt >= MAX_RETRIES) throw err;

        let delay: number;
        const retryAfter = (err as { headers?: Record<string, string> }).headers?.['retry-after'];
        if (retryAfter && !isNaN(Number(retryAfter))) {
          delay = Number(retryAfter) * 1000;
        } else {
          delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        }
        const jitter = delay * (0.75 + Math.random() * 0.5);
        logger.warn({ attempt: attempt + 1, delay: Math.round(jitter), status, code, error: (err as Error).message }, 'Retrying OpenRouter API call');
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }
}
