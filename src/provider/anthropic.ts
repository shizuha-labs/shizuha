import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

const MODEL_CONTEXT: Record<string, number> = {
  'claude-opus-4-20250514': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-haiku-4-20250514': 200000,
};

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (typeof m.content === 'string') {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: m.toolCallId ?? '',
                content: m.content,
              },
            ],
          };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }

      // Content blocks
      const blocks = (m.content as ChatContentBlock[]).map((b) => {
        if (b.type === 'text') return b.text ? { type: 'text' as const, text: b.text } : null;
        if (b.type === 'tool_use')
          return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input };
        if (b.type === 'reasoning') {
          // Only roundtrip thinking blocks that have BOTH encrypted content AND a valid
          // signature. Cross-provider blocks (e.g., from Codex) lack signatures and would
          // be rejected by Anthropic's signature validation. Empty thinking is also rejected.
          if (!b.encryptedContent || !b.signature) return null;
          // Anthropic API does NOT accept `id` on thinking blocks in requests —
          // it only returns `id` in responses. Sending `id` causes:
          //   "thinking.id: Extra inputs are not permitted"
          return {
            type: 'thinking' as const,
            thinking: b.encryptedContent,
            signature: b.signature,
          };
        }
        if (b.type === 'tool_result') {
          // If tool result contains an image, send as image content block
          const hasImage = !!(b as any).image;
          if (hasImage) {
            const img = (b as any).image;
            return {
              type: 'tool_result' as const,
              tool_use_id: b.toolUseId,
              content: [
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    data: img.base64,
                    media_type: img.mediaType,
                  },
                },
              ],
              is_error: b.isError ?? false,
            };
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: b.toolUseId,
            content: b.content,
            is_error: b.isError ?? false,
          };
        }
        return null;
      }).filter(Boolean);

      return {
        role: m.role as 'user' | 'assistant',
        content: blocks as Anthropic.ContentBlockParam[],
      };
    });
}

/** Sentinel marker from prompt/builder.ts separating static vs dynamic system prompt sections */
const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * Build system prompt with cache_control breakpoints for Anthropic's prompt caching.
 * Splits on DYNAMIC_BOUNDARY_MARKER:
 *   - Static section (base prompt, role, instructions) → cache_control: { type: "ephemeral" }
 *   - Dynamic section (git, memory, tools) → cache_control: { type: "ephemeral" }
 * This allows the static portion to be cached across turns (global scope),
 * and the dynamic portion to be cached within a session.
 */
function buildSystemBlocks(system: string): Anthropic.TextBlockParam[] {
  const parts = system.split(DYNAMIC_BOUNDARY_MARKER);
  if (parts.length < 2) {
    // No marker — single block with caching
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  const staticPart = parts[0]!.trim();
  const dynamicPart = parts.slice(1).join(DYNAMIC_BOUNDARY_MARKER).trim();
  const blocks: Anthropic.TextBlockParam[] = [];
  if (staticPart) {
    blocks.push({ type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } });
  }
  if (dynamicPart) {
    blocks.push({ type: 'text', text: dynamicPart, cache_control: { type: 'ephemeral' } });
  }
  return blocks;
}

