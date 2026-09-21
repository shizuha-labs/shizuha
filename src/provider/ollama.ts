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

/**
 * SCLI-522: interactive soft-stall threshold for the no-header wait.
 *
 * 1ad759e83 pushed the vLLM lane's interactive threshold 30s -> 300s and
 * regressed SCLI-388's bounded no-header recovery; the ollama lane never had
 * the keepalive contract at all (QA reconfirmation 2026-09-14: all four
 * SCLI-522 acceptance criteria fail on this lane with the TUI-side fix code
 * present, because nothing on this wire path emits `request_wait`). Mirror the
 * vLLM lane's bounded semantics: 30s interactive, 60s non-interactive floor.
 */
export const DEFAULT_INTERACTIVE_SOFT_STALL_MS = 30_000;

function parseTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

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

    // SCLI-522: emit the same header-wait keepalive contract as the vLLM lane
    // (request_start + periodic request_wait with elapsedMs) so the TUI's
    // bounded soft-stall card and queue-paused composer fire on this lane too.
    // The previous bare `await fetch` left the TUI on a passive spinner for the
    // whole no-header wait — the keepalive generator existed only in the TUI
    // consumer, unreachable from this wire path.
    const interactiveTui = process.env['SHIZUHA_INTERACTIVE_TUI'] === '1';
    const softStallMs = parseTimeoutMs(
      'OLLAMA_SOFT_STALL_MS',
      interactiveTui ? DEFAULT_INTERACTIVE_SOFT_STALL_MS : 60_000,
    );
    const statusIntervalMs = parseTimeoutMs(
      'OLLAMA_REQUEST_STATUS_INTERVAL_MS',
      interactiveTui ? 5_000 : 15_000,
    );
    const requestStartedAt = Date.now();
    yield {
      type: 'status',
      level: 'info',
      provider: this.name,
      code: 'request_start',
      sessionId: options.sessionId,
      waitPhase: 'headers',
      elapsedMs: 0,
      message: 'Waiting for model response...',
    };

    let response: Response;
    try {
      const fetchResult = fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let settled = await Promise.race([
        fetchResult,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), statusIntervalMs)),
      ]);
      while (!settled) {
        const elapsedMs = Date.now() - requestStartedAt;
        const pastSoft = elapsedMs >= softStallMs;
        yield {
          type: 'status',
          level: pastSoft ? 'warning' : 'info',
          provider: this.name,
          code: 'request_wait',
          sessionId: options.sessionId,
          waitPhase: 'headers',
          elapsedMs,
          message: pastSoft
            ? `Waiting for model response (${Math.round(elapsedMs / 1000)}s) · Esc to cancel · /model to switch`
            : 'Waiting for model response...',
        };
        settled = await Promise.race([
          fetchResult,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), statusIntervalMs)),
        ]);
      }
      if ('error' in settled) throw settled.error;
      response = settled.value;
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
