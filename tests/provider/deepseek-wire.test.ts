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
  model: string = 'DeepSeek-V4-Flash',
): Promise<Record<string, unknown>> {
  let body = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'DeepSeek-V4-Flash', max_model_len: 262144 },
        { id: 'DeepSeek-V3', max_model_len: 131072 },
        { id: 'glm-5.2', max_model_len: 262144 },
      ] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const parts: Buffer[] = [];
      req.on('data', (chunk) => parts.push(Buffer.from(chunk)));
      req.on('end', () => {
        body = Buffer.concat(parts).toString('utf8');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({
          id: 'c1', object: 'chat.completion.chunk', created: 0, model,
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
      model,
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

// ── SCLI-696 (re-land of SCLI-584, beta#276 reference pins) ──────────────
import { toVLlmMessages } from '../../src/provider/vllm.js';
import type { ModelProfile } from '../../src/provider/model-profile.js';

function betaToolTurn(): ChatMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', rawContent: 'Let me think about this carefully.' },
      { type: 'text', text: 'I will call the tool.' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ],
  } as ChatMessage;
}

function betaPlainTurn(): ChatMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', rawContent: 'Hidden chain of thought.' },
      { type: 'text', text: 'Here is the answer.' },
    ],
  } as ChatMessage;
}

function betaToolOnlyTurn(): ChatMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', rawContent: 'Reasoning before the call.' },
      { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'pwd' } },
    ],
  } as ChatMessage;
}

describe('SCLI-584 toVLlmMessages passback pins (beta#276 re-land)', () => {
  it('keeps reasoning_content on a tool-call turn', () => {
    const out = toVLlmMessages([betaToolTurn()]);
    const assistant = out[0] as { reasoning_content?: string; tool_calls?: unknown[] };
    expect(assistant.reasoning_content).toBe('Let me think about this carefully.');
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it('drops reasoning_content on a plain turn (no tool_calls)', () => {
    const out = toVLlmMessages([betaPlainTurn()], undefined, {
      reasoningPassback: 'tool-call-turns',
    } as ModelProfile);
    const assistant = out[0] as { reasoning_content?: string };
    expect(assistant.reasoning_content).toBeUndefined();
    expect(out[0].content).toBe('Here is the answer.');
  });

  it('keeps reasoning on a tool-only turn and content is "" (never null)', () => {
    const out = toVLlmMessages([betaToolOnlyTurn()]);
    const assistant = out[0] as { reasoning_content?: string; tool_calls?: unknown[]; content: unknown };
    expect(assistant.reasoning_content).toBe('Reasoning before the call.');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.content).toBe('');
    expect(assistant.content).not.toBeNull();
  });

  it('does not attach reasoning_content when there is no reasoning block', () => {
    const out = toVLlmMessages([{ role: 'assistant', content: [{ type: 'text', text: 'plain' }] }] as ChatMessage[]);
    expect((out[0] as { reasoning_content?: string }).reasoning_content).toBeUndefined();
  });

  it('keeps user/system/tool message shapes unchanged', () => {
    const out = toVLlmMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'ok' }] },
    ] as ChatMessage[]);
    expect(out[0]).toEqual({ role: 'user', content: 'hello' });
    expect(out[1].role).toBe('assistant');
  });
});

describe('SCLI-696 top-level DeepSeek wire pins (request body)', () => {
  it('DeepSeek request carries top-level thinking:enabled + profile-default effort high', async () => {
    const body = await captureChat([{ role: 'user', content: 'hi' }]);
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('high');
  });

  it('reasoning_effort max passes through unmapped', async () => {
    const body = await captureChat([{ role: 'user', content: 'hi' }], { reasoningEffort: 'max' });
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('max');
  });

  it('low/medium effort maps up to high (DeepSeek only knows high|max)', async () => {
    const low = await captureChat([{ role: 'user', content: 'hi' }], { reasoningEffort: 'low' });
    expect(low['reasoning_effort']).toBe('high');
    const medium = await captureChat([{ role: 'user', content: 'hi' }], { reasoningEffort: 'medium' });
    expect(medium['reasoning_effort']).toBe('high');
  });

  it('non-thinking DeepSeek still declares thinking:disabled with no effort', async () => {
    const body = await captureChat([{ role: 'user', content: 'hi' }], { thinkingLevel: 'off' }, 'DeepSeek-V3');
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('non-DeepSeek models get NO top-level thinking/reasoning_effort (08-14 garble scope)', async () => {
    const body = await captureChat([{ role: 'user', content: 'hi' }], { thinkingLevel: 'on' }, 'glm-5.2');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});
