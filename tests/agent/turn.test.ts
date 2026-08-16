import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { executeTurn, messagesToChat } from '../../src/agent/turn.js';
import type { Message, ContentBlock } from '../../src/agent/types.js';
import type { ToolHandler, ToolContext, ToolResult, ToolDefinition } from '../../src/tools/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

// ── Test Fixtures ──

function makeDummyTool(name: string, result: string, opts?: { readOnly?: boolean; riskLevel?: 'low' | 'medium' | 'high'; delay?: number }): ToolHandler {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: z.object({ value: z.string().optional() }),
    readOnly: opts?.readOnly ?? false,
    riskLevel: opts?.riskLevel ?? 'low',
    async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
      if (opts?.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return { toolUseId: '', content: result };
    },
  };
}

let provider: MockProvider;
let registry: ToolRegistry;
let permissions: PermissionEngine;
let emitter: AgentEventEmitter;
let events: AgentEvent[];
let ctx: ToolContext;

const MODEL = 'test-model';
const SYSTEM = 'You are a test agent.';

beforeEach(() => {
  provider = new MockProvider();
  registry = new ToolRegistry();
  permissions = new PermissionEngine('autonomous');
  emitter = new AgentEventEmitter();
  events = [];
  emitter.on('*', (e) => events.push(e));
  ctx = { cwd: '/tmp', sessionId: 'test-session' };
});

function run(messages: Message[], toolDefs?: ToolDefinition[]) {
  return executeTurn(
    messages, provider, MODEL, SYSTEM,
    toolDefs ?? registry.definitions(),
    registry, permissions, emitter, ctx,
    16384, 0,
  );
}

// ── messagesToChat ──

describe('messagesToChat', () => {
  it('converts string content messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const chat = messagesToChat(msgs);
    expect(chat).toHaveLength(2);
    expect(chat[0]!.role).toBe('user');
    expect(chat[0]!.content).toBe('hello');
  });

  it('converts content block messages', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', id: 'tc1', name: 'read', input: { file_path: '/tmp/x' } },
        ],
      },
    ];
    const chat = messagesToChat(msgs);
    expect(chat).toHaveLength(1);
    const blocks = chat[0]!.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('tool_use');
  });

  it('converts tool_result blocks', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'file data' },
        ],
      },
    ];
    const chat = messagesToChat(msgs);
    const blocks = chat[0]!.content as Array<{ type: string; toolUseId?: string }>;
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.toolUseId).toBe('tc1');
  });
});

// ── Text-only responses ──

