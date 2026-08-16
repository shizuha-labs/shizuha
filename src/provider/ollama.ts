import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

/** Model-specific context window sizes (tokens). Ollama defaults to 2048 without num_ctx. */
const MODEL_CONTEXT: Record<string, number> = {
  'qwen3-coder-next': 262144,  // 256K
  'qwen3-coder': 262144,
  'qwen3.5': 262144,           // 256K (MoE, 35B/3B active)
  'llama3.1': 128000,
  'deepseek-coder-v2': 128000,
  'codestral': 32000,
};

const DEFAULT_CONTEXT = 128000;

/** Look up context window for a model, checking base name (before ':' tag). */
function getModelContext(model: string): number {
  if (MODEL_CONTEXT[model]) return MODEL_CONTEXT[model]!;
  const baseName = model.split(':')[0]!;
  return MODEL_CONTEXT[baseName] ?? DEFAULT_CONTEXT;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaStreamChunk {
  message?: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

function toOllamaMessages(messages: ChatMessage[], systemPrompt?: string): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as OllamaChatMessage['role'], content: msg.content });
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];

    if (msg.role === 'assistant') {
      // Extract text and tool calls from assistant message
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      const ollamaMsg: OllamaChatMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      };
      if (toolUses.length > 0) {
        ollamaMsg.tool_calls = toolUses.map((tc) => ({
          function: {
            name: (tc as { name: string }).name,
            arguments: (tc as { input: Record<string, unknown> }).input,
          },
        }));
      }
      result.push(ollamaMsg);
    } else if (msg.role === 'user') {
      // Handle tool_result blocks → Ollama 'tool' role messages
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textParts = blocks.filter((b) => b.type === 'text');

      for (const tr of toolResults) {
        const r = tr as { toolUseId: string; content: string; isError?: boolean };
        result.push({ role: 'tool', content: r.content });
      }
      if (textParts.length > 0) {
        result.push({
          role: 'user',
          content: textParts.map((b) => (b as { text: string }).text).join('\n'),
        });
      }
    } else {
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (text) result.push({ role: msg.role as OllamaChatMessage['role'], content: text });
    }
  }
  return result;
}

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  supportsTools = true;
  maxContextWindow = 262144;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const ollamaMessages = toOllamaMessages(messages, options.systemPrompt);

    const tools = options.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const numCtx = getModelContext(options.model);
    const body: Record<string, unknown> = {
      model: options.model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.maxTokens ?? 16384,
        num_ctx: numCtx,
      },
    };
    if (tools?.length) body['tools'] = tools;
    if (options.stopSequences?.length) {
      (body['options'] as Record<string, unknown>)['stop'] = options.stopSequences;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        throw new Error(
          `Cannot connect to Ollama at ${this.baseUrl}.\n` +
          `Either install Ollama (https://ollama.com) and run: ollama pull ${options.model}\n` +
          `Or set a cloud API key: export ANTHROPIC_API_KEY=sk-ant-...`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: OllamaStreamChunk;
        try {
          chunk = JSON.parse(line) as OllamaStreamChunk;
        } catch {
          continue;
        }

        if (chunk.message?.content) {
          yield { type: 'text', text: chunk.message.content };
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const id = `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            yield { type: 'tool_use_start', id, name: tc.function.name };
            yield { type: 'tool_use_end', id, input: tc.function.arguments };
          }
        }

        if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) completionTokens = chunk.eval_count;

        if (chunk.done) {
          if (promptTokens || completionTokens) {
            yield { type: 'usage', inputTokens: promptTokens, outputTokens: completionTokens };
          }
          yield { type: 'done' };
          return;
        }
      }
    }

    yield { type: 'done' };
  }
}
