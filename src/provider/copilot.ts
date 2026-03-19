/**
 * GitHub Copilot Provider — access Claude models via GitHub Copilot Pro+ subscription.
 *
 * Flow:
 *  1. User provides a GitHub PAT (with Copilot scope)
 *  2. PAT is exchanged for a short-lived Copilot API token (~30 min)
 *  3. Copilot token calls https://api.githubcopilot.com/chat/completions
 *     (OpenAI-compatible format)
 *
 * Supported models (Copilot dot-notation):
 *   claude-opus-4.6, claude-sonnet-4.6, claude-sonnet-4.5, claude-haiku-4.5
 */

import OpenAI from 'openai';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_API_BASE = 'https://api.githubcopilot.com';

const MODEL_CONTEXT: Record<string, number> = {
  'claude-opus-4.6': 200000,
  'claude-opus-4.6-fast': 200000,
  'claude-opus-4.5': 200000,
  'claude-sonnet-4.6': 200000,
  'claude-sonnet-4.5': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4.5': 200000,
  'gpt-4o': 128000,
  'gpt-4.1': 1047576,
  'o4-mini': 200000,
};

// Buffer: refresh 2 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

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
        const r = tr as { toolUseId: string; content: string; isError?: boolean; image?: { base64: string; mediaType: string } };
        if (r.image) {
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

export class CopilotProvider implements LLMProvider {
  name = 'copilot';
  supportsTools = true;
  maxContextWindow = 200000;

  private githubToken: string;
  private copilotToken: string | null = null;
  private copilotTokenExpiresAt = 0;  // Unix ms
  private client: OpenAI | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(githubToken: string) {
    this.githubToken = githubToken;
  }

  /** Exchange GitHub PAT for a short-lived Copilot API token. */
  private async refreshCopilotToken(): Promise<void> {
    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const res = await fetch(COPILOT_TOKEN_URL, {
          headers: {
            'Authorization': `token ${this.githubToken}`,
            'Accept': 'application/json',
            'User-Agent': 'shizuha/0.1.0',
          },
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `GitHub Copilot token exchange failed (${res.status}): ${body}\n` +
            `Ensure your GitHub PAT has Copilot access and you have a Copilot Pro+ subscription.`,
          );
        }

        const data = await res.json() as { token: string; expires_at: number };
        this.copilotToken = data.token;
        // expires_at is Unix timestamp in seconds
        this.copilotTokenExpiresAt = data.expires_at * 1000;

        // Create/update the OpenAI client with the new token
        this.client = new OpenAI({
          apiKey: this.copilotToken,
          baseURL: COPILOT_API_BASE,
          maxRetries: 0,
          defaultHeaders: {
            'Copilot-Integration-Id': 'vscode-chat',
            'Editor-Version': 'vscode/1.100.0',
            'Editor-Plugin-Version': 'copilot/1.300.0',
          },
        });

        const expiresInMin = Math.round((this.copilotTokenExpiresAt - Date.now()) / 60000);
        logger.info({ expiresInMin }, 'GitHub Copilot token acquired');
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /** Ensure we have a valid, non-expired Copilot token. */
  private async ensureToken(): Promise<OpenAI> {
    const now = Date.now();
    if (!this.copilotToken || !this.client || now >= this.copilotTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      await this.refreshCopilotToken();
    }
    return this.client!;
  }

  /** Test the connection — exchange token and verify it works. */
  async testConnection(): Promise<{ ok: boolean; expiresAt?: number; error?: string }> {
    try {
      await this.refreshCopilotToken();
      return { ok: true, expiresAt: this.copilotTokenExpiresAt };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.maxContextWindow = MODEL_CONTEXT[options.model] ?? 200000;

    const client = await this.ensureToken();

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
        const stream = await client.chat.completions.create({
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

        // If 401, try refreshing the Copilot token
        if (status === 401 && attempt < MAX_RETRIES) {
          logger.warn({ attempt: attempt + 1 }, 'Copilot token expired, refreshing');
          this.copilotToken = null;
          try {
            await this.refreshCopilotToken();
          } catch {
            throw err;
          }
          continue;
        }

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
        logger.warn({ attempt: attempt + 1, delay: Math.round(jitter), status, code, error: (err as Error).message }, 'Retrying Copilot API call');
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }
}
