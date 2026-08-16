import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';

const MODEL_CONTEXT: Record<string, number> = {
  'gemini-2.5-pro': 1048576,
  'gemini-2.5-flash': 1048576,
  'gemini-2.0-flash': 1048576,
};

function toGoogleContents(messages: ChatMessage[]): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;

    const role = msg.role === 'assistant' ? 'model' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.role === 'tool') {
        contents.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: 'tool',
                response: { result: msg.content },
              },
            },
          ],
        });
      } else {
        contents.push({ role, parts: [{ text: msg.content }] });
      }
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];
    const parts: Part[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: { name: block.name, args: block.input },
        });
      } else if (block.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: 'tool',
            response: { result: block.content },
          },
        });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

export class GoogleProvider implements LLMProvider {
  name = 'google';
  supportsTools = true;
  maxContextWindow = 1048576;
  private genAI: GoogleGenerativeAI;

  constructor(apiKey?: string) {
    this.genAI = new GoogleGenerativeAI(apiKey ?? process.env['GOOGLE_API_KEY'] ?? '');
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.maxContextWindow = MODEL_CONTEXT[options.model] ?? 1048576;

    const model = this.genAI.getGenerativeModel({
      model: options.model,
      systemInstruction: options.systemPrompt,
    });

    const tools = options.tools?.length
      ? [
          {
            functionDeclarations: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : undefined;

    const contents = toGoogleContents(messages);
    const request = {
      contents,
      ...(tools ? { tools: tools as any } : {}),
      generationConfig: {
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxTokens ?? 16384,
        ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
      },
    };
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 32000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await model.generateContentStream(request as any);

        for await (const chunk of result.stream) {
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;

          for (const part of candidate.content?.parts ?? []) {
            if ('text' in part && part.text) {
              yield { type: 'text', text: part.text };
            }
            if ('functionCall' in part && part.functionCall) {
              const fc = part.functionCall;
              const id = `google_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              yield { type: 'tool_use_start', id, name: fc.name };
              yield { type: 'tool_use_end', id, input: (fc.args ?? {}) as Record<string, unknown> };
            }
          }

          // Usage
          if (chunk.usageMetadata) {
            yield {
              type: 'usage',
              inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
              outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            };
          }
        }

        yield { type: 'done' };
        return; // Success
      } catch (err) {
        const status = (err as { status?: number; httpErrorCode?: number }).status
          ?? (err as { httpErrorCode?: number }).httpErrorCode;
        const code = (err as { code?: string }).code;
        const isRetryable = status === 429 || (status != null && status >= 500) ||
          code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
        if (!isRetryable || attempt >= MAX_RETRIES) throw err;

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        const jitter = delay * (0.75 + Math.random() * 0.5);
        logger.warn({ attempt: attempt + 1, delay: Math.round(jitter), error: (err as Error).message }, 'Retrying Google API call');
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }
}
