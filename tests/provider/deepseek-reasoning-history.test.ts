import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeTurn, messagesToChat } from '../../src/agent/turn.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';

const tools = [{
  name: 'read',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}];
const rawReasoning = ' \nTrace the exact boundary, then preserve it.\n\t';
const history: ChatMessage[] = [
  { role: 'user', content: 'Inspect the source.' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', id: 'first', rawContent: rawReasoning.slice(0, 14) },
      { type: 'reasoning', id: 'second', rawContent: rawReasoning.slice(14) },
      { type: 'text', text: 'The first check is complete.' },
    ],
  },
  { role: 'user', content: 'Continue.' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', id: 'tool-reasoning', rawContent: 'Read the next file.\n' },
      { type: 'tool_use', id: 'read-call', name: 'read', input: { path: 'source.ts' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'read-call', content: 'file contents' }] },
  { role: 'assistant', content: [{ type: 'reasoning', id: 'unfinished', rawContent: '\nStill analyzing… ' }] },
  { role: 'user', content: 'Finish the analysis.' },
];

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const chunk of stream) void chunk;
}

function mockRequests(model: string, firstTruncated = false): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ data: [{ id: model, max_model_len: 1048576 }] });
    }
    requests.push(JSON.parse(String(init?.body)));
    const deltas = firstTruncated && requests.length === 1
      ? [{ reasoning_content: rawReasoning.slice(0, 17) }, { reasoning_content: rawReasoning.slice(17) }]
      : [{ content: 'Complete.' }];
    const payload = deltas.map((delta) => `data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`).join('') + `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: firstTruncated && requests.length === 1 ? 'length' : 'stop' }],
    })}\n\ndata: [DONE]\n\n`;
    return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
  }));
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('DeepSeek request-aware reasoning history', () => {
  it.each([
    'DeepSeek-V4-Flash',
    'cortex/DeepSeek-V4-Flash-Vision-Metal',
    'vllm/DeepSeek-V4-Flash-MLX',
  ])('replays every assistant reasoning block when %s carries tools', async (model) => {
    const requests = mockRequests(model);
    const before = structuredClone(history);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    await collect(provider.chat(history, { model, tools }));
    const request = requests[0]!;
    expect(request.tools).toHaveLength(1);
    const assistants = (request.messages as Array<Record<string, unknown>>).filter((message) => message.role === 'assistant');
    expect(assistants.map((message) => message.reasoning_content)).toEqual([
      rawReasoning, 'Read the next file.\n', '\nStill analyzing… ',
    ]);
    expect(assistants[0]?.content).toBe('The first check is complete.');
    expect(assistants[1]?.tool_calls).toEqual([
      { id: 'read-call', type: 'function', function: { name: 'read', arguments: '{"path":"source.ts"}' } },
    ]);
    expect(history).toEqual(before);
  });

  it.each([undefined, []])('retains the existing tool-free wire contract with tools=%j', async (requestTools) => {
    const model = 'DeepSeek-V4-Flash';
    const requests = mockRequests(model);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    await collect(provider.chat(history, { model, tools: requestTools }));
    expect(requests[0]).not.toHaveProperty('tools');
    const assistants = (requests[0]!.messages as Array<Record<string, unknown>>).filter((message) => message.role === 'assistant');
    expect(assistants.map((message) => message.reasoning_content)).toEqual([
      undefined, 'Read the next file.\n', undefined,
    ]);
  });

  it('uses tools presence even when tool_choice prevents a new tool call', async () => {
    const model = 'DeepSeek-V4-Flash';
    const requests = mockRequests(model);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    await collect(provider.chat(history, { model, tools, toolChoice: 'none' }));
    expect(requests[0]!.tools).toHaveLength(1);
    expect((requests[0]!.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe(rawReasoning);
  });

  it('re-evaluates tool presence when the same provider resumes after a tool-free request', async () => {
    const model = 'DeepSeek-V4-Flash';
    const requests = mockRequests(model);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    for (const requestTools of [tools, undefined, tools]) {
      await collect(provider.chat(history, { model, tools: requestTools }));
    }
    expect(requests.map((request) => (request.messages as Array<Record<string, unknown>>)[1]?.reasoning_content)).toEqual([
      rawReasoning, undefined, rawReasoning,
    ]);
  });

  it.each([undefined, tools])('leaves GLM reasoning replay unchanged with tools=%j', async (requestTools) => {
    const model = 'GLM-5.3-Flash';
    const requests = mockRequests(model);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    await collect(provider.chat(history, { model, tools: requestTools }));
    const assistants = (requests[0]!.messages as Array<Record<string, unknown>>).filter((message) => message.role === 'assistant');
    expect(assistants.map((message) => message.reasoning_content)).toEqual([
      rawReasoning, 'Read the next file.\n', '\nStill analyzing… ',
    ]);
  });

  it.each(['vllm', 'cortex'])('round-trips an actual length-truncated %s turn into its next tool-enabled request', async (providerName) => {
    const model = 'DeepSeek-V4-Flash-Vision-Metal';
    const requests = mockRequests(model, true);
    const provider = new VLlmProvider('http://localhost:8081', 1048576);
    provider.name = providerName;
    const initial = { role: 'user' as const, content: 'Inspect the source.' };
    const registry = new ToolRegistry();
    const turn = await executeTurn(
      [initial], provider, model, '', tools, registry,
      new PermissionEngine('autonomous'), new AgentEventEmitter(),
      { cwd: '/tmp', sessionId: 'deepseek-history-roundtrip' }, 32768, 0,
    );
    expect(turn.stopReason).toBe('max_tokens');
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.toolResults).toHaveLength(0);
    expect(turn.assistantMessage.content).toEqual([
      expect.objectContaining({ type: 'reasoning', rawContent: rawReasoning }),
    ]);
    const options: ChatOptions = { model, tools, maxTokens: 32768 };
    await collect(provider.chat(messagesToChat([initial, turn.assistantMessage]), options));
    expect(requests).toHaveLength(2);
    expect((requests[1]!.messages as Array<Record<string, unknown>>).at(-1)).toEqual({
      role: 'assistant', content: '', reasoning_content: rawReasoning,
    });
    expect(requests[1]!.max_tokens).toBe(32768);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
  });
});
