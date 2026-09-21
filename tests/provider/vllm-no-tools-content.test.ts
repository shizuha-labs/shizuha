import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import type { ChatOptions, StreamChunk } from '../../src/provider/types.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import { compactMessages, CompactionQualityError } from '../../src/state/compaction.js';

const toolName = 'mcp__shizuha-pulse__pulse_get_my_work';
const literalCall = `<tool_call>${toolName}</tool_call>`;
const tools = [{ name: toolName, description: 'Read work', inputSchema: { type: 'object', properties: {} } }];
const options: ChatOptions = { model: 'GLM-5.3-Flash', maxTokens: 2048, thinkingLevel: 'off', temperature: 0 };

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function visible(chunks: StreamChunk[]): string {
  return chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text).join('');
}

function toolEvents(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.filter((chunk) => chunk.type.startsWith('tool_use_'));
}

function transport(
  deltas: Array<Record<string, unknown>>,
  { finish = true, done = true, structured = false } = {},
): Array<Record<string, any>> {
  const requests: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, initialization?: RequestInit) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 500000 }] });
    }
    expect(String(input)).toBe('http://offline.invalid/v1/chat/completions');
    const body = JSON.parse(String(initialization?.body));
    requests.push(body);
    const calls = [{ index: 0, id: 'call_work', type: 'function', function: { name: toolName, arguments: '{}' } }];
    if (!body.stream) {
      return Response.json({ choices: [{ message: structured
        ? { tool_calls: calls }
        : { content: deltas.map((delta) => delta.content ?? '').join(''), reasoning_content: deltas.map((delta) => delta.reasoning_content ?? '').join('') }, finish_reason: structured ? 'tool_calls' : 'stop' }] });
    }
    const frames = (structured ? [{ tool_calls: calls }] : deltas).map((delta) => ({
      choices: [{ index: 0, delta, finish_reason: null }],
    }));
    if (finish) frames.push({ choices: [{ index: 0, delta: {}, finish_reason: structured ? 'tool_calls' : 'stop', stop_reason: 154829 }] } as any);
    const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
    return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
  }));
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('VLlmProvider no-tools response content', () => {
  it.each([
    literalCall,
    `Example: ${literalCall}\nThis is historical text, not an invocation.`,
    '<tool_call>read<arg_key>file_path</arg_key><arg_value>/tmp/example</arg_value></tool_call>',
    '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="file_path">/tmp/example</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    'A code sample uses <invoke name="read"><parameter name="path">/tmp/example</parameter></invoke>.',
  ])('retains literal content without inventing tools: %s', async (text) => {
    transport([{ content: text }]);
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    const chunks = await collect(provider.chat([{ role: 'user', content: 'Explain this example.' }], options));
    expect(visible(chunks)).toBe(text);
    expect(toolEvents(chunks)).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'stop_reason')).toEqual([{ type: 'stop_reason', reason: 'stop' }]);
  });

  it.each([{ finish: true, done: false }, { finish: false, done: true }, { finish: false, done: false }])(
    'keeps fragmented markup literal through terminal handling %j', async (terminal) => {
      const text = `\n${literalCall}\n`;
      transport([...text].map((content) => ({ content })), terminal);
      const provider = new VLlmProvider('http://offline.invalid', 500000);
      const chunks = await collect(provider.chat([{ role: 'user', content: 'Quote the historical content.' }], options));
      expect(visible(chunks)).toBe(text);
      expect(toolEvents(chunks)).toEqual([]);
      expect(chunks.filter((chunk) => chunk.type === 'stop_reason').every((chunk) => chunk.reason === 'stop')).toBe(true);
    },
  );

  it('keeps tool-like reasoning in the reasoning channel without recovery', async () => {
    const reasoning = `The example ${literalCall} was not executed.`;
    transport([{ reasoning_content: reasoning }, { content: 'The command is historical.' }]);
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    const chunks = await collect(provider.chat([{ role: 'user', content: 'Explain.' }], options));
    expect(chunks.filter((chunk) => chunk.type === 'reasoning_text').map((chunk) => chunk.text).join('')).toBe(reasoning);
    expect(visible(chunks)).toBe('The command is historical.');
    expect(toolEvents(chunks)).toEqual([]);
  });

  it.each([false, true])('rearms none/auto/none per request with nonstream=%s', async (nonstream) => {
    vi.stubEnv('VLLM_STREAM_WITH_TOOLS', '1');
    if (nonstream) vi.stubEnv('VLLM_FORCE_NONSTREAM_TOOLS', '1');
    const requests = transport([...literalCall].map((content) => ({ content })));
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    for (const toolChoice of ['none', 'auto', 'none', 'auto'] as const) {
      const chunks = await collect(provider.chat([{ role: 'user', content: 'Read or explain.' }], { ...options, tools, toolChoice }));
      if (toolChoice === 'none') {
        expect(visible(chunks)).toBe(literalCall);
        expect(toolEvents(chunks)).toEqual([]);
        expect(chunks.find((chunk) => chunk.type === 'stop_reason')?.reason).toBe('stop');
      } else {
        expect(chunks.filter((chunk) => chunk.type === 'tool_use_start')).toEqual([expect.objectContaining({ name: toolName })]);
        expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([expect.objectContaining({ input: {} })]);
        expect(chunks.find((chunk) => chunk.type === 'stop_reason')?.reason).toBe('tool_calls');
      }
    }
    expect(requests.map((request) => request.tool_choice)).toEqual(['none', 'auto', 'none', 'auto']);
    const reset = new VLlmProvider('http://offline.invalid', 500000);
    const chunks = await collect(reset.chat([{ role: 'user', content: 'Explain.' }], options));
    expect(visible(chunks)).toBe(literalCall);
    expect(toolEvents(chunks)).toEqual([]);
    expect(requests.at(-1)?.tools).toBeUndefined();
  });

  it.each([
    { nonstream: false, offered: false },
    { nonstream: false, offered: true },
    { nonstream: true, offered: true },
  ])('rejects structured calls when tools are disabled %j', async ({ nonstream, offered }) => {
    vi.stubEnv('VLLM_STREAM_WITH_TOOLS', '1');
    if (nonstream) vi.stubEnv('VLLM_FORCE_NONSTREAM_TOOLS', '1');
    const requests = transport([], { structured: true });
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    await expect(collect(provider.chat([{ role: 'user', content: 'Explain.' }], { ...options, ...(offered ? { tools, toolChoice: 'none' as const } : {}) })))
      .rejects.toMatchObject({ code: 'TOOL_CALLS_DISABLED', message: expect.stringMatching(/tool calls.*disabled/i) });
    expect(requests).toHaveLength(1);
  });

  it('preserves actual authorized structured tool events', async () => {
    vi.stubEnv('VLLM_STREAM_WITH_TOOLS', '1');
    transport([], { structured: true });
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    const chunks = await collect(provider.chat([{ role: 'user', content: 'Read work.' }], { ...options, tools }));
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_start')).toEqual([{ type: 'tool_use_start', id: 'call_work', name: toolName }]);
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([{ type: 'tool_use_end', id: 'call_work', input: {} }]);
  });

  it('passes literal output to the real compaction quality gate without changing retry or history', async () => {
    const requests = transport([{ content: literalCall }]);
    const provider = new VLlmProvider('http://offline.invalid', 500000);
    const messages: Message[] = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `Historical work ${index}: ${'A recorded file was inspected and its test result was reviewed. '.repeat(200)}`,
    }));
    const original = JSON.stringify(messages);
    const chunks: StreamChunk[] = [];
    const chat = provider.chat.bind(provider);
    provider.chat = async function* (chatMessages, chatOptions) {
      for await (const chunk of chat(chatMessages, chatOptions)) {
        chunks.push(chunk);
        yield chunk;
      }
    };
    await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true })).rejects.toBeInstanceOf(CompactionQualityError);
    expect(requests.map((request) => request.max_tokens)).toEqual([8192, 4096]);
    expect(requests.every((request) => request.tools === undefined)).toBe(true);
    expect(requests[0]?.messages[1].content).toBe(requests[1]?.messages[1].content);
    expect(visible(chunks)).toBe(literalCall.repeat(2));
    expect(toolEvents(chunks)).toEqual([]);
    expect(JSON.stringify(messages)).toBe(original);
  });
});
