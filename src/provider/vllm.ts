/**
 * vLLM provider — talks to a vLLM server via its OpenAI-compatible API.
 *
 * vLLM exposes POST /v1/chat/completions with SSE streaming.
 * This provider converts Shizuha messages to OpenAI format and streams back.
 *
 * Used for on-device inference on DGX Spark / GPU servers running quantized models
 * (e.g., Qwen3.5-122B-A10B-NVFP4, MiniMax M2.5).
 *
 * Env vars:
 *   VLLM_BASE_URL        — server URL (default: http://localhost:8000)
 *   VLLM_CONTEXT_WINDOW  — max context tokens (default: 131072)
 *   VLLM_API_KEY         — optional API key for authenticated vLLM servers
 */

import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

interface VLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface SSEChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: string | null;
}

interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: SSEChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function toVLlmMessages(messages: ChatMessage[], systemPrompt?: string): VLlmMessage[] {
  const result: VLlmMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as VLlmMessage['role'], content: msg.content });
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];

    if (msg.role === 'assistant') {
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      const vMsg: VLlmMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      };
      if (toolUses.length > 0) {
        vMsg.tool_calls = toolUses.map((tc) => ({
          id: (tc as { id: string }).id,
          type: 'function' as const,
          function: {
            name: (tc as { name: string }).name,
            arguments: JSON.stringify((tc as { input: Record<string, unknown> }).input),
          },
        }));
      }
      result.push(vMsg);
    } else if (msg.role === 'user') {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textParts = blocks.filter((b) => b.type === 'text');

      for (const tr of toolResults) {
        const r = tr as { toolUseId: string; content: string; isError?: boolean };
        result.push({ role: 'tool', content: r.content, tool_call_id: r.toolUseId });
      }
      if (textParts.length > 0) {
        result.push({
          role: 'user',
          content: textParts.map((b) => (b as { text: string }).text).join('\n'),
        });
      }
    } else {
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (text) result.push({ role: msg.role as VLlmMessage['role'], content: text });
    }
  }
  return result;
}

export class VLlmProvider implements LLMProvider {
  name = 'vllm';
  supportsTools = true;
  maxContextWindow: number;
  private baseUrl: string;
  private apiKey: string | undefined;
  /** Cached model name from /v1/models — avoids needing to know the served-model-name upfront. */
  private _servedModel: string | undefined;

  constructor(baseUrl?: string, contextWindow?: number, apiKey?: string) {
    this.baseUrl = (baseUrl ?? process.env['VLLM_BASE_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
    this.maxContextWindow = contextWindow
      ?? (process.env['VLLM_CONTEXT_WINDOW'] ? parseInt(process.env['VLLM_CONTEXT_WINDOW'], 10) : undefined)
      ?? 131072;
    this.apiKey = apiKey ?? process.env['VLLM_API_KEY'];
  }

  /** Discover the model name served by vLLM (caches on first call). */
  async getServedModel(): Promise<string | undefined> {
    if (this._servedModel) return this._servedModel;
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers });
      if (res.ok) {
        const json = (await res.json()) as { data: Array<{ id: string }> };
        if (json.data?.length) {
          this._servedModel = json.data[0]!.id;
          logger.debug(`vLLM: discovered served model: ${this._servedModel}`);
        }
      }
    } catch {
      // Server not reachable yet — will fail at chat() time with a better error
    }
    return this._servedModel;
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const vMessages = toVLlmMessages(messages, options.systemPrompt);

    const tools = options.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Use the model from options, falling back to auto-discovered served model
    let model = options.model;
    if (model.startsWith('vllm/')) model = model.slice(5);
    if (!model || model === 'vllm') {
      const served = await this.getServedModel();
      if (served) model = served;
    }

    const body: Record<string, unknown> = {
      model,
      messages: vMessages,
      stream: true,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 16384,
      // Request usage stats in the stream (vLLM extension)
      stream_options: { include_usage: true },
      // Disable thinking mode for Qwen3+ reasoning models — thinking wastes output tokens
      // and the reasoning_content field isn't consumed by the agent loop.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (tools?.length) body['tools'] = tools;
    if (options.stopSequences?.length) body['stop'] = options.stopSequences;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        throw new Error(
          `Cannot connect to vLLM at ${this.baseUrl}.\n` +
          `Ensure vLLM is running: docker compose up -d (or vllm serve <model>)`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`vLLM error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from vLLM');

    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;

    // Track streaming tool calls (may arrive across multiple SSE chunks)
    const toolCallBuilders = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // SSE format: "data: {...}" or "data: [DONE]"
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          // Flush any pending tool calls
          for (const [, tc] of toolCallBuilders) {
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
            yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
          }
          toolCallBuilders.clear();

          if (promptTokens || completionTokens) {
            yield { type: 'usage', inputTokens: promptTokens, outputTokens: completionTokens };
          }
          yield { type: 'done' };
          return;
        }

        let chunk: SSEChunk;
        try {
          chunk = JSON.parse(payload) as SSEChunk;
        } catch {
          continue;
        }

        // Usage info (from stream_options.include_usage or final chunk)
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }

        for (const choice of chunk.choices) {
          // Text content
          if (choice.delta.content) {
            yield { type: 'text', text: choice.delta.content };
          }

          // Tool calls (streamed incrementally)
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuilders.has(idx)) {
                const id = tc.id ?? `vllm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const name = tc.function?.name ?? '';
                toolCallBuilders.set(idx, { id, name, args: '' });
                if (name) {
                  yield { type: 'tool_use_start', id, name };
                }
              }
              const builder = toolCallBuilders.get(idx)!;
              if (tc.function?.arguments) {
                builder.args += tc.function.arguments;
                yield { type: 'tool_use_delta', id: builder.id, input: tc.function.arguments };
              }
            }
          }

          // Stop reason
          if (choice.finish_reason) {
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              for (const [, tc] of toolCallBuilders) {
                let parsedInput: Record<string, unknown> = {};
                try { parsedInput = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
                yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
              }
              toolCallBuilders.clear();
            }

            const reason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;
            yield { type: 'stop_reason', reason };
          }
        }
      }
    }

    // Stream ended without [DONE] — flush remaining
    for (const [, tc] of toolCallBuilders) {
      let parsedInput: Record<string, unknown> = {};
      try { parsedInput = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
      yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
    }

    if (promptTokens || completionTokens) {
      yield { type: 'usage', inputTokens: promptTokens, outputTokens: completionTokens };
    }
    yield { type: 'done' };
  }
}
