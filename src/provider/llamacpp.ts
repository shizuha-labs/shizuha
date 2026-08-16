/**
 * LlamaCpp provider — talks to a local llama-server via its OpenAI-compatible API.
 *
 * llama-server exposes POST /v1/chat/completions with SSE streaming.
 * This provider converts Shizuha messages to OpenAI format and streams back.
 *
 * Used for on-device inference on Android (Qwen, Llama, etc. via GGUF models).
 */

import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';

interface LlamaCppMessage {
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

function toLlamaCppMessages(messages: ChatMessage[], systemPrompt?: string): LlamaCppMessage[] {
  const result: LlamaCppMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as LlamaCppMessage['role'], content: msg.content });
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];

    if (msg.role === 'assistant') {
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      const lmMsg: LlamaCppMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      };
      if (toolUses.length > 0) {
        lmMsg.tool_calls = toolUses.map((tc) => ({
          id: (tc as { id: string }).id,
          type: 'function' as const,
          function: {
            name: (tc as { name: string }).name,
            arguments: JSON.stringify((tc as { input: Record<string, unknown> }).input),
          },
        }));
      }
      result.push(lmMsg);
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
      if (text) result.push({ role: msg.role as LlamaCppMessage['role'], content: text });
    }
  }
  return result;
}

export class LlamaCppProvider implements LLMProvider {
  name = 'llamacpp';
  supportsTools = true;
  maxContextWindow: number;
  private baseUrl: string;

  constructor(baseUrl?: string, contextWindow?: number) {
    this.baseUrl = baseUrl ?? process.env['LLAMACPP_BASE_URL'] ?? 'http://127.0.0.1:8086';
    this.maxContextWindow = contextWindow
      ?? (process.env['LLAMACPP_CONTEXT_WINDOW'] ? parseInt(process.env['LLAMACPP_CONTEXT_WINDOW'], 10) : undefined)
      ?? 32768;
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const lmMessages = toLlamaCppMessages(messages, options.systemPrompt);

    const tools = options.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const body: Record<string, unknown> = {
      model: options.model,
      messages: lmMessages,
      stream: true,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 4096,
      // Disable thinking mode for Qwen3+ models — thinking wastes output tokens
      // and the reasoning_content field isn't used by the agent loop.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (tools?.length) body['tools'] = tools;
    if (options.stopSequences?.length) body['stop'] = options.stopSequences;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        throw new Error(
          `Cannot connect to llama-server at ${this.baseUrl}.\n` +
          `Ensure llama-server is running with a loaded model.`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`llama-server error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from llama-server');

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

        // Usage info (may appear in the last chunk)
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
                const id = tc.id ?? `lc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
            // Flush tool calls on finish
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
