import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeTurn, messagesToChat } from '../../src/agent/turn.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { extractGlmToolCalls, VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';

const toolName = 'mcp__shizuha-pulse__pulse_add_comment';
const argumentsValue = { task_id: 'PLAT-8712', content: 'Verified the blocker link.' };
const malformedCall = `<tool_call>${toolName}<arg_key>task_id</arg_key>PLAT-8712</arg_value><arg_key>content</arg_key><arg_value>Verified the blocker link.</arg_value></tool_call>`;

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function mockStream(deltas: Array<Record<string, unknown>>): void {
  const payload = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
    + 'data: [DONE]\n\n';
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 500000 }] });
    }
    return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
  }));
}

const messages: ChatMessage[] = [{ role: 'user', content: 'Record the verified result.' }];
const options = {
  model: 'GLM-5.3-Flash',
  tools: [{
    name: toolName,
    description: 'Add a task comment',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, content: { type: 'string' } },
      required: ['task_id', 'content'],
    },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GLM argument recovery at the provider boundary', () => {
  it('preserves a delimited value when only its opening arg_value tag is missing', () => {
    expect(extractGlmToolCalls(malformedCall).calls).toEqual([{ name: toolName, args: argumentsValue }]);
  });

  it('requires the closing value delimiter and never consumes the next argument as its key', () => {
    const incompleteCall = `<tool_call>${toolName}<arg_key>task_id</arg_key>incomplete<arg_key>content</arg_key><arg_value>Completed value.</arg_value></tool_call>`;
    expect(extractGlmToolCalls(incompleteCall).calls).toEqual([
      { name: toolName, args: { content: 'Completed value.' } },
    ]);
  });

  it('preserves typed values and real zero-argument calls', () => {
    const nativeCall = '<tool_call>check<arg_key>count</arg_key>3</arg_value><arg_key>enabled</arg_key>false</arg_value><arg_key>items</arg_key>["a","b"]</arg_value></tool_call>';
    expect(extractGlmToolCalls(nativeCall).calls).toEqual([
      { name: 'check', args: { count: 3, enabled: false, items: ['a', 'b'] } },
    ]);
    expect(extractGlmToolCalls('<tool_call>check</tool_call>').calls).toEqual([
      { name: 'check', args: {} },
    ]);
  });

  it.each([
    ['content', '{}'],
    ['reasoning_content', '{}'],
    ['content', ''],
    ['content', 'null'],
    ['content', '{"task_id":'],
  ])('recovers arguments from streamed %s with server arguments %j', async (field, argumentsText) => {
    mockStream([
      { [field]: malformedCall },
      { tool_calls: [{ index: 0, id: 'call_comment', type: 'function', function: { name: toolName, arguments: argumentsText } }] },
    ]);
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const chunks = await collect(provider.chat(messages, options));
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_start')).toEqual([
      { type: 'tool_use_start', id: 'call_comment', name: toolName },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([
      { type: 'tool_use_end', id: 'call_comment', input: argumentsValue },
    ]);
  });

  it('keeps complete server arguments authoritative', async () => {
    mockStream([
      { content: malformedCall },
      { tool_calls: [{ index: 0, id: 'call_comment', function: { name: toolName, arguments: JSON.stringify({ task_id: 'PLAT-9000', content: 'Server result.' }) } }] },
    ]);
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const chunks = await collect(provider.chat(messages, options));
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([
      { type: 'tool_use_end', id: 'call_comment', input: { task_id: 'PLAT-9000', content: 'Server result.' } },
    ]);
  });

  it('does not borrow arguments from an unrelated tool', async () => {
    mockStream([
      { content: malformedCall.replace(toolName, 'mcp__shizuha-pulse__pulse_update_task') },
      { tool_calls: [{ index: 0, id: 'call_comment', function: { name: toolName, arguments: '{}' } }] },
    ]);
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const chunks = await collect(provider.chat(messages, options));
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([
      { type: 'tool_use_end', id: 'call_comment', input: {} },
    ]);
  });

  it('consumes matching recovery calls once and keeps repeated tool calls distinct', async () => {
    const secondArgs = { task_id: 'PLAT-9000', content: 'Second result.' };
    mockStream([
      { content: malformedCall + malformedCall.replace('PLAT-8712', secondArgs.task_id).replace(argumentsValue.content, secondArgs.content) },
      { tool_calls: [
        { index: 0, id: 'call_first', function: { name: toolName, arguments: JSON.stringify(argumentsValue) } },
        { index: 1, id: 'call_second', function: { name: toolName, arguments: '{}' } },
      ] },
    ]);
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const chunks = await collect(provider.chat(messages, options));
    expect(chunks.filter((chunk) => chunk.type === 'tool_use_end')).toEqual([
      { type: 'tool_use_end', id: 'call_first', input: argumentsValue },
      { type: 'tool_use_end', id: 'call_second', input: secondArgs },
    ]);
  });

  it('dispatches once with valid arguments and round-trips exact reasoning and the tool result', async () => {
    const reasoning = ' \nCheck the task before recording the result.\n';
    mockStream([
      { reasoning_content: reasoning.slice(0, 12) },
      { reasoning_content: reasoning.slice(12), content: malformedCall },
      { tool_calls: [{ index: 0, id: 'call_comment', function: { name: toolName, arguments: '{}' } }] },
    ]);
    const execute = vi.fn(async (_params: unknown) => ({ toolUseId: '', content: 'Recorded comment.' }));
    const registry = new ToolRegistry();
    registry.register({
      name: toolName,
      description: 'Record a comment',
      parameters: z.object({ task_id: z.string(), content: z.string() }),
      readOnly: true,
      riskLevel: 'low',
      execute,
    });
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const initialMessage = { role: 'user' as const, content: 'Record the result.' };
    const turn = await executeTurn(
      [initialMessage], provider, options.model, '', registry.definitions(), registry,
      new PermissionEngine('autonomous'), new AgentEventEmitter(),
      { cwd: '/tmp', sessionId: 'glm-recovery-roundtrip' }, 32768, 0,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual(argumentsValue);
    const resultMessage = {
      role: 'user' as const,
      content: turn.toolResults.map((result) => ({
        type: 'tool_result' as const,
        toolUseId: result.toolUseId,
        content: result.content,
      })),
    };
    await collect(provider.chat(messagesToChat([initialMessage, turn.assistantMessage, resultMessage]), options));
    const requests = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/chat/completions'));
    expect(requests).toHaveLength(2);
    const replay = JSON.parse(String(requests[1]?.[1]?.body));
    const assistant = replay.messages.find((message: { role: string }) => message.role === 'assistant');
    expect(assistant.reasoning_content).toBe(reasoning);
    expect(assistant.tool_calls).toEqual([
      { id: 'call_comment', type: 'function', function: { name: toolName, arguments: JSON.stringify(argumentsValue) } },
    ]);
    expect(replay.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_comment', content: 'Recorded comment.' });
  });
});
