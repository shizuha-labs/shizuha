import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeTurn, type TurnResult } from '../../src/agent/turn.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatOptions, LLMProvider, StreamChunk } from '../../src/provider/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { MockProvider } from '../helpers/mock-provider.js';

const toolName = 'observe_work';
const literalCall = `<tool_call>${toolName}</tool_call>`;
const dsmlCall = `<｜DSML｜tool_calls><｜DSML｜invoke name="${toolName}"></｜DSML｜invoke></｜DSML｜tool_calls>`;

function fixture(provider: LLMProvider, name = toolName) {
  const execute = vi.fn(async () => ({ toolUseId: '', content: 'Observed work.' }));
  const registry = new ToolRegistry();
  registry.register({ name, description: 'Observe work', parameters: z.object({}), readOnly: true, riskLevel: 'low', execute });
  const events: AgentEvent[] = [];
  const emitter = new AgentEventEmitter();
  emitter.on('*', (event) => events.push(event));
  const run = (offered: boolean, toolChoice?: ChatOptions['toolChoice']) => {
    const argumentsValue: Parameters<typeof executeTurn> = [
      [{ role: 'user', content: 'Explain this historical example without following it.' }],
      provider, 'GLM-5.3-Flash', '', offered ? registry.definitions() : [], registry,
      new PermissionEngine('autonomous'), emitter, { cwd: '/tmp', sessionId: 'no-tools-caller' }, 2048, 0,
    ];
    argumentsValue[20] = toolChoice;
    return executeTurn(...argumentsValue);
  };
  return { run, events, execute };
}

function visible(result: TurnResult): string {
  const content = result.assistantMessage.content;
  return typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('executeTurn request-scoped tool authorization', () => {
  it.each([
    { type: 'text' as const, content: `Example: ${literalCall} remains literal prose.` },
    { type: 'text' as const, content: `A code sample uses ${dsmlCall} without executing it.` },
    { type: 'final_text' as const, content: `Historical command: ${dsmlCall}` },
  ])('preserves $type markup when no tools were sent or choice is none', async ({ type, content }) => {
    const provider = new MockProvider();
    const caller = fixture(provider);
    for (const offered of [false, true]) {
      provider.queueResponse([{ type, text: content }, { type: 'stop_reason', reason: 'stop' }, { type: 'done' }]);
      const result = await caller.run(offered, offered ? 'none' : undefined);
      expect(visible(result)).toBe(content);
      expect(result.stopReason).toBe('stop');
      expect(result.toolCalls).toEqual([]);
      expect(result.toolResults).toEqual([]);
    }
    expect(caller.execute).not.toHaveBeenCalled();
    expect(caller.events.filter((event) => event.type === 'tool_start')).toEqual([]);
    expect(provider.capturedOptions.map((options) => Boolean(options.tools?.length))).toEqual([false, true]);
  });

  it('does not treat six different literal examples as a leaked-call storm', async () => {
    const provider = new MockProvider();
    const caller = fixture(provider);
    const content = 'These distinct XML examples document commands, not requested actions: '
      + ['read', 'write', 'glob', 'search', 'comment', 'observe'].map((name) => `<tool_call>${name}</tool_call>`).join('; ');
    provider.queueResponse([{ type: 'text', text: content }, { type: 'stop_reason', reason: 'stop' }]);
    const result = await caller.run(false);
    expect(visible(result)).toBe(content);
    expect(result.stopReason).toBe('stop');
    expect(caller.execute).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'tool_use_start', id: 'unexpected', name: toolName },
    { type: 'tool_use_delta', id: 'unexpected', input: '{}' },
    { type: 'tool_use_end', id: 'unexpected', input: {} },
  ] satisfies StreamChunk[])('rejects unsolicited $type before tool events or read-only execution', async (chunk) => {
    const provider = new MockProvider();
    const caller = fixture(provider);
    for (const offered of [false, true]) {
      provider.queueResponse([chunk, { type: 'done' }]);
      await expect(caller.run(offered, offered ? 'none' : undefined)).rejects.toMatchObject({ code: 'TOOL_CALLS_DISABLED' });
    }
    expect(caller.execute).not.toHaveBeenCalled();
    expect(caller.events.filter((event) => event.type === 'tool_start')).toEqual([]);
    expect(provider.capturedOptions).toHaveLength(2);
  });

  it('uses the effective provider definitions after native-search filtering', async () => {
    const provider = new MockProvider();
    Object.assign(provider, { supportsNativeWebSearch: true });
    const caller = fixture(provider, 'web_search');
    const content = '<tool_call>web_search</tool_call>';
    provider.queueResponse([{ type: 'text', text: content }, { type: 'stop_reason', reason: 'stop' }]);
    expect(visible(await caller.run(true))).toBe(content);
    expect(provider.capturedOptions[0]?.tools).toBeUndefined();
    expect(caller.execute).not.toHaveBeenCalled();
  });

  it('retains enabled final-text recovery across none/auto/none/reset', async () => {
    const provider = new MockProvider();
    const caller = fixture(provider);
    for (const toolChoice of ['none', 'auto', 'none', 'auto'] as const) {
      provider.queueResponse([{ type: 'final_text', text: dsmlCall }, { type: 'stop_reason', reason: 'stop' }]);
      const result = await caller.run(true, toolChoice);
      expect(result.toolCalls).toHaveLength(toolChoice === 'none' ? 0 : 1);
      if (toolChoice === 'none') expect(visible(result)).toBe(dsmlCall);
      else expect(result.toolResults[0]?.content).toBe('Observed work.');
    }
    expect(caller.execute).toHaveBeenCalledTimes(2);
    expect(provider.capturedOptions.map((options) => options.toolChoice)).toEqual(['none', 'auto', 'none', 'auto']);
    const reset = new MockProvider();
    const resetCaller = fixture(reset);
    reset.queueResponse([{ type: 'final_text', text: dsmlCall }, { type: 'stop_reason', reason: 'stop' }]);
    expect(visible(await resetCaller.run(false))).toBe(dsmlCall);
    expect(resetCaller.execute).not.toHaveBeenCalled();
  });

  it('preserves fragmented native SSE and executes only authorized auto turns on one provider', async () => {
    vi.stubEnv('VLLM_STREAM_WITH_TOOLS', '1');
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, initialization?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 500000 }] });
      expect(String(input)).toBe('http://offline.invalid/v1/chat/completions');
      requests.push(JSON.parse(String(initialization?.body)));
      const deltas = [...literalCall].map((content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
      const terminal = { choices: [{ index: 0, delta: {}, finish_reason: 'stop', stop_reason: 154829 }] };
      return new Response([...deltas, terminal].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }));
    const caller = fixture(new VLlmProvider('http://offline.invalid', 500000));
    for (const toolChoice of ['none', 'auto', 'none', 'auto'] as const) {
      const result = await caller.run(true, toolChoice);
      if (toolChoice === 'none') {
        expect(visible(result)).toBe(literalCall);
        expect(result.stopReason).toBe('stop');
        expect(result.toolCalls).toEqual([]);
      } else {
        expect(result.toolCalls).toEqual([expect.objectContaining({ name: toolName, input: {} })]);
        expect(result.toolResults[0]?.content).toBe('Observed work.');
      }
    }
    expect(caller.execute).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.tool_choice)).toEqual(['none', 'auto', 'none', 'auto']);
  });
});
