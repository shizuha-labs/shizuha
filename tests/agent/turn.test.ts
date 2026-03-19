import { describe, it, expect, beforeEach } from 'vitest';
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
});

// ── Tool call responses ──

describe('executeTurn — tool calls', () => {
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