describe('executeTurn — text-only', () => {
  it('returns assistant message with text content', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('Hello user!'));
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.content).toBe('Hello user!');
  });

  it('reports correct token counts', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('reply', { input: 150, output: 75 }));
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.inputTokens).toBe(150);
    expect(result.outputTokens).toBe(75);
  });

  it('returns empty toolCalls and toolResults arrays', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('just text'));
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolResults).toHaveLength(0);
  });

  it('propagates stopReason correctly', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('text'));
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  it('cuts off repeated action chatter and stores a clean diagnostic with evidence', async () => {
    const repeated = Array.from(
      { length: 14 },
      (_, index) => `Let me ${index % 2 === 0 ? 'edit the test' : 'apply the change'} now.`,
    ).join('\n\n');
    provider.queueResponse(ResponseBuilder.textOnly(repeated));

    const result = await run([{ role: 'user', content: 'fix it' }]);

    expect(result.stopReason).toBe('degenerate_generation');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    const content = String(result.assistantMessage.content);
    expect(content).toContain('Generation stopped by SCLI');
    expect(content).toContain('Evidence');
    expect(content).not.toContain(repeated);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'provider_status',
      code: 'degenerate_generation_stopped',
    }));
  });

  it('does not stop a working turn that restates one next file write', async () => {
    const restated = [
      'Let me check the existing auth pattern in the interviews views to mirror it in the coding views.',
      ...Array.from({ length: 5 }, () => 'Let me write views.py'),
    ].join('\n\n');
    provider.queueResponse(ResponseBuilder.textOnly(restated));

    const result = await run([
      { role: 'user', content: 'build the coding platform' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'views.py' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'r1', content: 'existing interview views' }],
      },
    ]);

    expect(result.stopReason).not.toBe('degenerate_generation');
    const content = String(result.assistantMessage.content);
    expect(content).not.toContain('Generation stopped by SCLI');
    expect(content).toContain('Let me write views.py');
  });

  it('does not replace a tool-bearing turn with a chatter stop notice', async () => {
    // Dense "Let me" preamble + a real tool call (DeepSeek often rephrases
    // intent before invoke). Even when final_text re-emits the wall after the
    // tool, the guard must keep content and execute (not claim "no tool").
    const preamble = Array.from(
      { length: 14 },
      (_, index) => `Let me ${index % 2 === 0 ? 'commit the change' : 'push the branch'} now.`,
    ).join('\n\n');
    registry.register(makeDummyTool('bash', 'ok'));
    provider.queueResponse([
      { type: 'text', text: preamble },
      { type: 'tool_use_start', id: 'tc-keep', name: 'bash' },
      { type: 'tool_use_delta', id: 'tc-keep', input: JSON.stringify({ value: 'echo ok' }) },
      { type: 'tool_use_end', id: 'tc-keep', input: { value: 'echo ok' } },
      { type: 'final_text', text: preamble },
      { type: 'usage', inputTokens: 10, outputTokens: 40 },
      { type: 'stop_reason', reason: 'tool_calls' },
      { type: 'done' },
    ]);

    const result = await run([{ role: 'user', content: 'ship it' }]);

    expect(result.stopReason).not.toBe('degenerate_generation');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('bash');
    const content = typeof result.assistantMessage.content === 'string'
      ? result.assistantMessage.content
      : JSON.stringify(result.assistantMessage.content);
    expect(content).not.toContain('Generation stopped by SCLI');
  });

  // SCLI-218: a cortex/auto backend reports the concrete served model per
  // response; the turn must surface it (plus its window) for the loop's
  // dynamic compaction budget.
  it('captures the served_model stream event into the TurnResult', async () => {
    provider.queueResponse([
      { type: 'served_model', model: 'Qwen3.6-27B-FP8', contextWindow: 131_072 },
      ...ResponseBuilder.textOnly('served by a smaller rung'),
    ]);
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.servedModel).toBe('Qwen3.6-27B-FP8');
    expect(result.servedContextWindow).toBe(131_072);
  });

  it('leaves servedModel undefined when the provider never reports one', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('plain'));
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.servedModel).toBeUndefined();
    expect(result.servedContextWindow).toBeUndefined();
  });

  it('does not synthesize a fallback stall during an accepted silent Cortex decode', async () => {
    vi.useFakeTimers();
    try {
      provider.name = 'cortex';
      provider.chat = async function* () {
        // Production order: Cortex acceptance is internal to the provider, then
        // a tool parser can remain semantically silent longer than the old
        // executeTurn fallback before completing normally. Transport comments
        // are intentionally not surfaced as agent/model progress.
        await new Promise((resolve) => setTimeout(resolve, 610_000));
        yield { type: 'text', text: 'completed after the long decode' } as const;
        yield { type: 'usage', inputTokens: 200_000, outputTokens: 16_000 } as const;
        yield { type: 'stop_reason', reason: 'stop' } as const;
        yield { type: 'done' } as const;
      };

      const turn = run([{ role: 'user', content: 'finish the overnight task' }]);
      await vi.advanceTimersByTimeAsync(610_001);
      const result = await turn;

      expect(result.assistantMessage.content).toBe('completed after the long decode');
      expect(events.some((event) => (
        event.type === 'provider_status' && event.code === 'stall_timeout'
      ))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers provider final_text for the stored assistant message', async () => {
    provider.queueResponse([
      { type: 'text', text: 'draft leaked tool transcript' },
      { type: 'final_text', text: 'clean final answer' },
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
      { type: 'stop_reason', reason: 'end_turn' },
      { type: 'done' },
    ]);
    const result = await run([{ role: 'user', content: 'hi' }]);
    expect(result.assistantMessage.content).toBe('clean final answer');
  });

  it('preserves streamed Cortex reasoning when a DeepSeek turn hits max_tokens', async () => {
    provider.name = 'cortex';
    provider.queueResponse([
      { type: 'reasoning_text', text: 'Now let me trace the render path.' },
      { type: 'usage', inputTokens: 300_000, outputTokens: 8192 },
      { type: 'stop_reason', reason: 'max_tokens' },
      { type: 'done' },
    ]);

    const result = await executeTurn(
      [{ role: 'user', content: 'inspect the issue' }],
      provider, 'DeepSeek-V4-Flash', SYSTEM, registry.definitions(),
      registry, permissions, emitter, ctx, 16384, 0,
    );
    provider.name = 'mock';

    expect(result.stopReason).toBe('max_tokens');
    expect(result.assistantMessage.content).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        rawContent: 'Now let me trace the render path.',
      }),
    ]);
  });
});

// ── Tool call responses ──