export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  supportsTools = true;
  supportsNativeWebSearch = true;
  maxContextWindow = 200000;
  private client: Anthropic;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      timeout: parseInt(process.env['API_TIMEOUT_MS'] || '600000', 10),
      maxRetries: 0, // We handle retries ourselves in the loop below
    });
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const systemRaw = options.systemPrompt ?? (typeof systemMsg?.content === 'string' ? systemMsg.content : undefined);
    const system = systemRaw ? buildSystemBlocks(systemRaw) : undefined;
    const anthropicMessages = toAnthropicMessages(messages);

    this.maxContextWindow = MODEL_CONTEXT[options.model] ?? 200000;

    const functionTools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    // Combine function tools with native web search server tool
    const allTools: Anthropic.ToolUnion[] = [
      ...(functionTools ?? []),
      { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 8 } as Anthropic.ToolUnion,
    ];

    const STREAM_TIMEOUT_MS = parseInt(process.env['API_TIMEOUT_MS'] || '300000', 10); // 5 min default
    const FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env['FIRST_TOKEN_TIMEOUT_MS'] || '60000', 10); // 60s
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 16000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // AbortController with inactivity timeout — prevents hanging if the API stalls
      const abortController = new AbortController();
      let activityTimer: ReturnType<typeof setTimeout> | null = null;
      let gotFirstEvent = false;

      const resetActivityTimer = () => {
        if (activityTimer) clearTimeout(activityTimer);
        const timeout = gotFirstEvent ? STREAM_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
        activityTimer = setTimeout(() => {
          const label = gotFirstEvent ? 'stream stalled' : 'no first event (connection may be hanging)';
          abortController.abort(new Error(`${label}: no events for ${Math.round(timeout / 1000)}s`));
        }, timeout);
      };

      try {
        resetActivityTimer();

        // Build extended thinking params if thinking is enabled
        const thinkingParams: Record<string, unknown> = {};
        if (options.thinkingLevel && options.thinkingLevel !== 'off') {
          const budgetMap: Record<string, number> = {
            on: 10000, low: 5000, medium: 16000, high: 32000,
          };
          const budget = budgetMap[options.thinkingLevel] ?? 10000;
          thinkingParams['thinking'] = { type: 'enabled', budget_tokens: budget };
          // Extended thinking requires temperature = 1 for Anthropic
          thinkingParams['temperature'] = 1;
        }

        const stream = this.client.messages.stream(
          {
            model: options.model,
            messages: anthropicMessages,
            max_tokens: options.maxTokens ?? 16384,
            ...(thinkingParams['temperature'] != null ? { temperature: thinkingParams['temperature'] as number } : { temperature: options.temperature ?? 0 }),
            ...(system ? { system } : {}),
            ...(allTools.length ? { tools: allTools } : {}),
            ...(options.stopSequences?.length ? { stop_sequences: options.stopSequences } : {}),
            ...(thinkingParams['thinking'] ? { thinking: thinkingParams['thinking'] } : {}),
          } as Anthropic.MessageStreamParams,
          { signal: abortController.signal },
        );

        const toolInputBuffers = new Map<string, string>();
        // Track block index → tool_use id for correct delta routing.
        // server_tool_use blocks (e.g. web_search) also send input_json_delta
        // but must NOT create phantom tool calls with empty IDs.
        const blockIndexToToolId = new Map<number, string>();
        let lastInputTokens = 0;
        let lastOutputTokens = 0;
        let rateLimitEmitted = false;

        for await (const event of stream) {
          // Extract rate limit headers from the underlying response (once)
          if (!rateLimitEmitted && options.onRateLimit) {
            try {
              const response = (stream as any).response;
              const headers = response?.headers;
              if (headers) {
                const limit = parseInt(headers.get?.('x-ratelimit-limit-requests') ?? headers['x-ratelimit-limit-requests'] ?? '', 10);
                const remaining = parseInt(headers.get?.('x-ratelimit-remaining-requests') ?? headers['x-ratelimit-remaining-requests'] ?? '', 10);
                if (!isNaN(limit) && !isNaN(remaining)) {
                  options.onRateLimit({ limit, remaining });
                  rateLimitEmitted = true;
                }
              }
            } catch { /* headers not accessible — skip */ }
          }
          gotFirstEvent = true;
          resetActivityTimer(); // Got an event — stream is alive
          const eventIndex = (event as any).index as number | undefined;
          if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              toolInputBuffers.set(block.id, '');
              if (eventIndex != null) blockIndexToToolId.set(eventIndex, block.id);
              yield { type: 'tool_use_start', id: block.id, name: block.name };
            } else if ((block as any).type === 'server_tool_use') {
              // Native web search started (server-side tool).
              // Do NOT register in toolInputBuffers — server tool input deltas
              // must be ignored to avoid creating phantom tool_use blocks.
              yield { type: 'web_search', status: 'searching' };
            } else if ((block as any).type === 'web_search_tool_result') {
              // Native web search completed
              yield { type: 'web_search', status: 'done' };
            } else if (block.type === 'thinking') {
              // Extended thinking block — will receive thinking_delta events
              // Emit as reasoning block for TUI
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string };
            if (delta.type === 'text_delta') {
              yield { type: 'text', text: delta.text ?? '' };
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              // Extended thinking content — emit as reasoning summary
              yield { type: 'reasoning', id: `thinking-${Date.now()}`, summary: [{ text: delta.thinking }] };
            } else if (delta.type === 'signature_delta') {
              // Signature for encrypted thinking — ignore for now
            } else if (delta.type === 'citations_delta') {
              // Citation events from native web search — silently skip
            } else if (delta.type === 'input_json_delta') {
              // Use the event index to find the correct tool_use id.
              // Skip if this delta belongs to a server tool (not in blockIndexToToolId).
              const toolId = eventIndex != null ? blockIndexToToolId.get(eventIndex) : undefined;
              if (toolId && toolInputBuffers.has(toolId)) {
                const partialJson = delta.partial_json ?? '';
                const prev = toolInputBuffers.get(toolId) ?? '';
                toolInputBuffers.set(toolId, prev + partialJson);
                yield { type: 'tool_use_delta', id: toolId, input: partialJson };
              }
            }
          } else if (event.type === 'content_block_stop') {
            // Finalize the tool_use block at this index (if it's a regular tool_use)
            const toolId = eventIndex != null ? blockIndexToToolId.get(eventIndex) : undefined;
            if (toolId && toolInputBuffers.has(toolId)) {
              const buffer = toolInputBuffers.get(toolId)!;
              const inputStr = buffer || '{}';
              try {
                const input = JSON.parse(inputStr) as Record<string, unknown>;
                yield { type: 'tool_use_end', id: toolId, input };
              } catch { /* incomplete JSON — should not happen at block stop */ }
              toolInputBuffers.delete(toolId);
              blockIndexToToolId.delete(eventIndex!);
            }
          } else if (event.type === 'message_start') {
            // Extract cache stats from initial message usage
            const msgUsage = (event as unknown as { message?: { usage?: {
              input_tokens?: number; output_tokens?: number;
              cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
            } } }).message?.usage;
            if (msgUsage) {
              lastInputTokens = msgUsage.input_tokens ?? 0;
              lastOutputTokens = msgUsage.output_tokens ?? 0;
              yield {
                type: 'usage',
                inputTokens: lastInputTokens,
                outputTokens: lastOutputTokens,
                cacheCreationInputTokens: msgUsage.cache_creation_input_tokens,
                cacheReadInputTokens: msgUsage.cache_read_input_tokens,
              };
            }
          } else if (event.type === 'message_delta') {
            const usage = (event as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
            if (usage) {
              lastInputTokens = usage.input_tokens ?? lastInputTokens;
              lastOutputTokens = usage.output_tokens ?? lastOutputTokens;
              yield {
                type: 'usage',
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              };
            }
          }
        }

        // Stream completed — emit final usage without awaiting finalMessage() (can deadlock)
        if (lastInputTokens > 0 || lastOutputTokens > 0) {
          yield { type: 'usage', inputTokens: lastInputTokens, outputTokens: lastOutputTokens };
        }
        yield { type: 'done' };
        return; // Success
      } catch (err) {
        // Stream stall → retryable
        if (abortController.signal.aborted) {
          logger.warn({ attempt: attempt + 1 }, `Anthropic stream stalled, retrying...`);
          if (attempt >= MAX_RETRIES) throw err;
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
          await sleep(delay + Math.random() * 0.25 * delay);
          continue;
        }
        // 429 / 5xx / network errors → retry
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        const isRetryable = status === 429 || (status != null && status >= 500) ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
        if (!isRetryable || attempt >= MAX_RETRIES) throw err;

        // Parse retry-after header for 429 responses
        let delay: number;
        const retryAfter = (err as { headers?: Record<string, string> }).headers?.['retry-after'];
        if (retryAfter && !isNaN(Number(retryAfter))) {
          delay = Number(retryAfter) * 1000;
        } else {
          delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        }
        logger.warn({ attempt: attempt + 1, delay, status, error: (err as Error).message }, 'Retrying Anthropic API call');
        await sleep(delay + Math.random() * 0.25 * delay);
      } finally {
        if (activityTimer) clearTimeout(activityTimer);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
