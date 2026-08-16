import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';
import {
  officialThinkingWire,
  shouldPassBackReasoning,
} from '../../src/provider/deepseek-wire.js';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function captureChat(
  messages: ChatMessage[],
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let body = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 262144 }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const parts: Buffer[] = [];
      req.on('data', (chunk) => parts.push(Buffer.from(chunk)));
      req.on('end', () => {
        body = Buffer.concat(parts).toString('utf8');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({
          id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'DeepSeek-V4-Flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 262144);
    await collect(provider.chat(messages, {
      model: 'DeepSeek-V4-Flash',
      maxTokens: 16,
      thinkingLevel: 'on',
      ...extra,
    }));
    return JSON.parse(body) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

afterEach(() => {
  delete process.env['VLLM_REASONING_EFFORT'];
});

describe('official DeepSeek wire helpers', () => {
  it('replays reasoning only on tool-call turns', () => {
    expect(shouldPassBackReasoning('tool-call-turns', false)).toBe(false);
    expect(shouldPassBackReasoning('tool-call-turns', true)).toBe(true);
    expect(shouldPassBackReasoning('always', false)).toBe(true);
    expect(shouldPassBackReasoning(undefined, false)).toBe(true);
  });

  it('never sends reasoning_effort off', () => {
    expect(officialThinkingWire({ thinkingEnabled: false, effort: 'high' }))
      .toEqual({ thinking: { type: 'disabled' } });
    expect(officialThinkingWire({ thinkingEnabled: true, effort: 'off' }))
      .toEqual({ thinking: { type: 'enabled' } });
    expect(officialThinkingWire({ thinkingEnabled: true, effort: 'high' }))
      .toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });
});

describe('SCLI-584 DeepSeek reasoning passback', () => {
  it('drops reasoning_content on a tool-call-free assistant turn', async () => {
    const body = await captureChat([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'r1', rawContent: 'Let me check the file first.' },
          { type: 'text', text: 'Done.' },
        ],
      },
      { role: 'user', content: 'next' },
    ]);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const prior = messages.find((m) => m.role === 'assistant');
    expect(prior?.content).toBe('Done.');
    expect(prior).not.toHaveProperty('reasoning_content');
  });

  it('keeps reasoning_content on a tool-call assistant turn', async () => {
    const body = await captureChat([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'r1', rawContent: 'Need to read the file.' },
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }],
      },
    ]);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const prior = messages.find((m) => m.role === 'assistant');
    expect(prior?.reasoning_content).toBe('Need to read the file.');
    expect(prior?.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
    ]);
  });
});