describe('executeTurn — tool calls', () => {
  it('does not execute a write tool from a max_tokens-truncated turn', async () => {
    let executions = 0;
    const writeTool = makeDummyTool('write_something', 'written');
    writeTool.execute = async () => {
      executions++;
      return { toolUseId: '', content: 'written' };
    };
    registry.register(writeTool);
    provider.queueResponse([
      { type: 'tool_use_start', id: 'partial-tool', name: 'write_something' },
      { type: 'tool_use_end', id: 'partial-tool', input: { value: 'unsafe' } },
      { type: 'stop_reason', reason: 'max_tokens' },
      { type: 'done' },
    ]);

    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());

    expect(result.stopReason).toBe('max_tokens');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolResults).toHaveLength(0);
    expect(executions).toBe(0);
  });

  it('omits the client web_search schema for providers with native web search', async () => {
    provider.supportsNativeWebSearch = true;
    provider.queueResponse(ResponseBuilder.textOnly('native search remains available'));
    const toolDefs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Client-side web search',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await run([{ role: 'user', content: 'search' }], toolDefs);

    expect(provider.capturedOptions[0]?.tools?.map((tool) => tool.name)).toEqual(['read']);
    expect(toolDefs.map((tool) => tool.name)).toEqual(['web_search', 'read']);
  });

  it('keeps the client web_search schema for providers without native web search', async () => {
    provider.supportsNativeWebSearch = false;
    provider.queueResponse(ResponseBuilder.textOnly('client search remains available'));
    const toolDefs: ToolDefinition[] = [{
      name: 'web_search',
      description: 'Client-side web search',
      inputSchema: { type: 'object', properties: {} },
    }];

    await run([{ role: 'user', content: 'search' }], toolDefs);

    expect(provider.capturedOptions[0]?.tools?.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('parses and executes a single tool call', async () => {
    registry.register(makeDummyTool('test_tool', 'tool output'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'test_tool', input: { value: 'x' } }]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('test_tool');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.content).toBe('tool output');
  });

  it('executes multiple tool calls in order', async () => {
    registry.register(makeDummyTool('tool_a', 'result_a'));
    registry.register(makeDummyTool('tool_b', 'result_b'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc1', name: 'tool_a', input: {} },
        { id: 'tc2', name: 'tool_b', input: {} },
      ]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]!.content).toBe('result_a');
    expect(result.toolResults[1]!.content).toBe('result_b');
  });

  it('returns error for unknown tool', async () => {
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'nonexistent', input: {} }]),
    );
    const result = await run([{ role: 'user', content: 'go' }]);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toContain('Unknown tool');
  });

  it('runs read-only tools in parallel', async () => {
    const startTimes: number[] = [];
    const makeSlowReadTool = (name: string): ToolHandler => ({
      name,
      description: `Slow read tool: ${name}`,
      parameters: z.object({}),
      readOnly: true,
      riskLevel: 'low',
      async execute(): Promise<ToolResult> {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return { toolUseId: '', content: `${name} done` };
      },
    });
    registry.register(makeSlowReadTool('read_a'));
    registry.register(makeSlowReadTool('read_b'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc1', name: 'read_a', input: {} },
        { id: 'tc2', name: 'read_b', input: {} },
      ]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolResults).toHaveLength(2);
    // Both should have started close together (parallel), not 50ms apart
    if (startTimes.length === 2) {
      expect(Math.abs(startTimes[1]! - startTimes[0]!)).toBeLessThan(40);
    }
  });

  it('toolUseId matches the tool call id', async () => {
    registry.register(makeDummyTool('matcher', 'ok'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'unique-id-123', name: 'matcher', input: {} }]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolResults[0]!.toolUseId).toBe('unique-id-123');
  });

  it('catches tool execution errors', async () => {
    const errorTool: ToolHandler = {
      name: 'error_tool',
      description: 'Throws',
      parameters: z.object({}),
      readOnly: false,
      riskLevel: 'low',
      async execute(): Promise<ToolResult> {
        throw new Error('boom');
      },
    };
    registry.register(errorTool);
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'error_tool', input: {} }]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toContain('boom');
  });

  it('includes text and tool_use in assistant message blocks', async () => {
    registry.register(makeDummyTool('blk_tool', 'res'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('thinking...', [{ id: 'tc1', name: 'blk_tool', input: {} }]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    const blocks = result.assistantMessage.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
  });
});

// ── Permission tests ──

describe('executeTurn — permissions', () => {
  it('plan mode denies high-risk tool', async () => {
    const planPerms = new PermissionEngine('plan');
    registry.register(makeDummyTool('risky', 'should not run', { riskLevel: 'high' }));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'risky', input: {} }]),
    );
    const result = await executeTurn(
      [{ role: 'user', content: 'go' }],
      provider, MODEL, SYSTEM, registry.definitions(),
      registry, planPerms, emitter, ctx, 16384, 0,
    );
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toContain('Permission denied');
  });

  it('supervised mode triggers onPermissionAsk for medium-risk tool', async () => {
    const supervisedPerms = new PermissionEngine('supervised');
    registry.register(makeDummyTool('medium_tool', 'executed', { riskLevel: 'medium' }));
    let askCalled = false;
    const onAsk = async () => { askCalled = true; return 'allow' as const; };
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'medium_tool', input: {} }]),
    );
    const result = await executeTurn(
      [{ role: 'user', content: 'go' }],
      provider, MODEL, SYSTEM, registry.definitions(),
      registry, supervisedPerms, emitter, ctx, 16384, 0, onAsk,
    );
    expect(askCalled).toBe(true);
    expect(result.toolResults[0]!.content).toBe('executed');
  });

  it('deny callback stops tool execution', async () => {
    const supervisedPerms = new PermissionEngine('supervised');
    registry.register(makeDummyTool('denied_tool', 'should not run', { riskLevel: 'medium' }));
    const onAsk = async () => 'deny' as const;
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'denied_tool', input: {} }]),
    );
    const result = await executeTurn(
      [{ role: 'user', content: 'go' }],
      provider, MODEL, SYSTEM, registry.definitions(),
      registry, supervisedPerms, emitter, ctx, 16384, 0, onAsk,
    );
    expect(result.toolResults[0]!.isError).toBe(true);
    expect(result.toolResults[0]!.content).toContain('denied');
  });

  it('allow_always records approval in engine', async () => {
    const supervisedPerms = new PermissionEngine('supervised');
    registry.register(makeDummyTool('persist_tool', 'ok', { riskLevel: 'medium' }));
    const onAsk = async () => 'allow_always' as const;
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'persist_tool', input: {} }]),
    );
    await executeTurn(
      [{ role: 'user', content: 'go' }],
      provider, MODEL, SYSTEM, registry.definitions(),
      registry, supervisedPerms, emitter, ctx, 16384, 0, onAsk,
    );
    // After allow_always, subsequent checks should auto-allow
    const decision = supervisedPerms.check({ toolName: 'persist_tool', input: {}, riskLevel: 'medium' });
    expect(decision).toBe('allow');
  });

  it('autonomous mode allows everything', async () => {
    registry.register(makeDummyTool('auto_tool', 'allowed', { riskLevel: 'high' }));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'auto_tool', input: {} }]),
    );
    const result = await run([{ role: 'user', content: 'go' }], registry.definitions());
    expect(result.toolResults[0]!.content).toBe('allowed');
    expect(result.toolResults[0]!.isError).toBeFalsy();
  });
});

