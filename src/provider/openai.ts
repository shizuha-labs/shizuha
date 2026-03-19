import OpenAI from 'openai';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

const MODEL_CONTEXT: Record<string, number> = {
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
  'gpt-5.4': 272000,
  'codex-mini-latest': 192000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  // Claude models (accessed via LiteLLM proxy / GitHub Copilot)
  'claude-opus-4.6': 200000,
  'claude-opus-4.6-fast': 200000,
  'claude-opus-4.5': 200000,
  'claude-sonnet-4.6': 200000,
  'claude-sonnet-4.5': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4.5': 200000,
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
    if (msg.role === 'system') continue; // handled above

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

    // Content blocks
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
        const r = tr as { toolUseId: string; content: string; isError?: boolean; image?: { base64: string; mediaType: string } };
        if (r.image) {
          // GPT-4V / o-series vision: send image alongside text as multipart content
          result.push({
            role: 'tool',
            tool_call_id: r.toolUseId,
            content: [
              { type: 'text', text: r.content },
              { type: 'image_url', image_url: { url: `data:${r.image.mediaType};base64,${r.image.base64}` } },
            ] as any,
          });
        } else {
          result.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
        }
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

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  supportsTools = true;
  maxContextWindow = 128000;
  private client: OpenAI;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      maxRetries: 0, // We handle retries ourselves in the loop below
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

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 16000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Map thinking level to OpenAI reasoning_effort for o-series models
        const isReasoningModel = /^o[34]/.test(options.model);
        const reasoningParams: Record<string, unknown> = {};
        if (isReasoningModel && options.thinkingLevel && options.thinkingLevel !== 'off') {
          const effortMap: Record<string, string> = {
            on: 'medium', low: 'low', medium: 'medium', high: 'high',
          };
          reasoningParams['reasoning_effort'] = effortMap[options.thinkingLevel] ?? 'medium';
        }

        const stream = await this.client.chat.completions.create({
          model: options.model,
          messages: openaiMessages,
          max_tokens: options.maxTokens ?? 16384,
          temperature: options.temperature ?? 0,
          stream: true,
          ...(tools?.length ? { tools } : {}),
          ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
          ...reasoningParams,
        });

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let inputTokens = 0;
        let outputTokens = 0;
        let rateLimitEmitted = false;

        for await (const chunk of stream) {
          // Extract rate limit headers once
          if (!rateLimitEmitted && options.onRateLimit) {
            try {
              const response = (stream as any).response;
              const headers = response?.headers;
              if (headers) {
                const limit = parseInt(headers.get?.('x-ratelimit-limit-requests') ?? '', 10);
                const remaining = parseInt(headers.get?.('x-ratelimit-remaining-requests') ?? '', 10);
                if (!isNaN(limit) && !isNaN(remaining)) {
                  options.onRateLimit({ limit, remaining });
                  rateLimitEmitted = true;
                }
              }
            } catch { /* skip */ }
          }
          const choice = chunk.choices[0];
          if (!choice) continue;
          const delta = choice.delta;

          // Text content
          if (delta.content) {
            yield { type: 'text', text: delta.content };
          }

          // Tool calls
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

          // Usage
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }

          // Finish
          if (choice.finish_reason) {
            // Emit completed tool calls
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
        return; // Success
      } catch (err) {
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        const isRetryable = status === 429 || (status != null && status >= 500) ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
        if (!isRetryable || attempt >= MAX_RETRIES) throw err;

        // Parse retry-after header if available
        let delay: number;
        const retryAfter = (err as { headers?: Record<string, string> }).headers?.['retry-after'];
        if (retryAfter && !isNaN(Number(retryAfter))) {
          delay = Number(retryAfter) * 1000;
        } else {
          delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        }
        const jitter = delay * (0.75 + Math.random() * 0.5); // ±25% jitter
        logger.warn({ attempt: attempt + 1, delay: Math.round(jitter), status, code, error: (err as Error).message }, 'Retrying OpenAI API call');
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }
}