// ── Event emission tests ──

describe('executeTurn — events', () => {
  it('emits tool_start and tool_complete events', async () => {
    registry.register(makeDummyTool('evt_tool', 'done'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc-evt', name: 'evt_tool', input: { value: 'x' } }]),
    );
    await run([{ role: 'user', content: 'go' }], registry.definitions());
    const starts = events.filter((e) => e.type === 'tool_start');
    const completes = events.filter((e) => e.type === 'tool_complete');
    // Two tool_start events: first at tool_use_start (input:{}) and second at
    // tool_use_end with complete input (so TUI can display tool arguments).
    expect(starts).toHaveLength(2);
    expect(completes).toHaveLength(1);
    expect((starts[0] as { toolCallId: string }).toolCallId).toBe('tc-evt');
    expect((starts[1] as { toolCallId: string; input: Record<string, unknown> }).toolCallId).toBe('tc-evt');
    expect((starts[1] as { input: Record<string, unknown> }).input).toEqual({ value: 'x' });
    expect((completes[0] as { toolCallId: string }).toolCallId).toBe('tc-evt');
  });

  it('emits content events for text chunks', async () => {
    provider.queueResponse(ResponseBuilder.textOnly('Hello!'));
    await run([{ role: 'user', content: 'hi' }]);
    const contentEvents = events.filter((e) => e.type === 'content');
    expect(contentEvents.length).toBeGreaterThan(0);
    expect((contentEvents[0] as { text: string }).text).toContain('Hello');
  });

  it('events include correct toolName', async () => {
    registry.register(makeDummyTool('named_tool', 'ok'));
    provider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'named_tool', input: {} }]),
    );
    await run([{ role: 'user', content: 'go' }], registry.definitions());
    const start = events.find((e) => e.type === 'tool_start') as { toolName: string } | undefined;
    expect(start?.toolName).toBe('named_tool');
  });
});
